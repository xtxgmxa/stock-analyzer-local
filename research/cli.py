"""JSON over stdin/stdout worker; stdout is reserved for the protocol."""
import json
import sys
from .data import connect, fetch_yahoo, fetch_twse, ingest_csv, save_dataset, load_dataset,records
from .engine import run
from .context import collect_context
from .ledger import report


def dispatch(j):
    action = j.get('action', 'run')
    if action == 'ledger':
        return report(j.get('symbol'))
    if action == 'quote':
        provider = j.get('provider', 'twse')
        if provider not in ['twse', 'yahoo']:
            raise ValueError('僅允許真實網路行情來源')
        df, source = (fetch_twse if provider == 'twse' else fetch_yahoo)(j.get('symbol', '2330'))
        quote={'symbol': j.get('symbol', '2330'), 'source': source, 'asOf': str(df.date.iloc[-1].date()), 'bars': [{'d': str(r.date.date()), 'o': float(r.open), 'h': float(r.high), 'l': float(r.low), 'c': float(r.close), 'v': float(r.volume)} for r in df.itertuples()]}
        if provider=='twse':
            with connect() as db:
                candidates=db.execute('SELECT payload FROM runs ORDER BY created_at DESC LIMIT 30').fetchall()
            for (raw,) in candidates:
                s=json.loads(raw)
                if s['symbol']==quote['symbol'] and s['asOf']==quote['asOf'] and s['version']=='0.4.0' and not s.get('synthetic'):
                    stored=load_dataset(s['datasetId'])
                    if stored['bars']==records(df):
                        from .publish import public_analysis
                        quote['analysis']=public_analysis(s)
                        quote['analysis']['forwardLedger']=report(s['symbol'])
                        break
        return quote
    if action == 'history':
        with connect() as db:
            rows = db.execute('SELECT payload FROM runs ORDER BY created_at DESC').fetchall()
        runs = [json.loads(r[0]) for r in rows]
        return {'runs': [{k: r[k] for k in ['runId','createdAt','datasetId','symbol','asOf']} for r in runs if not r.get('synthetic')][:30]}
    if action == 'snapshot':
        with connect() as db:
            row = db.execute('SELECT payload FROM runs WHERE id=?', (j.get('runId'),)).fetchone()
        if not row: raise ValueError('找不到快照')
        result = json.loads(row[0])
        if result.get('synthetic'):
            raise ValueError('正式介面不提供模擬資料分析')
        return result
    if j.get('datasetId'):
        if 'SYNTHETIC' in load_dataset(j['datasetId'])['source']:
            raise ValueError('正式介面不接受模擬資料')
        return run(j['datasetId'])
    provider = j.get('provider', 'twse')
    symbol = j.get('symbol', '2330')
    if provider == 'csv':
        df, source = ingest_csv(j.get('csv', '')), 'user CSV; unverified provenance; raw OHLCV'
    elif provider == 'yahoo':
        df, source = fetch_yahoo(symbol)
    elif provider == 'twse':
        df, source = fetch_twse(symbol)
    else:
        raise ValueError('未知資料來源')
    context=collect_context(symbol,df) if provider=='twse' else None
    digest = save_dataset(symbol, source, df,metadata={'context':context,'split_events':df.attrs.get('split_events',[])})
    return run(digest)


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        result = dispatch(payload)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=True, allow_nan=False))
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=True))
        sys.exit(1)
