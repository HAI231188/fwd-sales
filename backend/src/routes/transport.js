const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { canWrite } = require('../constants/roles');

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

// GET /api/transport-companies/route-price-history?q=<location>&from=&to=
// Đợt 1 (2026-06-02) — route price-history lookup. Fuzzy substring match on
// pickup/delivery location; UNIONs imported history rows (transport_price_history)
// with live priced truck_bookings. Read-open to any authenticated user (same
// access as the carrier list). Aggregates (avg/min/max) computed over ALL
// matched rows with cost IS NOT NULL via window functions (before the LIMIT),
// while the row list is capped. MUST be declared before GET /:id so the literal
// path isn't swallowed by the :id param route.
router.get('/route-price-history', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  const emptyAgg = { count: 0, avg_cost: null, min_cost: null, max_cost: null };
  if (!q) return res.json({ rows: [], aggregates: emptyAgg, total_matched: 0 });
  const like = `%${q}%`;
  const from = (req.query.from || '').trim() || null;
  const to   = (req.query.to   || '').trim() || null;
  const LIMIT = 200;
  try {
    const { rows } = await db.query(`
      WITH matched AS (
        -- (1) imported / historical rows
        SELECT tph.source             AS source,
               tph.booked_at          AS booked_at,
               tph.transport_name     AS carrier,
               tph.cont_type          AS cont_type,
               tph.cont_qty           AS cont_qty,
               tph.vehicle_type       AS vehicle_type,
               tph.pickup_location    AS pickup_location,
               tph.delivery_location  AS delivery_location,
               tph.cost               AS cost,
               tph.vehicle_number     AS vehicle_number,
               tph.notes              AS notes
          FROM transport_price_history tph
         WHERE tph.deleted_at IS NULL
           AND (tph.delivery_location ILIKE $1 OR tph.pickup_location ILIKE $1)
           AND ($2::timestamptz IS NULL OR tph.booked_at >= $2)
           AND ($3::timestamptz IS NULL OR tph.booked_at <= $3)
        UNION ALL
        -- (2) live priced truck_bookings
        SELECT 'live'::varchar        AS source,
               tb.planned_datetime    AS booked_at,
               COALESCE(tc.name, tb.transport_name) AS carrier,
               cagg.cont_type         AS cont_type,
               cagg.cont_qty          AS cont_qty,
               NULL::varchar          AS vehicle_type,
               tb.pickup_location     AS pickup_location,
               tb.delivery_location   AS delivery_location,
               tb.cost                AS cost,
               tb.vehicle_number      AS vehicle_number,
               tb.notes               AS notes
          FROM truck_bookings tb
          JOIN jobs j ON j.id = tb.job_id
          LEFT JOIN transport_companies tc ON tc.id = tb.transport_company_id
          LEFT JOIN LATERAL (
            SELECT string_agg(DISTINCT jc.cont_type, '/' ORDER BY jc.cont_type) AS cont_type,
                   COUNT(*)::int AS cont_qty
              FROM truck_booking_containers tbc
              JOIN job_containers jc ON jc.id = tbc.container_id
             WHERE tbc.booking_id = tb.id
          ) cagg ON TRUE
         WHERE tb.deleted_at IS NULL
           AND tb.cost IS NOT NULL
           AND (tb.delivery_location ILIKE $1 OR tb.pickup_location ILIKE $1)
           AND ($2::timestamptz IS NULL OR tb.planned_datetime >= $2)
           AND ($3::timestamptz IS NULL OR tb.planned_datetime <= $3)
      )
      SELECT m.*,
             COUNT(*)      OVER () AS total_matched,
             COUNT(m.cost) OVER () AS priced_count,
             AVG(m.cost)   OVER () AS avg_cost,
             MIN(m.cost)   OVER () AS min_cost,
             MAX(m.cost)   OVER () AS max_cost
        FROM matched m
       ORDER BY m.booked_at DESC
       LIMIT ${LIMIT}
    `, [like, from, to]);

    const aggregates = rows.length ? {
      count:    Number(rows[0].priced_count) || 0,
      avg_cost: rows[0].avg_cost != null ? Number(rows[0].avg_cost) : null,
      min_cost: rows[0].min_cost != null ? Number(rows[0].min_cost) : null,
      max_cost: rows[0].max_cost != null ? Number(rows[0].max_cost) : null,
    } : emptyAgg;
    const total_matched = rows.length ? Number(rows[0].total_matched) : 0;
    // Strip the window-aggregate columns from each row before returning.
    const clean = rows.map(({ total_matched: _t, priced_count: _p, avg_cost: _a,
                              min_cost: _mn, max_cost: _mx, ...r }) => r);
    res.json({ rows: clean, aggregates, total_matched });
  } catch (err) {
    console.error('GET /transport-companies/route-price-history error:', err.message);
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
