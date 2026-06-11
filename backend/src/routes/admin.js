// /api/admin/* — app-wide administrator user-management (2026-06-11).
//
// Every route is gated by requireAuth + requireAdmin (router-level, mirrors
// routes/accounting.js). Admins manage users across ALL departments: list,
// create, edit, change-role, disable/enable, reset-password.
//
// SECURITY:
//   • Never returns password_hash or any gmail secret (USER_COLS whitelist).
//   • Create + reset-password generate a RANDOM one-time temp password,
//     returned exactly once (temp_password) and stored only as a bcrypt hash.
//   • Self-lock + last-admin invariants (services/admin-guards.js): an admin
//     cannot disable/demote themselves, and the last active admin cannot be
//     disabled or demoted away from 'admin'.

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const db      = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { isValidRole, isSelf, wouldRemoveLastAdmin } = require('../services/admin-guards');

router.use(requireAuth, requireAdmin);

// Public user projection — NEVER includes password_hash / gmail_* secrets.
const USER_COLS = `id, name, code, username, role, avatar_color,
  created_at, disabled_at, (disabled_at IS NOT NULL) AS disabled`;

function randomTempPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

// COUNT of currently-active (non-disabled) admins, on a given client.
async function activeAdminCount(client) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL`
  );
  return rows[0].n;
}

// ─── GET /api/admin/users — list every user (all departments) ──────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${USER_COLS} FROM users ORDER BY role, name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/users — create. Body: {name, code, username, role, avatar_color?}
// Returns { user, temp_password } — temp password shown ONCE.
router.post('/users', async (req, res) => {
  const name     = String(req.body.name || '').trim();
  const code     = String(req.body.code || '').trim();
  const username = String(req.body.username || '').trim().toLowerCase();
  const role     = String(req.body.role || '').trim();
  const avatar   = req.body.avatar_color ? String(req.body.avatar_color).trim() : null;

  if (!name || !code || !username || !role) {
    return res.status(400).json({ error: 'Vui lòng nhập đủ tên, mã, username và vai trò' });
  }
  if (!isValidRole(role)) {
    return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  }

  const tempPw = randomTempPassword();
  const hash = await bcrypt.hash(tempPw, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (name, code, username, role, password_hash, avatar_color)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, '#00d4aa'))
       RETURNING ${USER_COLS}`,
      [name, code, username, role, hash, avatar]
    );
    res.status(201).json({ user: rows[0], temp_password: tempPw });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username hoặc mã nhân viên đã tồn tại' });
    if (err.code === '23514') return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/users/:id — edit name/code/username/avatar_color ─────────
router.patch('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const sets = []; const params = []; let i = 1;
  if (req.body.name !== undefined)         { sets.push(`name = $${i++}`);         params.push(String(req.body.name).trim()); }
  if (req.body.code !== undefined)         { sets.push(`code = $${i++}`);         params.push(String(req.body.code).trim()); }
  if (req.body.username !== undefined)     { sets.push(`username = $${i++}`);     params.push(String(req.body.username).trim().toLowerCase()); }
  if (req.body.avatar_color !== undefined) { sets.push(`avatar_color = $${i++}`); params.push(String(req.body.avatar_color).trim()); }
  if (!sets.length) return res.status(400).json({ error: 'Không có thay đổi để lưu' });

  params.push(id);
  try {
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${USER_COLS}`, params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username hoặc mã nhân viên đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/admin/users/:id/role — change role ─────────────────────────────
router.patch('/users/:id/role', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = String(req.body.role || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  if (!isValidRole(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT id, role, disabled_at FROM users WHERE id = $1`, [id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy người dùng' }); }
    const target = cur[0];

    // Self-demote guard.
    if (isSelf(req.user.id, id) && role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Không thể tự hạ quyền quản trị của chính mình' });
    }
    // Last-admin guard: demoting an ACTIVE admin away from 'admin'.
    if (target.role === 'admin' && role !== 'admin' && !target.disabled_at) {
      if (wouldRemoveLastAdmin(true, await activeAdminCount(client))) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Phải còn ít nhất 1 quản trị viên đang hoạt động' });
      }
    }

    const { rows } = await client.query(`UPDATE users SET role = $1 WHERE id = $2 RETURNING ${USER_COLS}`, [role, id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23514') return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/admin/users/:id/disable — lock account ─────────────────────────
router.patch('/users/:id/disable', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  if (isSelf(req.user.id, id)) return res.status(403).json({ error: 'Không thể tự khóa tài khoản của chính mình' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT id, role, disabled_at FROM users WHERE id = $1`, [id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy người dùng' }); }
    const target = cur[0];
    if (target.disabled_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Tài khoản đã bị khóa' }); }

    if (target.role === 'admin' && wouldRemoveLastAdmin(true, await activeAdminCount(client))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Phải còn ít nhất 1 quản trị viên đang hoạt động' });
    }

    const { rows } = await client.query(`UPDATE users SET disabled_at = NOW() WHERE id = $1 RETURNING ${USER_COLS}`, [id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/admin/users/:id/enable — unlock account ────────────────────────
router.patch('/users/:id/enable', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  try {
    const { rows } = await db.query(`UPDATE users SET disabled_at = NULL WHERE id = $1 RETURNING ${USER_COLS}`, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/admin/users/:id/reset-password — random temp, returned once ─────
router.post('/users/:id/reset-password', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  const tempPw = randomTempPassword();
  const hash = await bcrypt.hash(tempPw, 10);
  try {
    const { rows } = await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING ${USER_COLS}`, [hash, id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json({ user: rows[0], temp_password: tempPw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
