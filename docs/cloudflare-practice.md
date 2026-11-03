# 可變練習：Cloudflare Free 一次設定

這是部署者的設定指南。尚未部署及用兩部實體手機測試前，不應向領袖宣稱連網練習已可用。**固定題目／答案 QR 不需這個服務**。Cloudflare Free 有硬上限和服務條款，可能更改；超額或故障時練習可能停用，沒有無限量或永久免費的保證。Vercel 仍負責 App 網頁和領袖密碼驗證，有自己的額度及可能費用。

## 一次準備

1. 管理員建立／登入自己的 Cloudflare 帳戶，確認 **Workers Free**，不要啟用 Workers Paid 或其他收費服務。核對 [Workers 上限](https://developers.cloudflare.com/workers/platform/limits/)、[D1 收費及上限](https://developers.cloudflare.com/d1/platform/pricing/) 和帳戶的實際設定。所有旅團共用一個帳戶的額度；它不是每個旅團各有一份。
2. 在電腦使用本 repo、Node 22，先執行 `npm ci`。在同一電腦執行 `npx wrangler login`，由 Cloudflare 的瀏覽器頁面完成登入。領袖和成員不需各自註冊 Cloudflare，也不用提供密碼或 token 給這個聊天室。
3. 建立一次 D1 資料庫：`npx wrangler d1 create hm20c-practices`。複製 `wrangler.toml.example` 為同一目錄的 `wrangler.toml`；把命令輸出的 **database ID** 填入 `database_id`。該檔已被 `.gitignore` 排除；不要放秘密在這個檔案。
4. 在 `wrangler.toml` 的 `ALLOWED_ORIGINS` 設定正式 App 的**完整 HTTPS origin**，例如 `https://example.vercel.app`（只作格式例子，必須改為你實際的網址；不含最後的 `/` 或路徑）。多個需測試的 origin 可用逗號分隔。這是瀏覽器跨來源設定，**不是**存取控制；持活動 QR 的人仍能讀公開內容。
5. 執行 `npx wrangler d1 execute hm20c-practices --remote --file=cloudflare/schema.sql`，初始化你剛建立的遠端資料庫。**不要對其他現有資料庫執行此指令**。執行 `npx wrangler deploy`；此時尚未設定密碼／簽署秘密，Worker 會拒絕寫入。
6. 在私人環境選用至少 32 字元的獨立、高隨機性 `LEADER_SESSION_SECRET`。例如可在自己的電腦執行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`，把結果妥善保存，**不要貼到聊天、Git 或前端變數**。既有 `LEADER_PASSWORD` 和此簽署秘密都要分別存在 Vercel Production 的伺服器環境變數；如變更舊密碼，領袖須重新登入。
7. 用 `npx wrangler secret put LEADER_PASSWORD` 和 `npx wrangler secret put LEADER_SESSION_SECRET`，在安全提示中分別輸入**與 Vercel 相同的兩個值**。不要把值寫在命令列參數、`wrangler.toml`、Git、領袖備份或聊天中；不要用 `VITE_` 前綴。兩邊的簽署秘密不同會令領袖無法建立或修改練習。
8. Wrangler 的部署結果會顯示你的 `workers.dev` 網址。在 Vercel Production 設公開的 `VITE_ACTIVITY_API_URL` 為該網址加上 `/api/activity`，例如 `https://你的-worker.workers.dev/api/activity`。它只是公開網址，**不是密鑰**。確認兩個伺服器秘密和此網址均在 Production 後，重新部署 Vercel App。沒有設定 Worker 網址時，正式版會停用可變練習，不會偷偷使用舊 Redis。
9. 在兩部不同手機測試：共用密碼登入 → A 團建立題組及活動 → B 團建立另一活動 → 比較 QR → 成員各自掃碼 → A 改題 → 成員手動更新，確認 B 不變。另測期限延長、過期、未公布答案不進公開 QR／回應、網絡中斷及飛航模式後備。正式 Cloudflare 資料庫、CORS、iOS／Android 相機和網絡須實測。

Worker 程式位於 `cloudflare/worker.js`，資料表在 `cloudflare/schema.sql`；`npm test` 會以本機 SQLite 與 workerd 模擬驗證，但不會連接或建立真正的 Cloudflare 資源。`wrangler.toml.example` 的排程每小時清理到期資料，最多每次 1,000 筆；查詢和寫入即時拒絕已過期的活動。配額耗盡、服務故障或積壓可能延遲實際刪除，資料備份和保留另受 Cloudflare 政策約束。

## 給領袖和成員

- 一個共用領袖密碼，不按旅團登記。每次建立活動，伺服器產生隨機活動 ID 和獨立管理鑰匙。A、B 團各自建立會有不同 QR；同一手機想以同一套題目辦多個活動，可先「複製題組」再分別建立。活動 QR 只有讀取 ID，不含管理鑰匙或未公布答案。持 QR 者都可讀公開內容；這不是端對端加密或防作弊。
- 建立時由領袖選到期時間（最少 1 分鐘、最長 365 日），到期前可延長；正常修改／公布不會自動延長。過期或結束後，舊 QR 失效，需要新活動及新 QR；過期後先在該題組按「解除本機活動連結」，再建立活動。到期不能撤回已下載的題目或答案。
- 成員掃活動 QR 首次讀取需網絡。之後不定時輪詢、不自動重連更新；要取得新題目或已公布答案，按「更新題目及答案」。離線可看最後成功讀取的副本；出發前另存固定題目 QR，必要時掃新的固定題目或答案 QR。
- 題庫及管理鑰匙保存在目前瀏覽器和私人備份。共用同一手機瀏覽器時題庫不是隔離的旅團帳戶；備份含未公布答案及管理鑰匙，只由領袖保管。成員目前只保存一套多題題組，讀取另一活動會先提醒並取代現有副本。
- 香港時間每日早上 **08:00** 是日額度重設時間（00:00 UTC）。截至 2026-11-03，[Workers Free](https://developers.cloudflare.com/workers/platform/limits/) 每帳戶每天 100,000 次請求，每次 HTTP／排程 CPU 限 10 ms；[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) 另有每天 500 萬行讀取、10 萬行寫入、帳戶總儲存 5 GB 及最多 10 個資料庫。索引更新也可計作寫入。首次讀取、手動更新、領袖修改、CORS 預檢、排程、其他 Worker、管理員查詢和惡意請求等均可能消耗相關額度。到 Cloudflare 後台監察實際用量及 CPU；本機測試不證明正式環境永遠不超限。這不是按旅團人數保證容量，也不是所有 Vercel 費用的上限。
- 既有 Redis 連網活動不會自動遷入 D1。換用 Worker 前先備份題庫／管理資料及協調領袖；新 App 指向新資料庫後，舊活動 QR 不會自動轉移，要重新建立並分享。Vercel 上的舊 Redis endpoint 預設關閉；若自行開啟 `ACTIVITY_ALLOW_LEGACY_REDIS=1`，仍可能產生 Redis／Vercel 用量或費用，不屬本免費方案。
