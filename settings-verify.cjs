/**
 * Verifies GET /settings + PATCH /settings round-trips (the endpoints the
 * Flutter Settings screen now syncs to). Run: node settings-verify.cjs [BASE_URL]
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); }

async function main() {
  console.log(`Target: ${BASE}\n`);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(`UPDATE otp_verifications SET is_used = true WHERE phone = $1 AND is_used = false AND purpose = 'login'`, [PHONE]);
    await db.query(`INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at) VALUES ($1, $2, 'login', NOW() + interval '10 minutes')`,
      [PHONE, crypto.createHash('sha256').update(OTP).digest('hex')]);
    const auth = await api('POST', '/auth/otp/verify', null, { phone: PHONE, otp: OTP, device_id: 'settings-verify', device_type: 'android', app_version: '1.0.0-verify' });
    const token = auth.data.access_token;
    check('auth: logged in', !!token, `status ${auth.status}`);
    if (!token) throw new Error('no token');

    // GET baseline
    const g0 = await api('GET', '/settings', token);
    check('GET /settings → 200', g0.status === 200, `status ${g0.status}`);
    check('GET /settings has notif fields', g0.data && 'new_entry' in g0.data && 'occasion_reminders' in g0.data, JSON.stringify(g0.data));

    // Flip new_entry to the opposite of current, occasion_reminders too
    const targetNew = !g0.data.new_entry;
    const targetOcc = !g0.data.occasion_reminders;
    const p = await api('PATCH', '/settings', token, { new_entry: targetNew, occasion_reminders: targetOcc });
    check('PATCH /settings → 200', p.status === 200, `status ${p.status}`);
    check('PATCH echoes new values', p.data.new_entry === targetNew && p.data.occasion_reminders === targetOcc,
      `new_entry=${p.data.new_entry} occ=${p.data.occasion_reminders}`);

    // GET again — persisted?
    const g1 = await api('GET', '/settings', token);
    check('GET reflects persisted toggles', g1.data.new_entry === targetNew && g1.data.occasion_reminders === targetOcc,
      `new_entry=${g1.data.new_entry} occ=${g1.data.occasion_reminders}`);

    // Partial PATCH must not disturb the other field
    const p2 = await api('PATCH', '/settings', token, { new_entry: g0.data.new_entry });
    check('partial PATCH leaves occasion_reminders untouched', p2.data.occasion_reminders === targetOcc,
      `occ=${p2.data.occasion_reminders}`);

    // Restore original values
    await api('PATCH', '/settings', token, { new_entry: g0.data.new_entry, occasion_reminders: g0.data.occasion_reminders });
    console.log('restored original notif prefs');
  } finally { await db.end(); }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
