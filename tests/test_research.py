import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

from research import data
from research.data import demo, validate, parse_twse
from research.engine import splits, strategy, Model, run
from research.features import features, targets, rule, gate, join_events_asof


class ResearchTests(unittest.TestCase):
    def test_etf_symbol_keeps_letter_suffix(self):
        self.assertEqual(data.validate_symbol('00985A'), '00985A')
        self.assertEqual(data.validate_symbol('00632R.TW'), '00632R.TW')
        with self.assertRaises(ValueError):
            data.validate_symbol('00985A&token=bad')

    @classmethod
    def setUpClass(cls):
        cls.df = demo()

    def test_features_cannot_see_future(self):
        before = features(self.df).iloc[:800]
        changed = self.df.copy()
        changed.loc[800:, ['open','high','low','close','volume']] *= 2
        assert_frame_equal(before, features(changed).iloc[:800])

    def test_production_ingestion_rejects_demo_and_uses_explicit_network_source(self):
        from research import cli
        with self.assertRaises(ValueError):
            cli.dispatch({'provider':'demo','symbol':'2330'})
        with patch.object(cli,'fetch_twse',return_value=(self.df,'TWSE official')) as twse, patch.object(cli,'fetch_yahoo') as yahoo:
            result=cli.dispatch({'action':'quote','symbol':'2330'})
            twse.assert_called_once_with('2330');yahoo.assert_not_called()
            self.assertEqual(result['symbol'],'2330')
            self.assertEqual(result['bars'][-1]['c'],self.df.close.iloc[-1])

    def test_targets_are_next_open_not_signal_close(self):
        target = targets(self.df, 5, .01)
        expected = self.df.close.iloc[105]/self.df.open.iloc[101]-1
        self.assertAlmostEqual(target['return'].iloc[100], expected)
        self.assertEqual(target.end.iloc[100], self.df.date.iloc[105])
        self.assertTrue(target.label.iloc[-5:].isna().all())

    def test_every_horizon_has_purged_boundaries_and_unique_oos(self):
        for h in range(1, 6):
            t = targets(self.df, h, .01)
            seen = set()
            for train, cal, test in splits(len(self.df)-h):
                self.assertLess(t.end.iloc[train].max(), self.df.date.iloc[cal[0]])
                self.assertLess(t.end.iloc[cal].max(), self.df.date.iloc[test[0]])
                self.assertFalse(seen.intersection(test))
                seen.update(test)

    def test_validator_rejects_duplicates_nan_invalid_ohlc_and_close_only(self):
        variants = [pd.concat([self.df,self.df.iloc[[0]]]), self.df.assign(high=0), self.df.assign(volume=np.nan), self.df[['date','close']]]
        for df in variants:
            with self.subTest(columns=list(df.columns)), self.assertRaises(ValueError):
                validate(data.records(df))

    def test_validator_rejects_partial_and_future_bars(self):
        from datetime import datetime
        rows = data.records(self.df)
        rows[-1]['date'] = '2026-11-02'
        with self.assertRaises(ValueError):
            validate(rows, datetime(2026,11,2,14,tzinfo=data.TZ))
        validate(rows, datetime(2026,11,2,16,tzinfo=data.TZ))

    def test_flat_rsi_neutral_and_atr_uses_high_low(self):
        df = self.df.copy()
        df['open']=100.;df['close']=100.;df['high']=105.;df['low']=95.
        f=features(df).iloc[-1]
        self.assertEqual(f.rsi_14, 50)
        self.assertAlmostEqual(f.atr_pct, .1)

    def test_twse_roc_dates_volume_units_and_halts_fail_closed(self):
        rows=parse_twse({'stat':'OK','data':[['115/10/01','1,234','100,000','100','105','99','102']]})
        self.assertEqual(rows[0]['date'],'2026-10-01')
        self.assertEqual(rows[0]['volume'],1234)
        with self.assertRaises(ValueError):
            parse_twse({'stat':'OK','data':[['115/10/01','0','0','--','--','--','--']]})

    def test_event_join_respects_publication_time(self):
        bars=pd.DataFrame({'decision_at':pd.to_datetime(['2026-01-01T16:00Z','2026-01-02T16:00Z'])})
        events=pd.DataFrame({'available_at':pd.to_datetime(['2026-01-02T08:00Z']), 'sentiment':[.8]})
        result=join_events_asof(bars,events,['sentiment'])
        self.assertTrue(pd.isna(result.sentiment.iloc[0]))
        self.assertEqual(result.sentiment.iloc[1],.8)

    def test_risk_blocks_demo_and_stale(self):
        reasons=gate(features(self.df).iloc[-1],.9,demo=True,stale=True)
        self.assertTrue(any('示範' in r for r in reasons))
        self.assertTrue(any('更新' in r for r in reasons))

    def test_single_class_fit_no_crash(self):
        f=features(self.df).iloc[60:400]
        m=Model().fit(f.iloc[:250],pd.Series(np.zeros(250)),f.iloc[250:],pd.Series(np.zeros(90)))
        self.assertTrue(np.isfinite(m.predict(f.iloc[[-1]])).all())
        self.assertIsNone(m.calibrator)

    def test_strategy_nonoverlap_fee_drag_and_intraday_stop(self):
        df=self.df.iloc[:40].copy().reset_index(drop=True)
        df['open']=100.;df['close']=100.;df['high']=101.;df['low']=99.
        f=pd.DataFrame({'ma_gap_20':[.02]*40,'ma_gap_60':[.03]*40,'macd_hist':[.01]*40,'rsi_14':[50.]*40,
            'atr_pct':[.01]*40,'turnover_20':[1e9]*40,'volatility_20':[.01]*40,'volume_ratio':[1.]*40,'return_1':[0.]*40})
        predictions=[{'index':i,'probability':.8} for i in range(5,30)]
        s=strategy(df,f,predictions,5)
        self.assertLess(s['totalReturn'],0)
        for a,b in zip(s['fills'],s['fills'][1:]):
            self.assertLess(a['exit'],b['entry'])
        df.loc[6,'low']=90
        s=strategy(df,f,predictions,5)
        self.assertEqual(s['fills'][0]['reason'],'atr_stop')
        self.assertAlmostEqual(s['fills'][0]['exitPrice'],98)

    def test_full_pipeline_snapshot_and_reproducible_probabilities(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(data,'STORE',Path(tmp)):
            digest=data.save_dataset('2330','SYNTHETIC test fixture',self.df.iloc[:700])
            result=run(digest)
            self.assertEqual(len(result['horizons']),5)
            for h in result['horizons']:
                self.assertTrue(0<=h['upProbability']<=1)
                self.assertEqual(h['action'],'observe')
                self.assertGreater(h['evaluation']['probability']['n'],0)
            with data.connect() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM runs').fetchone()[0],1)
            again=run(digest)
            self.assertEqual([h['upProbability'] for h in result['horizons']],[h['upProbability'] for h in again['horizons']])


if __name__=='__main__':
    unittest.main()
