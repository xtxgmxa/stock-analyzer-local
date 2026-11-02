/* Pure presentation helpers, shared by browser and Node regression tests. */
(function(root){
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value.toLocaleString('zh-TW',{maximumFractionDigits:2}):'未提供';
 function parse(text){
  const clean=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const j=JSON.parse(clean);return j&&typeof j==='object'&&!Array.isArray(j)?j:null}catch(e){return null}
 }
 function cards(text){
  const j=parse(text);
  if(!j)return `<div style="white-space:pre-wrap;line-height:1.9">${escape(text)}</div>`;
  const prices=[['可留意的價格區間',Array.isArray(j.entry)&&j.entry.length===2?j.entry.map(number).join(' ～ '):'未提供'],['風險觀察價',number(j.stop)],['目標參考價',number(j.target)],['減碼參考價',number(j.trim)]];
  const risks=Array.isArray(j.risks)?j.risks.filter(r=>typeof r==='string'):[];
  return `<h3 style="margin:8px 0">目前判斷：${escape(typeof j.action==='string'?j.action:'請檢視以下說明')}</h3><p style="white-space:pre-wrap">${escape(typeof j.summary==='string'?j.summary:'AI 未提供摘要，請搭配資料來源與風險說明閱讀。')}</p><div class="g">${prices.map(([label,value])=>`<div class="k"><b>${escape(value)}</b><span>${label}</span></div>`).join('')}</div><h3>需要留意的風險</h3>${risks.length?`<ul>${risks.map(r=>`<li>${escape(r)}</li>`).join('')}</ul>`:'<p>AI 未列出風險；不代表沒有風險。</p>'}<p class="note">以上是 AI 對既有資料的解讀，價格僅供研究參考；未提供的價格不會自行補造。</p>`;
 }
 const api={parse,cards};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ReadableAI=api;
})(typeof window!=='undefined'?window:globalThis);
