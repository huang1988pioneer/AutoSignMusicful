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

第一次先在本機登入：

```bash
npm run setup
```

看到 Musicful 成長中心後按 `Ctrl+C` 結束，然後匯出登入狀態：

```bash
npm run export-state
```

複製 `logs/musicful-storage-state.base64` 的內容，到 GitHub repo 的 `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`，新增：

```text
MUSICFUL_STORAGE_STATE_BASE64
```

多帳號可繼續新增 secret，名稱依序使用：

```text
MUSICFUL_STORAGE_STATE_BASE64_2
MUSICFUL_STORAGE_STATE_BASE64_3
...
MUSICFUL_STORAGE_STATE_BASE64_33
```

每個 secret 放一個帳號匯出的 `logs/musicful-storage-state.base64` 內容。

workflow 會從 UTC 05:06 開始，每 15 分鐘跑一個帳號：

```text
05:06 MUSICFUL_STORAGE_STATE_BASE64
05:21 MUSICFUL_STORAGE_STATE_BASE64_2
05:36 MUSICFUL_STORAGE_STATE_BASE64_3
05:51 MUSICFUL_STORAGE_STATE_BASE64_4
```

後續帳號依此輪轉到 `MUSICFUL_STORAGE_STATE_BASE64_33`。你也可以在 GitHub Actions 頁面手動按 `Run workflow` 測試。

## 自訂網址

如果 Musicful 把成長中心換到其他語系或網址，可以用環境變數覆蓋：

```bash
MUSICFUL_SIGNIN_URL="https://tw.musicful.ai/growth-center/" npm run signin
```
