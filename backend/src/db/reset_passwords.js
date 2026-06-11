// ─── ONE-TIME ADMIN SCRIPT — force-rotate accounts still on a compromised default ───
//
// WHY: prior to the ĐỢT 1 security fix, seed_users.js / seed_ke_toan.js shipped
// working plaintext passwords in git (fwd2026, <username>2024). Treat all of
// them as COMPROMISED. This script finds every account whose CURRENT password
// still equals one of those known defaults (via bcrypt.compare) and resets it to
// a fresh random one-time temp, printed to stdout exactly once. Accounts whose
// owners already changed their password are detected as "already rotated" and
// are LEFT UNTOUCHED — nobody is locked out silently.
//
// This script is NOT wired into start.js — it never runs on deploy. Run it
// manually, ONCE, then hand each printed temp to its user (they change it on
// first login). Safe to re-run: after a reset the account no longer matches a
// known default, so a second run reports it as already-rotated.
//
// HOW TO RUN (must run where DATABASE_URL resolves — i.e. inside Railway):
//   railway run node backend/src/db/reset_passwords.js
//   — or from the repo root with a backend/.env that has the prod DATABASE_URL:
//   node backend/src/db/reset_passwords.js
//
// Optional dry run (report who WOULD be reset, change nothing):
//   railway run node backend/src/db/reset_passwords.js --dry-run

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');

// Every plaintext password that was ever committed to git — all compromised.
const COMPROMISED_PASSWORDS = [
  'fwd2026',        // shared default for seeded sales/lead + KT
  'sepchuong2024',
  'trong2024',
  'congty2024',
  'edward2024',
  'vy2024',
];

const DRY_RUN = process.argv.includes('--dry-run');

function randomTempPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

async function resetCompromised() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: users } = await client.query(
      `SELECT id, username, role, password_hash FROM users WHERE password_hash IS NOT NULL`
    );

    const reset = [];
    let alreadyRotated = 0;
    for (const u of users) {
      let isCompromised = false;
      for (const pw of COMPROMISED_PASSWORDS) {
        if (await bcrypt.compare(pw, u.password_hash)) { isCompromised = true; break; }
      }
      if (!isCompromised) { alreadyRotated++; continue; }

      const tempPw = randomTempPassword();
      if (!DRY_RUN) {
        const hash = await bcrypt.hash(tempPw, 10);
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, u.id]);
      }
      reset.push({ username: u.username, role: u.role, tempPw });
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log(`🔎 DRY RUN — no changes written.`);
    } else {
      await client.query('COMMIT');
    }

    console.log(`\nScanned ${users.length} accounts. ${alreadyRotated} already on a safe password (untouched).`);
    if (reset.length) {
      console.log(`\n🔑 ${DRY_RUN ? 'WOULD RESET' : 'RESET'} ${reset.length} compromised account(s) — temporary passwords (hand to each user; they change on first login):`);
      for (const r of reset) console.log(`   • ${r.username} (${r.role}): ${r.tempPw}`);
      console.log(`\n⚠️  Copy these now — they are shown ONCE and not stored anywhere.`);
    } else {
      console.log(`\n✅ No accounts are on a known compromised default. Nothing to do.`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Password reset failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

resetCompromised();
