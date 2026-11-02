// Compatibility entry point for start scripts.
const {server}=require('./companion');
const port=Number(process.env.PORT||5177);
server.listen(port,'127.0.0.1',()=>console.log('http://localhost:'+port));
