// Copy only public assets. Account config, data, snapshots and Python never enter Pages.
const fs=require('fs'),path=require('path');
fs.mkdirSync(path.join(__dirname,'site'),{recursive:true});
for(const name of ['index.html','research-ui.js','readable-ai.js','browser-quotes.js'])fs.copyFileSync(path.join(__dirname,name),path.join(__dirname,'site',name));
fs.writeFileSync(path.join(__dirname,'site','.nojekyll'),'');
if(fs.existsSync(path.join(__dirname,'public-quotes')))fs.cpSync(path.join(__dirname,'public-quotes'),path.join(__dirname,'site','public-quotes'),{recursive:true});
