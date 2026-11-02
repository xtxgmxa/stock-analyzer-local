"""Build a real-data basket, honest control comparisons and prospective ledger.

Each symbol either passes or receives an explicit blocked record. If every
source fails, publishing stops. No personal accounts or local database are published.
"""
import copy
import json
from datetime import datetime
from pathlib import Path

from .data import TZ,fetch_twse,save_dataset
from .context import collect_context
from .engine import run

BASKET=['2330','2317','2454','1216']


def public_analysis(result):
    result=copy.deepcopy(result)
    result['publicSummary']=True
    for h in result['horizons']:
        h.pop('oos',None)
        for key in ['strategy','ruleStrategy']:
            h[key].pop('fills',None);h[key].pop('equity',None)
    return result


def publish(symbols=None,target=None):
    quotes=[];summary=[]
    symbols=symbols or BASKET
    for symbol in symbols:
        print(f'Fetching real data and evaluating {symbol}...',flush=True)
        try:
            df,source=fetch_twse(symbol)
            context=collect_context(symbol,df)
            identifier=save_dataset(symbol,source,df,{'context':context,'split_events':df.attrs.get('split_events',[])})
            result=run(identifier)
        except ValueError as exc:
            reason=str(exc)
            quotes.append({'symbol':symbol,'blocked':True,'error':reason,'kind':'data-quality-blocked'})
            summary.append({'symbol':symbol,'quality':'blocked','error':reason,'horizons':[]})
            print(f'{symbol}: blocked by data quality: {reason}',flush=True)
            continue
        quote={'symbol':symbol,'source':source,'asOf':str(df.date.iloc[-1].date()),
            'publishedAt':datetime.now(TZ).isoformat(),'kind':'official-eod',
            'bars':[{'d':str(r.date.date()),'o':float(r.open),'h':float(r.high),'l':float(r.low),'c':float(r.close),'v':float(r.volume)} for r in df.tail(180).itertuples()],
            'analysis':public_analysis(result)}
        quotes.append(quote)
        summary.append({'symbol':symbol,'asOf':result['asOf'],'runId':result['runId'],'quality':result['quality']['status'],
            'horizons':[{'days':h['days'],'enhancedBrier':h['evaluation']['probability']['brier'],
                'holdout':{k:h['comparison']['holdout'][k] for k in ['start','end','pairedBrierImprovement','blockBootstrap95']},
                'baselineHoldoutBrier':h['comparison']['holdout']['ohlcvBaseline']['brier'],
                'enhancedHoldoutBrier':h['comparison']['holdout']['probability']['brier'],
                'action':h['action'],'expectedNetReturn':h['expectedNetReturn']} for h in result['horizons']]})
        print(f'{symbol}: quality checked; forecasts saved; as of {quote["asOf"]}',flush=True)
    if not any(not q.get('blocked') for q in quotes):raise ValueError('全部股票來源失敗，不發布替代資料')
    target=Path(target) if target else Path(__file__).resolve().parents[1]/'public-quotes';target.mkdir(exist_ok=True)
    # One bad instrument cannot silently receive another instrument's or fabricated data.
    for quote in quotes:
        if quote.get('analysis'):
            quote['analysis']['validationBasket']=[{'symbol':r['symbol'],'status':r['quality'],'reason':r.get('error')} for r in summary]
        (target/f'{quote["symbol"]}.json').write_text(json.dumps(quote,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    report={'version':'0.4.0','generatedAt':datetime.now(TZ).isoformat(),'symbols':symbols,'results':summary,
        'note':'固定四檔驗證籃子，未含下市母體；資料缺少的股票明確隔離，不產生預測。新增訊號是否改善由同日期 Brier 及區間顯示，不保證提高準確率。前瞻成績另行計算，不回填歷史。'}
    (target/'validation-summary.json').write_text(json.dumps(report,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    return report


if __name__=='__main__':publish()
