/**
 * Focused verification for the profile surface added this session:
 *   - GET  /users/me                     (new route → getProfile)
 *   - PUT  /onboarding/profile           (name save)
 *   - POST /onboarding/avatar/upload-url (presigned B2 URL)
 * Reuses the e2e OTP-login flow. Run: node profile-verify.cjs [BASE_URL]
 */
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.argv[2] || 'http://localhost:3001/v1';
const PHONE = '+919999000001';
const OTP = '424242';

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

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`Target: ${BASE}\n`);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(`UPDATE otp_verifications SET is_used = true WHERE phone = $1 AND is_used = false AND purpose = 'login'`, [PHONE]);
    await db.query(
      `INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at)
       VALUES ($1, $2, 'login', NOW() + interval '10 minutes')`,
      [PHONE, crypto.createHash('sha256').update(OTP).digest('hex')],
    );

    const auth = await api('POST', '/auth/otp/verify', null, {
      phone: PHONE, otp: OTP, device_id: 'profile-verify', device_type: 'android', app_version: '1.0.0-verify',
    });
    check('auth: logged in', auth.status === 200 && !!auth.data.access_token, `status ${auth.status}`);
    const token = auth.data.access_token;
    if (!token) throw new Error('no token');

    // 1. GET /users/me — the newly routed endpoint
    const me = await api('GET', '/users/me', token);
    check('GET /users/me → 200', me.status === 200, `status ${me.status}`);
    check('GET /users/me has id + masked phone', !!me.data?.id && typeof me.data?.phone === 'string', JSON.stringify(me.data));
    check('GET /users/me exposes avatar_url field', me.data && 'avatar_url' in me.data, `avatar_url=${me.data?.avatar_url}`);

    // 2. PUT /onboarding/profile — name save returns the updated profile
    const NAME = 'Verify Bot ' + Date.now().toString().slice(-4);
    const upd = await api('PUT', '/onboarding/profile', token, { name: NAME });
    check('PUT /onboarding/profile → 200', upd.status === 200, `status ${upd.status}`);
    check('PUT /onboarding/profile persisted name', upd.data?.name === NAME, `name=${upd.data?.name}`);

    // Confirm the name is readable back through GET /users/me
    const me2 = await api('GET', '/users/me', token);
    check('GET /users/me reflects saved name', me2.data?.name === NAME, `name=${me2.data?.name}`);

    // 3. POST /onboarding/avatar/upload-url — presigned B2 target
    const pre = await api('POST', '/onboarding/avatar/upload-url', token);
    check('POST avatar/upload-url → 200', pre.status === 200, `status ${pre.status}`);
    check('avatar upload-url returns upload_url + avatar_key',
      typeof pre.data?.upload_url === 'string' && /^avatars\//.test(pre.data?.avatar_key || ''),
      `key=${pre.data?.avatar_key}`);
  } finally {
    await db.end();
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
