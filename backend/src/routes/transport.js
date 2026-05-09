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

// L16 — email_cc helpers. The DB column is TEXT holding a JSON-stringified array.
// Read: parse with safe fallback to [] on corrupt data so a bad row never breaks the list endpoint.
function parseEmailCc(raw) {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(e => typeof e === 'string') : [];
  } catch { return []; }
}
// Write: trim, drop empties, validate each. Returns { ok: true, value } or { ok: false, badEmail }.
function prepareEmailCc(input) {
  if (input == null) return { ok: true, value: '[]' };
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr.map(e => (typeof e === 'string' ? e.trim() : '')).filter(e => e.length > 0);
  for (const e of cleaned) {
    if (!looksLikeEmail(e)) return { ok: false, badEmail: e };
  }
  return { ok: true, value: JSON.stringify(cleaned) };
}

// GET /api/transport-companies?search=xxx&limit=20
// Read-open to any authenticated user (CUS/OPS/Sales/Lead all need autocomplete).
router.get('/', requireAuth, async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const params = [];
  let where = 'tc.deleted_at IS NULL';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND tc.name ILIKE $${params.length}`;
  }
  params.push(limit);
  try {
    const { rows } = await db.query(
      `SELECT tc.id, tc.name, tc.tax_code, tc.address, tc.email, tc.phone,
              tc.contact_person, tc.notes, tc.email_cc, tc.created_at, tc.updated_at,
              COUNT(DISTINCT jtr.job_id)::int AS job_count
         FROM transport_companies tc
         LEFT JOIN job_truck jtr ON jtr.transport_company_id = tc.id
        WHERE ${where}
        GROUP BY tc.id
        ORDER BY tc.name
        LIMIT $${params.length}`,
      params
    );
    res.json(rows.map(r => ({ ...r, email_cc: parseEmailCc(r.email_cc) })));
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
              email_cc, created_by, created_at, updated_at, deleted_at
       FROM transport_companies WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy vận tải' });
    res.json({ ...rows[0], email_cc: parseEmailCc(rows[0].email_cc) });
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
  const cc = prepareEmailCc(req.body.email_cc);
  if (!cc.ok) return res.status(400).json({ error: `Email không hợp lệ: ${cc.badEmail}` });
  try {
    const { rows } = await db.query(
      `INSERT INTO transport_companies
        (name, tax_code, address, email, phone, contact_person, notes, email_cc, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [data.name, data.tax_code, data.address, data.email, data.phone, data.contact_person, data.notes, cc.value, req.user.id]
    );
    res.status(201).json({ ...rows[0], email_cc: parseEmailCc(rows[0].email_cc) });
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
  // L16 — email_cc handled separately (not in FIELDS because it needs JSON encoding).
  if (req.body.email_cc !== undefined) {
    const cc = prepareEmailCc(req.body.email_cc);
    if (!cc.ok) return res.status(400).json({ error: `Email không hợp lệ: ${cc.badEmail}` });
    sets.push(`email_cc = $${idx++}`);
    params.push(cc.value);
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
    res.json({ ...rows[0], email_cc: parseEmailCc(rows[0].email_cc) });
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
