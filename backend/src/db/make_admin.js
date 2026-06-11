// ─── ONE-TIME BOOTSTRAP — promote an existing account to 'admin' ───────────────
//
// The very first admin can't be created through the (admin-gated) /api/admin
// endpoints, so promote your own account once via this script. Idempotent and
// safe to re-run. Also clears disabled_at so the bootstrap admin can never be
// locked out by the promotion.
//
// HOW TO RUN (inside Railway, where the internal DATABASE_URL resolves):
//   railway ssh --service fwd-sales -- node /app/backend/src/db/make_admin.js <username>
//
// Example: railway ssh --service fwd-sales -- node /app/backend/src/db/make_admin.js hai

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

async function main() {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!username) {
    console.error('Usage: node make_admin.js <username>');
    process.exitCode = 1;
    return;
  }
  try {
    const { rows } = await db.query(
      `UPDATE users
          SET role = 'admin', disabled_at = NULL
        WHERE LOWER(username) = $1
        RETURNING id, name, username, role`,
      [username]
    );
    if (!rows[0]) {
      console.error(`❌ No user found with username '${username}'. Nothing changed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`✅ Promoted to admin: ${rows[0].username} (${rows[0].name}, id=${rows[0].id}, role=${rows[0].role})`);
  } catch (err) {
    console.error('❌ make_admin failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

main();
