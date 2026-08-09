// fatism-credits — Cloudflare Worker
// Endpoints:
//   POST /auth/register — {email,password} → create account (+welcome credits) → JWT
//   POST /auth/login    — {email,password} → JWT
//   GET  /auth/me       — Bearer → {email, role, credits}
//   POST /auth/password — Bearer + {oldPassword,newPassword}
//   POST /analyze       — Bearer; palm/face photo → Kimi K3 vision; super 免扣、其他扣 1 點
//   POST /webhook       — Paddle webhook (transaction.completed → grant credits)
//   GET  /credits?email=... — read balance (public, kept for pricing page)
//   GET  /admin/users   — super only; list accounts
//   POST /admin/credits — super only; {email, delta} or {email, set}
//   POST /admin/role    — super only; {email, role:'user'|'super'}
//   GET  /admin/stats   — super only; ?days=14 daily totals; ?day=YYYY-MM-DD per-user
// KV binding: CREDITS
//   <email>            → credits integer string (Paddle webhook 也寫這把 key)
//   user:<email>       → JSON {email,salt,hash,role,createdAt,lastLoginAt}
//   txn:<id>           → webhook idempotency marker
//   use:<day>          → analyze 當日總次數 (TTL 90d)
//   use:<day>:<email>  → analyze 當日個人次數 (TTL 90d，兼防濫用計數)
// Secrets: AUTH_SECRET, KIMI_API_KEY, PADDLE_WEBHOOK_SECRET (wrangler secret put <NAME>)

const SUPER_EMAILS = ['tonychuangtw@gmail.com']; // 永遠 super，不看 user 記錄
const WELCOME_CREDITS = 3;      // 新帳號贈點
const ANALYZE_COST = 1;         // 手相/面相每次扣點
const ABUSE_DAILY_CAP = 30;     // 非 super 每帳號每日 analyze 上限（就算點數夠也擋）
const TOKEN_TTL_SEC = 60 * 60 * 24 * 90; // JWT 90 天，app 端免頻繁重登
const PBKDF2_ITER = 100000;

const PACK_CREDITS = { pack5: 5, pack20: 20, pack50: 50 };

const KIMI_URL = 'https://api.moonshot.cn/v1/chat/completions';
const KIMI_MODEL = 'kimi-k3';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // data-URL length cap (frontend downscales to ~1280px)

const LANG_NAME = { tw: '繁體中文（台灣用語）', cn: '简体中文', en: 'English' };

const ANALYZE_PROMPTS = {
  palm: `你是一位精通中西手相學的資深命理老師。使用者上傳了一張手掌照片。

先判斷照片是否為清晰可辨的手掌：若不是手掌、太模糊、光線太暗或掌紋看不清楚，禮貌說明原因並請使用者重拍（光線充足、五指張開、掌心正對鏡頭），不要編造分析。

判斷左右手的規則（掌心朝鏡頭、手指朝上時）：拇指在畫面左側＝左手掌；拇指在畫面右側＝右手掌。若手指朝向其他方向，以拇指相對其餘四指的位置換算後再判斷；沒把握時不要斷言左右手。

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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ---------- crypto helpers ----------

const te = new TextEncoder();

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64url(buf) {
  return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s) {
  return b64url(te.encode(s));
}
function fromB64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function b64urlDecodeStr(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return b64(bits);
}

async function hmacSign(msg, secret) {
  const key = await crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, te.encode(msg));
}

async function signToken(payload, secret) {
  const h = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64urlStr(JSON.stringify(payload));
  const sig = b64url(await hmacSign(`${h}.${p}`, secret));
  return `${h}.${p}.${sig}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(await hmacSign(`${parts[0]}.${parts[1]}`, secret));
  if (!timingSafeEq(expected, parts[2])) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecodeStr(parts[1])); } catch { return null; }
  if (!payload.sub || !payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ---------- user / auth helpers ----------

function normEmail(e) {
  return (e || '').trim().toLowerCase();
}
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

async function getUser(env, email) {
  const raw = await env.CREDITS.get(`user:${email}`);
  return raw ? JSON.parse(raw) : null;
}
async function putUser(env, user) {
  await env.CREDITS.put(`user:${user.email}`, JSON.stringify(user));
}
function roleOf(email, user) {
  if (SUPER_EMAILS.includes(email)) return 'super';
  return (user && user.role) === 'super' ? 'super' : 'user';
}
async function getCredits(env, email) {
  return parseInt((await env.CREDITS.get(email)) || '0', 10);
}

// 回 null 表示未通過驗證；否則回 {email, user, role}
async function requireAuth(request, env) {
  if (!env.AUTH_SECRET) return { error: json({ error: 'auth not configured' }, 500) };
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  const payload = m ? await verifyToken(m[1].trim(), env.AUTH_SECRET) : null;
  if (!payload) return { error: json({ error: 'unauthorized' }, 401) };
  const email = normEmail(payload.sub);
  const user = await getUser(env, email);
  if (!user) return { error: json({ error: 'unauthorized' }, 401) };
  return { email, user, role: roleOf(email, user) };
}

async function authResponse(env, email, user) {
  const role = roleOf(email, user);
  const token = await signToken(
    { sub: email, role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC },
    env.AUTH_SECRET);
  return json({ token, email, role, credits: await getCredits(env, email) });
}

// Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of `${ts}:${rawBody}`>
async function verifyPaddleSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(';').map(kv => kv.split('=')));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  // Reject events older than 15 min (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 900) return false;
  const mac = await hmacSign(`${ts}:${rawBody}`, secret);
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEq(hex, h1);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 2026-08-07 Tony：網址一律不分大小寫。路徑與 query 參數名都轉小寫後再比對，
    // /Credits?Email=x 跟 /credits?email=x 走同一條路。參數「值」不動（email 另外自己轉）。
    const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    const qs = new URLSearchParams();
    for (const [k, v] of url.searchParams) qs.append(k.toLowerCase(), v);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const readBody = async () => {
      try { return await request.json(); } catch { return null; }
    };

    // ---------- public ----------

    if (path === '/credits' && request.method === 'GET') {
      const email = normEmail(qs.get('email'));
      if (!validEmail(email)) return json({ error: 'invalid email' }, 400);
      return json({ email, credits: await getCredits(env, email) });
    }

    if (path === '/auth/register' && request.method === 'POST') {
      if (!env.AUTH_SECRET) return json({ error: 'auth not configured' }, 500);
      const body = await readBody();
      if (!body) return json({ error: 'bad json' }, 400);
      const email = normEmail(body.email);
      const password = String(body.password || '');
      if (!validEmail(email)) return json({ error: 'invalid email' }, 400);
      if (password.length < 8) return json({ error: 'password too short (min 8)' }, 400);
      if (await getUser(env, email)) return json({ error: 'account exists' }, 409);

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const user = {
        email,
        salt: b64(salt),
        hash: await pbkdf2(password, salt),
        role: 'user',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      await putUser(env, user);
      // 贈點疊加在既有餘額上（先買點後註冊的人不吃虧）
      const cur = await getCredits(env, email);
      await env.CREDITS.put(email, String(cur + WELCOME_CREDITS));
      return authResponse(env, email, user);
    }

    if (path === '/auth/login' && request.method === 'POST') {
      if (!env.AUTH_SECRET) return json({ error: 'auth not configured' }, 500);
      const body = await readBody();
      if (!body) return json({ error: 'bad json' }, 400);
      const email = normEmail(body.email);
      const user = await getUser(env, email);
      if (!user) return json({ error: 'wrong email or password' }, 401);
      const hash = await pbkdf2(String(body.password || ''), fromB64(user.salt));
      if (!timingSafeEq(hash, user.hash)) return json({ error: 'wrong email or password' }, 401);
      user.lastLoginAt = new Date().toISOString();
      await putUser(env, user);
      return authResponse(env, email, user);
    }

    if (path === '/auth/me' && request.method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth.error) return auth.error;
      return json({ email: auth.email, role: auth.role, credits: await getCredits(env, auth.email) });
    }

    if (path === '/auth/password' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth.error) return auth.error;
      const body = await readBody();
      if (!body) return json({ error: 'bad json' }, 400);
      const oldHash = await pbkdf2(String(body.oldPassword || ''), fromB64(auth.user.salt));
      if (!timingSafeEq(oldHash, auth.user.hash)) return json({ error: 'wrong password' }, 401);
      const newPw = String(body.newPassword || '');
      if (newPw.length < 8) return json({ error: 'password too short (min 8)' }, 400);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      auth.user.salt = b64(salt);
      auth.user.hash = await pbkdf2(newPw, salt);
      await putUser(env, auth.user);
      return json({ ok: true });
    }

    // ---------- Paddle webhook ----------

    if (path === '/webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const ok = await verifyPaddleSignature(
        rawBody, request.headers.get('Paddle-Signature'), env.PADDLE_WEBHOOK_SECRET);
      if (!ok) return json({ error: 'bad signature' }, 401);

      const evt = JSON.parse(rawBody);
      if (evt.event_type !== 'transaction.completed') return json({ ignored: evt.event_type });

      const txnId = evt.data?.id;
      const custom = evt.data?.custom_data || {};
      const email = normEmail(custom.email || evt.data?.customer?.email);
      const pack = custom.pack;
      const credits = PACK_CREDITS[pack];
      if (!email || !credits) return json({ error: 'missing email or unknown pack' }, 422);

      // Idempotency: skip if this transaction was already processed
      const seenKey = `txn:${txnId}`;
      if (await env.CREDITS.get(seenKey)) return json({ ok: true, duplicate: true });

      const cur = await getCredits(env, email);
      await env.CREDITS.put(email, String(cur + credits));
      await env.CREDITS.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 90 });

      return json({ ok: true, email, granted: credits, balance: cur + credits });
    }

    // ---------- analyze (登入 + 扣點) ----------

    if (path === '/analyze' && request.method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth.error) return auth.error;

      const body = await readBody();
      if (!body) return json({ error: 'bad json' }, 400);

      const kind = body.kind;
      const image = body.image || '';
      const lang = LANG_NAME[body.lang] ? body.lang : 'tw';
      if (!ANALYZE_PROMPTS[kind]) return json({ error: 'kind must be palm or face' }, 400);
      if (!image.startsWith('data:image/')) return json({ error: 'image must be a data URL' }, 400);
      if (image.length > MAX_IMAGE_BYTES) return json({ error: 'image too large' }, 413);

      const isSuper = auth.role === 'super';
      const day = new Date().toISOString().slice(0, 10);
      const useKey = `use:${day}:${auth.email}`;
      const usedToday = parseInt((await env.CREDITS.get(useKey)) || '0', 10);

      if (!isSuper) {
        if (usedToday >= ABUSE_DAILY_CAP) {
          return json({ error: 'daily limit reached', limit: ABUSE_DAILY_CAP }, 429);
        }
        const credits = await getCredits(env, auth.email);
        if (credits < ANALYZE_COST) {
          return json({ error: 'insufficient credits', credits }, 402);
        }
      }

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

      // 成功才扣點（上游失敗不吃使用者點數）；KV 非原子，極端並發下可能少扣，可接受
      let remaining = null;
      if (!isSuper) {
        const cur = await getCredits(env, auth.email);
        remaining = Math.max(0, cur - ANALYZE_COST);
        await env.CREDITS.put(auth.email, String(remaining));
      }
      const ttl = { expirationTtl: 60 * 60 * 24 * 90 };
      await env.CREDITS.put(useKey, String(usedToday + 1), ttl);
      const total = parseInt((await env.CREDITS.get(`use:${day}`)) || '0', 10);
      await env.CREDITS.put(`use:${day}`, String(total + 1), ttl);

      return json({ result, remaining, role: auth.role });
    }

    // ---------- admin (super only) ----------

    if (path.startsWith('/admin/')) {
      const auth = await requireAuth(request, env);
      if (auth.error) return auth.error;
      if (auth.role !== 'super') return json({ error: 'forbidden' }, 403);

      if (path === '/admin/users' && request.method === 'GET') {
        const list = await env.CREDITS.list({ prefix: 'user:', limit: 1000 });
        const users = await Promise.all(list.keys.map(async k => {
          const u = JSON.parse((await env.CREDITS.get(k.name)) || '{}');
          const email = k.name.slice(5);
          return {
            email,
            role: roleOf(email, u),
            credits: await getCredits(env, email),
            createdAt: u.createdAt || null,
            lastLoginAt: u.lastLoginAt || null,
          };
        }));
        users.sort((a, b) => (b.lastLoginAt || '').localeCompare(a.lastLoginAt || ''));
        return json({ users, truncated: !list.list_complete });
      }

      if (path === '/admin/credits' && request.method === 'POST') {
        const body = await readBody();
        if (!body) return json({ error: 'bad json' }, 400);
        const email = normEmail(body.email);
        if (!validEmail(email)) return json({ error: 'invalid email' }, 400);
        let next;
        if (typeof body.set === 'number') next = Math.max(0, Math.floor(body.set));
        else if (typeof body.delta === 'number') next = Math.max(0, await getCredits(env, email) + Math.floor(body.delta));
        else return json({ error: 'need delta or set (number)' }, 400);
        await env.CREDITS.put(email, String(next));
        return json({ ok: true, email, credits: next });
      }

      if (path === '/admin/role' && request.method === 'POST') {
        const body = await readBody();
        if (!body) return json({ error: 'bad json' }, 400);
        const email = normEmail(body.email);
        const role = body.role;
        if (!['user', 'super'].includes(role)) return json({ error: 'role must be user or super' }, 400);
        if (SUPER_EMAILS.includes(email) && role !== 'super') {
          return json({ error: 'cannot demote a hardcoded super account' }, 400);
        }
        const user = await getUser(env, email);
        if (!user) return json({ error: 'no such account' }, 404);
        user.role = role;
        await putUser(env, user);
        return json({ ok: true, email, role });
      }

      if (path === '/admin/stats' && request.method === 'GET') {
        const oneDay = qs.get('day');
        if (oneDay) {
          // 單日各用戶用量
          const list = await env.CREDITS.list({ prefix: `use:${oneDay}:`, limit: 1000 });
          const rows = await Promise.all(list.keys.map(async k => ({
            email: k.name.slice(`use:${oneDay}:`.length),
            count: parseInt((await env.CREDITS.get(k.name)) || '0', 10),
          })));
          rows.sort((a, b) => b.count - a.count);
          return json({ day: oneDay, users: rows });
        }
        const days = Math.min(31, Math.max(1, parseInt(qs.get('days') || '14', 10)));
        const out = [];
        for (let i = 0; i < days; i++) {
          const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          out.push({ day: d, total: parseInt((await env.CREDITS.get(`use:${d}`)) || '0', 10) });
        }
        return json({ days: out });
      }

      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  },
};
