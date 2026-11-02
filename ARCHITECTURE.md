> v0.5 最新使用方式以 README.md 與 RELEASE-v0.5.md 為準；v0.4 研究核心保留，下列較早版本內容作交接歷史。

# 台股 1～5 日機率研究 v0.3

## 接手前的結構

原有六個檔案：index.html、server.js、start.bat、start.command、README.md、HANDOFF.md。
原有技術棧為 HTML/CSS/JavaScript + Node 內建 http/https/child_process，無套件管理、資料庫、模型或回測。
前端已有 SMA20/60、EMA、MACD、簡單 RSI、近似 ATR、啟發式評分、價位建議、SVG 圖、收盤價 CSV、持倉成本、深淺色及 AI 提示詞。
初始行情為種子模擬，後端 Yahoo 只取收盤價。AI 呼叫本機 Codex/Cursor CLI，但原有狀態只查工具是否存在。

## 本版結構

```text
GitHub Pages 或 localhost 的 index.html + research-ui.js
  → 各使用者電腦的 http://localhost:5177
     server.js → companion.js
       /api/status       CLI 存在 + 官方登入狀態指令
       /api/ai           本機 CLI subprocess；憑證由 CLI 管理
       /api/quote        原有技術展示用 Yahoo 歷史 OHLCV
       /api/research     Python JSON worker
         research/data.py      官方 TWSE / Yahoo / CSV / 示範
                               嚴格檢查 + SQLite 原始回應與內容版本
         research/features.py  收盤前可得 OHLCV 特徵 + 規則 + 風控
         research/engine.py    1/2/3/4/5 日模型、校正、Walk-Forward、交易模擬
         research/cli.py       研究、快照、快照列表、行情的 JSON 協定
```

研究介面沒有重做原有圖表與離線展示。原前端計算保留於「原有技術規則展示」，新增後端特徵計算是模型與回測共用的正式研究路徑。
原前端 ATR 是收盤變動近似值；研究 ATR 為完整 OHLC 的 14 日平均 True Range。兩者不可混用。
前後端 RSI 都是最近 14 日簡單平均漲跌比，非 Wilder 平滑；平盤為 50。既有 EMA/MACD 保留。

## 時間與防洩漏合約

- 台北時區。只接受已完成日 K：當日 16:00 後才能納入當日；不是盤中預判系統。
- 先按日期排序，拒絕重複、NaN、無效 OHLC、未來日期、週末、疑似拆股的大跳動；不 forward/back-fill OHLC。
- 特徵明確白名單，僅 backward rolling/ewm。沒有 label、future return 或 end date 進入模型。
- 每個 h 定義 `entry=open[t+1]`，`exit=close[t+h]`；標籤為 gross exit/entry > 1。尾端未知標籤維持缺值。
- 先暖機 59 筆。252 個訓練訊號起始，間隔 5 個交易日，100 筆校正，間隔 5 個交易日，再測試 63 筆；訓練窗擴展。
- 每折 assert 訓練 label_end < calibration_start，calibration label_end < test_start。禁止 random split，未用測試區間調參。
- LightGBM / XGBoost 等權平均 raw probability；LogisticRegression 對集成 logit 做 sigmoid 校正，僅使用該折校正段。
- 單類別訓練回退歷史 prior；單類別校正段保留未校正結果並標示，最新訊號會暫停。
- 最新預測使用截至最新收盤已實現的標籤重新擬合，與歷史 OOS 預測明確區分。
- 最新訊號額外要求 OOS Brier 優於每折訓練歷史上漲率 prior；此條件不回頭修改歷史策略。
- 完整輸出保留每折日期、個別模型／集成／prior 的 Brier、log loss、AUC、accuracy、reliability bins，以及每筆 OOS 預測。

## 交易及風控合約

每個 h 是獨立策略，不能加總五組資產曲線。單一多頭持倉，持倉期間不加碼。
機率 >= 0.6 且規則分數 >= 1；平均成交金額 >= 2,000 萬、20 日日報酬標準差 <= 4%；不接受當日零成交量、近漲跌停波動。
倉位最多 20%；以 2 ATR 損失距離及 1% 資產風險預算縮小倉位。次日開盤進場；開盤價重算停損。
若跳空開在停損以下，以開盤成交；否則日內 low 觸停損以停損價出場；到期以收盤出場。這些成交是假設，無法保證漲跌停成交。
買入／賣出手續費各 0.1425%，賣出稅 0.3%，單邊滑價 0.1%。預設是股票稅率，ETF 使用者需在 engine.CONFIG 調整後重跑。
每日按收盤價估值，回撤以每日收盤資產計算；快照含逐日 equity 與所有 fills。沒有將重疊 h 日報酬連乘。
示範與過期資料不產生最新候選訊號，示範歷史回測只用於檢查流程。

## 資料版本、復現與擴充

`data/research.sqlite` 保存原始 TWSE 月回應、SHA256 資料版本、研究快照。資料版本只插入不覆寫。
快照包含規則、特徵版本、套件版本、固定參數、日期、資料 ID、模型指標、逐筆預測、交易結果。
原始 TWSE 回應有快取：歷史月 7 日、當月 6 小時；跨日或跨 16:00 收盤門檻會更新當月。
重跑同一 datasetId 使用已存資料，不重新抓來源。固定套件、單執行緒及種子在本機重跑機率已驗證一致；模型 binary 尚未單獨保存。

新聞、重大訊息、法人、財報、LLM 尚未連線。擴充使用 `join_events_asof`：
輸入帶時區的 `decision_at` 與真正可得時間 `available_at`，只 backward join，不以財報期間截止日代替公告時間。
LLM 僅解讀快照，不覆寫機率；未設定 OpenAI API key，也未把訂閱視為免費 API。

## GitHub 與使用者帳號

GitHub Pages 只部署公開靜態檔案，不執行 Node/Python，也不能讀取訪客電腦帳號。
每個人必須自己安裝並登入 CLI、啟動 companion，必要時允許該網站連線 localhost。
CLI 偵測只輸出 installed/authenticated/unknown 等狀態，不回傳原始帳號文字或 token。
Codex 已在接手電腦完成 auth status 及實際回覆測試。Cursor 未安裝，僅保留 adapter，尚無真實帳號測試；IDE 登入不等於 CLI 登入。
Node 子程序使用 shell:false，提示詞不經命令字串。Codex 預設 read-only。
Host 限 localhost；Origin 使用精確白名單；只開放公開資產清單，資料庫、config、憑證與研究程式不提供下載。

## 後續優先事項

1. 官方交易日曆、上櫃官方 adapter、除權息與拆股事件、停牌與無法成交的漲跌停。
2. 正確 point-in-time 的法人／營收／財報與大盤指標，加入後使用相同 OOS 流程比較，而非直接增加權重。
3. 跨個股與含下市股票母體驗證、更多未見市場時期、漂移監測、費稅設定介面。
4. 真實 Cursor CLI 支援與其他作業系統、實際 GitHub Pages 網域及瀏覽器本機網路權限測試。
5. 模型二進位持久化、排程增量訓練與未來前瞻 paper trading；現階段不自動下單。

## v0.3.1 正式資料優先（本節優先）

正式網頁、CLI 與 API 已移除模擬資料入口。首頁先取得 TWSE 真實行情，載入失敗或切換代號會清除舊分析並停用 AI。
GitHub Pages 另發布明確日期的官方 2330 公開日 K（最近 180 筆），其他股票與完整模型需本機服務。
AI 讀取來源、日期、最近 60 筆真實 OHLCV，回覆改以中文卡片呈現，原始內容收在進階區。
readable-ai.js 為可獨立驗證的呈現模組。合成序列只保留於測試 fixture，不可用於正式分析。
