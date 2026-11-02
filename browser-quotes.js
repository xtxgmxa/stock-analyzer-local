/* Browser-safe real EOD data. Fixed endpoint, no credentials, no synthetic fallback. */
(function(root){
 const API='https://api.finmindtrade.com/api/v4/data';
 const cache=new Map();
 function normalizedSymbol(value){
  const symbol=String(value).trim().toUpperCase().replace(/\.(TW|TWO)$/,'');
  if(!/^\d{4,6}$/.test(symbol))throw new Error('請輸入 4～6 位台股代號，例如 2330 或 2317');
  return symbol;
 }
 function dates(now=new Date()){
  const taipei=new Date(now.getTime()+8*3600000),today=taipei.toISOString().slice(0,10);
  if(taipei.getUTCHours()<16)taipei.setUTCDate(taipei.getUTCDate()-1);
  const end=taipei.toISOString().slice(0,10),start=new Date(taipei.getTime()-400*86400000).toISOString().slice(0,10);
  return {today,end,start};
 }
 function validateResponse(json,value,now=new Date()){
  const symbol=normalizedSymbol(value),range=dates(now);
  if(json.status!==200||!Array.isArray(json.data))throw new Error('行情來源暫時無法提供資料：'+String(json.msg||'請稍後再試'));
  const seen=new Set(),bars=[];
  for(const row of json.data){
   if(String(row.stock_id)!==symbol)throw new Error('來源回傳的股票代號不一致，停止分析');
   const day=String(row.date);
   if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new Error('日期格式不正確，停止分析');
   if(day>range.today)throw new Error('來源含未來行情，停止分析');
   if(day>range.end)continue; // today's unfinished daily candle is never used.
   if(seen.has(day))throw new Error('行情日期重複，停止分析');seen.add(day);
   if([0,6].includes(new Date(day).getUTCDay()))throw new Error('行情含非交易週末，停止分析');
   const values=[row.open,row.max,row.min,row.close,row.Trading_Volume];
   if(values.some(x=>typeof x!=='number'||!Number.isFinite(x)))throw new Error('行情價格或成交量缺值，停止分析');
   const [o,h,l,c,v]=values;
   if(Math.min(o,h,l,c)<=0||v<0||h<Math.max(o,c,l)||l>Math.min(o,c,h))throw new Error('行情高低價或成交量不合理，停止分析');
   bars.push({d:day,o,h,l,c,v});
  }
  bars.sort((a,b)=>a.d.localeCompare(b.d));
  if(bars.length<61)throw new Error('找不到足夠行情，請確認代號；至少需要 61 個有效交易日');
  if((Date.parse(range.end)-Date.parse(bars.at(-1).d))/86400000>7)throw new Error('最新行情超過 7 天，請核對停牌或資料來源');
  if(bars.at(-1).v===0)throw new Error('最新行情沒有成交量，暫停技術分析');
  if(bars.some((r,i)=>i&&Math.abs(r.c/bars[i-1].c-1)>.35))throw new Error('期間出現疑似拆股或大幅跳動，需完整事件核對後才能分析');
  return {symbol,bars,asOf:bars.at(-1).d,source:'FinMind TaiwanStockPrice (exchange daily data aggregator)',
   kind:'external-eod',readAt:now.toISOString(),analysisMode:'technical_only',startDate:bars[0].d};
 }
 function sameBars(published,fresh){
  if(published?.symbol!==fresh.symbol||published.asOf!==fresh.asOf||published.analysis?.synthetic)return false;
  const a=published.bars,b=fresh.bars;
  if(!Array.isArray(a)||a.length<61||!Array.isArray(b)||b.length<a.length)return false;
  const tail=b.slice(-a.length);
  return a.every((r,i)=>r.d===tail[i].d&&['o','h','l','c','v'].every(k=>typeof r[k]==='number'&&r[k]===tail[i][k]));
 }
 async function load(value,{fetcher=root.fetch.bind(root),now=new Date(),signal}={}){
  const symbol=normalizedSymbol(value),range=dates(now),key=symbol+'|'+range.end;
  if(signal?.aborted)throw new Error('讀取已取消');
  const old=cache.get(key);
  if(old&&Date.now()-old.saved<60000)return JSON.parse(JSON.stringify(old.quote));
  const controller=new AbortController(),abort=()=>controller.abort();
  if(signal?.aborted)throw new Error('讀取已取消');
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,20000);
  try{
   const url=API+'?'+new URLSearchParams({dataset:'TaiwanStockPrice',data_id:symbol,start_date:range.start,end_date:range.end});
   const response=await fetcher(url,{mode:'cors',credentials:'omit',cache:'no-store',signal:controller.signal});
   if(!response.ok)throw new Error([402,429].includes(response.status)?'行情來源用量暫時受限，請稍後再試':'無法讀取行情來源，請稍後再試');
   const quote=validateResponse(await response.json(),symbol,now);
   cache.set(key,{saved:Date.now(),quote});
   return JSON.parse(JSON.stringify(quote));
  }catch(e){if(controller.signal.aborted)throw new Error('行情讀取已取消或逾時，請重新查詢');throw e}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
 }
 const api={load,validateResponse,normalizedSymbol,dates,sameBars};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BrowserQuotes=api;
})(typeof window!=='undefined'?window:globalThis);
