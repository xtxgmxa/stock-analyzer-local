const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizedSymbol,dates,validateResponse,sameBars,load}=require('../browser-quotes');
const now=new Date('2026-11-02T10:00:00Z');
function response(symbol='2317'){
 const data=[];let day=new Date('2026-11-02T00:00:00Z');
 while(data.length<90){if(![0,6].includes(day.getUTCDay()))data.unshift({date:day.toISOString().slice(0,10),stock_id:symbol,open:100,max:105,min:99,close:102,Trading_Volume:1000000});day=new Date(day.getTime()-86400000)}
 return {status:200,data};
}
test('mobile lookup preserves leading zeros and limits requests to stock IDs',()=>{
 assert.equal(normalizedSymbol('0050.TW'),'0050');assert.equal(normalizedSymbol('6488.TWO'),'6488');
 assert.equal(normalizedSymbol('00985a.tw'),'00985A');assert.equal(normalizedSymbol('00632R'),'00632R');
 for(const s of ['2330&token=bad','https://example.com','abc','23'])assert.throws(()=>normalizedSymbol(s));
});
test('Taipei close cutoff never includes an unfinished daily candle',()=>{
 const before=new Date('2026-11-02T06:00:00Z');assert.equal(dates(before).end,'2026-11-01');
 const q=validateResponse(response(),'2317',before);assert.equal(q.asOf,'2026-10-30');
 assert.equal(validateResponse(response(),'2317',now).asOf,'2026-11-02');
});
test('network response is mapped from actual OHLCV without manufactured bars',()=>{
 assert.equal(validateResponse(response('00985A'),'00985A',now).symbol,'00985A');
 const q=validateResponse(response(),'2317',now);
 assert.equal(q.symbol,'2317');assert.equal(q.bars.length,90);assert.deepEqual(q.bars.at(-1),{d:'2026-11-02',o:100,h:105,l:99,c:102,v:1000000});
 assert.equal(q.analysisMode,'technical_only');assert.equal(q.analysis,undefined);
});
test('rejects wrong symbols, duplicates, invalid prices and impossible dates',()=>{
 const variants=[];
 let r=response();r.data[0].stock_id='2330';variants.push(r);
 r=response();r.data.push({...r.data[0]});variants.push(r);
 r=response();r.data[0].max=1;variants.push(r);
 r=response();r.data[0].close=null;variants.push(r);
 r=response();r.data[0].date='2026-02-30';variants.push(r);
 r=response();r.data[0].date='2026-11-03';variants.push(r);
 for(const r of variants)assert.throws(()=>validateResponse(r,'2317',now));
});
test('rejects stale, missing, halted and unexplained split-like data',()=>{
 assert.throws(()=>validateResponse({status:200,data:[]},'2317',now));
 assert.throws(()=>validateResponse(response(),'2317',new Date('2026-12-01T10:00:00Z')));
 let r=response();r.data.at(-1).Trading_Volume=0;assert.throws(()=>validateResponse(r,'2317',now));
 r=response();r.data.at(-1).open=200;r.data.at(-1).max=205;r.data.at(-1).min=199;r.data.at(-1).close=202;assert.throws(()=>validateResponse(r,'2317',now));
});
test('published probabilities require exact dates and OHLCV equality',()=>{
 const q=validateResponse(response(),'2317',now);
 const published={symbol:'2317',asOf:q.asOf,bars:q.bars.slice(-61),analysis:{synthetic:false}};
 assert.equal(sameBars(published,q),true);
 const altered=JSON.parse(JSON.stringify(published));altered.bars[0].v+=1;assert.equal(sameBars(altered,q),false);
 assert.equal(sameBars({...published,asOf:'2026-10-30'},q),false);
 assert.equal(sameBars({...published,analysis:{synthetic:true}},q),false);
});
test('direct request uses a fixed HTTPS endpoint and no account credentials',async()=>{
 let called=0;
 const q=await load('2454',{now,fetcher:async(url,options)=>{
  called++;assert.equal(new URL(url).origin,'https://api.finmindtrade.com');assert.equal(new URL(url).searchParams.get('data_id'),'2454');
  assert.equal(options.credentials,'omit');assert.equal(options.mode,'cors');
  return {ok:true,json:async()=>response('2454')};
 }});
 assert.equal(called,1);assert.equal(q.symbol,'2454');
 await load('2454',{now,fetcher:()=>{throw new Error('cache should avoid redundant quota use')}});
});
test('quota and cancelled requests fail without synthetic or previous-symbol output',async()=>{
 await assert.rejects(load('1216',{now,fetcher:async()=>({ok:false,status:429})}),/用量/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(load('0050',{now,signal:controller.signal,fetcher:()=>{throw new Error('must not fetch')}}),/取消/);
});
