// fatism-credits — Cloudflare Worker
// Endpoints:
//   POST /webhook  — Paddle webhook (transaction.completed → grant credits)
//   GET  /credits?email=... — read balance
// KV binding: CREDITS (key = lowercased email, value = integer string)
// Secret: PADDLE_WEBHOOK_SECRET (set via `wrangler secret put PADDLE_WEBHOOK_SECRET`)

const PACK_CREDITS = { pack5: 5, pack20: 20, pack50: 50 };

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

    return json({ error: 'not found' }, 404);
  },
};
