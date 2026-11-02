import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd
from pandas.testing import assert_frame_equal

from research import data,ledger
from research.context import context_features,feature_prices,quality_report,roc_date
from research.engine import run,similar_outcomes
from research.features import targets


def fixture_context(df):
    days=df.date.dt.strftime('%Y-%m-%d').tolist()
    context={'version':'test','market':[{'date':d,'close':1000+i} for i,d in enumerate(days)],
        'institutional':[{'date':d,'foreign':i*100.,'trust':200.,'dealer':300.,'foreign_dealer':0.,'complete':True} for i,d in enumerate(days)],
        'events':[],'sources':{'market':'test fixture','institutional':'test fixture'}}
    context['quality']=quality_report(df,context)
    return context


class ContextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.df=data.demo()

    def test_roc_date_formats(self):
        self.assertEqual(roc_date('115年10月30日'),'2026-10-30')
        self.assertEqual(roc_date('115/10/30'),'2026-10-30')
        with self.assertRaises(ValueError):roc_date('bad')

    def test_institutional_predictors_are_one_session_late(self):
        c=fixture_context(self.df);before=context_features(self.df,c)
        c['institutional'][500]['foreign']+=10000000
        after=context_features(self.df,c)
        assert_frame_equal(before.iloc[:501],after.iloc[:501])
        self.assertNotEqual(before.foreign_net_ratio_lag1.iloc[501],after.foreign_net_ratio_lag1.iloc[501])

    def test_future_market_changes_cannot_change_past_features(self):
        c=fixture_context(self.df);before=context_features(self.df,c)
        for r in c['market'][700:]:r['close']*=2
        assert_frame_equal(before.iloc[:700],context_features(self.df,c).iloc[:700])

    def test_reference_adjustment_is_causal_and_preserves_raw_data(self):
        df=self.df.copy();day=str(df.date.iloc[500].date())
        prices=feature_prices(df,[{'date':day,'factor':.5}])
        self.assertEqual(prices.close.iloc[499],df.close.iloc[499])
        self.assertEqual(prices.close.iloc[500],df.close.iloc[500]*2)
        self.assertEqual(df.close.iloc[500],self.df.close.iloc[500])

    def test_calendar_holes_are_blocked_instead_of_compressed(self):
        c=fixture_context(self.df)
        report=quality_report(self.df.drop(index=500),c)
        self.assertEqual(report['status'],'blocked')
        self.assertIn(str(self.df.date.iloc[500].date()),report['missingSessions'])

    def test_missing_fund_rows_are_identified_not_interpreted_as_zero(self):
        c=fixture_context(self.df);del c['institutional'][500]
        f=context_features(self.df,c)
        self.assertEqual(f.institutional_missing_lag1.iloc[501],1)
        self.assertEqual(f.institutional_missing_lag1.iloc[500],0)
        df=self.df.copy();df.loc[600,'volume']=0
        f=context_features(df,fixture_context(df))
        self.assertEqual(f.institutional_missing_lag1.iloc[601],1)

    def test_verified_split_passes_validation_and_labels_do_not_show_fake_crash(self):
        df=self.df.copy()
        for col in ['open','high','low','close']:df[col]=100.
        df.loc[500:,['open','high','low','close']]=25.
        e={'date':str(df.date.iloc[500].date()),'factor':.25,'type':'split','shareRatio':4.}
        with self.assertRaises(ValueError):data.validate(data.records(df))
        data.validate(data.records(df),split_events=[e])
        self.assertAlmostEqual(targets(df,5,.01,[e])['return'].iloc[497],0.)

    def test_insufficient_similar_samples_never_invent_expected_returns(self):
        result=similar_outcomes([{'probability':.6,'label':1,'return':.02,'netReturn':.01}],.6)
        self.assertEqual(result['n'],1);self.assertIsNone(result['averageNetReturn'])

    def test_enhanced_and_control_evaluate_identical_oos_dates(self):
        df=self.df.iloc[:700];c=fixture_context(df)
        with tempfile.TemporaryDirectory() as tmp,patch.object(data,'STORE',Path(tmp)):
            identifier=data.save_dataset('2330','SYNTHETIC controlled fixture',df,{'context':c})
            result=run(identifier)
            self.assertTrue(result['context']['connected'])
            self.assertGreater(result['context']['featureCount'],result['context']['baselineFeatureCount'])
            for h in result['horizons']:
                hold=h['comparison']['holdout']
                self.assertEqual(hold['probability']['n'],63)
                self.assertEqual(hold['ohlcvBaseline']['n'],63)
                self.assertTrue(all('ohlcvBaseline' in p for p in h['oos']))
                self.assertFalse(h['oos'][0]['entryAllowed'])

    def test_publisher_isolates_a_bad_stock_without_inventing_bars(self):
        from research import publish as publication
        df=self.df.iloc[:700]
        result={'symbol':'2330','asOf':str(df.date.iloc[-1].date()),'runId':'test','quality':{'status':'passed'},'horizons':[]}
        with tempfile.TemporaryDirectory() as tmp,patch.object(publication,'fetch_twse',side_effect=[(df,'TWSE test fixture'),ValueError('missing prices')]),patch.object(publication,'collect_context',return_value={}),patch.object(publication,'save_dataset',return_value='test-id'),patch.object(publication,'run',return_value=result) as model:
            report=publication.publish(['2330','2317'],Path(tmp))
            self.assertEqual(report['results'][1]['quality'],'blocked')
            blocked=json.loads((Path(tmp)/'2317.json').read_text(encoding='utf-8'))
            self.assertTrue(blocked['blocked']);self.assertNotIn('bars',blocked)
            model.assert_called_once()

    def test_publisher_stops_if_all_sources_fail(self):
        from research import publish as publication
        with tempfile.TemporaryDirectory() as tmp,patch.object(publication,'fetch_twse',side_effect=ValueError('offline')):
            with self.assertRaises(ValueError):publication.publish(['2330'],Path(tmp))
            self.assertEqual(list(Path(tmp).iterdir()),[])


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.patch=patch.object(data,'STORE',Path(self.tmp.name));self.patch.start()
        self.result={'symbol':'2330','asOf':'2026-10-30','version':'0.4.0','featureVersion':'test','datasetId':'data0','runId':'run0','source':'test real-like fixture','synthetic':False,
            'config':{'buy_fee':.001425,'sell_fee':.001425,'sell_tax':.003,'slippage_each_side':.001},
            'horizons':[{'days':h,'upProbability':.7,'trainingPrior':.5,'action':'observe','riskReasons':[]} for h in range(1,6)]}

    def tearDown(self):self.patch.stop();self.tmp.cleanup()

    def test_first_forecast_is_immutable_and_old_reconstruction_is_not_live(self):
        now=datetime(2026,10,30,17,tzinfo=data.TZ)
        ledger.record(self.result,now)
        self.result['horizons'][0]['upProbability']=.99;ledger.record(self.result,now)
        r=ledger.report('2330')
        self.assertEqual(len(r['records']),5)
        self.assertEqual(next(f for f in r['records'] if f['horizon']==1)['probability'],.7)
        self.result['asOf']='2026-10-29';ledger.record(self.result,now)
        r=ledger.report('2330');self.assertEqual(r['historicalExcluded'],5)
        self.assertEqual(r['byHorizon'][0]['issued'],1)

    def test_future_is_not_settled_and_completed_outcome_cannot_be_rewritten(self):
        ledger.record(self.result,datetime(2026,10,30,17,tzinfo=data.TZ))
        days=pd.to_datetime(['2026-10-30','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06'])
        df=pd.DataFrame({'date':days,'open':[100.]*6,'close':[100.,110.,111.,112.,113.,114.]})
        context={'market':[{'date':str(d.date())} for d in days],'events':[]}
        ledger.reconcile('2330',df,context,'future-data',datetime(2026,11,1,17,tzinfo=data.TZ))
        self.assertEqual(ledger.report('2330')['byHorizon'][0]['settled'],0)
        ledger.reconcile('2330',df,context,'observed-data',datetime(2026,11,2,17,tzinfo=data.TZ))
        r=ledger.report('2330');self.assertEqual(r['byHorizon'][0]['settled'],1);self.assertEqual(r['byHorizon'][1]['settled'],0)
        f=next(f for f in r['records'] if f['horizon']==1)
        self.assertAlmostEqual(f['outcome']['grossReturn'],.1)
        self.assertLess(f['outcome']['netReturn'],.1)
        df.loc[1,'close']=50
        ledger.reconcile('2330',df,context,'revised-data',datetime(2026,11,2,18,tzinfo=data.TZ))
        f=next(f for f in ledger.report('2330')['records'] if f['horizon']==1)
        self.assertEqual(f['outcome']['outcomeDatasetId'],'observed-data')
        self.assertEqual(f['outcome']['exitClose'],110.)


if __name__=='__main__':unittest.main()
