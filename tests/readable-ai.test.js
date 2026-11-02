const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const {parse,cards}=require('../readable-ai');
test('JSON responses become Chinese cards with numbers and risks',()=>{
 const h=cards(JSON.stringify({action:'觀望',summary:'等待訊號',entry:[2300,2310],stop:2250,target:null,risks:['波動偏高']}));
 assert.match(h,/目前判斷：觀望/);assert.match(h,/2,300/);assert.match(h,/波動偏高/);assert.match(h,/未提供/);
 assert.doesNotMatch(h,/"action"/);
});
test('fenced JSON is supported and all model content is escaped',()=>{
 assert.equal(parse('```json\n{"action":"觀望"}\n```').action,'觀望');
 assert.doesNotMatch(cards('{"action":"<img src=x onerror=alert(1)>","risks":["<script>bad()</script>"]}'),/<script>|<img/);
 assert.match(cards('分析暫時失敗 <script>'),/&lt;script&gt;/);
});
test('formal UI never generates or offers simulated prices',()=>{
 const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
 assert.doesNotMatch(html,/function gen\(|function rng\(|custom\|\|gen|value="demo"|改回模擬資料/);
 assert.match(html,/if\(!custom\|\|custom.symbol!==s\)/);
 assert.match(html,/aiCards/);
});
