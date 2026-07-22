# Musicful Auto Sign

這個小工具會用獨立的瀏覽器登入狀態打開 Musicful 成長中心，並嘗試完成每日簽到。

Musicful 頁面顯示每日簽到以紐約時間 00:00 重置；在台灣時間約為 12:00 或 13:00，所以 macOS 排程預設每天 13:10 執行。

## 第一次設定

請先確認 Mac 有安裝 Google Chrome。

```bash
npm install
npm run setup
```

瀏覽器打開後登入 Musicful，確認看得到成長中心和帳號狀態後，在終端機按 `Ctrl+C` 結束。

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

- **單一 job、依序簽到**：不是 matrix 平行跑。一個 job 從帳號 1 掃到 33，有設定 secret 的才真正開瀏覽器。
- **帳號間隔**：預設每兩個帳號之間隨機等待約 **5–15 秒**（可用 repository variables 調整，見下方）。
- **未設定 secret 的槽位**：結果標成略過（`skipped`），不會讓 job 失敗。
- **有任一已設定帳號失敗**：整個 job 失敗；Summary 會列出需關注帳號。

#### 排程

workflow 每天跑兩次所有已設定帳號：

```text
台灣時間 05:06
台灣時間 17:06
```

（cron 為 UTC `6 21 * * *` 與 `6 9 * * *`。）

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

Workflow 與 [AutoSignLitVideo](https://github.com/huang1988pioneer/AutoSignLitVideo/actions/runs/29248744621) 相同模式：**單一 job** 依序跑完所有帳號後，直接寫入 GitHub **Job Summary**，並上傳報告 artifact。

跑完後在 Actions run 頁面可看到：

1. **Summary** 區塊（中文標題 + 統計表 + 各帳號狀態 / 成長點 / 音樂點 / 連續）  
2. Artifact：`musicful-signin-report`（保留 30 天）  
   - `signin-daily-summary.md` / `.json`  
   - 各帳號 `signin-result-N.json`  
3. 未設定 secret 的槽位會標成略過（例如 `#21–33`）  
4. 有帳號失敗時 job 會失敗，Summary 會列出需關注帳號  

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
