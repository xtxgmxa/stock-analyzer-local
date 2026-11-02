/* Uses the existing UI; model results are kept separate from heuristic prices. */
let snapshot=null,availablePublished=null;
let dataGeneration=0,quoteBusy=false,quoteController=null,inputTimer=null;
const stockNames=new Map();
function sourceLabel(source){return source.startsWith('TWSE')?'臺灣證券交易所（官方日 K）':source.startsWith('FinMind')?'FinMind（彙整交易所日 K，本次由網頁直接讀取）':source.startsWith('Yahoo')?'Yahoo Finance（非官方日 K）':'自行匯入 CSV（來源需自行核對）'}
function clearAnalysis(message){
 snapshot=null;availablePublished=null;$('snapshotDownload').disabled=true;$('researchResult').replaceChildren();
 $('out').textContent='';$('aiCards').textContent=message;
 noData(message);$('dataState').textContent=message;
 $('stockIdentity').hidden=true;$('stockIdentity').textContent='';
 updateCostState();
 refreshExternalExport();
 $('researchStatus').textContent=message;
}
function showDataState(){
 if(!last)return;
 const bar=last.data[last.data.length-1];
 const identity=$('stockIdentity'),symbol=last.sym,generation=dataGeneration;
 identity.hidden=false;identity.textContent=symbol+'｜正在確認股票名稱…';
 BrowserQuotes.stockName(symbol).then(name=>{
  if(generation===dataGeneration&&last?.sym===symbol){stockNames.set(symbol,name);identity.textContent=(name||'股票名稱暫未提供')+'（'+symbol+'）';if($('promptDetails').open)$('externalPromptText').value=externalBrief()}
 }).catch(()=>{if(generation===dataGeneration&&last?.sym===symbol)identity.textContent=symbol+'｜名稱暫時讀取失敗';});
 $('dataState').innerHTML=`<b>${esc(last.sym)}｜最新已載入收盤價 ${Number(bar.c).toLocaleString('zh-TW')} 元</b><p style="margin:4px 0">資料日期：${esc(bar.d)} 收盤｜來源：${esc(sourceLabel(srcName))}</p><span class="sub">這是收盤後的日 K，不是盤中即時價格。所有圖表與分析均使用這份已載入資料。</span>`;
 $('aiCards').textContent='真實行情已載入。按「產生 AI 判讀」即可閱讀中文摘要與風險。';
 refreshExternalExport();
}
async function loadRealQuote(publicOnly=false){
 clearTimeout(inputTimer);quoteController?.abort();quoteController=new AbortController();
 quoteBusy=false;$('go').disabled=false;$('live').disabled=false;$('researchRun').disabled=false;
 const signal=quoteController.signal;
 const symbol=$('sym').value.trim().toUpperCase(),provider=$('researchProvider').value;
 const generation=++dataGeneration;
 clearAnalysis('正在從外部網路取得真實行情，完成前暫停分析…');
 if(!/^(?:\d{4,6}|\d{4,5}[A-Z])(?:\.TW|\.TWO)?$/.test(symbol)){clearAnalysis('請輸入有效的台股代號');return}
 if(provider==='csv'){clearAnalysis('已選擇 CSV。請匯入你確認來源的真實資料後再分析。');return}
 quoteBusy=true;$('go').disabled=true;$('live').disabled=true;$('researchRun').disabled=true;
 try{
  let j;
  if(provider==='auto'){
   const normalized=BrowserQuotes.normalizedSymbol(symbol);
   // The optional published model is not a substitute for fetching the requested quote.
   const publishedPromise=['2330','2317','2454','1216'].includes(normalized)?fetch('./public-quotes/'+encodeURIComponent(normalized)+'.json',{cache:'no-store',signal}).then(r=>r.ok?r.json():null).catch(()=>null):Promise.resolve(null);
   j=await BrowserQuotes.load(symbol,{signal});
   if(generation!==dataGeneration)return;
   const published=await Promise.race([publishedPromise,new Promise(resolve=>setTimeout(()=>resolve(null),2500))]);
   if(published?.analysis&&BrowserQuotes.sameBars(published,j))j.analysis=published.analysis;
   else{j.publishedAnalysis=published?.analysis;j.researchBlockedDetail=published?.blocked?published.error:null;j.researchUnavailableReason=published?.blocked?'完整四年機率模型因過去缺價暫停；本次僅針對近一年有效行情作技術觀察。':published?.analysis?'本次資料與已發布模型版本不同，不自動套用舊機率。':'這支股票尚未提供經回測校正的 1～5 日機率。'}
   // Keep suffixes usable as display aliases without mixing model identities.
   j.symbol=symbol;
  }else{
   if(publicOnly||!srv)throw new Error('此進階來源需要本機服務。請選「自動讀取外部行情（免安裝）」。');
   const response=await apiFetch('/api/quote?symbol='+encodeURIComponent(symbol)+'&provider='+provider,{signal});
   j=await response.json();if(!response.ok)throw new Error(j.error||'行情來源暫時無法讀取');
  }
  if(!j.bars||j.bars.length<61)throw new Error(j.error||'有效交易日不足');
  if(generation!==dataGeneration)return;
  if(j.symbol!==symbol||!j.source||!j.asOf)throw new Error('資料來源或代號無法確認');
  const age=(Date.now()-Date.parse(j.asOf+'T16:00:00+08:00'))/86400000;
  if(age>7)throw new Error('最新行情已超過 7 天，請核對停牌或來源更新');
  custom=j.bars;custom.symbol=symbol;srcName=j.source;run();showDataState();
  updateCostState();
  if(j.analysis){showSnapshot(j.analysis);$('researchStatus').textContent='本次行情與已發布模型逐筆一致，已顯示完整研究。'}
  else{
   $('researchStatus').textContent='已直接取得近一年真實日 K，完成技術觀察；這不是經校正的機率模型。';
   $('researchResult').innerHTML='<p><b>基本行情分析已就緒（免安裝）</b></p><p>'+esc(j.researchUnavailableReason||'尚無完整機率研究。')+'</p><p class="sub">下方圖表、技術觀察與自動摘要使用本次實際讀取的行情，不補造機率。個人 Codex／Cursor AI 為選用功能。</p>';
   if(j.researchBlockedDetail){const detail=document.createElement('details');detail.innerHTML='<summary>查看完整模型停止原因</summary><p>'+esc(j.researchBlockedDetail)+'</p>';$('researchResult').append(detail)}
   if(j.publishedAnalysis){
    availablePublished=j.publishedAnalysis;const button=document.createElement('button');
    button.textContent='查看已發布模型（歷史資料版本）';
    button.onclick=()=>{if(!availablePublished)return;showSnapshot(availablePublished);if($('pv').value==='rule')$('ai').onclick()};
    $('researchResult').append(button);
   }
  }
  if($('pv').value==='rule'&&last)await $('ai').onclick();
 }catch(e){if(generation===dataGeneration)clearAnalysis('行情未取得，已停止分析：'+e.message)}
 finally{if(generation===dataGeneration){quoteBusy=false;$('go').disabled=false;$('live').disabled=false;$('researchRun').disabled=false}}
}
const pct=x=>x==null?'—':(x*100).toFixed(1)+'%';
const returnPct=x=>x==null?'—':(x*100).toFixed(2)+'%';
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function researchApi(payload){const r=await apiFetch('/api/research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'研究失敗');return j.result}
function readableSnapshot(s){
 const q=s.quality||{},c=s.context||{},inst=c.institutionalUsed,fmt=n=>n==null?'—':Number(n).toLocaleString('zh-TW',{maximumFractionDigits:2});
 const chips=inst?`<p>模型使用 ${esc(inst.date)} 法人資料（延後一個交易日）：外資（不含外資自營商） ${fmt(inst.foreign/1000)} 張、投信 ${fmt(inst.trust/1000)} 張、自營商 ${fmt(inst.dealer/1000)} 張。正數為買超，負數為賣超。</p>`:'<p>未連接法人歷史，不以零買賣超代替缺資料。</p>';
 const cards=s.horizons.map(h=>{const similar=h.similarSignals;return `<div class="box"><b>${h.days===1?'下一交易日':h.days+' 個交易日'}｜上漲機率 ${pct(h.upProbability)}</b><p>${h.action==='candidate'?'列入研究候選，仍須檢視風險':'先觀察，尚未通過全部條件'}</p>${similar?`<p class="sub">過去相近機率訊號 ${similar.n} 筆，實際上漲 ${pct(similar.actualUpFrequency)}；扣成本後平均 ${returnPct(similar.averageNetReturn)}。</p>`:''}<details><summary>${h.action==='candidate'?'檢視風險':'為什麼先觀察？'}</summary><p class="note">${h.riskReasons.map(esc).join('、')}</p></details></div>`}).join('');
 const comparisons=s.horizons.filter(h=>h.comparison).map(h=>{const t=h.comparison.holdout,interval=t.blockBootstrap95,proven=interval[0]>0;return `<tr><td>${h.days} 日</td><td>${t.ohlcvBaseline.brier.toFixed(4)}</td><td>${t.probability.brier.toFixed(4)}</td><td>${proven?'這段測試有改善':t.pairedBrierImprovement>0?'略好，但差異尚不明確':'尚未優於價量基準'}</td></tr>`}).join('');
 const ledger=s.forwardLedger;
 const settled=ledger?ledger.byHorizon.reduce((n,h)=>n+h.settled,0):0;
 const forward=ledger?`<h3>每日預測對帳：真正往後驗證</h3><p>${settled?'已有到期預測，以下為當時保存、事後核對的結果。':'預測已保存，尚無到期樣本。先等未來行情發生，再顯示命中率。'}</p><div style="overflow:auto"><table style="width:100%;text-align:right"><thead><tr><th>期間</th><th>已保存</th><th>等待結果</th><th>已核對</th><th>方向命中率</th><th>扣成本平均報酬</th></tr></thead><tbody>${ledger.byHorizon.map(h=>`<tr><td>${h.days} 日</td><td>${h.issued}</td><td>${h.pending}</td><td>${h.settled}</td><td>${pct(h.accuracy)}</td><td>${returnPct(h.averageNetReturn)}</td></tr>`).join('')}</tbody></table></div><p class="sub">${esc(ledger.note)}</p>`:'<p>這是舊版快照，尚未建立前瞻對帳。請重新分析。</p>';
 const basket=s.validationBasket?`<details><summary>其他股票的資料檢查結果</summary><ul>${s.validationBasket.map(r=>`<li>${esc(r.symbol)}：${r.status==='passed'?'已完成相同流程驗證':esc(r.reason||'資料未通過，停止分析')}</li>`).join('')}</ul></details>`:'';
 return `<h3>資料與訊號檢查</h3><p><b>${q.status==='passed'?'官方交易日與企業行動查核通過':'僅完成基本行情檢查'}</b>｜資料截至 ${esc(s.asOf)} 收盤</p>${q.expectedSessions?`<p>核對 ${q.expectedSessions} 個交易日；缺少 ${(q.missingSessions||[]).length} 日；已核對 ${(q.corporateActions||[]).length} 筆除權息／拆股事件。</p>`:''}<p>${c.connected?`已加入大盤、相對強弱及法人；共 ${c.featureCount} 個訊號。大盤近 5 日漲跌 ${pct(s.features.market_return_5)}。`:'目前只使用個股價量訊號。'}</p>${chips}${c.connected?'<p class="sub">法人來源：FinMind 整理的交易所資料；現金股利未計入策略報酬。</p>':''}${basket}<div class="g">${cards}</div><p class="sub">「上漲機率」是股價方向，不是獲利保證。相近訊號為歷史樣本外統計，可能重疊；與下方真正前瞻成績分開。</p>${comparisons?`<h3>新增訊號有沒有比較準？</h3><p>固定用最後 63 筆歷史測試，和純價量模型比較。分數越小越好；小幅改善未必代表穩定優勢。</p><div style="overflow:auto"><table style="width:100%;text-align:right"><thead><tr><th>期間</th><th>純價量</th><th>加入大盤／法人</th><th>解讀</th></tr></thead><tbody>${comparisons}</tbody></table></div>`:''}${forward}`;
}
function showSnapshot(s){
 if(s.synthetic)throw new Error('正式介面不使用模擬資料');
 $('out').textContent='';
 snapshot=s;$('snapshotDownload').disabled=false;$('snapshotDownload').textContent=s.publicSummary?'下載公開分析摘要':'下載完整快照 JSON';
 if(s.recentBars){custom=s.recentBars;custom.symbol=s.symbol;srcName=s.source;$('sym').value=s.symbol;run();showDataState()}
 const format=x=>Number(x).toFixed(3);
 const technical=`<p><b>${esc(s.symbol)}｜截至 ${esc(s.asOf)}｜歷史行情研究</b></p><p class="sub">${esc(s.source)}<br>方向定義：次日開盤 → 第 h 日收盤，未扣成本。機率校正不保證有效。</p>
 <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;text-align:right"><thead><tr><th>交易日</th><th>上漲機率</th><th>狀態</th><th>OOS 筆數</th><th>校正 Brier↓</th><th>原始 Brier↓</th><th>基準 Brier↓</th><th>策略報酬</th><th>最大回撤</th></tr></thead><tbody>${s.horizons.map(h=>`<tr><td>${h.days} 日</td><td>${pct(h.upProbability)}</td><td>${h.action==='candidate'?'候選':'觀察'}</td><td>${h.evaluation.probability.n}</td><td>${format(h.evaluation.probability.brier)}</td><td>${format(h.evaluation.rawEnsemble.brier)}</td><td>${format(h.evaluation.prior.brier)}</td><td>${pct(h.strategy.totalReturn)}</td><td>${pct(h.strategy.maxDrawdown)}</td></tr>`).join('')}</tbody></table></div>
 <p>規則分數 ${s.rule.score}｜ATR14 ${format(s.risk.atr14)}｜參考停損 ${format(s.risk.referenceStop)}｜倉位上限 ${pct(s.risk.maxPosition)}</p>
 <p class="note">${s.horizons.map(h=>`${h.days} 日：${h.riskReasons.length?h.riskReasons.map(esc).join('、'):'符合預設條件，仍須人工檢視'}`).join('<br>')}</p>
 <details><summary>回測方法與限制</summary><p>擴展式 Walk-Forward；252 日起始訓練、100 日校正、63 日測試；兩處均留 5 日間隔。每期重新訓練 LightGBM／XGBoost，等權集成後用獨立時段做 sigmoid 校正。每個持有期獨立回測，不可相加為組合績效。</p><p>策略：次日開盤、單一持倉、不重疊、2 ATR 停損、最多 20% 倉位、1% 風險預算。買賣手續費各 0.1425%、賣出稅 0.3%、單邊滑價 0.1%。每日收盤估值。</p><ul>${s.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>
 <p class="sub">快照 ${esc(s.runId.slice(0,16))}｜資料版本 ${esc(s.datasetId.slice(0,16))}｜模型 ${esc(s.version)}</p>`;
 $('researchResult').innerHTML=readableSnapshot(s)+'<details><summary>進階：完整回測指標與方法</summary>'+technical+'</details>';
 $('researchStatus').textContent=s.publicSummary?'已顯示已發布模型摘要；請核對資料日期與版本，非盤中即時預測。':'完成。完整快照含每折時間邊界、樣本外預測、兩模型指標、規則策略與逐日資產曲線。';
 refreshExternalExport();
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
 }catch(e){srv=null;$('st').textContent='尚未連接自己的 AI 帳號，可先使用內建摘要。';$('connection').textContent='尚未連接本機服務。可以先閱讀已發布的多檔官方日 K 與模型結果；自行訓練、未發布的股票與個人 AI 帳號功能，請先執行 start.bat 再連線。';if(!last&&!quoteBusy)await loadRealQuote(true)}
 finally{clearTimeout(timer)}
};
$('researchRun').onclick=async()=>{
 if(!srv){$('researchStatus').textContent='自行訓練與回測需要本機服務，請先執行 start.bat 並連線。已載入的真實行情仍可閱讀。';return}
 const generation=++dataGeneration;
 clearAnalysis('正在取得並驗證真實資料，再進行模型分析…');
 const button=$('researchRun');button.disabled=true;$('snapshotDownload').disabled=true;$('researchResult').replaceChildren();snapshot=null;
 $('researchStatus').textContent='抓取／驗證資料並執行 1～5 日訓練與 Walk-Forward 回測中…';
 try{const s=await researchApi({provider:$('researchProvider').value==='auto'?'twse':$('researchProvider').value,symbol:$('sym').value.trim().toUpperCase(),csv:$('researchCsv').value});if(generation===dataGeneration)showSnapshot(s)}
 catch(e){if(generation===dataGeneration){clearAnalysis('資料驗證或分析失敗：'+e.message);$('researchStatus').textContent='未產生預測：'+e.message}}finally{button.disabled=false}
};
$('snapshotDownload').onclick=()=>{if(!snapshot)return;const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${snapshot.symbol}-${snapshot.asOf}-${snapshot.runId.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('historyLoad').onclick=async()=>{if(!srv){$('researchStatus').textContent='個人歷史快照需要選用的本機服務；目前仍可直接查詢行情與基本分析。';return}try{const h=await researchApi({action:'history'});$('researchHistory').replaceChildren();for(const r of h.runs){const b=document.createElement('button');b.textContent=`${r.symbol}｜資料 ${r.asOf}｜分析 ${r.createdAt.slice(0,16).replace('T',' ')}`;b.onclick=async()=>{const generation=++dataGeneration;clearAnalysis('正在讀取歷史分析…');try{const s=await researchApi({action:'snapshot',runId:r.runId});if(generation===dataGeneration)showSnapshot(s)}catch(e){clearAnalysis(e.message)}};$('researchHistory').append(b)}if(!h.runs.length)$('researchHistory').textContent='尚無真實資料快照'}catch(e){$('researchStatus').textContent=e.message}};
// Attach an already-generated snapshot to AI interpretation, without asking LLM to invent probabilities.
const legacyPrompt=prompt;
prompt=function(){if(!snapshot)return legacyPrompt();return '你是股票研究助理，只解讀以下資料，不執行工具、不讀檔、不修改電腦。機率是統計模型輸出，勿改寫或保證報酬。指出校正前後 Brier、基準比較與失效風險，不提供保證式買賣指令。以繁體中文回答。資料：'+JSON.stringify({symbol:snapshot.symbol,asOf:snapshot.asOf,source:snapshot.source,synthetic:snapshot.synthetic,rule:snapshot.rule,risk:snapshot.risk,warnings:snapshot.warnings,horizons:snapshot.horizons.map(h=>({days:h.days,probability:h.upProbability,riskReasons:h.riskReasons,calibratedBrier:h.evaluation.probability.brier,rawBrier:h.evaluation.rawEnsemble.brier,priorBrier:h.evaluation.prior.brier}))})};
const snapshotPrompt=prompt;
prompt=function(){return snapshotPrompt()+'\n大盤／法人與歷史相近訊號（無資料即 null，不得自行補造）：'+JSON.stringify(snapshot?{context:snapshot.context,similar:snapshot.horizons.map(h=>({days:h.days,similar:h.similarSignals})),forward:snapshot.forwardLedger?.byHorizon}:null)+'\n以下為同一來源實際載入的最近 60 個交易日 OHLCV（d 日期、o 開盤、h 最高、l 最低、c 收盤、v 成交股數；不含新聞或盤中五檔）：'+JSON.stringify(last.data.slice(-60))+'\n請以一般人看得懂的繁體中文，回傳 JSON：{"action":"目前判斷","summary":"白話摘要","entry":null,"stop":null,"target":null,"trim":null,"risks":["主要風險"]}。只能使用輸入中提供的價格，沒有的項目填 null，不得自行估造。'};
const priceContextPrompt=prompt;
prompt=function(){return priceContextPrompt()+'\n使用者持有成本（非行情，不得當成最新報價）：'+JSON.stringify(validCost()?{cost:Number($('cost').value),unrealizedReturnBeforeFees:last.r.px/Number($('cost').value)-1}:null)};
$('ai').onclick=async()=>{
 if(!last){$('aiCards').textContent='請先取得真實行情，再進行分析。';return}
 const generation=dataGeneration,provider=$('pv').value;
 $('ai').disabled=true;$('aiCards').textContent=provider==='rule'?'正在整理資料摘要…':'AI 正在閱讀已載入的真實資料…';$('out').textContent='';
 try{
  let text;
  if(provider==='rule'){
   const r=last.r;
   const summary=(snapshot?snapshot.horizons.map(h=>`${h.days} 個交易日的上漲機率為 ${pct(h.upProbability)}，${h.action==='observe'?'目前先觀察':'列為研究候選'}。`).join('\n'):`目前收盤價為 ${r.px.toLocaleString('zh-TW')} 元。${r.why.slice(0,2).join('。')}。`)+(validCost()?`\n持有成本 ${Number($('cost').value).toLocaleString('zh-TW')} 元，相對已載入收盤價的未扣費用損益為 ${((r.px/Number($('cost').value)-1)*100).toFixed(2)}%。`:'');
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
  if($('promptDetails').open)$('externalPromptText').value=externalBrief();
 }catch(e){if(generation===dataGeneration)$('aiCards').textContent='無法完成判讀：'+e.message}
 finally{$('ai').disabled=!last}
};
function invalidateQuote(message){
 clearTimeout(inputTimer);quoteController?.abort();dataGeneration++;quoteBusy=false;
 $('go').disabled=false;$('live').disabled=false;$('researchRun').disabled=false;clearAnalysis(message);
}
function validCost(){return $('cost').value!==''&&$('cost').validity.valid&&Number.isFinite(Number($('cost').value))&&Number($('cost').value)>0}
function externalBrief(){
 return ExternalPrompt.build({last,snapshot,source:srcName,name:stockNames.get(last?.sym)||null,
  cost:$('includePromptCost').checked&&validCost()?Number($('cost').value):null,
  conclusion:$('includePromptCost').checked||!validCost()?$('out').textContent:null});
}
function refreshExternalExport(){
 for(const id of ['cp','promptPreview','promptDownload'])$(id).disabled=!last;
 $('cp').textContent='複製完整 AI 分析提示詞';
 $('externalPromptText').value=last&&$('promptDetails').open?externalBrief():'';
 $('promptStatus').textContent=last?'已可匯出本次結果。複製後貼給外部 AI；它需要自行上網核對新聞。':'請先取得真實行情，才能匯出本次分析。';
}
function previewExternalBrief(){
 if(!last)return;
 $('externalPromptText').value=externalBrief();$('promptDetails').open=true;
 $('promptStatus').textContent='已產生完整提示詞，可在下方全選／長按複製，或下載文字檔。';
}
$('promptPreview').onclick=previewExternalBrief;
$('promptDetails').addEventListener('toggle',()=>{if($('promptDetails').open&&last)$('externalPromptText').value=externalBrief()});
$('includePromptCost').addEventListener('change',refreshExternalExport);
$('cp').onclick=async()=>{
 if(!last)return;
 const generation=dataGeneration,text=externalBrief();$('externalPromptText').value=text;
 try{
  if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');
  await navigator.clipboard.writeText(text);
  if(generation!==dataGeneration)return;
  $('cp').textContent='已複製完整內容';$('promptStatus').textContent=`已複製約 ${text.length.toLocaleString('zh-TW')} 字元。切換到外部 AI 貼上，選擇網路搜尋模式後送出。`;
 }catch(e){if(generation===dataGeneration){previewExternalBrief();$('promptStatus').textContent='此瀏覽器未允許自動複製。請長按／全選下方完整內容複製，或按「下載提示詞文字檔」。'}}
};
$('promptDownload').onclick=()=>{
 if(!last)return;
 const text=externalBrief(),url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download=`${last.sym}-${last.data.at(-1).d}-AI分析提示詞.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 $('promptStatus').textContent='已準備提示詞文字檔。可用其他 AI 開啟或上傳；手機也可先預覽並長按複製。';
};
function updateCostState(){
 const field=$('cost'),state=$('costState');
 if(field.validity.badInput||(field.value!==''&&!validCost())){state.textContent='持有成本請輸入大於 0 的有效價格，可含小數，例如 20.85；無效價格不納入損益。';return}
 if(!field.value){state.textContent='持有成本可輸入小數；填入後自動更新成本損益。它不會取代真實收盤價。';return}
 state.textContent=last?`已按成本 ${Number(field.value).toLocaleString('zh-TW')} 元更新：相對收盤價 ${last.r.px.toLocaleString('zh-TW')} 元，未扣費用損益 ${((last.r.px/Number(field.value)-1)*100).toFixed(2)}%。`:'成本已填入，請先取得此股票的真實行情；單一價格不足以判斷趨勢。';
}
function refreshPersonalInputs(){
 if(last){dataGeneration++;run();showDataState();if($('pv').value==='rule')$('ai').onclick();else{$('aiCards').textContent='成本或風險設定已更新，請重新產生個人 AI 判讀。';$('out').textContent=''}}
 updateCostState();
}
$('cost').addEventListener('input',refreshPersonalInputs);
$('rk').onchange=refreshPersonalInputs;
$('sym').addEventListener('input',()=>{invalidateQuote('代號已變更，輸入完成後將自動讀取真實行情…');if(/^(?:\d{4,6}|\d{4,5}[A-Z])(?:\.TW|\.TWO)?$/.test($('sym').value.trim().toUpperCase())&&$('researchProvider').value==='auto')inputTimer=setTimeout(()=>loadRealQuote(),1100)});
$('researchProvider').addEventListener('change',()=>{invalidateQuote('資料來源已變更，請重新取得資料後分析。');if($('researchProvider').value==='auto')loadRealQuote()});
const importCloseCsv=$('ld').onclick;
$('ld').onclick=()=>{dataGeneration++;clearAnalysis('正在核對匯入資料…');importCloseCsv();if(last)showDataState()};
// Phones never probe localhost automatically or need a local-network permission prompt.
if(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.origin))$('connect').click();
else{srv=null;$('connection').textContent='選用功能：只有使用個人 CLI 帳號或重新訓練時，才需要連接本機服務。';$('st').textContent='目前使用免登入的內建分析；外部 AI 帳號為選用功能。';loadRealQuote(true)}
