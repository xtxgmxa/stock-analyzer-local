// Refresh only official market data, then publish the public assets branch.
// No local database, credentials, config or source code enters that branch.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const root=__dirname,win=process.platform==='win32',target=path.join(root,'.pages-publish');
function run(cmd,args,cwd=root){const r=spawnSync(cmd,args,{cwd,encoding:'utf8',windowsHide:true,shell:false});if(r.status!==0)throw new Error(r.stderr||r.stdout||'Command failed');return r.stdout.trim()}
run(path.join(root,'.venv',win?'Scripts/python.exe':'bin/python'),['-m','research.publish']);
run(process.execPath,['build-pages.js']);
const remote=run('git',['remote','get-url','origin']);
fs.mkdirSync(target,{recursive:true});
for(const name of ['index.html','research-ui.js','readable-ai.js','.nojekyll'])fs.copyFileSync(path.join(root,'site',name),path.join(target,name));
fs.cpSync(path.join(root,'site','public-quotes'),path.join(target,'public-quotes'),{recursive:true});
if(!fs.existsSync(path.join(target,'.git'))){
 run('git',['init','-b','codex/pages'],target);
 for(const key of ['user.name','user.email'])run('git',['config',key,run('git',['config',key])],target);
 run('git',['remote','add','origin',remote],target);
}
run('git',['add','.'],target);
const changed=spawnSync('git',['diff','--cached','--quiet'],{cwd:target,windowsHide:true}).status;
if(changed===1)run('git',['commit','-m','Publish verified official closing data and web assets'],target);
run('git',['push','-u','origin','codex/pages'],target);
console.log('Published verified real-data web assets to codex/pages.');
