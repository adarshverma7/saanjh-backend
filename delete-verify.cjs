/**
 * Verifies the account-deletion flow the frontend button now drives:
 *   login → POST /auth/account/delete/request → POST /auth/account/delete/confirm
 * then asserts the user is soft-deleted and sessions are deactivated.
 * Uses a THROWAWAY user (never a real test SIM) and hard-removes it after.
 * Run: node delete-verify.cjs [BASE_URL]
 */
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();

const BASE = process.argv[2] || 'http://localhost:3001/v1';
const PHONE = '+91888' + Date.now().toString().slice(-7); // throwaway, avoids 9999 test SIMs
const LOGIN_OTP = '424242';
const DELETE_OTP = '135790';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
  console.log(`Target: ${BASE}\nThrowaway: ${PHONE}\n`);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  let userId;
  try {
    // Login (creates the throwaway user)
    await db.query(`INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at) VALUES ($1,$2,'login',NOW()+interval '10 minutes')`, [PHONE, sha(LOGIN_OTP)]);
    const auth = await api('POST', '/auth/otp/verify', null, { phone: PHONE, otp: LOGIN_OTP, device_id: 'delete-verify', device_type: 'android', app_version: '1.0.0' });
    const token = auth.data?.access_token;
    userId = auth.data?.user?.id;
    check('login as throwaway user', !!token && !!userId, `status ${auth.status}`);
    if (!token) throw new Error('no token');

    // Step 1: request deletion (backend generates + "sends" a delete OTP)
    const req = await api('POST', '/auth/account/delete/request', token);
    check('POST /auth/account/delete/request → 200', req.status === 200, `status ${req.status}`);
    const seeded = await db.query(`SELECT 1 FROM otp_verifications WHERE phone=$1 AND purpose='delete_account' AND is_used=false`, [PHONE]);
    check('a delete_account OTP row was created', seeded.rows.length >= 1);

    // Wrong OTP is rejected
    const bad = await api('POST', '/auth/account/delete/confirm', token, { otp: '000000' });
    check('confirm with wrong OTP is rejected', bad.status === 401 || bad.status === 400, `status ${bad.status}`);

    // Seed a known delete OTP (stand-in for the SMS the user would receive)
    await db.query(`UPDATE otp_verifications SET is_used=true WHERE phone=$1 AND purpose='delete_account' AND is_used=false`, [PHONE]);
    await db.query(`INSERT INTO otp_verifications (phone, otp_hash, purpose, expires_at) VALUES ($1,$2,'delete_account',NOW()+interval '10 minutes')`, [PHONE, sha(DELETE_OTP)]);

    // Step 2: confirm with the correct OTP
    const conf = await api('POST', '/auth/account/delete/confirm', token, { otp: DELETE_OTP });
    check('POST /auth/account/delete/confirm → 200', conf.status === 200, `status ${conf.status}`);

    // Assert soft-delete + session deactivation
    const u = await db.query('SELECT deleted_at FROM users WHERE id=$1', [userId]);
    check('user is soft-deleted (deleted_at set)', !!u.rows[0]?.deleted_at, `deleted_at=${u.rows[0]?.deleted_at}`);
    const sess = await db.query(`SELECT COUNT(*)::int AS active FROM device_sessions WHERE user_id=$1 AND is_active=true`, [userId]);
    check('all sessions deactivated', sess.rows[0].active === 0, `active=${sess.rows[0].active}`);
  } finally {
    // Hard-remove the throwaway user so nothing lingers (delete FK children first)
    if (userId) {
      await db.query('DELETE FROM audit_logs WHERE user_id=$1', [userId]);
      await db.query('DELETE FROM device_sessions WHERE user_id=$1', [userId]);
      await db.query('DELETE FROM notification_preferences WHERE user_id=$1', [userId]);
      await db.query('DELETE FROM notifications WHERE user_id=$1', [userId]);
      await db.query('DELETE FROM users WHERE id=$1', [userId]);
    }
    await db.query(`DELETE FROM otp_verifications WHERE phone=$1`, [PHONE]);
    console.log('cleaned up throwaway user');
    await db.end();
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
