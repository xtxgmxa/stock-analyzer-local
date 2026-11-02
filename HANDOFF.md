# 走勢研判台：專案交接文件（給接手的 AI／工程師）

## 1. 目標
網頁版股票分析工具：讀取今日與歷史行情，輸出走勢研判、建議進場價、停損、目標價、減碼／贖回價，並可選擇 AI 模型（OpenAI／Codex GPT、Cursor 模型、自訂 OpenAI 相容端點）做二次判讀。使用者為台灣用戶，**紅漲綠跌**，預設代號例為 2330、0050。

## 2. 目前狀態（v0.1 前端原型）
單檔 `stock-analyzer.html`，純前端、無建置流程。

已完成：
- 技術指標：SMA20／60、EMA、MACD(12,26,9)、RSI14、ATR 近似。
- 評分制：均線位置、均線排列、MACD 動能、RSI 過熱／超賣、60 日區間位置，加總為 -4～+4。
- 建議：分批買進／偏多持有／觀望／減碼／贖回；並計算進場區間、停損、目標、減碼價。
- 未來 20 日推估：以近 60 日對數報酬的均值與波動，輸出約 80% 區間（常態假設，僅示意）。
- 持有成本輸入，會依損益調整提示。
- AI 面板：模型來源下拉、模型名稱、後端代理網址；未設代理時輸出可貼進 Codex／Cursor 的結構化提示詞。
- 深淺色、手機版型。

**已知限制（重要）**
1. 行情是**依代號種子產生的模擬資料**，非真實。可用「貼上 CSV」替代。
2. 已發布的頁面受 CSP 限制，無法直接請求第三方行情或 AI API，因此真實串接**必須經後端**。
3. 金鑰絕不可放前端。前端只送請求給自家後端。
4. 評分規則為啟發式，未回測，不構成投資建議。

## 3. 建議架構（下一步）
```
瀏覽器 (本檔 UI)
   │  GET /api/quote?symbol=2330&range=1y
   │  POST /api/ai-analyze
   ▼
後端代理 (Node/Express 或 FastAPI)
   ├─ 行情層：台股 TWSE OpenAPI / TPEx；美股 Alpha Vantage／Polygon／Yahoo 非官方
   ├─ 指標層：可把 analyze() 移到後端，與前端共用同一套測試
   └─ AI 層：provider adapter（見下）
```

### 3.1 行情 API 合約
`GET /api/quote?symbol=2330&range=1y` →
```json
{"symbol":"2330","currency":"TWD","bars":[{"d":"2026-11-02","o":0,"h":0,"l":0,"c":0,"v":0}],"asOf":"ISO8601","source":"twse"}
```
前端目前只用 `{d,c}`；改接時請在 `render()` 前把回傳轉成 `[{d,c}]`，並移除 `gen()` 的模擬路徑（保留作離線示範）。

### 3.2 AI API 合約
前端已送出：
```json
POST /api/ai-analyze
{"provider":"openai|cursor|custom","model":"字串","prompt":"已組好的提示詞","context":{"symbol":"2330"}}
```
建議回傳（提示詞要求模型輸出此 JSON，後端驗證後再回傳）：
```json
{"action":"","entry":[0,0],"stop":0,"target":0,"trim":0,"risks":[],"summary":""}
```
目前前端把回應當純文字顯示；接上後請改為解析 JSON 並渲染卡片。

### 3.3 Provider adapter
- `openai`：官方 SDK，Responses 或 Chat Completions，模型名由前端傳入並在後端白名單檢查。
- `custom`：任何 OpenAI 相容 `base_url`＋`api_key`，放環境變數。
- `cursor`：**需先確認** Cursor 是否提供可程式呼叫的公開 API 與認證方式；若沒有，則維持「複製提示詞貼進 Cursor」流程，不要假設有端點。
- 「登入選模型」：建議用 OAuth／後端 session，不要在前端存金鑰。

## 4. 待辦清單（依優先序）
1. 建後端代理與 `/api/quote`，接 TWSE 日 K，加快取（同代號同日只抓一次）。
2. 把 `analyze()` 拆成獨立模組＋單元測試（用已知序列驗 RSI、MACD）。
3. AI adapter 與 JSON schema 驗證、逾時與重試、錯誤訊息。
4. 加入開高低量 K 線、成交量、法人買賣超、基本面（本益比、殖利率）。
5. 簡易回測：評分規則歷史勝率與最大回撤，結果顯示於頁面。
6. 自選股清單、價格警示、持股損益總覽（需登入與資料庫）。
7. 贖回建議延伸：基金／ETF 的淨值、配息日與費用考量。
8. 合規：免責聲明、資料來源標示、資料延遲標示。

## 5. 程式結構（stock-analyzer.html）
- `gen(sym)`：模擬資料。`analyze(data,rk)`：指標＋評分＋價位＋推估。
- `render()`：更新結論卡與判斷依據。`draw()`：SVG 圖。
- `prompt()`：組 AI 提示詞。`#ai` 的 click：分流內建引擎／後端代理／僅提示詞。
- 色彩與深淺色皆由 `:root` 變數控制，改色請只動變數。

## 6. 給接手 AI 的守則
- 不得宣稱模擬資料為真實行情；任何輸出需保留免責聲明。
- 不要把任何 API 金鑰寫進前端或提交進版控。
- 修改指標公式時同步更新測試與本文件。
- 保持單檔可離線開啟，除非已明確升級為多檔專案。

---
## 7. v0.2 更新：本機打包版（登入式 AI）
- 結構：`index.html`（UI）、`server.js`（零依賴 Node，綁 127.0.0.1）、`start.bat`／`start.command`、`config.json`（選填）。
- AI 改為**帳號登入式**：`/api/ai` 以子程序呼叫本機已登入的 CLI。Codex 預設 `codex exec --skip-git-repo-check -`（提示詞走 stdin）；Cursor 預設 `cursor-agent -p <prompt>`。
- **尚未在真實登入環境驗證**：CLI 參數以官方文件為準，請接手者先於終端機實測，再修 `config.json`／`server.js` 的預設值。
- `config.json` 範例：`{"cursor":{"cmd":"cursor-agent","args":["-p","--output-format","text"],"stdin":false,"modelFlag":"--model"},"timeoutSec":180}`
- `/api/status` 回報兩個 CLI 是否存在；`/api/quote?symbol=` 用 Yahoo 非官方介面回 `{bars:[{d,c}],source}`，已知不穩，建議換 TWSE 官方。
- 安全注意：非 stdin 模式會過濾提示詞特殊字元；勿放寬 Host 檢查；勿開放對外。
- 待辦新增：在真實環境驗證兩個 CLI；解析 AI 的 JSON 回覆並渲染卡片；失敗時的 CLI 版本偵測。

---
## v0.3 已實作更新（本節優先於先前建議）

目前結構、實作範圍與接手盤點見 ARCHITECTURE.md，啟動及 GitHub Pages 方式見 README.md。
已加入 research/ Python 核心、SQLite 原始回應／資料版本／快照、TWSE 官方日 K、OHLCV 嚴格檢查、1～5 日 LightGBM + XGBoost、purged walk-forward、獨立時間校正、規則／風控及含成本停損回測。
server.js 現為相容啟動入口，實際服務為 companion.js。保留原有 UI 並新增研究區塊，CLI subprocess 改用 shell:false。
網站透過各使用者自己的本機服務使用各自登入的 CLI；GitHub Pages 本身不執行模型或取得電腦帳號。
Codex 已實測登入與回覆；Cursor 尚未安裝，保留但未實測。
原有模型輸入欄位不保證帳號具有該模型權限；不得將「CLI 存在」當成「帳號已登入」。
指標更動：前端平盤 RSI 修正為 50，研究 RSI 與前端同用 14 日簡單平均；研究 ATR 使用 OHLC True Range，原前端 ATR 仍為展示近似值。對應測試位於 tests/test_research.py。

## v0.3.1 更新
正式介面不再產生或提供模擬資料。先讀取官方網路行情，失敗則停止分析。AI 接收實際 OHLCV 並以中文卡片呈現。GitHub Pages 發布公開的官方 2330 日 K，完整模型與個人 AI 使用本機服務。README.md 為最新啟動與部署說明。
