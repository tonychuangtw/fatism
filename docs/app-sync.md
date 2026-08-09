# fatism 帳號／點數 API — 網頁版與 App 共用規格

網頁版與未來的 App **共用同一個後端**（Cloudflare Worker `fatism-credits`），
帳號、點數、解讀次數天然同步 —— 不需要另外的同步機制，因為狀態只存在伺服器一份。

- Base URL：`https://fatism-credits.tonychuangtw.workers.dev`
- 認證：JWT Bearer token，效期 90 天（HS256，`AUTH_SECRET` 簽名）
- 路徑與 query 參數名不分大小寫；email 一律伺服器端轉小寫
- 所有回應都是 JSON，都帶 CORS `*`

## 資料模型（KV）

| Key | 內容 |
|---|---|
| `<email>` | 點數餘額（整數字串）。Paddle webhook、扣點、admin 調點都操作這把 |
| `user:<email>` | `{email, salt, hash, role, createdAt, lastLoginAt}`（PBKDF2-SHA256 10 萬輪） |
| `txn:<paddle-txn-id>` | webhook 冪等標記（90 天 TTL） |
| `use:<YYYY-MM-DD>` / `use:<day>:<email>` | 每日 analyze 總量／個人量（90 天 TTL） |

角色：`user`（一般）／`super`（不扣點、不限量、可用 admin API）。
`tonychuangtw@gmail.com` 在程式碼裡硬編為永遠 super（`SUPER_EMAILS`），不可被降級。

## 端點

### 帳號

| Method | Path | Body / Query | 回應 |
|---|---|---|---|
| POST | `/auth/register` | `{email, password}`（密碼 ≥8 碼） | `{token, email, role, credits}`；新帳號送 3 點 |
| POST | `/auth/login` | `{email, password}` | 同上 |
| GET | `/auth/me` | Bearer | `{email, role, credits}` |
| POST | `/auth/password` | Bearer + `{oldPassword, newPassword}` | `{ok}` |

錯誤碼：400 格式錯、401 帳密錯/token 失效、409 已註冊過。

### 解讀（扣點核心）

| Method | Path | 說明 |
|---|---|---|
| POST | `/analyze` | Bearer 必帶。`{kind: "palm"\|"face", image: "data:image/jpeg;base64,...", lang: "tw"\|"cn"\|"en"}` |

- 一般帳號：餘額 <1 → **402** `{error:"insufficient credits"}`；每日超過 30 次 → **429**
- 扣點時機：**上游 AI 成功回覆才扣**，失敗不吃點數
- 回應：`{result: "<markdown>", remaining: <剩餘點數>, role}`；super 的 `remaining` 是 `null`
- 圖片請先縮到長邊 ≤1280px、JPEG 品質 0.85（web 端做法，App 照抄），data URL 上限 4MB

### 點數與購買

| Method | Path | 說明 |
|---|---|---|
| GET | `/credits?email=` | 查餘額（公開，不用登入） |
| POST | `/webhook` | Paddle `transaction.completed` → 加點。`custom_data` 需含 `{email, pack}` |

### 管理（Bearer 且 role=super）

| Method | Path | 說明 |
|---|---|---|
| GET | `/admin/users` | 全部帳號（email、role、credits、註冊/最後登入時間） |
| POST | `/admin/credits` | `{email, delta: ±n}` 或 `{email, set: n}`；可發給尚未註冊的 email |
| POST | `/admin/role` | `{email, role: "user"\|"super"}` |
| GET | `/admin/stats?days=14` | 近 N 天每日 analyze 總量 |
| GET | `/admin/stats?day=YYYY-MM-DD` | 單日各用戶用量 |

網頁版管理介面：`admin.html`（用 super 帳號登入即可）。

## App 端實作指引

1. **登入流**：註冊/登入 → 拿 `token` → 存進 Keychain（iOS）/ EncryptedSharedPreferences（Android）。
   之後所有請求帶 `Authorization: Bearer <token>`。
2. **點數顯示**：進場與每次解讀完打 `/auth/me` 刷新；`role === "super"` 顯示 ∞。
3. **401 處理**：token 過期（90 天）→ 清 token、跳登入頁。
4. **402 處理**：導去購點頁。
5. **購點**：
   - 網頁版走 Paddle Checkout（`custom_data.email` + `pack`，webhook 自動入點）。
   - App 上架 Apple/Google 需用 IAP —— 屆時在 Worker 加 `/iap/verify`（驗 App Store / Play 收據後入點），
     資料模型不用動：同一把 `<email>` key 加點即可，網頁與 App 點數天然互通。
6. **離線**：點數與結果都在伺服器，App 只需快取最後一次 `/auth/me` 顯示用，操作一律連線。
7. 塔羅／八字／紫微目前是純前端邏輯（不花 API 錢、不扣點），App 可直接內嵌同一套 JS 或 WebView。

## 網頁端共用元件

`assets/auth.js` → `window.FatismAuth`：token/帳號快取（localStorage `fatism_token` / `fatism_acct`）、
登入/註冊 modal（繁/簡/英）、`api()` 自動帶 Authorization。palm、face、pricing、admin 四頁都吃它。

## Secrets（wrangler secret put）

| 名稱 | 用途 |
|---|---|
| `AUTH_SECRET` | JWT 簽名（洩漏＝任何人可偽造登入，換掉即全站登出） |
| `KIMI_API_KEY` | Kimi K3 vision |
| `PADDLE_WEBHOOK_SECRET` | Paddle webhook 驗簽（未設前 /webhook 一律 401） |
