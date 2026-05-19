// KT1 — seed for the Kế toán công nợ (Accounting) role. Independent from
// seed_users.js so each seed script touches only its own role family per
// L7 (Seed scripts must never DELETE users outside their own scope).
//
// Run inside the Railway container so internal DNS resolves:
//   railway ssh --service fwd-sales -- node /app/backend/src/db/seed_ke_toan.js
// or via the SSH+base64 helper used by M1 / KT1 application steps.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
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

const DEFAULT_PASSWORD = 'fwd2026';

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

    for (const user of USERS) {
      const hash = await bcrypt.hash(user.password || DEFAULT_PASSWORD, 10);
      await client.query(`
        INSERT INTO users (name, username, code, role, avatar_color, password_hash, gmail_address)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (username) DO UPDATE SET
          name          = EXCLUDED.name,
          code          = EXCLUDED.code,
          role          = EXCLUDED.role,
          avatar_color  = EXCLUDED.avatar_color,
          gmail_address = EXCLUDED.gmail_address
      `, [user.name, user.username, user.code, user.role, user.avatar_color, hash, user.email]);
    }

    await client.query('COMMIT');
    console.log(`✅ KT users seeded successfully (${USERS.length} user${USERS.length === 1 ? '' : 's'})`);
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
