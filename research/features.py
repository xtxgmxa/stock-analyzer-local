"""All predictors use only information available at that day's completed close."""
import numpy as np
import pandas as pd

FEATURE_VERSION = 'daily-ohlcv-v1'


def features(df):
    c, h, l, v = df.close, df.high, df.low, df.volume
    f = pd.DataFrame(index=df.index)
    for n in (1, 3, 5, 10, 20):
        f[f'return_{n}'] = c.pct_change(n)
    for n in (5, 20, 60):
        f[f'ma_gap_{n}'] = c / c.rolling(n).mean() - 1
    f['volatility_20'] = c.pct_change().rolling(20).std()
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = -delta.clip(upper=0).rolling(14).mean()
    f['rsi_14'] = (100 - 100 / (1 + gain / loss.replace(0, np.nan))).where(loss != 0, 100).where((gain + loss) != 0, 50)
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    f['atr_pct'] = tr.rolling(14).mean() / c
    macd = c.ewm(span=12, adjust=False).mean() - c.ewm(span=26, adjust=False).mean()
    f['macd_hist'] = (macd - macd.ewm(span=9, adjust=False).mean()) / c
    f['volume_ratio'] = v / v.rolling(20).mean().replace(0, np.nan)
    f['turnover_20'] = (c*v).rolling(20).mean()
    f['range_position'] = (c-l.rolling(60).min()) / (h.rolling(60).max()-l.rolling(60).min()).replace(0, np.nan)
    f['gap'] = df.open / c.shift() - 1
    return f.replace([np.inf, -np.inf], np.nan)


def targets(df, horizon, cost, events=None):
    # Signal at close t; entry open t+1, exit close t+h. Includes both endpoint costs.
    scale=pd.Series(1.,index=df.index)
    for e in events or []:
        if e.get('type')=='split':scale.loc[df.date.dt.strftime('%Y-%m-%d')>=e['date']]*=e['shareRatio']
    ret = (df.close*scale).shift(-horizon) / (df.open*scale).shift(-1) - 1
    end = df.date.shift(-horizon)
    return pd.DataFrame({'return': ret, 'net_return': (1+ret)*(1-cost)-1,
        'label': ret.where(ret.isna(), (ret > 0).astype(float)), 'end': end})


def rule(f):
    score = (int(f.ma_gap_20 > 0)*2-1) + (int(f.ma_gap_60 > f.ma_gap_20)*2-1) + (int(f.macd_hist > 0)*2-1)
    score += 1 if f.rsi_14 < 30 else -1 if f.rsi_14 > 70 else 0
    return {'score': score, 'trend': 'bull' if f.ma_gap_60 > 0 else 'bear',
            'momentum': 'positive' if f.macd_hist > 0 else 'negative', 'rsi14': float(f.rsi_14),
            'volumeRatio': float(f.volume_ratio), 'volatility20': float(f.volatility_20)}


def gate(f, probability, *, demo=False, stale=False):
    reasons = []
    if demo: reasons.append('示範資料')
    if stale: reasons.append('行情超過 7 個日曆日，請更新或檢查停牌')
    if f.turnover_20 < 20000000: reasons.append('20 日平均成交金額低於 2,000 萬')
    if f.volatility_20 > .04: reasons.append('20 日波動高於 4%')
    if f.volume_ratio == 0: reasons.append('當日無成交量')
    if abs(f.return_1) >= .095: reasons.append('近漲跌停波動，成交假設不可靠')
    if rule(f)['score'] < 1: reasons.append('規則訊號未確認')
    if probability < .6: reasons.append('校正機率未達 60%')
    return reasons


def join_events_asof(bars, events, columns):
    """Extension contract: available_at is actual publication/ingestion time, never period-end.

    Caller supplies timezone-aware decision_at; missing releases remain missing.
    News/filings/LLM outputs must use this join, never join by reporting period.
    """
    left = bars.sort_values('decision_at')
    right = events[['available_at', *columns]].sort_values('available_at')
    return pd.merge_asof(left, right, left_on='decision_at', right_on='available_at', direction='backward')
