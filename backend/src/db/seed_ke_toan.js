// KT1 — seed for the Kế toán công nợ (Accounting) role. Independent from
// seed_users.js so each seed script touches only its own role family per
// L7 (Seed scripts must never DELETE users outside their own scope).
//
// Run inside the Railway container so internal DNS resolves:
//   railway ssh --service fwd-sales -- node /app/backend/src/db/seed_ke_toan.js
// or via the SSH+base64 helper used by M1 / KT1 application steps.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');

// The `users` table has no dedicated `email` column — the canonical place to
// store a user's contact email is `gmail_address` (VARCHAR(255), repurposed
// from the SMTP-setup field). Each KT user gets a unique short `code` (used
// for the Navbar avatar pill).
const USERS = [
  {
    username:     'ketoan_test',
    name:         'Kế Toán Test',
    code:         'KT1',
    email:        'ketoan_test@slbglobal.vn', // stored in gmail_address
    role:         'ke_toan',
    avatar_color: '#0891b2', // teal — distinct from existing role palette
  },
];

// SECURITY (ĐỢT 1): no plaintext passwords in seed files. A newly-INSERTED KT
// account gets a random one-time temp password printed to the log once; existing
// accounts are never re-passworded (ON CONFLICT does not touch password_hash).
// To rotate an account already on a compromised default, run reset_passwords.js.
function randomTempPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

async function seedKeToan() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Scope DELETE to role='ke_toan' only — never touch other roles
    // (per L7: seed scripts must not DELETE outside their own scope).
    // Drops any KT users not in this list (e.g. old test users).
    const realUsernames = USERS.map(u => u.username);
    await client.query(
      `DELETE FROM users WHERE role = 'ke_toan' AND (username IS NULL OR username != ALL($1::text[]))`,
      [realUsernames]
    );

    const seededTemps = [];
    for (const user of USERS) {
      const tempPw = randomTempPassword();
      const hash = await bcrypt.hash(tempPw, 10);
      // RETURNING (xmax = 0) → true only for a fresh INSERT, so we reveal a temp
      // password only for genuinely new accounts; existing keep their password.
      const { rows } = await client.query(`
        INSERT INTO users (name, username, code, role, avatar_color, password_hash, gmail_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        -- NEVER overwrite role, password_hash, or gmail_address on existing
        -- users: role is admin-controlled and gmail_address is the user's own
        -- self-set SMTP/contact email (via /users/me/gmail-setup). Overwriting
        -- either on every deploy would revert admin promotions / break a KT
        -- user's configured email. Seed only INSERTs missing users + refreshes
        -- cosmetic name/code/avatar.
        ON CONFLICT (username) DO UPDATE SET
          name          = EXCLUDED.name,
          code          = EXCLUDED.code,
          avatar_color  = EXCLUDED.avatar_color
        RETURNING (xmax = 0) AS inserted
      `, [user.name, user.username, user.code, user.role, user.avatar_color, hash, user.email]);
      if (rows[0] && rows[0].inserted) seededTemps.push({ username: user.username, tempPw });
    }

    await client.query('COMMIT');
    console.log(`✅ KT users seeded successfully (${USERS.length} user${USERS.length === 1 ? '' : 's'})`);
    if (seededTemps.length) {
      console.log('🔑 NEW KT accounts — one-time temporary passwords (change on first login):');
      for (const t of seededTemps) console.log(`   • ${t.username}: ${t.tempPw}`);
    } else {
      console.log('ℹ️  No new KT accounts created — existing passwords left untouched.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ KT seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

seedKeToan();
