"""Purged expanding walk-forward evaluation, with a separate temporal calibration set."""
import contextlib
import hashlib
import importlib.metadata
import io
import json
from datetime import datetime

import numpy as np
from lightgbm import LGBMClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from xgboost import XGBClassifier

from .data import TZ, connect, load_dataset, validate
from .features import FEATURE_VERSION, features, targets, rule, gate

VERSION = '0.3.0'
CONFIG = {'train_min': 252, 'calibration': 100, 'test': 63, 'purge': 5,
          'buy_fee': .001425, 'sell_fee': .001425, 'sell_tax': .003,
          'slippage_each_side': .001, 'threshold': .6, 'max_position': .2,
          'risk_budget': .01, 'seed': 42, 'trees': 80}


def splits(n, config=CONFIG):
    start = config['train_min'] + config['purge'] + config['calibration'] + config['purge']
    while start < n:
        cal_end = start - config['purge']
        cal_start = cal_end - config['calibration']
        train_end = cal_start - config['purge']
        yield np.arange(train_end), np.arange(cal_start, cal_end), np.arange(start, min(start+config['test'], n))
        start += config['test']


def logit(p):
    p = np.clip(p, 1e-6, 1-1e-6)
    return np.log(p/(1-p)).reshape(-1, 1)


class Model:
    def fit(self, x, y, cx, cy):
        self.prior = float(y.mean())
        self.models = []
        if len(np.unique(y)) > 1:
            models = [LGBMClassifier(n_estimators=80, num_leaves=7, max_depth=3, learning_rate=.04,
                       min_child_samples=30, reg_lambda=3, random_state=42, n_jobs=1, verbosity=-1),
                      XGBClassifier(n_estimators=80, max_depth=3, learning_rate=.04, min_child_weight=10,
                       reg_lambda=3, objective='binary:logistic', eval_metric='logloss', random_state=42, n_jobs=1)]
            for model in models:
                with contextlib.redirect_stdout(io.StringIO()):
                    model.fit(x.to_numpy(), y.to_numpy())
                self.models.append(model)
        self.calibrator = None
        self.calibration_status = 'single_class_holdout_uncalibrated'
        if self.models and len(np.unique(cy)) > 1:
            self.calibrator = LogisticRegression(C=1, random_state=42).fit(logit(self.raw(cx).mean(axis=0)), cy)
            self.calibration_status = 'sigmoid_temporal_holdout'
        return self

    def raw(self, x):
        return np.array([m.predict_proba(x.to_numpy())[:, 1] for m in self.models]) if self.models else np.full((2, len(x)), self.prior)

    def predict(self, x):
        p = self.raw(x).mean(axis=0)
        return self.calibrator.predict_proba(logit(p))[:, 1] if self.calibrator is not None else p


def metrics(y, p):
    y, p = np.array(y), np.array(p)
    bins = []
    for lo, hi in zip(np.arange(0, 1, .1), np.arange(.1, 1.1, .1)):
        mask = (p >= lo) & (p < hi if hi < .999 else p <= 1)
        if mask.any():
            bins.append({'low': float(lo), 'n': int(mask.sum()), 'probability': float(p[mask].mean()), 'observed': float(y[mask].mean())})
    return {'n': len(y), 'accuracy': float(((p >= .5) == y).mean()), 'brier': float(brier_score_loss(y, p)),
            'logLoss': float(log_loss(y, np.clip(p, 1e-6, 1-1e-6), labels=[0, 1])),
            'auc': float(roc_auc_score(y, p)) if len(np.unique(y)) > 1 else None,
            'reliability': bins}


def strategy(df, f, predictions, horizon, probability_key='probability'):
    """One position at a time, mark to market daily, ATR stop with opening-gap fills.

    Price-return stock model: no dividends, no shorting, no limit-order fill guarantee.
    Costs charged on actual filled turnover; horizon equals max holding trading days.
    """
    cash, shares, position_end, stop = 1., 0., -1, 0.
    last_equity, peak, maxdd, trades = 1., 1., 0., []
    by_entry = {p['index']+1: p for p in predictions}
    first, end = predictions[0]['index']+1, min(len(df)-1, predictions[-1]['index']+horizon)
    curve, entry_equity = [], None
    buy_cost = CONFIG['buy_fee'] + CONFIG['slippage_each_side']
    sell_cost = CONFIG['sell_fee'] + CONFIG['sell_tax'] + CONFIG['slippage_each_side']
    entry_info = None
    for i in range(first, end+1):
        bar = df.iloc[i]
        if shares == 0 and i in by_entry:
            p = by_entry[i]
            signal = f.iloc[i-1]
            if not gate(signal, p[probability_key]):
                distance = max(2*float(signal.atr_pct)*float(df.close.iloc[i-1]), .005*float(bar.open))
                weight = min(CONFIG['max_position'], CONFIG['risk_budget']/(distance/float(bar.open)))
                entry_equity = cash
                shares = cash*weight/(float(bar.open)*(1+buy_cost))
                cash -= shares*float(bar.open)*(1+buy_cost)
                stop = max(.01, float(bar.open)-distance)
                position_end = i+horizon-1
                entry_info = {'signal': str(df.date.iloc[i-1].date()), 'entry': str(bar.date.date()), 'entryPrice': float(bar.open), 'weight': weight}
        if shares > 0:
            exit_price = None
            reason = 'horizon'
            if bar.open <= stop:
                exit_price, reason = float(bar.open), 'gap_stop'
            elif bar.low <= stop:
                exit_price, reason = stop, 'atr_stop'
            elif i >= position_end or i == end:
                exit_price = float(bar.close)
            if exit_price is not None:
                cash += shares*exit_price*(1-sell_cost)
                shares = 0.
                trades.append({**entry_info, 'exit': str(bar.date.date()), 'exitPrice': exit_price, 'reason': reason, 'portfolioReturn': cash/entry_equity-1})
        equity = cash+shares*float(bar.close)
        peak = max(peak, equity)
        maxdd = min(maxdd, equity/peak-1)
        curve.append({'date': str(bar.date.date()), 'equity': equity, 'dailyReturn': equity/last_equity-1})
        last_equity = equity
    return {'trades': len(trades), 'winRate': float(np.mean([t['portfolioReturn'] > 0 for t in trades])) if trades else None,
            'totalReturn': last_equity-1, 'maxDrawdown': maxdd, 'equity': curve, 'fills': trades,
            'assumptions': 'long only; non-overlap; next open; ATR stop; 20% max position; daily close MTM; stock tax default; no dividend; price-limit fills not guaranteed'}


def run(dataset_id):
    dataset = load_dataset(dataset_id)
    df = validate(dataset['bars'])
    f_all = features(df)
    valid = f_all.notna().all(axis=1)
    f = f_all.loc[valid].reset_index(drop=True)
    df = df.loc[valid].reset_index(drop=True)
    if len(f) < 500:
        raise ValueError('特徵暖機後有效交易日不足 500；零量或缺值過多')
    # Missing daily bars must not be compressed into fake multi-day horizons.
    if not valid.iloc[59:].all():
        raise ValueError('暖機後特徵缺值；請檢查零量或資料異常，不可直接刪除交易日')
    demo = 'SYNTHETIC' in dataset['source']
    stale = (datetime.now(TZ).date() - df.date.iloc[-1].date()).days > 7
    horizons = []
    cost = 1-(1-CONFIG['sell_fee']-CONFIG['sell_tax']-CONFIG['slippage_each_side'])/(1+CONFIG['buy_fee']+CONFIG['slippage_each_side'])
    for h in range(1, 6):
        target = targets(df, h, cost)
        n = len(df)-h
        predictions, audits = [], []
        for train, cal, test in splits(n):
            # Label outcome must be known strictly before the next segment's decision day.
            assert target.end.iloc[train].max() < df.date.iloc[cal[0]]
            assert target.end.iloc[cal].max() < df.date.iloc[test[0]]
            m = Model().fit(f.iloc[train], target.label.iloc[train], f.iloc[cal], target.label.iloc[cal])
            raw = m.raw(f.iloc[test])
            prob = m.predict(f.iloc[test])
            audits.append({'trainStart': str(df.date.iloc[train[0]].date()), 'trainEnd': str(df.date.iloc[train[-1]].date()),
                'trainLabelEnd': str(target.end.iloc[train].max().date()), 'calibrationStart': str(df.date.iloc[cal[0]].date()),
                'calibrationEnd': str(df.date.iloc[cal[-1]].date()), 'calibrationLabelEnd': str(target.end.iloc[cal].max().date()),
                'testStart': str(df.date.iloc[test[0]].date()), 'testEnd': str(df.date.iloc[test[-1]].date()), 'calibration': m.calibration_status})
            for k, i in enumerate(test):
                predictions.append({'index': int(i), 'date': str(df.date.iloc[i].date()), 'probability': float(prob[k]),
                    'lightgbm': float(raw[0,k]), 'xgboost': float(raw[1,k]), 'rawEnsemble': float(raw[:,k].mean()),
                    'prior': m.prior, 'label': int(target.label.iloc[i]), 'return': float(target['return'].iloc[i]),
                    'netReturn': float(target.net_return.iloc[i]), 'ruleScore': rule(f.iloc[i])['score']})
        if not predictions:
            raise ValueError('Walk-forward 無有效測試區間')
        # Latest fit uses all labels already observable by latest completed close,
        # with same independent calibration boundary and a fresh final prediction.
        cal_end = n
        cal_start = cal_end-CONFIG['calibration']
        train_end = cal_start-CONFIG['purge']
        latest = Model().fit(f.iloc[:train_end], target.label.iloc[:train_end], f.iloc[cal_start:cal_end], target.label.iloc[cal_start:cal_end])
        p = float(latest.predict(f.iloc[[-1]])[0])
        reasons = gate(f.iloc[-1], p, demo=demo, stale=stale)
        if latest.calibrator is None:
            reasons.append('校正樣本只有單一類別，暫停訊號')
        y = [r['label'] for r in predictions]
        evaluation = {key: metrics(y, [r[key] for r in predictions]) for key in ['probability','lightgbm','xgboost','rawEnsemble','prior']}
        evaluation['ruleAccuracy'] = float(np.mean([(r['ruleScore'] >= 1) == bool(r['label']) for r in predictions]))
        # This evidence gate applies only to the latest forecast. Never use the
        # full future OOS score to alter historical strategy signals.
        if evaluation['probability']['brier'] >= evaluation['prior']['brier']:
            reasons.append('樣本外機率未優於歷史上漲率基準')
        horizons.append({'days': h, 'upProbability': p, 'calibration': latest.calibration_status, 'action': 'observe' if reasons else 'candidate',
            'riskReasons': reasons, 'evaluation': evaluation, 'folds': audits, 'oos': predictions,
            'strategy': strategy(df, f, predictions, h),
            'ruleStrategy': strategy(df, f, [{**p, 'probability': 1. if p['ruleScore'] >= 1 else 0.} for p in predictions], h)})
    last = f.iloc[-1]
    px = float(df.close.iloc[-1])
    atr = float(last.atr_pct)*px
    result = {'version': VERSION, 'featureVersion': FEATURE_VERSION, 'createdAt': datetime.now(TZ).isoformat(),
        'symbol': dataset['symbol'], 'datasetId': dataset_id, 'source': dataset['source'], 'retrievedAt': dataset['retrievedAt'],
        'asOf': str(df.date.iloc[-1].date()), 'synthetic': demo, 'stale': stale, 'config': CONFIG,
        'recentBars': [{'d': str(r.date.date()), 'c': float(r.close), 'o': float(r.open), 'h': float(r.high), 'l': float(r.low), 'v': float(r.volume)} for r in df.tail(180).itertuples()],
        'probabilityDefinition': 'P(close[t+h] > open[t+1]); gross price direction, not probability of profit after costs/stops',
        'rows': len(df), 'rule': rule(last), 'features': {k: float(v) for k,v in last.items()},
        'risk': {'atr14': atr, 'referenceStop': max(.01, px-2*atr), 'maxPosition': min(.2, .01/max(2*atr/px, .005)),
                 'riskBudget': .01, 'note': '參考停損於進場開盤價重算；跳空、漲跌停可能使損失超過風險預算'},
        'horizons': horizons, 'extensions': {'news': 'not_connected', 'filings': 'not_connected', 'llm': 'interpretation_only'},
        'warnings': ['僅 OHLCV 多訊號，尚未含法人、基本面與市場指數', '歷史資料為事後取得，尚無供應商 point-in-time 修訂庫',
                     '單一個股研究，不代表全市場績效；不含下市股票母體', '未還原除權息，非總報酬；拆股大跳動拒絕輸入',
                     '交易成本是可審核預設假設，ETF 稅率與券商折扣需另設', '校正不保證有效，請比較 OOS Brier 與 prior baseline',
                     '停牌／假日缺列尚未以官方交易日曆補核；策略未模擬無法成交的漲跌停', '研究用途，不保證預判準確率']}
    result['packages'] = {p: importlib.metadata.version(p) for p in ['pandas','numpy','scikit-learn','lightgbm','xgboost']}
    payload = json.dumps(result, sort_keys=True, allow_nan=False)
    run_id = hashlib.sha256(payload.encode()).hexdigest()
    result['runId'] = run_id
    with connect() as db:
        db.execute('INSERT INTO runs VALUES (?,?,?,?)', (run_id, result['createdAt'], dataset_id, json.dumps(result, allow_nan=False)))
    return result
