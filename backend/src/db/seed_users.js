require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./index');

// SECURITY (ĐỢT 1): seed scripts must NEVER contain working plaintext passwords.
// Each newly-INSERTED account gets a RANDOM one-time temporary password printed
// to the server log exactly once (read it from the Railway deploy logs, hand it
// to the user, they change it on first login). Existing accounts are never
// re-passworded here — ON CONFLICT DO UPDATE does not touch password_hash. To
// rotate an account already on a compromised default, run
// `node src/db/reset_passwords.js` (see that file's header).
const USERS = [
  { name: 'Hoài Anh',  username: 'hoaianh', code: 'HA',   role: 'sales', avatar_color: '#00d4aa' },
  { name: 'Hiếu',      username: 'hieu',    code: 'HIE',  role: 'sales', avatar_color: '#7c3aed' },
  { name: 'Hoàng',     username: 'hoang',   code: 'HOA',  role: 'sales', avatar_color: '#f59e0b' },
  { name: 'Cường',     username: 'cuong',   code: 'CU',   role: 'sales', avatar_color: '#ec4899' },
  { name: 'Thu',       username: 'thu',     code: 'TH',   role: 'sales', avatar_color: '#3b82f6' },
  { name: 'Sếp Chương', username: 'sepchuong', code: 'SC', role: 'sales', avatar_color: '#10b981' },
  { name: 'Mr Hải',    username: 'hai',     code: 'HAI',  role: 'lead',  avatar_color: '#ff6b35' },
  { name: 'Trọng',     username: 'trong',   code: 'TR',   role: 'sales', avatar_color: '#f97316' },
  { name: 'Công Ty',   username: 'congty',  code: 'CT',   role: 'sales', avatar_color: '#06b6d4' },
  { name: 'Edward',    username: 'edward',  code: 'ED',   role: 'sales', avatar_color: '#8b5cf6' },
  { name: 'Vy',        username: 'vy',      code: 'VY',   role: 'sales', avatar_color: '#e11d48' },
];

// 18-char URL-safe random temp password (no ambiguous +/= characters).
function randomTempPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

async function seedUsers() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Only touch sales/lead users — LOG staff (cus*, ops, dieu_do, etc.) are managed separately
    // and may have FK references in ai_assignment_logs that prevent deletion
    await client.query(`DELETE FROM users WHERE username IS NULL AND role IN ('sales','lead')`);
    const realCodes = USERS.map(u => u.code);
    await client.query(`DELETE FROM users WHERE code != ALL($1::text[]) AND role IN ('sales','lead')`, [realCodes]);

    const seededTemps = [];
    for (const user of USERS) {
      const tempPw = randomTempPassword();
      const hash = await bcrypt.hash(tempPw, 10);
      // RETURNING (xmax = 0) distinguishes a fresh INSERT from an ON CONFLICT
      // UPDATE — we only reveal a temp password for genuinely new accounts;
      // existing accounts keep whatever password they already have.
      const { rows } = await client.query(`
        INSERT INTO users (name, username, code, role, avatar_color, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (username) DO UPDATE SET
          name         = EXCLUDED.name,
          code         = EXCLUDED.code,
          role         = EXCLUDED.role,
          avatar_color = EXCLUDED.avatar_color
        RETURNING (xmax = 0) AS inserted
      `, [user.name, user.username, user.code, user.role, user.avatar_color, hash]);
      if (rows[0] && rows[0].inserted) seededTemps.push({ username: user.username, tempPw });
    }

    await client.query('COMMIT');
    console.log(`✅ Users seeded successfully (${USERS.length} users)`);
    if (seededTemps.length) {
      console.log('🔑 NEW accounts — one-time temporary passwords (user must change on first login):');
      for (const t of seededTemps) console.log(`   • ${t.username}: ${t.tempPw}`);
    } else {
      console.log('ℹ️  No new accounts created — existing passwords left untouched.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ User seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

seedUsers();
