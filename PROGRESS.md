# fatism 線 — webui-fixes 兩項通用檢修

STATUS: done
最後更新：2026-08-15（台北）

主線派工來源：`claude-shared/projects/webui-fixes/discussion.md`

## 負責站台盤點

| 站台 | 位址 | 性質 |
|---|---|---|
| 命運閣 Fatism 主站 | https://tonychuangtw.github.io/fatism/ | GitHub Pages 靜態站 |
| 五個 widget | `/widgets/{palm,face,bazi,ziwei,tarot}/` | 同站靜態頁 |
| 五篇 learn 文章 | `/learn/*.html` | 同站靜態頁 |
| 管理後台 | `/admin.html` | 同站靜態頁（super 帳號限定） |
| pricing | `/pricing.html` | 同站靜態頁 |
| fatism-credits Worker | `fatism-credits.tonychuangtw.workers.dev` | Cloudflare Worker，純 API 無 UI |

## 問題 1：原生 alert/confirm/prompt → 站內 modal（有中，已修）

掃出 5 處，全部改掉：

- `admin.html` — `prompt('把 X 的點數設為：')`、`confirm('確定升為 SUPER？')`
  → 新增站內 `.adm-overlay/.adm-dialog` 對話框（深紫底＋金框，沿用站內 `.btn` / `.btn-ghost`），
  以 `uiConfirm()` / `uiPrompt()` 兩個 Promise 版 helper 取代。確認類保留「確定／取消」兩段式；
  設定點數的輸入框改成 number 並預帶該帳號目前點數。支援 Esc 取消、Enter 送出、點遮罩關閉。
- `widgets/{ziwei,bazi,tarot}/index.html` — `alert(t('acctEmailErr'))`（信箱格式錯誤）
  → 改成登入 modal 內的紅框行內錯誤訊息 `#acctEmailErrBox`，樣式比照 `assets/auth.js` 的 `.fa-err`。

其餘檔案（index/pricing/learn/palm/face widget/worker）掃描結果為 0 處，無需改。
修完全站 `grep -rnE "\balert\(|\bconfirm\(|\bprompt\("` 只剩一行註解。
四個改動檔的 inline script 均通過 `node --check`。

## 問題 2：Google 登入鈕在 App 內建瀏覽器消失（不適用）

本站**沒有 Google / 第三方登入**。登入是自建的 email + 密碼（JWT），
前端 `assets/auth.js` 自畫 modal 打自家 Worker 的 `/auth/*`，
不載入 `accounts.google.com` 或任何 GIS 元件（全站 grep 只有金流文案提到 "Google Pay"）。
webview 擋第三方網域不影響本站登入鈕，無 fallback 需求。

## 部署

GitHub Pages（push 即上線）。commit：見 fatism repo `main`。
