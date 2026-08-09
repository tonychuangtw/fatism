# fatism-credits Worker

功能（完整 API 規格見 `../docs/app-sync.md`）：

1. 帳號系統 `/auth/*` — email+密碼註冊/登入，JWT 90 天；新帳號送 3 點
   - `tonychuangtw@gmail.com` 硬編為 super（不扣點、不限量、可用 /admin/*）
2. `POST /analyze` — 手相/面相照片 → Kimi K3 視覺分析（要登入；成功才扣 1 點；每帳號每日上限 30 次防濫用）
   - body：`{"kind":"palm"|"face","image":"data:image/jpeg;base64,...","lang":"tw"|"cn"|"en"}`
3. Paddle webhook → 發點數到 KV；前端用 `/credits?email=` 查餘額
4. `/admin/*` — 管理後台 API（`../admin.html` 用）：用戶列表、調點數、設角色、每日用量

## 部署步驟

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create CREDITS   # 把回傳的 id 填進 wrangler.toml
npx wrangler secret put AUTH_SECRET        # JWT 簽名用，隨機 64 字元；換掉＝全站強制重新登入
npx wrangler secret put KIMI_API_KEY       # 貼 Kimi 中國站 key（~/.kimi-code/config.toml 裡那把）
npx wrangler secret put PADDLE_WEBHOOK_SECRET   # Paddle 開好後再補；沒設之前 /webhook 一律 401，不影響 /analyze
npx wrangler deploy
```

部署完把 workers.dev 網址填進：
- `widgets/palm/index.html` 頂部 `WORKER_URL`
- `widgets/face/index.html` 頂部 `WORKER_URL`
- `pricing.html` 的 `PADDLE_CONFIG.workerUrl`（Paddle 上線時）

## 本機測試 /analyze

```bash
cd worker
echo 'KIMI_API_KEY=sk-...' > .dev.vars    # 已在 .gitignore，不會進 repo
npx wrangler dev --local
# 另開 shell：
curl -X POST http://localhost:8787/analyze -H 'Content-Type: application/json' \
  -d '{"kind":"palm","image":"data:image/jpeg;base64,...","lang":"tw"}'
```

## Paddle dashboard 設定

1. Catalog → 建 3 個 product/price：pack5 NT$250、pack20 NT$800、pack50 NT$1800
2. Developer tools → Notifications → 新增 webhook：
   - URL: `https://fatism-credits.<acct>.workers.dev/webhook`
   - 事件勾 `transaction.completed`
   - 複製 secret → `wrangler secret put PADDLE_WEBHOOK_SECRET`
3. Developer tools → Authentication → 複製 client-side token

## 回填 pricing.html

`PADDLE_CONFIG`（pricing.html 頂部）填入：
- `clientToken`、三個 `priceIds`（pri_...）、`workerUrl`
- sandbox 測完把 `environment` 改 `'production'`

## 測試

```bash
curl "https://fatism-credits.<acct>.workers.dev/credits?email=test@example.com"
# → {"email":"test@example.com","credits":0}
```

Sandbox 測試卡：4242 4242 4242 4242，任意未來效期 + CVC。
