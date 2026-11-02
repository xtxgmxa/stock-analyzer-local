const {test}=require('node:test');
const assert=require('node:assert/strict');
const {build}=require('../external-prompt');
function input(){return {last:{sym:'00985A',rk:1.5,data:[{d:'2026-11-02',o:20,h:21,l:19,c:19.8,v:123456}],r:{px:19.8,m20:20,m60:21,R:40,A:.5,hist:-.1,sc:-2,act:'減碼',why:['短線轉弱','你目前有獲利而趨勢轉弱，可考慮分批獲利了結'],entry:[19,20],stop:18,target:22,tgt:22,trim:23,proj:Array(20).fill({m:20,u:22,l:18}),lo:19,hi:24}},source:'FinMind',name:'主動野村台灣50',now:new Date('2026-11-02T12:00:00Z')}}
function payload(text){return JSON.parse(text.split('## 六、本站當次資料與結論（JSON，null表示未提供）\n')[1].split('\n\n## 七、行情附錄')[0])}
test('portable brief includes actual symbol, definitions, source and news verification contract',()=>{
 const text=build({...input(),cost:20.85,conclusion:'當次摘要'}),p=payload(text);
 assert.equal(p.symbol,'00985A');assert.equal(p.name,'主動野村台灣50');assert.equal(p.personal.holdingCost,20.85);
 assert.equal(p.technical.close,19.8);assert.equal(p.model,null);assert.equal(p.displayedSummary,'當次摘要');
 for(const definition of ['不是 Wilder','並非使用最高','未經覆蓋率校正','未進行即時新聞','首次公告時間','同一通稿','model=null','settled=0','ETF須另核對'])assert.ok(text.includes(definition),definition);
 assert.match(text,/2026-11-02,20,21,19,19.8,123456/);
});
test('missing cost and OHLCV stay absent and personalized technical comments are removed',()=>{
 const i=input();i.last.data=[{d:'2026-11-02',c:19.8}];const text=build(i),p=payload(text);
 assert.equal(p.personal,null);assert.equal(p.displayedSummary,null);assert.equal(p.technical.reasons.length,1);
 assert.match(text,/2026-11-02,null,null,null,19.8,null/);
 assert.doesNotMatch(text,/你目前有獲利/);
});
test('a different symbol or historical date never exports unrelated model probabilities',()=>{
 for(const snapshot of [{symbol:'2330',asOf:'2026-11-02'},{symbol:'00985A',asOf:'2026-10-30'}])assert.equal(payload(build({...input(),snapshot})).model,null);
});
test('model brief carries validation evidence without entire OOS or trades',()=>{
 const snapshot={symbol:'00985A',asOf:'2026-11-02',version:'v0.4',horizons:[{days:1,upProbability:.55,evaluation:{probability:{brier:.24,n:100}},strategy:{totalReturn:.01,maxDrawdown:-.02,trades:['private internal trace']},oos:['large trace']}],forwardLedger:{byHorizon:[{settled:0,pending:1}],note:'尚未到期'}};
 const text=build({...input(),snapshot}),p=payload(text);
 assert.equal(p.model.horizons[0].upProbability,.55);assert.equal(p.model.forwardLedger.byHorizon[0].settled,0);
 assert.doesNotMatch(text,/large trace|private internal trace/);
 assert.throws(()=>build({last:null}),/請先載入/);
});
