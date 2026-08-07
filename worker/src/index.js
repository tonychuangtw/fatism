// fatism-credits — Cloudflare Worker
// Endpoints:
//   POST /webhook  — Paddle webhook (transaction.completed → grant credits)
//   GET  /credits?email=... — read balance
//   POST /analyze  — palm/face photo → Kimi K3 vision analysis
// KV binding: CREDITS (key = lowercased email, value = integer string;
//                      also rl:<ip>:<date> daily rate-limit counters)
// Secrets: PADDLE_WEBHOOK_SECRET, KIMI_API_KEY (set via `wrangler secret put <NAME>`)

const PACK_CREDITS = { pack5: 5, pack20: 20, pack50: 50 };

const KIMI_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_MODEL = 'kimi-k3';
const ANALYZE_FREE_PER_DAY = 5;          // per-IP daily cap while palm/face is in free beta
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // data-URL length cap (frontend downscales to ~1280px)

const LANG_NAME = { tw: '繁體中文（台灣用語）', cn: '简体中文', en: 'English' };

const ANALYZE_PROMPTS = {
  palm: `你是一位精通中西手相學的資深命理老師。使用者上傳了一張手掌照片。

先判斷照片是否為清晰可辨的手掌：若不是手掌、太模糊、光線太暗或掌紋看不清楚，禮貌說明原因並請使用者重拍（光線充足、五指張開、掌心正對鏡頭），不要編造分析。

若可以分析，以 Markdown 輸出，結構：
## 整體印象
## 生命線
## 智慧線
## 感情線
## 事業線與其他紋路
## 掌型與掌丘
## 綜合建議

要求：先具體描述照片中實際看到的特徵（線的長短、深淺、彎直、分岔、起訖位置），再對應傳統手相學解讀；語氣溫暖專業、正向但不浮誇。結尾加一行斜體免責聲明：手相解讀僅供反思與啟發，不構成醫療、財務或任何人生決策建議。`,
  face: `你是一位精通傳統面相學（麻衣相法體系）的資深命理老師。使用者上傳了一張正面人像照片。

先判斷照片是否為清晰可辨的正面臉部：若不是人臉、太模糊、側臉角度過大或光線太暗，禮貌說明原因並請使用者重拍（正面、光線均勻、露出額頭與下巴），不要編造分析。

若可以分析，以 Markdown 輸出，結構：
## 整體印象
## 三停（上停・中停・下停）
## 五官解讀（眉、眼、鼻、口、耳）
## 十二宮位重點（命宮、財帛宮、夫妻宮、官祿宮、田宅宮擇要）
## 氣色與神態
## 綜合建議

要求：先具體描述照片中實際看到的特徵（比例、形狀、氣色），再對應傳統面相學解讀；語氣溫暖尊重，聚焦優勢與提醒，避免外貌評判或負面斷言。結尾加一行斜體免責聲明：面相解讀僅供反思與啟發，不構成醫療、財務或任何人生決策建議。`,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of `${ts}:${rawBody}`>
async function verifyPaddleSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(';').map(kv => kv.split('=')));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  // Reject events older than 15 min (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 900) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== h1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ h1.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/credits' && request.method === 'GET') {
      const email = (url.searchParams.get('email') || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return json({ error: 'invalid email' }, 400);
      const v = await env.CREDITS.get(email);
      return json({ email, credits: v ? parseInt(v, 10) : 0 });
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const ok = await verifyPaddleSignature(
        rawBody, request.headers.get('Paddle-Signature'), env.PADDLE_WEBHOOK_SECRET);
      if (!ok) return json({ error: 'bad signature' }, 401);

      const evt = JSON.parse(rawBody);
      if (evt.event_type !== 'transaction.completed') return json({ ignored: evt.event_type });

      const txnId = evt.data?.id;
      const custom = evt.data?.custom_data || {};
      const email = (custom.email || evt.data?.customer?.email || '').trim().toLowerCase();
      const pack = custom.pack;
      const credits = PACK_CREDITS[pack];
      if (!email || !credits) return json({ error: 'missing email or unknown pack' }, 422);

      // Idempotency: skip if this transaction was already processed
      const seenKey = `txn:${txnId}`;
      if (await env.CREDITS.get(seenKey)) return json({ ok: true, duplicate: true });

      const cur = parseInt((await env.CREDITS.get(email)) || '0', 10);
      await env.CREDITS.put(email, String(cur + credits));
      await env.CREDITS.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 90 });

      return json({ ok: true, email, granted: credits, balance: cur + credits });
    }

    if (url.pathname === '/analyze' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

      const kind = body.kind;
      const image = body.image || '';
      const lang = LANG_NAME[body.lang] ? body.lang : 'tw';
      if (!ANALYZE_PROMPTS[kind]) return json({ error: 'kind must be palm or face' }, 400);
      if (!image.startsWith('data:image/')) return json({ error: 'image must be a data URL' }, 400);
      if (image.length > MAX_IMAGE_BYTES) return json({ error: 'image too large' }, 413);

      // Per-IP daily free quota (KV counter, expires after 1 day)
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const rlKey = `rl:${ip}:${day}`;
      const used = parseInt((await env.CREDITS.get(rlKey)) || '0', 10);
      if (used >= ANALYZE_FREE_PER_DAY) {
        return json({ error: 'daily limit reached', limit: ANALYZE_FREE_PER_DAY }, 429);
      }
      await env.CREDITS.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 24 });

      const upstream = await fetch(KIMI_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.KIMI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: KIMI_MODEL,
          max_tokens: 2500,
          messages: [
            { role: 'system', content: `${ANALYZE_PROMPTS[kind]}\n\n全文一律使用${LANG_NAME[lang]}回答。` },
            { role: 'user', content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: '請依照指示分析這張照片。' },
            ] },
          ],
        }),
      });

      if (!upstream.ok) {
        const detail = await upstream.text();
        console.log('kimi error', upstream.status, detail.slice(0, 500));
        return json({ error: 'analysis service unavailable' }, 502);
      }
      const data = await upstream.json();
      const result = data.choices?.[0]?.message?.content;
      if (!result) return json({ error: 'empty analysis' }, 502);

      return json({ result, remaining: ANALYZE_FREE_PER_DAY - used - 1 });
    }

    return json({ error: 'not found' }, 404);
  },
};
