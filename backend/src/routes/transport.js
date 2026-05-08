const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const WRITE_ROLES = ['truong_phong_log', 'dieu_do'];
function canWrite(req) { return WRITE_ROLES.includes(req.user?.role); }

const FIELDS = ['name', 'tax_code', 'address', 'email', 'phone', 'contact_person', 'notes'];

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Naive but pragmatic email check — only enforced when value is present.
function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// GET /api/transport-companies?search=xxx&limit=20
// Read-open to any authenticated user (CUS/OPS/Sales/Lead all need autocomplete).
router.get('/', requireAuth, async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const params = [];
  let where = 'deleted_at IS NULL';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND name ILIKE $${params.length}`;
  }
  params.push(limit);
  try {
    const { rows } = await db.query(
      `SELECT id, name, tax_code, address, email, phone, contact_person, notes, created_at, updated_at
       FROM transport_companies WHERE ${where} ORDER BY name LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /transport-companies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transport-companies/:id — returns even soft-deleted (so historical FKs still resolve)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, tax_code, address, email, phone, contact_person, notes,
              created_by, created_at, updated_at, deleted_at
       FROM transport_companies WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy vận tải' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transport-companies
router.post('/', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });
  const data = {};
  for (const f of FIELDS) data[f] = trimOrNull(req.body[f]);
  if (!data.name) return res.status(400).json({ error: 'Tên vận tải là bắt buộc' });
  if (data.email && !looksLikeEmail(data.email)) {
    return res.status(400).json({ error: 'Email không hợp lệ' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO transport_companies
        (name, tax_code, address, email, phone, contact_person, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [data.name, data.tax_code, data.address, data.email, data.phone, data.contact_person, data.notes, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // 23505 = unique_violation — surfaces the case-insensitive name collision
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Tên vận tải đã tồn tại' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/transport-companies/:id
router.patch('/:id', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });
  const sets = []; const params = []; let idx = 1;
  for (const f of FIELDS) {
    if (req.body[f] === undefined) continue;
    const v = trimOrNull(req.body[f]);
    if (f === 'name' && !v) return res.status(400).json({ error: 'Tên vận tải là bắt buộc' });
    if (f === 'email' && v && !looksLikeEmail(v)) {
      return res.status(400).json({ error: 'Email không hợp lệ' });
    }
    sets.push(`${f} = $${idx++}`);
    params.push(v);
  }
  if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  sets.push(`updated_at = NOW()`);
  params.push(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE transport_companies SET ${sets.join(', ')}
         WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy vận tải' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Tên vận tải đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transport-companies/:id — soft delete only
router.delete('/:id', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(
      `UPDATE transport_companies SET deleted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy vận tải' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
