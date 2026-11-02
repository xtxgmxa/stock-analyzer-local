// Loopback companion for GitHub Pages and local UI. No account tokens leave this process.
const http=require('http'),fs=require('fs'),path=require('path');
const {spawn,spawnSync}=require('child_process');
const ROOT=__dirname,WIN=process.platform==='win32',PORT=Number(process.env.PORT||5177);
let cfg={codex:{cmd:'codex',args:['exec','--skip-git-repo-check','--sandbox','read-only','-'],stdin:true,modelFlag:'-m'},cursor:{cmd:'cursor-agent',args:['-p'],stdin:false,modelFlag:'--model'},timeoutSec:180,allowedOrigins:[]};
try{cfg={...cfg,...JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'))}}catch(e){if(e.code!=='ENOENT')throw e}
const origins=new Set([`http://localhost:${PORT}`,`http://127.0.0.1:${PORT}`,...cfg.allowedOrigins]);
const PYTHON=process.env.STOCK_PYTHON||path.join(ROOT,'.venv',WIN?'Scripts/python.exe':'bin/python');
const send=(res,code,obj,type='application/json')=>{res.writeHead(code,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(type==='application/json'?JSON.stringify(obj):obj)};
function child(cmd,args,input='',timeout=180000){return new Promise(resolve=>{
 let output='',error='',done=false,timer;
 const p=spawn(cmd,args,{cwd:ROOT,shell:false,windowsHide:true,env:process.env});
 const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value)}};
 timer=setTimeout(()=>{p.kill();finish({code:-1,error:'執行逾時；請檢查來源連線或 CLI 登入'})},timeout);
 p.on('error',e=>finish({code:-1,error:e.message}));
 p.stdout.on('data',d=>{output+=d;if(output.length>15e6){p.kill();finish({code:-1,error:'輸出過大'})}});
 p.stderr.on('data',d=>{error=(error+d).slice(-4000)});
 p.on('close',code=>finish({code,output,error}));p.stdin.on('error',()=>{});p.stdin.end(input);
})}
// Resolve npm shims without passing prompts through a shell.
function command(cmd){
 const found=spawnSync(WIN?'where.exe':'which',[cmd],{windowsHide:true,encoding:'utf8',timeout:4000});
 if(found.status!==0)return null;
 const paths=found.stdout.trim().split(/\r?\n/),exe=paths.find(p=>/\.exe$/i.test(p));
 if(exe)return {cmd:exe,prefix:[]};
 const shim=paths.find(p=>/\.cmd$/i.test(p));
 if(shim){const b=fs.readFileSync(shim,'utf8'),m=b.match(/%dp0%\\([^"\r\n]+\.(?:js|cjs|mjs))/i)||b.match(/%~dp0\\([^"\r\n]+\.(?:js|cjs|mjs))/i);
  if(m){const script=path.resolve(path.dirname(shim),m[1]);if(fs.existsSync(script))return {cmd:process.execPath,prefix:[script]}}return null}
 return {cmd:paths[0],prefix:[]};
}
async function auth(provider){
 const rcmd=command(cfg[provider].cmd);
 if(!rcmd)return {installed:false,authenticated:false,state:'unavailable',message:'CLI 未安裝或啟動格式不支援'};
 const r=await child(rcmd.cmd,[...rcmd.prefix,...(provider==='codex'?['login','status']:['status'])],'',10000);
 const text=(r.output||'')+' '+(r.error||'');
 const confirmed=r.code===0&&/logged in|authenticated|已登入/i.test(text)&&!/not logged|unauthenticated|not authenticated/i.test(text);
 return {installed:true,authenticated:confirmed,state:confirmed?'authenticated':r.code===0?'unknown':'not_authenticated',message:confirmed?'CLI 已確認登入':r.code===0?'已安裝，登入狀態未能確認':'請先於終端機登入'};
}
async function ai(j){
 if(!['codex','cursor'].includes(j.provider))throw new Error('未知的提供者');
 const c=cfg[j.provider],model=j.model||'',prompt=String(j.prompt||'');
 if(!/^[a-zA-Z0-9._:/-]{0,100}$/.test(model)||prompt.length>60000)throw new Error('模型名稱或提示長度不合法');
 const status=await auth(j.provider);if(!status.authenticated)throw new Error(status.message);
 const rcmd=command(c.cmd),args=[...rcmd.prefix,...c.args];
 if(model&&c.modelFlag)args.splice(c.stdin?args.length-1:args.length,0,c.modelFlag,model);
 if(!c.stdin)args.push(prompt);
 const r=await child(rcmd.cmd,args,c.stdin?prompt:'',cfg.timeoutSec*1000);
 return r.code===0&&r.output.trim()?{ok:true,text:r.output.trim()}:{ok:false,error:(r.error||'CLI 沒有回覆').slice(-800)};
}
let researchBusy=false,aiBusy=false;
async function research(j){
 if(researchBusy)throw new Error('研究工作執行中，請稍後再試');
 if(!fs.existsSync(PYTHON))throw new Error('請先執行 setup.bat 安裝研究環境');
 researchBusy=true;
 try{const r=await child(PYTHON,['-m','research.cli'],JSON.stringify(j),600000);
  try{return JSON.parse(r.output)}catch(e){throw new Error(r.error||'研究核心沒有回傳有效結果')}
 }finally{researchBusy=false}
}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',d=>{b+=d;if(b.length>2e6){reject(new Error('請求過大'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(b))}catch(e){reject(new Error('JSON 格式不正確'))}});req.on('error',reject)})}
const server=http.createServer(async(req,res)=>{
 try{
  if(![`localhost:${PORT}`,`127.0.0.1:${PORT}`].includes(req.headers.host||''))return send(res,403,{error:'Host not allowed'});
  const origin=req.headers.origin;
  if(origin&&!origins.has(origin))return send(res,403,{error:'請在 config.json.allowedOrigins 設定自己的 GitHub Pages 網域，或開啟本機網頁'});
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Private-Network','true')}
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.writeHead(204);return res.end()}
  const u=new URL(req.url,'http://localhost');
  const assets={'/':'index.html','/index.html':'index.html','/research-ui.js':'research-ui.js','/readable-ai.js':'readable-ai.js'};
  if(assets[u.pathname]&&req.method==='GET')return send(res,200,fs.readFileSync(path.join(ROOT,assets[u.pathname]),'utf8'),u.pathname.endsWith('.js')?'application/javascript':'text/html');
  const publicFeed=u.pathname.match(/^\/public-quotes\/(2330|2317|2454|1216|validation-summary)\.json$/);
  if(publicFeed&&req.method==='GET'){
   const file=path.join(ROOT,'public-quotes',publicFeed[1]+'.json');
   if(!fs.existsSync(file))return send(res,404,{error:'尚無已發布資料'});
   return send(res,200,JSON.parse(fs.readFileSync(file,'utf8')));
  }
  if(u.pathname==='/api/status'&&req.method==='GET'){
   const [codex,cursor]=await Promise.all([auth('codex'),auth('cursor')]);
   return send(res,200,{codex:codex.installed,cursor:cursor.installed,accounts:{codex,cursor},research:fs.existsSync(PYTHON),version:'0.4.0'});
  }
  if(u.pathname==='/api/quote'&&req.method==='GET'){
   const s=(u.searchParams.get('symbol')||'').toUpperCase();if(!/^\d{4,6}(?:\.TW|\.TWO)?$/.test(s))return send(res,400,{error:'僅接受台股代號'});
   const provider=u.searchParams.get('provider')||'twse';
   if(!['twse','yahoo'].includes(provider))return send(res,400,{error:'請選擇真實行情來源'});
   const r=await research({action:'quote',symbol:s,provider});return send(res,r.ok?200:422,r.ok?r.result:r);
  }
  if(u.pathname==='/api/research'&&req.method==='POST'){
   if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{error:'Use application/json'});
   const r=await research(await body(req));return send(res,r.ok?200:422,r);
  }
  if(u.pathname==='/api/ai'&&req.method==='POST'){
   if(!req.headers['content-type']?.startsWith('application/json'))return send(res,415,{ok:false,error:'Use application/json'});
   if(aiBusy)return send(res,409,{ok:false,error:'AI 工作執行中'});
   const j=await body(req);aiBusy=true;try{return send(res,200,await ai(j))}finally{aiBusy=false}
  }
  send(res,404,{error:'not found'});
 }catch(e){if(!res.destroyed)send(res,400,{ok:false,error:e.message})}
});
if(require.main===module)server.listen(PORT,'127.0.0.1',()=>console.log('走勢研判台： http://localhost:'+PORT));
module.exports={server,command};
