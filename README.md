# Musicful Auto Sign

這個小工具會用獨立的瀏覽器登入狀態打開 Musicful 成長中心，並嘗試完成每日簽到。

Musicful 頁面顯示每日簽到以紐約時間 00:00 重置；在台灣時間約為 12:00 或 13:00，所以 macOS 排程預設每天 13:10 執行。

## 第一次設定

Musicful Flow 簽到總覽會顯示 Musicful Auto Sign 的上次成功日期、上次失敗日期及 GitHub Actions 連續成功天數，日期皆為台灣時間。每天至少一次成功，且所有已完成執行皆成功才計入；同日多次成功只算一天，缺日、失敗、取消或逾時會中斷。今天尚無已完成執行時保留截至昨天的天數。上次失敗包含 failure、timed_out 與 startup_failure。

開啟程式及點選「更新執行結果」會更新 GitHub 目前可用的歷史紀錄，並保存到本機 `logs/github-action-history.json`。離線時保留上次更新時的統計並標示資料時間；統計範圍為此 workflow 的所有分支與觸發方式。

使用 Musicful Flow 桌面工具時，登入視窗關閉、頁面穩定 **5 秒**後，會自動切換到 Musicful「成長中心」；登入完成後偵測並自動匯出登入狀態。若未自動切換，可手動前往。請勿關閉瀏覽器；等匯出完成後，再點選「複製 Base64」旁的「更新 GitHub Secret」上傳。

建議安裝 **Google Chrome**（預設、較穩定）。若 Chrome 無法使用，可改用 **Microsoft Edge** 或 **Firefox** 備案。

```bash
npm install
npx playwright install chromium   # 預設（Chrome / Edge 共用 Playwright chromium 驅動）
# 備案：npx playwright install firefox
npm run setup
```

瀏覽器打開後登入 Musicful，確認看得到成長中心和帳號狀態後，在終端機按 `Ctrl+C` 結束。

### 選擇瀏覽器（Chrome 預設 / Edge・Firefox 備案）

腳本與桌面工具皆支援：

| 方式 | 說明 |
|------|------|
| 環境變數 | `MUSICFUL_BROWSER=chrome`（預設）、`edge` 或 `firefox` |
| CLI | `--browser chrome` / `edge` / `firefox` |
| 自訂路徑 | `CHROME_PATH=...` / `EDGE_PATH=...` / `FIREFOX_PATH=...` |
| Musicful Flow | 「更新登入狀態」頁的瀏覽器下拉選單 |

```bash
# Edge 備案：登入／匯出／簽到（需已安裝 Microsoft Edge）
npm run setup -- --browser edge
npm run export-state -- --browser edge --profile musicful-01
npm run signin -- --browser edge

# Firefox 備案：登入／匯出／簽到
npm run setup -- --browser firefox
npm run export-state -- --browser firefox --profile musicful-01
npm run signin -- --browser firefox
npm run signin:headed -- --browser firefox
```

> 切換瀏覽器後請重新匯出 Storage State；不同瀏覽器的登入狀態不保證互通。GitHub Actions 仍預設使用 Chromium。  
> Edge 透過 Playwright `channel=msedge` 使用系統已安裝的 Microsoft Edge。

## 手動簽到一次

```bash
npm run signin
```

如果想看瀏覽器畫面：

```bash
npm run signin:headed
```

## 安裝每天自動簽到

```bash
chmod +x install-macos-launch-agent.sh
./install-macos-launch-agent.sh
```

之後每天 13:10 會自動跑一次。紀錄會保存在 `logs/`。

## GitHub Actions 自動簽到

這個專案也包含 GitHub Actions workflow：`.github/workflows/musicful-auto-sign.yml`。

### 單一帳號：匯出並設定 secret

第一次先在本機登入：

```bash
npm run setup
```

看到 Musicful 成長中心後按 `Ctrl+C` 結束，然後匯出登入狀態：

```bash
npm run export-state
```

複製 `logs/musicful-storage-state.base64` 的內容（匯出成功時也會盡量寫入剪貼簿），到 GitHub repo 的  
`Settings` → `Secrets and variables` → `Actions` → `New repository secret`，新增：

```text
MUSICFUL_STORAGE_STATE_BASE64_1
```

> **注意：** GitHub Actions 使用的正式命名是帶編號的 `MUSICFUL_STORAGE_STATE_BASE64_1` … `_33`。  
> 本機單機跑時仍可用未編號別名 `MUSICFUL_STORAGE_STATE_BASE64`（等同帳號 1），但 CI 請一律用 `_1` 起算。

### 多帳號設定

最多支援 **33** 個帳號槽位（workflow 的 `MUSICFUL_MAX_ACCOUNTS=33`）。每個帳號對應一個 repository secret：

| 槽位 | Secret 名稱 |
|------|-------------|
| 1 | `MUSICFUL_STORAGE_STATE_BASE64_1` |
| 2 | `MUSICFUL_STORAGE_STATE_BASE64_2` |
| 3 | `MUSICFUL_STORAGE_STATE_BASE64_3` |
| … | … |
| 33 | `MUSICFUL_STORAGE_STATE_BASE64_33` |

**每個 secret 只放一個帳號** 匯出的 base64 內容；不要把多個帳號塞進同一個 secret。

#### 建議流程（每個帳號重複一次）

1. **獨立本機 profile 登入**（避免多帳號共用同一個瀏覽器 profile 互相覆蓋）：

   ```bash
   # 帳號 2 範例：profile 名稱自訂，會寫入 .musicful-profile-<名稱>
   node scripts/musicful-signin.mjs --headed --setup --profile account2
   ```

2. 在開啟的瀏覽器中登入該帳號，確認成長中心可見後按 `Ctrl+C`。

3. **匯出該 profile 的登入狀態**：

   ```bash
   node scripts/musicful-signin.mjs --headed --export-state --profile account2
   ```

   - 預設仍會寫入 `logs/musicful-storage-state.base64`
   - 有指定 `--profile` 時，額外寫入  
     `logs/musicful-storage-state-<profile>.base64`  
     （例如 `logs/musicful-storage-state-account2.base64`）

4. 到 GitHub 新增對應編號 secret，例如帳號 2：

   ```text
   名稱：MUSICFUL_STORAGE_STATE_BASE64_2
   內容：該次匯出的 base64 字串
   ```

5. 換下一個帳號時，使用**新的** `--profile` 名稱（或刪除舊 profile 目錄後重登），再重複步驟 1–4。

#### 帳號顯示名稱（可選）

Job Summary 裡的帳號標籤來自 workflow 環境變數 `MUSICFUL_ACCOUNT_LABELS_JSON`  
（見 `.github/workflows/musicful-auto-sign.yml`）。格式為 index → 顯示名稱：

```json
{"1":"goldshoot0720","2":"abuhg17","3":"fengtuprinfo"}
```

新增帳號後若要在 Summary 看到可讀名稱，請一併改 workflow 裡的 labels JSON（未設定的槽位會顯示為 `account_N` 或 secret 名稱）。

#### 執行行為

- **單一 job、依序同時簽到**：不是 matrix 拆 job。一個 job 內最多 **33** 個帳號，有設定 secret 的才真正開瀏覽器。
- **啟動節奏（累積延遲、並行執行）**：
  1. 帳號 1 立刻開始
  2. 帳號 2 比帳號 1 隨機晚 **5–15 秒** 開始
  3. 帳號 3 比帳號 2 再隨機晚 **5–15 秒** 開始
  4. 依此類推到帳號 33  
  後續帳號**不必等前一個簽到完成**，各自在自己的 browser context 並行跑（間隔可用 repository variables 調整，見下方）。
- **未設定 secret 的槽位**：結果標成略過（`skipped`），不會讓 job 失敗。
- **有任一已設定帳號失敗**：整個 job 失敗；Summary 會列出需關注帳號。

#### 排程

workflow 每天在三個時段各執行一次，涵蓋所有已設定帳號：

```text
台灣時間 05:00–06:00
台灣時間 13:00–14:00
台灣時間 21:00–22:00
```

每個時段在整點由 cron 觸發，接著隨機等待 **0–59 分鐘** 才開始簽到（讓實際開始落在該小時內）；同一次 run 中 33 個帳號再依上列 5–15 秒累積延遲依序啟動並同時執行。GitHub 排程本身可能延遲，因此實際開始時間可能略晚於整點。

（cron 為 UTC `0 21 * * *`、`0 5 * * *` 與 `0 13 * * *`，對應台灣時間 05:00 / 13:00 / 21:00。）

#### 手動執行 / 只跑單一帳號

在 Actions 頁面選 **Musicful Auto Sign** → **Run workflow**：

| 輸入 `account_index` | 行為 |
|----------------------|------|
| `all`（預設） | 跑所有已設定 secret 的帳號 |
| `1` … `33` | 只跑該編號帳號（其餘標成「本次未選」略過） |

適合用來重試某一個過期帳號，或測試新加入的 secret。

#### 更新過期的登入狀態

若 Summary / 日誌出現 *logged out or expired* 等錯誤：

1. 用該帳號的 `--profile` 重新 `setup` + `export-state`（或本機重登後再匯出）。
2. 到 GitHub **更新**對應編號 secret 的內容（同名 secret 可直接改值）。
3. 用 `account_index` 指定該編號手動跑一次 workflow 驗證。

#### 被動續期（自動把新 cookie 寫回 secret）

每次簽到成功後，瀏覽器手上的 cookie 通常已被 Musicful 換發成更新的一份。開啟被動續期後，
腳本會把**簽到後**的 storage state 寫回同一個編號 secret，讓登入狀態隨每天簽到自動延壽，
不用等到過期才手動重匯出。

它**不會**繞過任何驗證：只是保存瀏覽器已經拿到的 cookie，登入仍然是你手動做的。

設定方式：

1. 建立一個有寫入 secret 權限的 token（GITHUB_TOKEN 做不到）：
   - Fine-grained PAT → 該 repo → **Secrets: Read and write**（另需 Metadata: Read-only）
   - 或 classic PAT → `repo` scope
2. 把它存成 repository secret **`MUSICFUL_SECRET_WRITE_TOKEN`**。
3. 完成。`Musicful Auto Sign` 預設就會啟用（`MUSICFUL_REFRESH_SECRETS` 預設 `1`）。

行為與保護措施：

- 只有**簽到成功**的帳號才會寫回；失敗 / 過期的帳號完全不動原本的 secret。
- 匯出結果沒有任何 cookie 時會跳過，不會用空狀態覆蓋掉好的 secret。
- 內容和舊值相同就不寫，避免無謂的 secret 版本。
- 超過 GitHub 的 48 KB secret 上限時跳過並在日誌標示。
- 日誌只印 secret 名稱、位元組數與 sha 前 8 碼，**不會**印出狀態內容。
- workflow 加了 `concurrency` 群組，避免兩個 run 同時把舊 cookie 蓋掉新的。

先觀察不寫入（建議第一次這樣跑）：不要設 `MUSICFUL_SECRET_WRITE_TOKEN`，日誌會顯示
`Secret refresh: N state(s) changed but MUSICFUL_SECRET_WRITE_TOKEN is unset`，
確認有偵測到變動後再放 token。

關閉：把 repository variable `MUSICFUL_REFRESH_SECRETS` 設成 `0`。

相關環境變數：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `MUSICFUL_REFRESH_SECRETS` | `1`（workflow 內） | `1` 啟用被動續期；本機也可加 `--refresh-secrets` |
| `MUSICFUL_SECRET_WRITE_TOKEN` | 無 | 寫入 secret 用的 PAT；沒有就只回報不寫入 |
| `MUSICFUL_SECRET_REPO` | `GITHUB_REPOSITORY` | 目標 repo（`owner/name`），本機執行時需要 |
| `MUSICFUL_MAX_SECRET_BYTES` | `48000` | 超過此大小的狀態不寫回 |

> 寫回是用 `gh secret set`（GitHub CLI），值透過 stdin 傳入，不會出現在命令列或 process list。

#### 檢查重複 secret（建議）

另一個 workflow：`.github/workflows/check-musicful-secrets.yml`  
（Actions 名稱：**Check Musicful Secrets**）

- 每天台灣時間約 **04:30** 自動跑，也可手動 **Run workflow**。
- 會檢查：
  - 多個 secret 內容是否完全相同
  - 解碼後的 storage state 是否相同
  - cookie / token 類欄位是否在不同帳號間重複
- 本機若已把 secrets 注入環境變數，也可：

  ```bash
  npm run check:secrets
  ```

> 請確保每個編號 secret 對應**不同** Musicful 帳號；重複內容會讓檢查 workflow 失敗。

### 每日匯總（Job Summary）

Workflow 與 [AutoSignLitVideo](https://github.com/huang1988pioneer/AutoSignLitVideo/actions/runs/29248744621) 相同模式：**單一 job** 以交錯延遲並行跑完所有帳號後，直接寫入 GitHub **Job Summary**，並上傳報告 artifact。

跑完後在 Actions run 頁面可看到：

1. **Summary** 區塊（中文標題 + 統計表 + 各帳號狀態 / 成長點 / 音樂點 / **連續簽到天數** + 最高／最低／平均彙總）  
2. Artifact：`musicful-signin-report`（保留 30 天）  
   - `signin-daily-summary.md` / `.json`  
   - `signin-streaks.json`（各帳號連續簽到天數 + 彙總統計）  
   - 各帳號 `signin-result-N.json`（含 `streakDays` 欄位）  
3. 未設定 secret 的槽位會標成略過（例如 `#21–33`）  
4. 有帳號失敗時 job 會失敗，Summary 會列出需關注帳號  

每次簽到成功或已簽過時，腳本會從成長中心頁面擷取「累計：N 天」寫入結果；Job Summary 與 `signin-streaks.json` 都會列出每個帳號的連續簽到天數，並計算已紀錄帳號數、最高／最低／平均／合計天數。  

狀態說明：

| Summary 顯示 | 意義 |
|--------------|------|
| 今日簽到 | 本次成功點擊簽到 |
| 已簽過 | 今日稍早已領過 |
| 略過 | 未設定 secret，或手動 run 時未選到 |
| 失敗 | 需重新登入匯出，或頁面結構變更 |

本機也可從結果資料夾重建匯總：

```bash
npm run summary -- path/to/artifacts
```

### Repository variables（可選）

在 `Settings` → `Secrets and variables` → `Actions` → **Variables** 可覆寫：

| Variable | 預設 | 說明 |
|----------|------|------|
| `MUSICFUL_SIGNIN_URL` | `https://tw.musicful.ai/growth-center/` | 成長中心網址 |
| `MUSICFUL_DELAY_MIN_MS` | `5000` | 帳號間最短等待（毫秒） |
| `MUSICFUL_DELAY_MAX_MS` | `15000` | 帳號間最長等待（毫秒） |
| `MUSICFUL_REFRESH_SECRETS` | `1` | 被動續期；設 `0` 關閉自動寫回 secret |

## 自訂網址

如果 Musicful 把成長中心換到其他語系或網址，可以用環境變數覆蓋：

```bash
MUSICFUL_SIGNIN_URL="https://tw.musicful.ai/growth-center/" npm run signin
```

## 本機多帳號速查

| 目的 | 指令 |
|------|------|
| 新帳號登入（獨立 profile） | `node scripts/musicful-signin.mjs --headed --setup --profile <名稱>` |
| 匯出該 profile 狀態 | `node scripts/musicful-signin.mjs --headed --export-state --profile <名稱>` |
| 本機用 env 跑多帳號 | 設定 `MUSICFUL_STORAGE_STATE_BASE64_1`… 後 `npm run signin` |
| 只跑某一號 | `MUSICFUL_ACCOUNT_FILTER=3 npm run signin` |
| 檢查 secret 是否重複 | `npm run check:secrets`（需已注入 env） |
| 從結果資料夾重建 Summary | `npm run summary -- artifacts` |
