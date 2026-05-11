// /api/truck-bookings — multi-truck booking CRUD (Phase 2 of the truck_bookings system).
//
// Replaces the deprecated job_truck workflow. One job can have N truck_bookings;
// each booking carries a subset of the job's containers via truck_booking_containers
// (M:N link, UNIQUE on container_id so a single container belongs to at most one
// active booking — see L20).
//
// Auth:
//   GET   /                — any authenticated user (read-only)
//   POST  /                — dieu_do + truong_phong_log
//   PATCH /:id             — dieu_do + truong_phong_log
//   DELETE /:id            — dieu_do + truong_phong_log (soft delete the booking +
//                            HARD delete the link rows so the containers become
//                            available for re-booking; the soft-deleted booking
//                            row remains for audit). Spec "Option B".

const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const WRITE_ROLES = ['dieu_do', 'truong_phong_log'];
function canWrite(req) { return WRITE_ROLES.includes(req.user?.role); }

// ─── Shared SELECT fragment ────────────────────────────────────────────────────
// One row per booking, joined with current transport_companies name and an
// aggregated `containers` array. Filters soft-deleted bookings.
async function loadBookingsByJob(client, jobId) {
  const { rows } = await client.query(`
    SELECT
      tb.id, tb.job_id, tb.transport_company_id, tb.transport_name,
      tb.planned_datetime, tb.delivery_location, tb.cost, tb.vehicle_number,
      tb.notes, tb.completed_at, tb.created_at, tb.updated_at,
      tc.name AS transport_current_name,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', jc.id,
          'cont_number', jc.cont_number,
          'cont_type', jc.cont_type,
          'seal_number', jc.seal_number
        ) ORDER BY jc.id)
        FROM truck_booking_containers tbc
        JOIN job_containers jc ON jc.id = tbc.container_id
        WHERE tbc.booking_id = tb.id
      ), '[]'::json) AS containers
    FROM truck_bookings tb
    LEFT JOIN transport_companies tc ON tc.id = tb.transport_company_id
    WHERE tb.job_id = $1 AND tb.deleted_at IS NULL
    ORDER BY tb.created_at ASC, tb.id ASC
  `, [jobId]);
  return rows;
}

async function loadBookingById(client, id) {
  const { rows } = await client.query(`
    SELECT
      tb.id, tb.job_id, tb.transport_company_id, tb.transport_name,
      tb.planned_datetime, tb.delivery_location, tb.cost, tb.vehicle_number,
      tb.notes, tb.completed_at, tb.created_at, tb.updated_at,
      tc.name AS transport_current_name,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', jc.id,
          'cont_number', jc.cont_number,
          'cont_type', jc.cont_type,
          'seal_number', jc.seal_number
        ) ORDER BY jc.id)
        FROM truck_booking_containers tbc
        JOIN job_containers jc ON jc.id = tbc.container_id
        WHERE tbc.booking_id = tb.id
      ), '[]'::json) AS containers
    FROM truck_bookings tb
    LEFT JOIN transport_companies tc ON tc.id = tb.transport_company_id
    WHERE tb.id = $1 AND tb.deleted_at IS NULL
  `, [id]);
  return rows[0] || null;
}

// ─── GET /api/truck-bookings?job_id=N ──────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const jobId = parseInt(req.query.job_id, 10);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'job_id là bắt buộc' });
  }
  try {
    const rows = await loadBookingsByJob(db, jobId);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/truck-bookings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/truck-bookings ──────────────────────────────────────────────────
// Creates one booking. Validates carrier exists, container_ids all belong to
// the job AND aren't already in another active booking. Snapshots transport_name
// from transport_companies (L13). Inserts the M:N link rows. Atomic.
router.post('/', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });

  const {
    job_id, transport_company_id, planned_datetime, delivery_location,
    cost, container_ids, notes,
  } = req.body || {};

  if (!Number.isFinite(parseInt(job_id, 10))) {
    return res.status(400).json({ error: 'job_id là bắt buộc' });
  }
  if (!Number.isFinite(parseInt(transport_company_id, 10))) {
    return res.status(400).json({ error: 'transport_company_id là bắt buộc' });
  }
  if (!planned_datetime || !String(planned_datetime).trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập ngày giờ giao xe (planned_datetime)' });
  }
  if (!delivery_location || !String(delivery_location).trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập địa điểm giao (delivery_location)' });
  }
  if (!Array.isArray(container_ids) || container_ids.length === 0) {
    return res.status(400).json({ error: 'Vui lòng chọn ít nhất 1 container cho booking' });
  }
  const contIds = container_ids.map(x => parseInt(x, 10)).filter(Number.isFinite);
  if (contIds.length !== container_ids.length) {
    return res.status(400).json({ error: 'container_ids không hợp lệ' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Validate carrier exists + is live; capture name for the snapshot.
    const { rows: tcRows } = await client.query(
      `SELECT name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
      [transport_company_id]
    );
    if (!tcRows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Vận tải không tồn tại hoặc đã bị xóa' });
    }
    const transport_name = tcRows[0].name;

    // Validate every container belongs to this job (count must match).
    const { rows: contRows } = await client.query(
      `SELECT id FROM job_containers WHERE id = ANY($1::int[]) AND job_id = $2`,
      [contIds, job_id]
    );
    if (contRows.length !== contIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Một số container không thuộc job này',
      });
    }

    // Pre-check: none already in another LIVE booking. UNIQUE(container_id)
    // on the link table would catch this on INSERT, but a friendly pre-check
    // gives the user actionable info on which container is already taken.
    const { rows: dupRows } = await client.query(`
      SELECT tbc.container_id, jc.cont_number
      FROM truck_booking_containers tbc
      JOIN truck_bookings tb ON tb.id = tbc.booking_id
      JOIN job_containers jc ON jc.id = tbc.container_id
      WHERE tb.deleted_at IS NULL
        AND tbc.container_id = ANY($1::int[])
    `, [contIds]);
    if (dupRows.length > 0) {
      await client.query('ROLLBACK');
      const names = dupRows.map(r => r.cont_number || `#${r.container_id}`).join(', ');
      return res.status(400).json({
        error: `Container ${names} đã thuộc booking khác. Hãy xóa booking cũ trước.`,
      });
    }

    // Insert the booking. vehicle_number left NULL — DD fills when truck assigned.
    const { rows: bRows } = await client.query(
      `INSERT INTO truck_bookings
         (job_id, transport_company_id, transport_name,
          planned_datetime, delivery_location, cost, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [job_id, transport_company_id, transport_name,
       planned_datetime, delivery_location,
       (cost === '' || cost == null) ? null : cost,
       notes || null, req.user.id]
    );
    const bookingId = bRows[0].id;

    // Insert M:N link rows. UNIQUE(container_id) is the load-bearing invariant.
    for (const cid of contIds) {
      await client.query(
        `INSERT INTO truck_booking_containers (booking_id, container_id) VALUES ($1, $2)`,
        [bookingId, cid]
      );
    }

    await client.query('COMMIT');
    const created = await loadBookingById(db, bookingId);
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/truck-bookings error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/truck-bookings/:id ─────────────────────────────────────────────
// Editable fields only. transport_company_id change re-snapshots the name.
// vehicle_number transitions drive completed_at lifecycle:
//   NULL/'' → value: completed_at = NOW() (first time truck assigned)
//   value → NULL/'': completed_at = NULL (un-assign)
//   value → value:   completed_at unchanged
// container_ids NOT editable here — caller must DELETE + re-POST to re-shuffle.
const PATCH_FIELDS = ['transport_company_id', 'planned_datetime', 'delivery_location',
                      'cost', 'vehicle_number', 'notes'];

router.patch('/:id', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: curRows } = await client.query(
      `SELECT * FROM truck_bookings WHERE id = $1 AND deleted_at IS NULL`, [id]
    );
    if (!curRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy booking' });
    }
    const cur = curRows[0];

    const sets = []; const params = []; let idx = 1;

    for (const f of PATCH_FIELDS) {
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      // Normalize empty strings to null for the nullable columns.
      if (['cost', 'vehicle_number', 'notes'].includes(f)
          && (v === '' || v == null)) v = null;
      sets.push(`${f} = $${idx++}`); params.push(v);
    }

    // transport_company_id change → re-snapshot transport_name from tc.
    if (req.body.transport_company_id !== undefined
        && req.body.transport_company_id !== cur.transport_company_id) {
      const newId = req.body.transport_company_id;
      if (newId == null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'transport_company_id không được để trống' });
      }
      const { rows: tcRows } = await client.query(
        `SELECT name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`, [newId]
      );
      if (!tcRows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Vận tải không tồn tại hoặc đã bị xóa' });
      }
      sets.push(`transport_name = $${idx++}`); params.push(tcRows[0].name);
    }

    // vehicle_number lifecycle → completed_at side effect.
    if (req.body.vehicle_number !== undefined) {
      const prev = (cur.vehicle_number || '').trim();
      const next = (req.body.vehicle_number || '').trim();
      if (!prev && next) {
        sets.push(`completed_at = NOW()`);
      } else if (prev && !next) {
        sets.push(`completed_at = NULL`);
      }
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK');
      return res.json(await loadBookingById(db, id));
    }
    sets.push(`updated_at = NOW()`);
    params.push(id);
    await client.query(
      `UPDATE truck_bookings SET ${sets.join(', ')} WHERE id = $${idx}`, params
    );

    await client.query('COMMIT');
    res.json(await loadBookingById(db, id));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /api/truck-bookings/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/truck-bookings/:id ────────────────────────────────────────────
// Option B per spec: soft-delete the booking row (audit) + HARD delete the
// link rows so the containers become eligible for re-booking. The UNIQUE
// constraint on truck_booking_containers.container_id is unconditional, so
// freeing the container requires removing the link — not just tombstoning
// the parent.
router.delete('/:id', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE truck_bookings SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`, [id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy hoặc đã bị xóa' });
    }
    await client.query(
      `DELETE FROM truck_booking_containers WHERE booking_id = $1`, [id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, soft_deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/truck-bookings/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
