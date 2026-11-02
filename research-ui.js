/* Uses the existing UI; model results are kept separate from heuristic prices. */
let snapshot=null;
let dataGeneration=0,quoteBusy=false;
function sourceLabel(source){return source.startsWith('TWSE')?'臺灣證券交易所（官方日 K）':source.startsWith('Yahoo')?'Yahoo Finance（非官方日 K）':'自行匯入 CSV（來源需自行核對）'}
function clearAnalysis(message){
 snapshot=null;$('snapshotDownload').disabled=true;$('researchResult').replaceChildren();
 $('out').textContent='';$('aiCards').textContent=message;
 noData(message);$('dataState').textContent=message;
}
function showDataState(){
 if(!last)return;
 const bar=last.data[last.data.length-1];
 $('dataState').innerHTML=`<b>${esc(last.sym)}｜最新已載入收盤價 ${Number(bar.c).toLocaleString('zh-TW')} 元</b><p style="margin:4px 0">資料日期：${esc(bar.d)} 收盤｜來源：${esc(sourceLabel(srcName))}</p><span class="sub">這是收盤後的日 K，不是盤中即時價格。所有圖表與分析均使用這份已載入資料。</span>`;
 $('aiCards').textContent='真實行情已載入。按「產生 AI 判讀」即可閱讀中文摘要與風險。';
}
async function loadRealQuote(publicOnly=false){
 if(quoteBusy)return;
 const symbol=$('sym').value.trim().toUpperCase(),provider=$('researchProvider').value;
 const generation=++dataGeneration;
 clearAnalysis('正在從外部網路取得真實行情，完成前暫停分析…');
 if(!/^\d{4,6}(?:\.TW|\.TWO)?$/.test(symbol)){clearAnalysis('請輸入有效的台股代號');return}
 if(provider==='csv'){clearAnalysis('已選擇 CSV。請匯入你確認來源的真實資料後再分析。');return}
 quoteBusy=true;$('go').disabled=true;$('live').disabled=true;$('researchRun').disabled=true;
 try{
  const published=publicOnly||!srv;
  if(published&&provider!=='twse')throw new Error('這個來源需要本機服務。公開網站目前提供 2330 官方日 K');
  const response=published?await fetch('./public-quotes/'+encodeURIComponent(symbol)+'.json',{cache:'no-store'}):await apiFetch('/api/quote?symbol='+encodeURIComponent(symbol)+'&provider='+provider);
  if(!response.ok)throw new Error(published?'公開行情尚未提供這支股票，請啟動本機服務讀取官方資料':'行情來源暫時無法讀取');
  const j=await response.json();
  if(!response.ok||!j.bars||j.bars.length<61)throw new Error(j.error||'有效交易日不足');
  if(generation!==dataGeneration)return;
  if(j.symbol!==symbol||!j.source||!j.asOf||(published&&j.kind!=='official-eod'))throw new Error('資料來源或代號無法確認');
  const age=(Date.now()-Date.parse(j.asOf+'T16:00:00+08:00'))/86400000;
  if(age>7)throw new Error('最新行情已超過 7 天，請核對停牌或來源更新');
  custom=j.bars;custom.symbol=symbol;srcName=j.source;run();showDataState();
 }catch(e){if(generation===dataGeneration)clearAnalysis('行情未取得，已停止分析：'+e.message)}
 finally{quoteBusy=false;$('go').disabled=false;$('live').disabled=false;$('researchRun').disabled=false}
}
const pct=x=>x==null?'—':(x*100).toFixed(1)+'%';
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function researchApi(payload){const r=await apiFetch('/api/research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'研究失敗');return j.result}
function showSnapshot(s){
 if(s.synthetic)throw new Error('正式介面不使用模擬資料');
 snapshot=s;$('snapshotDownload').disabled=false;
 if(s.recentBars){custom=s.recentBars;custom.symbol=s.symbol;srcName=s.source;$('sym').value=s.symbol;run();showDataState()}
 const format=x=>Number(x).toFixed(3);
 $('researchResult').innerHTML=`<p><b>${esc(s.symbol)}｜截至 ${esc(s.asOf)}｜${s.synthetic?'示範資料（非真實行情）':'歷史行情研究'}</b></p><p class="sub">${esc(s.source)}<br>方向定義：次日開盤 → 第 h 日收盤，未扣成本。機率校正不保證有效。</p>
 <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr><th>交易日</th><th>上漲機率</th><th>狀態</th><th>OOS 筆數</th><th>校正 Brier↓</th><th>原始 Brier↓</th><th>基準 Brier↓</th><th>策略報酬</th><th>最大回撤</th></tr></thead><tbody>${s.horizons.map(h=>`<tr><td>${h.days} 日</td><td>${pct(h.upProbability)}</td><td>${h.action==='candidate'?'候選':'觀察'}</td><td>${h.evaluation.probability.n}</td><td>${format(h.evaluation.probability.brier)}</td><td>${format(h.evaluation.rawEnsemble.brier)}</td><td>${format(h.evaluation.prior.brier)}</td><td>${pct(h.strategy.totalReturn)}</td><td>${pct(h.strategy.maxDrawdown)}</td></tr>`).join('')}</tbody></table></div>
 <p>規則分數 ${s.rule.score}｜ATR14 ${format(s.risk.atr14)}｜參考停損 ${format(s.risk.referenceStop)}｜倉位上限 ${pct(s.risk.maxPosition)}</p>
 <p class="note">${s.horizons.map(h=>`${h.days} 日：${h.riskReasons.length?h.riskReasons.map(esc).join('、'):'符合預設條件，仍須人工檢視'}`).join('<br>')}</p>
 <details><summary>回測方法與限制</summary><p>擴展式 Walk-Forward；252 日起始訓練、100 日校正、63 日測試；兩處均留 5 日間隔。每期重新訓練 LightGBM／XGBoost，等權集成後用獨立時段做 sigmoid 校正。每個持有期獨立回測，不可相加為組合績效。</p><p>策略：次日開盤、單一持倉、不重疊、2 ATR 停損、最多 20% 倉位、1% 風險預算。買賣手續費各 0.1425%、賣出稅 0.3%、單邊滑價 0.1%。每日收盤估值。</p><ul>${s.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>
 <p class="sub">快照 ${esc(s.runId.slice(0,16))}｜資料版本 ${esc(s.datasetId.slice(0,16))}｜模型 ${esc(s.version)}</p>`;
 $('researchStatus').textContent='完成。完整快照含每折時間邊界、樣本外預測、兩模型指標、規則策略與逐日資產曲線。';
}
$('bridge').value=localStorage.getItem('stockBridge')||'http://localhost:5177';
$('connect').onclick=async()=>{
 const base=$('bridge').value.replace(/\/$/,'');
 if(!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)){$('connection').textContent='請使用 http://localhost:連接埠 或 http://127.0.0.1:連接埠';return}
 localStorage.setItem('stockBridge',base);$('connection').textContent='偵測中…';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),6000);
 try{const r=await apiFetch('/api/status',{signal:controller.signal});const s=await r.json();if(!r.ok||!s.accounts)throw new Error(s.error||'不相容的服務');srv=s;$('live').disabled=false;
  $('connection').textContent=`已連線｜研究環境：${s.research?'已就緒':'請執行 setup.bat'}｜Codex：${s.accounts.codex.message}｜Cursor：${s.accounts.cursor.message}`;
  $('st').textContent='使用這台電腦的 CLI 登入狀態。僅安裝桌面 App 不一定已登入 CLI。';
  if(!last&&!quoteBusy)await loadRealQuote();
 }catch(e){srv=null;$('st').textContent='尚未連接自己的 AI 帳號，可先使用內建摘要。';$('connection').textContent='尚未連接本機服務。可以先閱讀網站發布的 2330 官方日 K；自行訓練、其他股票與個人 AI 帳號功能，請先執行 start.bat 再連線。';if(!last&&!quoteBusy)await loadRealQuote(true)}
 finally{clearTimeout(timer)}
};
$('researchRun').onclick=async()=>{
 if(!srv){$('researchStatus').textContent='自行訓練與回測需要本機服務，請先執行 start.bat 並連線。已載入的官方行情仍可閱讀。';return}
 const generation=++dataGeneration;
 clearAnalysis('正在取得並驗證真實資料，再進行模型分析…');
 const button=$('researchRun');button.disabled=true;$('snapshotDownload').disabled=true;$('researchResult').replaceChildren();snapshot=null;
 $('researchStatus').textContent='抓取／驗證資料並執行 1～5 日訓練與 Walk-Forward 回測中…';
 try{const s=await researchApi({provider:$('researchProvider').value,symbol:$('sym').value.trim().toUpperCase(),csv:$('researchCsv').value});if(generation===dataGeneration)showSnapshot(s)}
 catch(e){if(generation===dataGeneration){clearAnalysis('資料驗證或分析失敗：'+e.message);$('researchStatus').textContent='未產生預測：'+e.message}}finally{button.disabled=false}
};
$('snapshotDownload').onclick=()=>{if(!snapshot)return;const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${snapshot.symbol}-${snapshot.asOf}-${snapshot.runId.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('historyLoad').onclick=async()=>{try{const h=await researchApi({action:'history'});$('researchHistory').replaceChildren();for(const r of h.runs){const b=document.createElement('button');b.textContent=`${r.symbol}｜資料 ${r.asOf}｜分析 ${r.createdAt.slice(0,16).replace('T',' ')}`;b.onclick=async()=>{const generation=++dataGeneration;clearAnalysis('正在讀取歷史分析…');try{const s=await researchApi({action:'snapshot',runId:r.runId});if(generation===dataGeneration)showSnapshot(s)}catch(e){clearAnalysis(e.message)}};$('researchHistory').append(b)}if(!h.runs.length)$('researchHistory').textContent='尚無真實資料快照'}catch(e){$('researchStatus').textContent=e.message}};
// Attach an already-generated snapshot to AI interpretation, without asking LLM to invent probabilities.
const legacyPrompt=prompt;
prompt=function(){if(!snapshot)return legacyPrompt();return '你是股票研究助理，只解讀以下資料，不執行工具、不讀檔、不修改電腦。機率是統計模型輸出，勿改寫或保證報酬。指出校正前後 Brier、基準比較與失效風險，不提供保證式買賣指令。以繁體中文回答。資料：'+JSON.stringify({symbol:snapshot.symbol,asOf:snapshot.asOf,source:snapshot.source,synthetic:snapshot.synthetic,rule:snapshot.rule,risk:snapshot.risk,warnings:snapshot.warnings,horizons:snapshot.horizons.map(h=>({days:h.days,probability:h.upProbability,riskReasons:h.riskReasons,calibratedBrier:h.evaluation.probability.brier,rawBrier:h.evaluation.rawEnsemble.brier,priorBrier:h.evaluation.prior.brier}))})};
const snapshotPrompt=prompt;
prompt=function(){return snapshotPrompt()+'\n以下為同一來源實際載入的最近 60 個交易日 OHLCV（d 日期、o 開盤、h 最高、l 最低、c 收盤、v 成交股數；不含新聞或盤中五檔）：'+JSON.stringify(last.data.slice(-60))+'\n請以一般人看得懂的繁體中文，回傳 JSON：{"action":"目前判斷","summary":"白話摘要","entry":null,"stop":null,"target":null,"trim":null,"risks":["主要風險"]}。只能使用輸入中提供的價格，沒有的項目填 null，不得自行估造。'};
$('ai').onclick=async()=>{
 if(!last){$('aiCards').textContent='請先取得真實行情，再進行分析。';return}
 const generation=dataGeneration,provider=$('pv').value;
 $('ai').disabled=true;$('aiCards').textContent=provider==='rule'?'正在整理資料摘要…':'AI 正在閱讀已載入的真實資料…';$('out').textContent='';
 try{
  let text;
  if(provider==='rule'){
   const r=last.r;
   const summary=snapshot?snapshot.horizons.map(h=>`${h.days} 個交易日的上漲機率為 ${pct(h.upProbability)}，${h.action==='observe'?'目前先觀察':'列為研究候選'}。`).join('\n'):`目前收盤價為 ${r.px.toLocaleString('zh-TW')} 元。${r.why.slice(0,2).join('。')}。`;
   text=JSON.stringify({action:snapshot?(snapshot.horizons.some(h=>h.action==='candidate')?'列入觀察名單':'先觀察，等待更明確訊號'):r.act,summary,entry:snapshot?null:r.entry,stop:snapshot?snapshot.risk.referenceStop:r.stop,target:snapshot?null:r.tgt,trim:snapshot?null:r.trim,
    risks:snapshot?[...new Set(snapshot.horizons.flatMap(h=>h.riskReasons))]:['這是技術規則觀察，尚未含新聞、基本面與整體市場變化。','參考價位來自簡單技術規則，不代表保證可成交或獲利。']});
  }else{
   if(!srv)throw new Error('請先連接本機服務，才能使用自己已登入的 AI 帳號');
   const response=await apiFetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,model:$('md').value.trim(),prompt:prompt()})}),j=await response.json();
   if(!response.ok||!j.ok)throw new Error(j.error||'AI 沒有回覆');text=j.text;
  }
  if(generation!==dataGeneration)return;
  const date=last.data[last.data.length-1].d;
  $('aiCards').innerHTML=`<p class="sub">分析對象：${esc(last.sym)}｜資料截至 ${esc(date)} 收盤｜${esc(sourceLabel(srcName))}</p>`+ReadableAI.cards(text);
  $('out').textContent=text;
 }catch(e){if(generation===dataGeneration)$('aiCards').textContent='無法完成判讀：'+e.message}
 finally{$('ai').disabled=!last}
};
$('sym').addEventListener('input',()=>{dataGeneration++;clearAnalysis('股票代號已變更，請先更新這支股票的真實行情。')});
$('researchProvider').addEventListener('change',()=>{dataGeneration++;clearAnalysis('資料來源已變更，請重新取得資料後分析。')});
const importCloseCsv=$('ld').onclick;
$('ld').onclick=()=>{dataGeneration++;clearAnalysis('正在核對匯入資料…');importCloseCsv();if(last)showDataState()};
// Public prices should never wait for an optional localhost connection.
if(!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.origin))loadRealQuote(true);
$('connect').click();
