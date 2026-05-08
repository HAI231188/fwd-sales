require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const db = require('./index');

const USERS = [
  { name: 'Hoài Anh',  username: 'hoaianh', code: 'HA',   role: 'sales', avatar_color: '#00d4aa' },
  { name: 'Hiếu',      username: 'hieu',    code: 'HIE',  role: 'sales', avatar_color: '#7c3aed' },
  { name: 'Hoàng',     username: 'hoang',   code: 'HOA',  role: 'sales', avatar_color: '#f59e0b' },
  { name: 'Cường',     username: 'cuong',   code: 'CU',   role: 'sales', avatar_color: '#ec4899' },
  { name: 'Thu',       username: 'thu',     code: 'TH',   role: 'sales', avatar_color: '#3b82f6' },
  { name: 'Sếp Chương', username: 'sepchuong', code: 'SC',   role: 'sales', avatar_color: '#10b981', password: 'sepchuong2024' },
  { name: 'Mr Hải',    username: 'hai',     code: 'HAI',  role: 'lead',  avatar_color: '#ff6b35' },
  { name: 'Trọng',     username: 'trong',   code: 'TR',   role: 'sales', avatar_color: '#f97316', password: 'trong2024' },
  { name: 'Công Ty',   username: 'congty',  code: 'CT',   role: 'sales', avatar_color: '#06b6d4', password: 'congty2024' },
  { name: 'Edward',    username: 'edward',  code: 'ED',   role: 'sales', avatar_color: '#8b5cf6', password: 'edward2024' },
  { name: 'Vy',        username: 'vy',      code: 'VY',   role: 'sales', avatar_color: '#e11d48', password: 'vy2024'   },
];

const DEFAULT_PASSWORD = 'fwd2026';

async function seedUsers() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Only touch sales/lead users — LOG staff (cus*, ops, dieu_do, etc.) are managed separately
    // and may have FK references in ai_assignment_logs that prevent deletion
    await client.query(`DELETE FROM users WHERE username IS NULL AND role IN ('sales','lead')`);
    const realCodes = USERS.map(u => u.code);
    await client.query(`DELETE FROM users WHERE code != ALL($1::text[]) AND role IN ('sales','lead')`, [realCodes]);

    for (const user of USERS) {
      const hash = await bcrypt.hash(user.password || DEFAULT_PASSWORD, 10);
      await client.query(`
        INSERT INTO users (name, username, code, role, avatar_color, password_hash)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (username) DO UPDATE SET
          name         = EXCLUDED.name,
          code         = EXCLUDED.code,
          role         = EXCLUDED.role,
          avatar_color = EXCLUDED.avatar_color
      `, [user.name, user.username, user.code, user.role, user.avatar_color, hash]);
    }

    await client.query('COMMIT');
    console.log('✅ Users seeded successfully (11 users)');
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
