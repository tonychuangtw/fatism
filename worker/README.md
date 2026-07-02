# fatism-credits Worker

Paddle webhook → 發點數到 KV；前端用 `/credits?email=` 查餘額。

## 部署步驟（Tony 的 Paddle 帳號開好後）

```bash
cd worker
npx wrangler kv namespace create CREDITS   # 把回傳的 id 填進 wrangler.toml
npx wrangler secret put PADDLE_WEBHOOK_SECRET   # 貼 Paddle notification 的 secret
npx wrangler deploy
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
