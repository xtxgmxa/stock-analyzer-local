"""Versioned real-world context; institutional predictors are lagged one session.

TWSE index history is also the realized market-session calendar. FinMind is
explicitly attributed as an aggregator; raw responses are retained in SQLite.
"""
import hashlib
import json
import re
import time
from fractions import Fraction
from datetime import datetime
from urllib.parse import urlencode

import numpy as np
import pandas as pd

from .data import TZ, connect, request_json, validate_symbol


def cached_json(url, ttl=86400):
    now = datetime.now(TZ)
    with connect() as db:
        old = db.execute('SELECT payload,retrieved_at FROM raw_sources WHERE url=? ORDER BY retrieved_at DESC LIMIT 1', (url,)).fetchone()
    if old and (now-datetime.fromisoformat(old[1])).total_seconds() < ttl:
        return json.loads(old[0])
    raw = request_json(url)
    encoded = json.dumps(raw, sort_keys=True, ensure_ascii=True)
    digest = hashlib.sha256((url+encoded).encode()).hexdigest()
    with connect() as db:
        db.execute('INSERT OR IGNORE INTO raw_sources VALUES (?,?,?,?)', (digest,url,now.isoformat(),encoded))
    return raw


def roc_date(value):
    numbers = list(map(int,re.findall(r'\d+',value)))
    if len(numbers)!=3:
        raise ValueError('官方日期格式變更，停止解析')
    y,m,d=numbers
    return f'{y+1911 if y<1911 else y:04d}-{m:02d}-{d:02d}'


def finmind(dataset,symbol,start,end):
    params={'dataset':dataset,'data_id':symbol.removesuffix('.TW').removesuffix('.TWO'), 'start_date':start,'end_date':end}
    raw=cached_json('https://api.finmindtrade.com/api/v4/data?'+urlencode(params),ttl=6*3600)
    if raw.get('status')!=200:
        raise ValueError(f'FinMind {dataset} 無法取得：{raw.get("msg","來源未回傳成功")}; 不補造資料')
    return raw.get('data',[])


def market_history(start,end):
    first=pd.Timestamp(start);last=pd.Timestamp(end)
    rows=[]
    for total in range(first.year*12+first.month-1,last.year*12+last.month):
        y,m=total//12,total%12+1
        url=f'https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date={y:04d}{m:02d}01'
        raw=cached_json(url,6*3600 if (y,m)==(last.year,last.month) else 7*86400)
        if raw.get('stat')!='OK':
            raise ValueError('TWSE 大盤／交易日曆不完整，停止新版分析')
        if raw.get('fields',[])[:1]!=['日期']:
            raise ValueError('TWSE 指數欄位格式變更')
        for r in raw.get('data',[]):
            day=roc_date(r[0])
            if start<=day<=end:
                rows.append({'date':day,'close':float(r[4].replace(',',''))})
    df=pd.DataFrame(rows).sort_values('date').reset_index(drop=True)
    if df.empty or df.date.duplicated().any() or not np.isfinite(df.close).all() or (df.close<=0).any():
        raise ValueError('官方大盤資料無效或重複')
    return rows


def corporate_actions(symbol,start,end):
    ticker=validate_symbol(symbol).removesuffix('.TW')
    events=[]
    for y in range(int(start[:4]),int(end[:4])+1):
        a=max(start,f'{y}-01-01');b=min(end,f'{y}-12-31')
        url='https://www.twse.com.tw/rwd/zh/exRight/TWT49U?'+urlencode({'response':'json','startDate':a.replace('-',''),'endDate':b.replace('-','')})
        raw=cached_json(url,6*3600 if y==int(end[:4]) else 30*86400)
        if raw.get('stat')!='OK':
            raise ValueError('官方除權息查核資料缺少，停止新版分析')
        fields=raw.get('fields',[])
        if '股票代號' not in fields or '除權息參考價' not in fields:
            raise ValueError('官方除權息欄位格式變更')
        for r in raw.get('data',[]):
            if str(r[fields.index('股票代號')]).strip()!=ticker:continue
            day=roc_date(r[fields.index('資料日期')])
            if not start<=day<=end:continue
            before=float(r[fields.index('除權息前收盤價')].replace(',',''))
            after=float(r[fields.index('除權息參考價')].replace(',',''))
            if before<=0 or after<=0:raise ValueError('除權息參考價無效')
            events.append({'date':day,'before':before,'reference':after,'factor':after/before,'type':r[fields.index('權/息')],'source':'TWSE TWT49U'})
    for row in finmind('TaiwanStockSplitPrice',symbol,start,end):
        before=float(row['before_price']);after=float(row['after_price'])
        if before<=0 or after<=0:raise ValueError('拆股參考價無效')
        ratio=float(Fraction(before/after).limit_denominator(100))
        events.append({'date':row['date'],'before':before,'reference':after,'factor':1/ratio,
            'shareRatio':ratio,'type':'split','source':'FinMind TaiwanStockSplitPrice'})
    keys=[(e['date'],e['type']) for e in events]
    if len(keys)!=len(set(keys)):raise ValueError('企業行動資料重複')
    return sorted(events,key=lambda e:e['date'])


def institutional_history(symbol,start,end):
    rows=finmind('TaiwanStockInstitutionalInvestorsBuySell',symbol,start,end)
    if not rows:raise ValueError('法人歷史資料為空，不以零買賣超代替')
    names={'Foreign_Investor':'foreign','Investment_Trust':'trust','Dealer':'dealer','Dealer_self':'dealer','Dealer_Hedging':'dealer','Foreign_Dealer_Self':'foreign_dealer'}
    result={};seen=set()
    for r in rows:
        if r['name'] not in names:raise ValueError('未知法人分類，請核對供應商格式')
        key=(r['date'],r['name'])
        if key in seen:raise ValueError('重複法人交易資料')
        seen.add(key)
        if str(r['stock_id'])!=symbol.removesuffix('.TW').removesuffix('.TWO'):raise ValueError('法人代號不一致')
        buy,sell=float(r['buy']),float(r['sell'])
        if not np.isfinite([buy,sell]).all() or min(buy,sell)<0:raise ValueError('法人交易股數無效')
        item=result.setdefault(r['date'],{'date':r['date'],'foreign':0.,'trust':0.,'dealer':0.,'foreign_dealer':0.,'categories':[]})
        item[names[r['name']]]+=buy-sell;item['categories'].append(r['name'])
    for item in result.values():
        item['complete']=all(n in item['categories'] for n in ['Foreign_Investor','Investment_Trust']) and ('Dealer' in item['categories'] or all(n in item['categories'] for n in ['Dealer_self','Dealer_Hedging']))
    return sorted(result.values(),key=lambda r:r['date'])


def quality_report(df,context):
    dates=df.date.dt.strftime('%Y-%m-%d').tolist();market=[r['date'] for r in context['market']]
    expected=[d for d in market if dates[0]<=d<=dates[-1]]
    missing=sorted(set(expected)-set(dates));unexpected=sorted(set(dates)-set(expected))
    fund_by={r['date']:r for r in context['institutional']}
    fund_missing=[d for d in expected if d not in fund_by or not fund_by[d]['complete']]
    events=context['events'];eventdays={e['date'] for e in events}
    jumps=[dates[i] for i in range(1,len(df)) if abs(float(df.close.iloc[i]/df.close.iloc[i-1]-1))>.12 and dates[i] not in eventdays]
    blockers=[]
    if missing:blockers.append('缺少官方交易日行情，可能停牌或來源遺漏；不壓縮持有日數')
    if unexpected:blockers.append('個股日期不在官方交易日曆')
    if jumps:blockers.append('存在無企業行動解釋的大幅價格跳動')
    return {'status':'blocked' if blockers else 'passed','calendarSource':'TWSE MI_5MINS_HIST realized sessions','expectedSessions':len(expected),
        'missingSessions':missing,'unexpectedSessions':unexpected,'unexplainedJumps':jumps,'corporateActions':events,
        'institutionalCoverage':1-len(fund_missing)/max(1,len(expected)),'institutionalMissingDates':fund_missing,
        'zeroVolumeDates':df.loc[df.volume==0,'date'].dt.strftime('%Y-%m-%d').tolist(),'blockers':blockers,
        'notes':['法人延後一個交易日使用；缺列保留 missing 指標，不當作真實零買賣超',
                 '交易日曆為已實現大盤交易日，尚無個股正式停復牌公告時點庫',
                 '官方已發生除權息用於連續指標；現金股利未計入策略報酬，非總報酬',
                 '資料為事後取得，仍可能有供應商修訂，非完整 point-in-time 修訂庫']}


def collect_context(symbol,df):
    start=str(df.date.iloc[0].date());end=str(df.date.iloc[-1].date())
    context={'version':'tw-context-v1','retrievedAt':datetime.now(TZ).isoformat(),
        'market':market_history(start,end),'events':corporate_actions(symbol,start,end),
        'institutional':institutional_history(symbol,start,end),
        'sources':{'market':'TWSE MI_5MINS_HIST','corporate':'TWSE TWT49U + FinMind TaiwanStockSplitPrice',
                   'institutional':'FinMind TaiwanStockInstitutionalInvestorsBuySell (TWSE/TPEx aggregator)'},'institutionalLagSessions':1}
    context['quality']=quality_report(df,context)
    if context['quality']['blockers']:raise ValueError('；'.join(context['quality']['blockers']))
    return context


def feature_prices(df,events):
    """Forward-only reference-price adjustment: future events cannot alter past features."""
    result=df.copy();scale=pd.Series(1.,index=df.index)
    days=df.date.dt.strftime('%Y-%m-%d')
    for event in events:
        if event['factor']<=0:raise ValueError('企業行動調整因子無效')
        scale.loc[days>=event['date']]/=event['factor']
    for col in ['open','high','low','close']:result[col]=df[col]*scale
    return result


def context_features(df,context):
    days=df.date.dt.strftime('%Y-%m-%d')
    market=pd.DataFrame(context['market']).set_index('date').reindex(days).close
    market.index=df.index
    f=pd.DataFrame(index=df.index)
    for n in [1,5,20]:f[f'market_return_{n}']=market.pct_change(n)
    f['market_ma_gap_60']=market/market.rolling(60).mean()-1
    f['market_volatility_20']=market.pct_change().rolling(20).std()
    f['relative_strength_5']=df.close.pct_change(5)-f.market_return_5
    inst=pd.DataFrame(context['institutional']).set_index('date').reindex(days)
    inst.index=df.index
    for name in ['foreign','trust','dealer']:
        net=inst[name].where(inst.complete.fillna(False)).shift(1)
        denominator=df.volume.shift(1).replace(0,np.nan)
        f[f'{name}_net_ratio_lag1']=(net/denominator).clip(-5,5).fillna(0)
        f[f'{name}_net_ratio_5_lag1']=(net.rolling(5).sum()/denominator.rolling(5).sum()).clip(-5,5).fillna(0)
    usable=inst.complete.fillna(False)&df.volume.gt(0)
    f['institutional_missing_lag1']=usable.shift(1,fill_value=False).eq(False).astype(float)
    f['institutional_window_missing_lag1']=usable.shift(1,fill_value=False).rolling(5,min_periods=1).min().eq(False).astype(float)
    return f
