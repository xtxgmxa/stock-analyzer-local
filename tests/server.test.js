const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
process.env.PORT='5188';
const {server}=require('../companion');
before(()=>new Promise(resolve=>server.listen(5188,'127.0.0.1',resolve)));
after(()=>new Promise(resolve=>server.close(resolve)));
const root='http://127.0.0.1:5188';
test('serves page and JS with the correct content types',async()=>{
 const r=await fetch(root);assert.equal(r.status,200);assert.match(await r.text(),/researchRun/);
 const js=await fetch(root+'/research-ui.js');assert.match(js.headers.get('content-type'),/javascript/);
});
test('rejects other origins and host rebinding',async()=>{
 assert.equal((await fetch(root+'/api/status',{headers:{Origin:'https://evil.example'}})).status,403);
 const code=await new Promise((resolve,reject)=>{require('http').get(root+'/api/status',{headers:{Host:'evil.example:5188'}},r=>{r.resume();resolve(r.statusCode)}).on('error',reject)});
 assert.equal(code,403);
});
test('allows same-origin preflight and rejects non-JSON mutation',async()=>{
 const r=await fetch(root+'/api/research',{method:'OPTIONS',headers:{Origin:root}});
 assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),root);
 assert.equal((await fetch(root+'/api/ai',{method:'POST',body:'{}'})).status,415);
});
test('does not serve local account config, database, source or traversal',async()=>{
 for(const p of ['/config.json','/data/research.sqlite','/companion.js','/%2e%2e/config.json'])assert.equal((await fetch(root+p)).status,404);
});
test('validates symbols and AI provider/model input before execution',async()=>{
 assert.equal((await fetch(root+'/api/quote?symbol=2330%26whoami')).status,400);
 assert.equal((await fetch(root+'/api/quote?symbol=2330&provider=demo')).status,400);
 const r=await fetch(root+'/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'codex',model:'x&whoami',prompt:'test'})});
 assert.equal(r.status,400);assert.equal((await r.json()).ok,false);
});
