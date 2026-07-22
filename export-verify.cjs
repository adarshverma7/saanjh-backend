/**
 * Verifies the data-export flow end-to-end: trigger GET /settings/data-export,
 * then confirm the background generation created a 'data_export' notification
 * with a working download link + a completion audit log. Cleans up after.
 * Run: node export-verify.cjs [BASE_URL]
 */
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.argv[2] || 'http://localhost:3001/v1';
const PHONE = '+919999000001';
const OTP = '424242';

async function api(method, path, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Target: ${BASE}\n`);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let userId;
  try {
    await db.query(`UPDATE otp_verifications SET is_used = true WHERE phone = $1 AND is_used = false AND purpose = 'login'`, [PHONE]);
    await db.query(`INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at) VALUES ($1, $2, 'login', NOW() + interval '10 minutes')`,
      [PHONE, crypto.createHash('sha256').update(OTP).digest('hex')]);
    const authRes = await fetch(BASE + '/auth/otp/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: PHONE, otp: OTP, device_id: 'export-verify', device_type: 'android', app_version: '1.0.0-verify' }),
    });
    const authData = await authRes.json();
    const token = authData.access_token;
    userId = authData.user_id || authData.user?.id;
    check('auth: logged in', !!token, `status ${authRes.status}`);
    if (!token) throw new Error('no token');
    if (!userId) { const u = await db.query('SELECT id FROM users WHERE phone=$1', [PHONE]); userId = u.rows[0]?.id; }

    const since = new Date();
    const trig = await api('GET', '/settings/data-export', token);
    check('GET /settings/data-export → 200', trig.status === 200, `status ${trig.status}`);

    // Poll for the background-generated notification
    let notif = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const r = await db.query(
        `SELECT id, data, created_at FROM notifications
         WHERE user_id = $1 AND type = 'data_export' AND created_at >= $2
         ORDER BY created_at DESC LIMIT 1`,
        [userId, since],
      );
      if (r.rows.length) { notif = r.rows[0]; break; }
    }
    check('data_export notification created', !!notif, notif ? '' : 'none within 15s');

    if (notif) {
      const data = typeof notif.data === 'string' ? JSON.parse(notif.data) : notif.data;
      check('notification carries a download_url', !!data.download_url, `keys=${Object.keys(data)}`);
      check('export format is json', data.format === 'json', `format=${data.format}`);
      // The link should actually resolve to the uploaded object
      if (data.download_url) {
        const dl = await fetch(data.download_url);
        check('download_url resolves (200)', dl.status === 200, `status ${dl.status}`);
        const bundle = await dl.json().catch(() => null);
        check('export bundle is valid JSON with counts', !!bundle && !!bundle.counts, bundle ? `counts=${JSON.stringify(bundle.counts)}` : 'not json');
      }
    }

    // Completion audit log present
    const audit = await db.query(
      `SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'user.data_export_completed' AND created_at >= $2 LIMIT 1`,
      [userId, since],
    );
    check('completion audit log written', audit.rows.length === 1);

    // Cleanup: remove the test notification we created
    if (notif) await db.query('DELETE FROM notifications WHERE id = $1', [notif.id]);
    console.log('cleaned up test notification');
  } finally {
    await db.end();
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
