"""Append-only prospective predictions and one-time, provenance-tagged settlements.

Historical OOS predictions are NEVER inserted as live forecasts. The first
forecast per symbol/date/horizon/model version is retained across reruns.
"""
import hashlib
import json
import math
from datetime import datetime

from .data import TZ, connect


def ensure(db):
    db.execute('CREATE TABLE IF NOT EXISTS forecasts (id TEXT PRIMARY KEY, symbol TEXT, as_of TEXT, horizon INTEGER, model TEXT, issued_at TEXT, eligibility TEXT, payload TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS outcomes (forecast_id TEXT PRIMARY KEY, settled_at TEXT, payload TEXT)')


def record(result,now=None):
    if result.get('synthetic'):return
    now=now or datetime.now(TZ)
    eligible='live' if result['asOf']==str(now.date()) and now.hour>=16 else 'historical_only'
    with connect() as db:
        ensure(db)
        for h in result['horizons']:
            key=f"{result['symbol']}|{result['asOf']}|{h['days']}|{result['version']}|{result['featureVersion']}"
            identifier=hashlib.sha256(key.encode()).hexdigest()
            item={'id':identifier,'symbol':result['symbol'],'asOf':result['asOf'],'horizon':h['days'],
                'modelVersion':result['version'],'featureVersion':result['featureVersion'],'datasetId':result['datasetId'],
                'runId':result['runId'],'issuedAt':now.isoformat(),'eligibility':eligible,
                'probability':h['upProbability'],'priorProbability':h.get('trainingPrior'),
                'action':h['action'],'riskReasons':h['riskReasons'],'costConfig':result['config'],
                'expectedNetReturn':h.get('expectedNetReturn'), 'source':result['source']}
            db.execute('INSERT OR IGNORE INTO forecasts VALUES (?,?,?,?,?,?,?,?)',
                (identifier,result['symbol'],result['asOf'],h['days'],result['version'],now.isoformat(),eligible,json.dumps(item,allow_nan=False)))


def reconcile(symbol,df,context,dataset_id,now=None):
    now=now or datetime.now(TZ)
    market=sorted(r['date'] for r in context['market'])
    by_date={str(r.date.date()):r for r in df.itertuples()}
    with connect() as db:
        ensure(db)
        rows=db.execute('SELECT f.id,f.payload FROM forecasts f LEFT JOIN outcomes o ON f.id=o.forecast_id WHERE f.symbol=? AND f.eligibility=? AND o.forecast_id IS NULL', (symbol,'live')).fetchall()
        for identifier,payload in rows:
            f=json.loads(payload)
            future=[d for d in market if d>f['asOf']]
            if len(future)<f['horizon']:continue
            entry,exit=future[0],future[f['horizon']-1]
            if exit>str(now.date()) or (exit==str(now.date()) and now.hour<16):continue
            if entry not in by_date or exit not in by_date:continue
            ratio=1.
            for e in context.get('events',[]):
                if e.get('type')=='split' and entry<e['date']<=exit:ratio*=e['shareRatio']
            gross=by_date[exit].close*ratio/by_date[entry].open-1
            c=f['costConfig'];buy=c['buy_fee']+c['slippage_each_side'];sell=c['sell_fee']+c['sell_tax']+c['slippage_each_side']
            net=(1+gross)*(1-sell)/(1+buy)-1
            label=int(gross>0)
            outcome={'entryDate':entry,'exitDate':exit,'entryOpen':by_date[entry].open,'exitClose':by_date[exit].close,
                'grossReturn':gross,'netReturn':net,'label':label,'directionCorrect':int((f['probability']>=.5)==bool(label)),
                'brier':(f['probability']-label)**2,'priorBrier':(f['priorProbability']-label)**2 if f.get('priorProbability') is not None else None,
                'outcomeDatasetId':dataset_id,'settledAt':now.isoformat(),
                'definition':'fixed horizon next open to close; split-share adjusted; cash dividends excluded; not ATR-stop strategy'}
            db.execute('INSERT OR IGNORE INTO outcomes VALUES (?,?,?)',(identifier,now.isoformat(),json.dumps(outcome,allow_nan=False)))


def wilson(success,n):
    if not n:return None
    z=1.95996398454;p=success/n;d=1+z*z/n
    mid=(p+z*z/(2*n))/d;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [max(0.,mid-half),min(1.,mid+half)]


def report(symbol=None,model='0.4.0'):
    with connect() as db:
        ensure(db)
        query='SELECT f.payload,o.payload FROM forecasts f LEFT JOIN outcomes o ON f.id=o.forecast_id WHERE f.model=?'
        args=[model]
        if symbol:query+=' AND f.symbol=?';args.append(symbol)
        rows=db.execute(query+' ORDER BY f.issued_at DESC,f.horizon',args).fetchall()
    items=[]
    for raw,outcome in rows:
        f=json.loads(raw);f['outcome']=json.loads(outcome) if outcome else None
        f['status']='historical_only' if f['eligibility']!='live' else 'settled' if outcome else 'pending'
        items.append(f)
    groups=[]
    for h in range(1,6):
        group=[f for f in items if f['horizon']==h and f['eligibility']=='live']
        settled=[f for f in group if f['outcome']]
        outcomes=[f['outcome'] for f in settled];n=len(outcomes);hits=sum(o['directionCorrect'] for o in outcomes)
        groups.append({'days':h,'issued':len(group),'pending':len(group)-n,'settled':n,
            'accuracy':hits/n if n else None,'accuracy95':wilson(hits,n),
            'brier':sum(o['brier'] for o in outcomes)/n if n else None,
            'averageNetReturn':sum(o['netReturn'] for o in outcomes)/n if n else None,
            'actualUpFrequency':sum(o['label'] for o in outcomes)/n if n else None,
            'averageForecastProbability':sum(f['probability'] for f in settled)/n if n else None})
    return {'modelVersion':model,'symbol':symbol,'byHorizon':groups,'records':items[:100],
        'historicalExcluded':sum(f['eligibility']!='live' for f in items),
        'note':'只有訊號當日收盤後保存的預測計入前瞻成績，不回填歷史。對帳採固定日數持有並包含觀察訊號，非實際操作績效。多日樣本可能重疊，區間僅為描述性參考。'}
