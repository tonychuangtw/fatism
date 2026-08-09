# fatism

算命互動網站 · 繁中 / 简中 / English

## 內容

| 項目 | 狀態 | 引擎 |
|---|---|---|
| 塔羅牌 Tarot | ✅ v2 (78 張完整 + 位置脈絡 + 凱爾特對位 + 整體綜觀) | 自製 |
| 八字命盤 BaZi | ✅ v2 (六親/三分項/大運評分/四柱解讀/當前運勢解讀) | `lunar-javascript` |
| 紫微斗數 Zi Wei | ✅ v2 (12 宮位+大限流年+三方四正+命宮深度+12宮逐宮+格局判讀) | `iztro` |
| 手相 Palmistry | ✅ v1 (照片上傳 → AI 視覺分析) | Kimi K3 vision (經 CF Worker) |
| 面相 Physiognomy | ✅ v1 (照片上傳 → AI 視覺分析) | Kimi K3 vision (經 CF Worker) |

## 目錄

```
index.html              ← 命運閣首頁（串接 3 個 widget）
pricing.html            ← 點數方案頁（3 種 pack；登入走 FatismAuth，Paddle 開通前隱藏結帳鈕）
admin.html              ← 管理後台（super 帳號限定：用戶/點數/角色/每日用量）
assets/auth.js          ← FatismAuth 共用登入元件（token、登入/註冊 modal、API 包裝）
docs/app-sync.md        ← 帳號/點數 API 規格 · 網頁與 App 共用後端說明
widgets/
  tarot/index.html      塔羅 · 78 張全 + 位置脈絡解讀 + 凱爾特對位 + 整體綜觀
  bazi/index.html       八字命盤 · 含六親 / 三分項 / 大運評分 / 四柱解讀 / 流年解讀
  ziwei/index.html      紫微斗數 · 12 宮位排盤 + 大限流年 + 命宮深度 + 12宮逐宮 + 格局判讀
  palm/index.html       手相 · 照片上傳 → Kimi K3 視覺分析（走 worker /analyze）
  face/index.html       面相 · 照片上傳 → Kimi K3 視覺分析（走 worker /analyze）
worker/                 Cloudflare Worker · Paddle webhook + 點數查詢 + /analyze 代理
```

手相／面相需要後端 `worker/`（見 `worker/README.md`），且**需登入**：
新帳號送 3 點，每次 AI 解讀扣 1 點；super 帳號（Tony）不扣點不限量。
Worker 網址統一放在 `assets/auth.js` 的 `WORKER_URL`。

## 本機預覽首頁

直接用瀏覽器打開 `index.html`。

## 在 CodePen 上跑

1. 開新 Pen → ⚙️ HTML Settings
2. 把 `widgets/tarot/index.html` 全部複製貼到 Pen 的 HTML 區
3. CSS / JS 區留空（已內嵌在 HTML 裡）
4. 儲存即可

## 本機預覽

直接用瀏覽器打開 `widgets/tarot/index.html` 即可。

## 規劃與決策

詳見 [`claude-shared/projects/fatism/discussion.md`](https://github.com/tonychuangtw/claude-shared/blob/main/projects/fatism/discussion.md)。
