# 台股 1～5 日機率研究台

先取得真實行情，再進行分析。正式介面不生成、不提供、不回退到模擬價格。

- [開啟網頁](https://xtxgmxa.github.io/stock-analyzer-local/)
- [原始碼](https://github.com/xtxgmxa/stock-analyzer-local)

## 一般使用者

網頁預設載入 2330 的 TWSE 官方歷史日 K，畫面標示來源、資料日期與收盤價。
公開網頁不需要安裝就能閱讀已發布的 2330 真實行情、圖表與內建摘要。
資料是收盤後日 K，不是盤中即時報價。目前公開行情由維護者手動發布；請以畫面資料日期為準。已備妥工作日台北時間 16:30 自動更新範本，待 repository 擁有者授權 workflow 後才能啟用。

未發布的股票、超過 7 天的資料、來源錯誤或資料驗證失敗，會停止分析並顯示原因，不以假資料補上。

## 使用其他股票、完整模型與自己的 AI 帳號

Windows 安裝 Node.js 20+、Python 3.12 並加入 PATH，下載原始碼後：

1. 第一次執行 `setup.bat`，安裝專案專用環境。
2. 執行 `start.bat`，開啟 http://localhost:5177。
3. 本機服務從 TWSE 官方讀取上市股票日 K。上櫃可自行選 Yahoo 非官方 .TWO 來源或匯入真實 CSV。
4. 輸入代號，按「更新行情並分析」，確認來源與日期，再閱讀技術觀察或產生 AI 判讀。
5. 「執行訓練與回測」會抓取、驗證完整資料，再訓練 1～5 日模型；首次官方抓取約 1～3 分鐘。

Mac/Linux：`bash setup.command`，接著 `bash start.command`。已在 Windows 驗證；CI 包含 Ubuntu 檢查。

Codex CLI 需先 `codex login`，並可用 `codex login status` 確認登入。
Cursor adapter 預設 `cursor-agent login` / `cursor-agent status`，若版本使用 `agent`，可於 config.json 覆寫；Cursor 真實帳號尚未實測。
僅有桌面 App 登入不一定代表 CLI 已登入。各使用者使用自己的帳號、額度與資料庫，網站不接收 token。
AI 讀取目前已載入的真實行情、來源、日期、最近 60 個交易日 OHLCV 與分析快照；回覆顯示為中文卡片，原始 JSON 收在進階區。

在 GitHub Pages 使用本機帳號時，複製 config.example.json 為 config.json，將 allowedOrigins 設成 `https://xtxgmxa.github.io`，重新啟動本機服務。
瀏覽器可能要求本機網路存取權限；若政策阻擋，可直接使用 localhost 網頁。

## 研究核心

- 真實來源：TWSE 官方上市歷史日 K；明確選擇的 Yahoo 非官方 OHLCV；使用者確認來源的 CSV。
- 完整研究 CSV：`date,open,high,low,close,volume`，至少 650 個交易日，成交量單位為股。
- 嚴格檢查缺值、OHLC、重複、未來日期、未完成日 K 與疑似拆股大跳動。
- LightGBM + XGBoost baseline，各 1～5 日分開；技術、動能、波動、量能及流動性訊號。
- Expanding Walk-Forward：252 日起始訓練、100 日獨立校正、63 日測試，兩個邊界各留 5 日 purge。
- 上漲機率定義：第 h 日收盤是否高於次日開盤，為未扣成本的方向機率。
- 含手續費、稅、滑價、隔日開盤、ATR 停損、倉位上限及不重疊持倉的回測。
- SQLite 資料版本、每折稽核、逐筆 OOS、Brier/prior 比較、交易明細、資產曲線、歷史快照與 JSON 下載。
- 模型未優於基準時，最新訊號維持「觀察」，不宣稱有預測優勢。

完整方法與費稅假設見 ARCHITECTURE.md。研究資料庫與帳號設定不提供公開下載。
合成序列僅存在於單元測試的固定測試資料，不可由正式 CLI/API/介面用來分析。

## 驗證

```powershell
.\.venv\Scripts\python -m unittest discover -s tests -p "test_*.py" -v
npm test
node build-pages.js
```

已通過 13 項 Python 與 8 項 Node 測試。除原有回測／洩漏檢查，新增：正式入口拒絕模擬、官方來源選擇、中文卡片與輸出轉義。

## GitHub 部署與公開資料

目前採一般分支部署，Settings → Pages → Source 選 Deploy from a branch，分支 `codex/pages`，目錄 `/`。
維護者於本機執行 `node publish-pages.js`，會先實際讀取 TWSE，產生公開 2330 的最近 180 個交易日 `public-quotes/2330.json`，再只推送公開檔案至發布分支。
現有 GitHub 登入未具 workflow 授權，因此自動更新及 CI 範本保存在 `.github/workflow-templates/`，目前尚未啟用。具備相應權限後可移至 `.github/workflows/` 並改用 Actions 部署。
來源取得失敗時部署失敗，保留前次發布版本及其原資料日期，不生成替代行情。超過 7 天的公開行情停止分析。
只發布公開前端及明確整理的官方行情，不發布 `.venv`、`data`、`.env`、config.json、個人歷史快照或 CLI 登入。

GitHub Pages 無法執行本機 Python 或直接取得訪客電腦帳號。完整模型與個人 AI 仍由各自的本機服務執行。

## 尚未完成的範圍

新聞、重大訊息、法人、基本面及大盤尚未接入，已預留按發布時間 backward as-of join。
未還原除權息、尚未建立官方交易日曆、完整上市下市母體及供應商 point-in-time 修訂庫。
ETF 費稅需另外調整，回測不保證漲跌停可成交，跳空可能超過風險預算。沒有自動下單功能。
20 日陰影是統計外推示意，不是未來真實行情，也不是新增 1～5 日模型的預測。

本工具是可驗證的研究版，模型可執行不代表具有穩定預測優勢。
