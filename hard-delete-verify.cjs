/**
 * Schema-level integration check for the hard-delete path. Seeds a throwaway
 * user soft-deleted 40 days ago (+ a child notification_preferences row) and
 * runs the exact SQL sequence from CleanupWorker.hardDeleteUser against the
 * real Neon schema, then asserts the rows are gone. This validates that every
 * table/column the purge touches exists (the delete_user_data path likely never
 * ran in prod because it required Redis). Run: node hard-delete-verify.cjs
 *
 * NOTE: mirrors CleanupWorker.hardDeleteUser — keep in sync if that changes.
 */
require('dotenv').config();
const crypto = require('crypto');
const { Client } = require('pg');

let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); }

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const phone = '+19' + Date.now().toString().slice(-10);
  const phoneHash = crypto.createHash('sha256').update(phone).digest('hex');
  const ins = await db.query(
    `INSERT INTO users (phone, phone_hash, name, is_verified, is_active, deleted_at, created_at, updated_at)
     VALUES ($1, $2, 'HardDelete Test', true, false, NOW() - interval '40 days', NOW(), NOW())
     RETURNING id`,
    [phone, phoneHash],
  );
  const userId = ins.rows[0].id;
  await db.query(`INSERT INTO notification_preferences (user_id) VALUES ($1)`, [userId]);
  console.log(`seeded throwaway user ${userId} (soft-deleted 40 days ago)\n`);

  try {
    // Grace-period guard (mirrors the worker)
    const rows = await db.query('SELECT deleted_at FROM users WHERE id = $1', [userId]);
    const daysSince = (Date.now() - new Date(rows.rows[0].deleted_at).getTime()) / 86_400_000;
    check('grace period elapsed (>=29 days)', daysSince >= 29, `${daysSince.toFixed(1)} days`);

    // ── The exact purge sequence from CleanupWorker.hardDeleteUser ──────────
    const journalMedia = await db.query(
      `SELECT media_key FROM personal_journal_entries WHERE user_id = $1 AND media_key IS NOT NULL`, [userId]);
    void journalMedia;
    await db.query(`DELETE FROM personal_journal_entries WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM device_sessions WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM otp_verifications WHERE phone = (SELECT phone FROM users WHERE id = $1)`, [userId]);
    await db.query(`DELETE FROM notification_preferences WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM invites WHERE inviter_id = $1 AND status != 'accepted'`, [userId]);
    await db.query(`UPDATE diary_entries SET author_id = NULL, updated_at = NOW() WHERE author_id = $1`, [userId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await db.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
       VALUES (NULL, 'account.hard_deleted', 'user', $1, $2)`,
      [userId, JSON.stringify({ requested_at: 'verify' })],
    );
    check('purge SQL executed against real schema (no column/table errors)', true);

    const userGone = (await db.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length === 0;
    check('user row hard-deleted', userGone);
    const prefsGone = (await db.query('SELECT 1 FROM notification_preferences WHERE user_id = $1', [userId])).rows.length === 0;
    check('child notification_preferences purged', prefsGone);
  } finally {
    // Tidy the audit row + any leftover user if an assertion failed mid-way
    await db.query(`DELETE FROM audit_logs WHERE resource_id = $1 AND action = 'account.hard_deleted'`, [userId]);
    await db.query('DELETE FROM notification_preferences WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  await db.end();
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
