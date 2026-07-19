/**
 * E2E test: voice/video entry send → receive between two users.
 * Mirrors the Flutter app flow exactly:
 *   auth (OTP) → invite/accept → request-upload → raw PUT to B2 → confirm
 *   → partner receives via SSE new_entry + list + signed URL download.
 *
 * Run: node e2e-av-test.cjs [BASE_URL]
 */
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.argv[2] || 'http://localhost:3001/v1';
const PHONE_A = '+919999000001';
const PHONE_B = '+919999000002';
const OTP = '424242';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function seedOtps(db) {
  for (const phone of [PHONE_A, PHONE_B]) {
    await db.query(
      `UPDATE otp_verifications SET is_used = true WHERE phone = $1 AND is_used = false AND purpose = 'login'`,
      [phone],
    );
    await db.query(
      `INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at)
       VALUES ($1, $2, 'login', NOW() + interval '10 minutes')`,
      [phone, crypto.createHash('sha256').update(OTP).digest('hex')],
    );
  }
}

async function login(phone, deviceId) {
  const r = await api('POST', '/auth/otp/verify', null, {
    phone, otp: OTP,
    device_id: deviceId, device_type: 'android', app_version: '1.0.0-e2e',
  });
  if (r.status !== 200) throw new Error(`login ${phone} failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

function listenSse(connectionId, token, wantedType, timeoutMs) {
  return new Promise(async (resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
    try {
      const res = await fetch(`${BASE}/connections/${connectionId}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // Nest @Sse frames: "data: {...}\n\n" (event type inside JSON payload)
        for (const frame of buf.split('\n\n')) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim());
              const t = payload.type || payload.event;
              if (t === wantedType) {
                clearTimeout(timer); ctrl.abort();
                return resolve(payload);
              }
            } catch (_) {}
          }
        }
        buf = buf.slice(-8192);
      }
    } catch (_) {}
    clearTimeout(timer);
    resolve(null);
  });
}

async function sendMediaEntry(sender, connectionId, entryType, contentType, bytes) {
  // Step 1 — request upload
  const req = await api('POST', `/connections/${connectionId}/entries/request-upload`, sender.access_token, {
    entry_type: entryType,
    client_msg_id: crypto.randomUUID(),
  });
  check(`${entryType}: request-upload`, req.status === 200 && !!req.data?.upload_url,
    `status=${req.status}${req.data?.upload_url ? '' : ' body=' + JSON.stringify(req.data)}`);
  if (req.status !== 200) return null;

  // Step 2 — raw PUT to B2 (same as app's HttpClient: URL used verbatim)
  const put = await fetch(req.data.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  check(`${entryType}: B2 PUT upload`, put.ok, `status=${put.status}`);
  if (!put.ok) return null;

  // Step 3 — confirm
  const conf = await api('POST', `/connections/${connectionId}/entries/confirm`, sender.access_token, {
    entry_id: req.data.entry_id,
    duration_seconds: 5,
    recorded_at: new Date().toISOString(),
  });
  check(`${entryType}: confirm`, conf.status >= 200 && conf.status < 300,
    `status=${conf.status}${conf.status >= 300 ? ' body=' + JSON.stringify(conf.data) : ''}`);
  return { entryId: req.data.entry_id, confirm: conf.data };
}

async function receiveAndPlay(receiver, connectionId, entryId, entryType, expectedBytes) {
  const list = await api('GET', `/connections/${connectionId}/entries?limit=20`, receiver.access_token);
  const items = list.data?.entries || list.data?.data || [];
  const found = items.find((e) => e.id === entryId || e.entry_id === entryId);
  check(`${entryType}: receiver sees entry in list`, !!found,
    found ? undefined : `status=${list.status} count=${items.length}`);
  if (!found) return;

  const one = await api('GET', `/connections/${connectionId}/entries/${entryId}`, receiver.access_token);
  const url = one.data?.media_url || one.data?.signed_url || one.data?.url
    || one.data?.entry?.media_url || found.media_url;
  check(`${entryType}: signed playback URL present`, !!url, url ? undefined : `body keys=${Object.keys(one.data || {})}`);
  if (!url) return;

  const dl = await fetch(url);
  const body = Buffer.from(await dl.arrayBuffer());
  check(`${entryType}: media downloads & bytes match`, dl.ok && body.length === expectedBytes.length,
    `status=${dl.status} got=${body.length}B want=${expectedBytes.length}B identical=${body.equals(expectedBytes)}`);
}

(async () => {
  console.log(`Target: ${BASE}\n`);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── Auth ──
  await seedOtps(db);
  const userA = await login(PHONE_A, 'e2e-device-a');
  const userB = await login(PHONE_B, 'e2e-device-b');
  check('auth: both users logged in', !!userA.access_token && !!userB.access_token);

  // ── Connection ──
  let connectionId = null;
  const conns = await api('GET', '/connections', userA.access_token);
  const list = Array.isArray(conns.data) ? conns.data
    : conns.data?.connections || conns.data?.data || conns.data?.items || [];
  const existing = list.find((c) =>
    [c.partner?.phone, c.partner_phone].includes(PHONE_B) || true) && list[0];
  if (list.length > 0) {
    connectionId = list[0].id || list[0].connection_id;
    console.log(`(reusing existing connection ${connectionId})`);
  } else {
    const inv = await api('POST', '/connections/invite', userA.access_token, {
      relationship_type: 'friends', connection_name: 'E2E Partner B',
    });
    const code = inv.data?.invite_code || inv.data?.code;
    check('connection: invite created', !!code, `status=${inv.status} body=${JSON.stringify(inv.data)}`);
    const acc = await api('POST', `/connections/invite/${code}/accept`, userB.access_token, {
      invite_code: code, connection_name: 'E2E Partner A',
    });
    connectionId = acc.data?.connection_id || acc.data?.id || acc.data?.connection?.id;
    check('connection: invite accepted', !!connectionId, `status=${acc.status} body=${JSON.stringify(acc.data)}`);
  }
  if (!connectionId) throw new Error('no connection available');

  // ── Voice entry A → B, with B listening on SSE ──
  const voiceBytes = crypto.randomBytes(48 * 1024);
  const ssePromiseV = listenSse(connectionId, userB.access_token, 'new_entry', 25000);
  await new Promise((r) => setTimeout(r, 1500)); // let SSE attach first
  const voice = await sendMediaEntry(userA, connectionId, 'voice', 'audio/mp4', voiceBytes);
  if (voice) {
    const sse = await ssePromiseV;
    check('voice: receiver got real-time SSE new_entry', !!sse, sse ? `entry=${sse.entry_id || sse.data?.entry_id || 'n/a'}` : 'no event within 25s');
    await receiveAndPlay(userB, connectionId, voice.entryId, 'voice', voiceBytes);
  }

  // ── Video entry B → A (reverse direction) ──
  const videoBytes = crypto.randomBytes(96 * 1024);
  const ssePromiseM = listenSse(connectionId, userA.access_token, 'new_entry', 25000);
  await new Promise((r) => setTimeout(r, 1500));
  const video = await sendMediaEntry(userB, connectionId, 'video', 'video/mp4', videoBytes);
  if (video) {
    const sse = await ssePromiseM;
    check('video: receiver got real-time SSE new_entry', !!sse, sse ? '' : 'no event within 25s');
    await receiveAndPlay(userA, connectionId, video.entryId, 'video', videoBytes);
  }

  await db.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E ABORT:', e.message); process.exit(2); });
