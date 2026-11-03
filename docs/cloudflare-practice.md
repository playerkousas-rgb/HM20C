# 活動題庫：Cloudflare Free 一次設定

這是部署者的設定指南。尚未部署及用兩部實體手機測試前，不應向領袖宣稱活動題庫的連網功能已完成驗收。**固定題庫的題目／答案 QR 不需這個服務**。Cloudflare Free 有硬上限和服務條款，可能更改；超額或故障時活動可能停用，沒有無限量或永久免費的保證。Vercel 仍負責 App 網頁和領袖驗證，有自己的額度及可能費用。

v1.2.2 的活動管理介面及 v1.2.1 的題庫入口與分類屬前端更新；若已完成 v1.2.0 的 Worker／D1 和驗證設定，這次不需重建資料庫、重跑 schema 或重部署 Worker。既有活動的資料及 QR 沿用，仍須實際測試。

**密碼如何運作：**共用領袖密碼 `LEADER_PASSWORD` 只由 Vercel 使用。Worker 儲存另一個獨立、高隨機性的伺服器秘密 `LEADER_SESSION_SECRET`，以及固定的正式 Vercel 驗證網址。每次領袖手動建立／修改／延長／結束活動，Worker 會向該正式網址確認目前登入仍有效；成員掃碼及手動更新只直接讀取 Worker，不會輪詢或向 Vercel 驗證。這會增加少量 Vercel 函數請求；服務或配額不足時，寫入可能失敗，已儲存的本機題目及離線 QR 仍可使用。題目內容和地圖不會因驗證而送到 Vercel。

## 全新服務：一次準備

已有 Worker 和 D1 的管理員，**不要重新建立或初始化資料庫**，請看下一節。

1. 管理員登入自己的 Cloudflare 帳戶，確認 **Workers Free**，不要啟用 Workers Paid 或其他收費服務。核對 [Workers 上限](https://developers.cloudflare.com/workers/platform/limits/)、[D1 收費及上限](https://developers.cloudflare.com/d1/platform/pricing/) 和帳戶實際設定。所有旅團共用一個帳戶的額度；不是每個旅團各有一份。
2. 在電腦使用本 repo、Node 22，執行 `npm ci` 和 `npx wrangler login`，由 Cloudflare 的瀏覽器頁面登入。領袖和成員不需各自註冊 Cloudflare，也不用把密碼或 token 發到聊天室。
3. 在同一 Cloudflare 帳戶的 Workers & Pages 清單檢查名稱。**第一次部署必須選用尚未存在的 Worker 名稱；部署到既有名稱可能覆蓋現有 Worker。** 建立新的 D1：`npx wrangler d1 create hm20c-practices`。把 `wrangler.toml.example` 複製為同一目錄的 `wrangler.toml`，填入 D1 的 `database_id`，並選擇未使用的 Worker `name`；不要把秘密寫進該檔。此本機檔已被 `.gitignore` 排除。
4. 在 `wrangler.toml` 的 `ALLOWED_ORIGINS` 寫正式 App 的完整 HTTPS origin，例如 `https://example.vercel.app`（只作格式例子；無最後的 `/` 或路徑）。`LEADER_VERIFY_URL` 則要指向**同一個固定 Production 網址**加 `/api/leader-verify`，例如 `https://example.vercel.app/api/leader-verify`。不要填 Preview、歷次部署獨立網址或可改變的外部網址。`ALLOWED_ORIGINS` 是瀏覽器跨來源設定，**不是**存取控制；持活動 QR 者仍能讀公開內容。
5. 只對剛建立、尚未初始化的 D1 執行 `npx wrangler d1 execute hm20c-practices --remote --file=cloudflare/schema.sql`。不要對其他現有資料庫執行，也不要重建已成功設定的資料庫。若控制台表格數與結果不一致，可用 `npx wrangler d1 execute hm20c-practices --remote --command "PRAGMA table_list"` 只讀查詢，確認 `activities` 表格。先執行 `npx wrangler deploy --dry-run` 檢查設定；它不會部署，也不能替代名稱及 database ID 的核對。查部署紀錄時，`10007` 不足以證明同名 Pages 或其他帳戶的項目不存在。
6. 在私人環境準備獨立、高隨機性的 `LEADER_SESSION_SECRET`；例如自己的電腦執行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`。它不是領袖密碼，不可給領袖或成員；不要貼到聊天、Git、`wrangler.toml`、備份或 `VITE_` 變數。如 Vercel 已有此秘密，先確認其是否已是獨立高隨機值，避免不必要地覆蓋；如無法確認原值，安排更換並通知領袖現有登入會失效。
7. 確認名稱尚未被使用、dry-run 指向正確資料庫後，執行 `npx wrangler deploy` 建立 Worker；尚未設定秘密時寫入會被拒絕。用 `npx wrangler secret put LEADER_SESSION_SECRET` 在安全提示中輸入上述秘密；**不需要在 Worker 設定或更新領袖密碼**。Wrangler 的 secret 更新會立即部署同一 Worker 的新版本；請確認名稱及帳戶正確，不要把秘密寫成命令列參數。
8. 在 Vercel **Production** 設定：既有共用 `LEADER_PASSWORD`；與 Worker 相同的 `LEADER_SESSION_SECRET`；及公開的 `VITE_ACTIVITY_API_URL`（Worker 網址加 `/api/activity`）。後者是公開網址，不是密鑰。確認設定後重新部署 Vercel Production（不能只上傳 `dist/`）。新部署必須包含 `/api/leader-verify`；若尚未部署、兩邊伺服器秘密不一致、CORS 或正式網址錯誤，領袖的活動寫入會失敗。沒有 Worker 網址時正式版不會偷偷回退至舊 Redis。
9. 在兩部不同手機測試：共用密碼登入 → A 團建立題組及活動 → B 團建立另一活動 → 比較 QR → 成員各自掃碼 → A 改題 → 成員手動更新，確認 B 不變。另測期限延長、過期、未公布答案不進公開回應、網絡中斷及飛航後備。正式 Cloudflare、CORS、iOS／Android 相機及網絡須實測。

## 已有 Worker／D1：升級而非重建

- 先備份題庫及活動管理資料，檢查目前使用的帳戶、Worker 名稱和 D1 ID。保留原本 `wrangler.toml`；若重新下載分支，它是被 Git 排除的私人設定檔，不會隨 ZIP 自動帶上。只在同一配置的 `[vars]` 增加 `LEADER_VERIFY_URL`，指向**正式**網站加 `/api/leader-verify`，並保留原 `ALLOWED_ORIGINS`、Worker 名稱、D1 名稱及 ID。Wrangler 部署會以設定檔覆蓋一般變數，若另在 Cloudflare 後台設過一般變數也要先核對；部署不會刪除現有 secrets。不要新建另一 Worker／資料庫。
- **不需 schema migration，也不要重跑 `schema.sql`**。新驗證方式沿用現有 `activities` 表格及現有活動 ID／資料。
- 配置 Vercel 與同一 Worker 的固定 `LEADER_SESSION_SECRET`，按上面第 6–8 步中的秘密與 Vercel 設定進行（不要重新建立 Worker）；確認 `VITE_ACTIVITY_API_URL` 指向同一 Worker。若 Worker 已存有舊 `LEADER_PASSWORD`，新版不會使用它；不必為這次升級而刪除或再修改它。
- 安排維護時段，確認 `npx wrangler deploy --dry-run` 指向同一 Worker 和 D1 後更新該 Worker；同時部署包含新驗證 API 的 Vercel Production。**先前與新版前後端並非完全相容**，在兩者及設定均完成前，活動寫入可能暫停。切換前先備份舊 Redis 活動並與領袖協調；舊 Redis 資料不會自動轉到 D1。
- 升級後測登入、建立和延長、A／B 隔離、成員手動讀取；亦要測用舊密碼／舊登入不能在新的正式網址修改活動。不得只憑本機測試宣稱真實服務已驗收。

## 日後更換共用領袖密碼

**只改 Vercel，不用改 Cloudflare。** 在 Vercel 專案 Settings → Environment Variables 修改 Production 的 `LEADER_PASSWORD`，儲存後重新部署 Production；環境變數不會改變現有部署。通知領袖用新密碼重新登入。固定的 `LEADER_SESSION_SECRET`、`LEADER_VERIFY_URL`、Worker、D1 和現有活動 QR 均不用為一般換密碼而修改。

新 Production 就緒後，Worker 會向固定正式網址驗證每次領袖寫入：舊密碼不能在該正式網址新登入；即使舊憑證或舊版本網站仍可簽發舊憑證，也不能用來修改該 Worker 的活動。若已開啟的舊領袖頁面嘗試修改活動而收到驗證失效，會鎖回成員模式，本機資料不會因此刪除。

**重要限制：**已開啟的領袖頁面可能離線保持最多 8 小時，改密碼不會即時收回它已顯示或下載的答案、題庫或地圖工具；重新載入或關頁後須重新登入。瀏覽器已有地圖和計算程式，因此這不是絕對防作弊系統。若擔心有人以舊密碼在**舊 Vercel 部署網址**解鎖舊版介面，管理員應一次檢查 [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)：使用 Vercel Authentication 的 **Standard Protection** 保護舊及預覽部署，同時保持正式網址公開，並在登出／無痕模式實測正式網址可開、舊獨立網址需要 Vercel 登入；另檢查分享連結、例外及其他公開 Production 網域。不要誤選會封鎖所有成員的 All Deployments。無法代查帳戶設定，實際保護範圍以 Vercel 後台及測試為準。

若伺服器秘密本身洩漏或需要輪換，須安排維護並在 Vercel 和同一 Worker 更新 `LEADER_SESSION_SECRET`、重新部署及測試；這是更換**服務密鑰**，不是日常更換領袖密碼。

## 給領袖和成員

- 一個共用領袖密碼，不按旅團登記。領袖選「活動題庫 → 建立題組」，可在同一套中新增多題；每次建立活動，伺服器產生隨機活動 ID 和獨立管理鑰匙。A、B 團各自建立會有不同 QR；同一手機想以同一套題目辦多個活動，可先「複製題組」再分別建立。活動 QR 只有讀取 ID，不含管理鑰匙或未公布答案。持 QR 者都可讀公開內容；這不是端對端加密或防作弊。
- 建立時由領袖選到期時間（最少 1 分鐘、最長 365 日），到期前可延長；正常修改／公布不會自動延長。過期或結束後，舊 QR 失效，需要新活動及新 QR；過期後先在該題組按「解除本機活動連結」，再建立活動。到期不能撤回已下載的題目或答案。
- 成員掃活動 QR 首次讀取需網絡。之後不定時輪詢、不自動重連更新；要取得新題目或已公布答案，按「更新題目及答案」。離線可看最後成功讀取的副本；出發前另存固定題目 QR，必要時掃新的固定題目或答案 QR。
- 題庫及管理鑰匙保存在目前瀏覽器和私人備份。共用同一手機瀏覽器時題庫不是隔離的旅團帳戶；備份含未公布答案及管理鑰匙，只由領袖保管。成員目前只保存一套多題題組，讀取另一活動會先提醒並取代現有副本。
- 香港時間每日早上 **08:00** 是日額度重設時間（00:00 UTC）。截至 2026-11-03，[Workers Free](https://developers.cloudflare.com/workers/platform/limits/) 每帳戶每天 100,000 次請求，每次 HTTP／排程 CPU 限 10 ms；[D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) 另有每天 500 萬行讀取、10 萬行寫入、帳戶總儲存 5 GB 及最多 10 個資料庫。索引更新也可計作寫入。首次讀取、手動更新、領袖修改、CORS 預檢、排程、其他 Worker、管理員查詢和惡意請求等均可能消耗相關額度；每次領袖連網寫入另產生一次 Vercel 驗證請求，Vercel 登入及其他流量另計。到 Cloudflare 和 Vercel 後台監察實際用量及 CPU；本機測試不證明正式環境永遠不超限，也不是按旅團人數保證容量或所有服務的費用上限。
- 既有 Redis 連網活動不會自動遷入 D1。換用 Worker 前先備份題庫／管理資料及協調領袖；新 App 指向新資料庫後，舊活動 QR 不會自動轉移，要重新建立並分享。Vercel 上的舊 Redis endpoint 預設關閉；若自行開啟 `ACTIVITY_ALLOW_LEGACY_REDIS=1`，仍可能產生 Redis／Vercel 用量或費用，不屬本免費方案。

Worker 程式位於 `cloudflare/worker.js`，全新資料庫的資料表在 `cloudflare/schema.sql`；`npm test` 使用本機 SQLite 與 workerd 模擬驗證，不會連接或建立真正的 Cloudflare 資源。`wrangler.toml.example` 的排程每小時清理到期活動，最多每次 1,000 筆；讀寫即時拒絕已過期活動。配額耗盡、服務故障或積壓可能延遲實際刪除，資料備份和保留另受 Cloudflare 政策約束。
