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
const { checkAndCompleteJob } = require('../services/job-completion');

const WRITE_ROLES = ['dieu_do', 'truong_phong_log'];
function canWrite(req) { return WRITE_ROLES.includes(req.user?.role); }

// Phase 5 Step 2 — "Đặt kế hoạch xe" is open to a broader set of roles than
// the carrier-side single POST (Quản lý đặt xe). CUS confirms delivery with
// the customer, Sales confirms commercials, TPL/DD execute. Lead can override.
// Role enum lives in schema.sql:183 — sales/lead/truong_phong_log/dieu_do/
// cus/cus1/cus2/cus3/ops. ops is intentionally excluded (no plan-write role).
const PLAN_ROLES = ['dieu_do', 'truong_phong_log', 'lead', 'sales',
                    'cus', 'cus1', 'cus2', 'cus3'];
function canPlan(req) { return PLAN_ROLES.includes(req.user?.role); }

// ─── Booking code generator ────────────────────────────────────────────────────
// Phase 5 Step 3 — auto-generate "Mã kế hoạch" with format "KH-{job_code}-{NN}".
// NN is sequential per job. Critically, the MAX scan does NOT filter by
// deleted_at — soft-deleted rows still occupy their number, so re-creating a
// booking after delete gets the next free number (never recycles).
//
// Caller must pass an open client (we're always inside a BEGIN-COMMIT block
// when this runs), so subsequent INSERTs in the same transaction see the
// previously-generated codes via PG's read-committed visibility.
async function nextBookingCode(client, jobId) {
  const { rows: [j] } = await client.query(
    `SELECT job_code FROM jobs WHERE id = $1`, [jobId]
  );
  const jobCode = j?.job_code;
  if (!jobCode) throw new Error(`Job #${jobId} không có job_code — không thể sinh booking_code`);
  const { rows: [{ next_n }] } = await client.query(`
    SELECT COALESCE(MAX(substring(booking_code from '\\d+$')::int), 0) + 1 AS next_n
      FROM truck_bookings
     WHERE job_id = $1
       AND booking_code LIKE 'KH-' || $2::text || '-%'
  `, [jobId, jobCode]);
  return `KH-${jobCode}-${String(next_n).padStart(2, '0')}`;
}

// ─── Shared SELECT fragment ────────────────────────────────────────────────────
// One row per booking, joined with current transport_companies name and an
// aggregated `containers` array. Filters soft-deleted bookings.
async function loadBookingsByJob(client, jobId) {
  const { rows } = await client.query(`
    SELECT
      tb.id, tb.job_id, tb.booking_code,
      tb.transport_company_id, tb.transport_name,
      tb.planned_datetime, tb.actual_datetime, tb.delivery_location,
      tb.pickup_location, tb.cost, tb.vehicle_number,
      tb.notes, tb.note, tb.receiver_name, tb.receiver_phone, tb.bbbg_note,
      tb.completed_at, tb.created_at, tb.updated_at,
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
      tb.id, tb.job_id, tb.booking_code,
      tb.transport_company_id, tb.transport_name,
      tb.planned_datetime, tb.actual_datetime, tb.delivery_location,
      tb.pickup_location, tb.cost, tb.vehicle_number,
      tb.notes, tb.note, tb.receiver_name, tb.receiver_phone, tb.bbbg_note,
      tb.completed_at, tb.created_at, tb.updated_at,
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
// Creates one booking. transport_company_id is OPTIONAL (Phase 5 Step 2 — DD
// can fill it later). When provided, validates carrier + snapshots
// transport_name (L13). When omitted/null, transport_name is NULL too.
// Always validates container_ids belong to the job and aren't already in
// another active booking. Inserts the M:N link rows. Atomic.
router.post('/', requireAuth, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'Không có quyền' });

  const {
    job_id, transport_company_id, planned_datetime, delivery_location,
    cost, container_ids, notes, note,
    actual_datetime, pickup_location,
    receiver_name, receiver_phone, bbbg_note,
  } = req.body || {};

  if (!Number.isFinite(parseInt(job_id, 10))) {
    return res.status(400).json({ error: 'job_id là bắt buộc' });
  }
  // transport_company_id is OPTIONAL. Treat '', null, undefined as "absent".
  // Anything else must parse to a finite int.
  const tcRaw = transport_company_id;
  const tcAbsent = (tcRaw === '' || tcRaw == null);
  const tcId = tcAbsent ? null : parseInt(tcRaw, 10);
  if (!tcAbsent && !Number.isFinite(tcId)) {
    return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
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
    // Only when caller supplied a carrier (Phase 5 Step 2 — planning rows can
    // be created carrier-less; DD assigns later).
    let transport_name = null;
    if (tcId != null) {
      const { rows: tcRows } = await client.query(
        `SELECT name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
        [tcId]
      );
      if (!tcRows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Vận tải không tồn tại hoặc đã bị xóa' });
      }
      transport_name = tcRows[0].name;
    }

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

    // Generate the booking_code (Phase 5 Step 3). Format "KH-{job_code}-{NN}".
    const bookingCode = await nextBookingCode(client, job_id);

    // Insert the booking. vehicle_number left NULL — DD fills when truck assigned.
    // actual_datetime + pickup_location optional on create (filled later via PATCH).
    // transport_company_id + transport_name may both be NULL for planning rows.
    const { rows: bRows } = await client.query(
      `INSERT INTO truck_bookings
         (job_id, booking_code, transport_company_id, transport_name,
          planned_datetime, actual_datetime,
          delivery_location, pickup_location,
          cost, notes, note,
          receiver_name, receiver_phone, bbbg_note,
          created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [job_id, bookingCode, tcId, transport_name,
       planned_datetime,
       (actual_datetime === '' || actual_datetime == null) ? null : actual_datetime,
       delivery_location,
       (pickup_location === '' || pickup_location == null) ? null : pickup_location,
       (cost === '' || cost == null) ? null : cost,
       notes || null, note || null,
       (receiver_name  === '' || receiver_name  == null) ? null : receiver_name,
       (receiver_phone === '' || receiver_phone == null) ? null : receiver_phone,
       (bbbg_note      === '' || bbbg_note      == null) ? null : bbbg_note,
       req.user.id]
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
const PATCH_FIELDS = ['transport_company_id', 'planned_datetime', 'actual_datetime',
                      'delivery_location', 'pickup_location',
                      'cost', 'vehicle_number', 'notes', 'note',
                      'receiver_name', 'receiver_phone', 'bbbg_note'];

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

    // transport_company_id needs special handling — see block below.
    // Skip it from the generic loop and normalize empty→null for it explicitly.
    for (const f of PATCH_FIELDS) {
      if (f === 'transport_company_id') continue;
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      // Normalize empty strings to null for the nullable columns.
      if (['cost', 'vehicle_number', 'notes', 'note', 'actual_datetime', 'pickup_location',
           'receiver_name', 'receiver_phone', 'bbbg_note'].includes(f)
          && (v === '' || v == null)) v = null;
      sets.push(`${f} = $${idx++}`); params.push(v);
    }

    // transport_company_id transitions (Phase 5 Step 2):
    //   NULL → value: validate carrier exists + re-snapshot transport_name from tc.
    //   value → NULL: clear transport_name (carrier un-assigned).
    //   value → value: validate new carrier + re-snapshot transport_name.
    //   unchanged:     no-op.
    if (req.body.transport_company_id !== undefined) {
      const raw = req.body.transport_company_id;
      const newId = (raw === '' || raw == null) ? null : parseInt(raw, 10);
      if (newId !== null && !Number.isFinite(newId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
      }
      if (newId !== cur.transport_company_id) {
        if (newId == null) {
          // value → NULL: drop the FK and the snapshot.
          sets.push(`transport_company_id = $${idx++}`); params.push(null);
          sets.push(`transport_name = $${idx++}`);       params.push(null);
        } else {
          const { rows: tcRows } = await client.query(
            `SELECT name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`, [newId]
          );
          if (!tcRows[0]) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Vận tải không tồn tại hoặc đã bị xóa' });
          }
          sets.push(`transport_company_id = $${idx++}`); params.push(newId);
          sets.push(`transport_name = $${idx++}`);       params.push(tcRows[0].name);
        }
      }
    }

    // vehicle_number lifecycle → completed_at side effect.
    let vehicleTransitioned = false;
    if (req.body.vehicle_number !== undefined) {
      const prev = (cur.vehicle_number || '').trim();
      const next = (req.body.vehicle_number || '').trim();
      if (!prev && next) {
        sets.push(`completed_at = NOW()`);
        vehicleTransitioned = true;
      } else if (prev && !next) {
        sets.push(`completed_at = NULL`);
        vehicleTransitioned = true;
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

    // Phase 4: vehicle_number transitions may flip the job's truck_booking_status
    // to/from 'da_giao_xong', which can complete (or un-complete) the parent job.
    // Call inside the same transaction so completion is atomic with the booking update.
    if (vehicleTransitioned) {
      await checkAndCompleteJob(client, cur.job_id, req.user.id, null);
    }

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

// ─── POST /api/truck-bookings/batch ────────────────────────────────────────────
// Phase 5 Step 2 — "Đặt kế hoạch xe" bulk-create endpoint. Accepts an array
// of {job_id, container_id, planned_datetime, delivery_location, note} rows
// and creates one carrier-less booking per row (transport_company_id=NULL,
// transport_name=NULL, vehicle_number=NULL). DD fills the carrier later
// via PATCH (Step 3).
//
// All-or-nothing: every row is validated, then all INSERTs run inside a
// single transaction. If any row's container doesn't belong to the named
// job OR is already in another active booking, the whole batch is rolled
// back with a single 400.
//
// Auth: same as POST / — dieu_do + truong_phong_log. CUS/Sales/lead are
// expected to call this via TPL or DD; if they need direct access, lift
// the guard in a follow-up. The user spec mentions CUS/Sales/TPL/DD click
// the button — see L9 audit before relaxing the guard further.
router.post('/batch', requireAuth, async (req, res) => {
  if (!canPlan(req)) return res.status(403).json({ error: 'Không có quyền' });

  const items = Array.isArray(req.body?.items) ? req.body.items
              : Array.isArray(req.body) ? req.body
              : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Vui lòng cung cấp danh sách kế hoạch (items)' });
  }

  // Per-row shape validation. Build a normalized list with parsed ids.
  const norm = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i] || {};
    const jobId = parseInt(r.job_id, 10);
    const contId = parseInt(r.container_id, 10);
    if (!Number.isFinite(jobId)) {
      return res.status(400).json({ error: `Dòng ${i + 1}: job_id không hợp lệ` });
    }
    if (!Number.isFinite(contId)) {
      return res.status(400).json({ error: `Dòng ${i + 1}: container_id không hợp lệ` });
    }
    if (!r.planned_datetime || !String(r.planned_datetime).trim()) {
      return res.status(400).json({ error: `Dòng ${i + 1}: thiếu ngày giờ giao xe` });
    }
    if (!r.delivery_location || !String(r.delivery_location).trim()) {
      return res.status(400).json({ error: `Dòng ${i + 1}: thiếu địa điểm giao` });
    }
    norm.push({
      job_id: jobId,
      container_id: contId,
      planned_datetime: r.planned_datetime,
      delivery_location: String(r.delivery_location).trim(),
      note: (r.note === '' || r.note == null) ? null : String(r.note),
      receiver_name:  (r.receiver_name  === '' || r.receiver_name  == null) ? null : String(r.receiver_name),
      receiver_phone: (r.receiver_phone === '' || r.receiver_phone == null) ? null : String(r.receiver_phone),
      bbbg_note:      (r.bbbg_note      === '' || r.bbbg_note      == null) ? null : String(r.bbbg_note),
    });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Validate every container belongs to its named job. Group by job_id to
    // minimize roundtrips. The COUNT-match technique mirrors the single-POST
    // path (line ~145).
    const byJob = new Map();
    for (const r of norm) {
      const arr = byJob.get(r.job_id) || [];
      arr.push(r.container_id);
      byJob.set(r.job_id, arr);
    }
    for (const [jobId, cids] of byJob) {
      const { rows } = await client.query(
        `SELECT id FROM job_containers WHERE id = ANY($1::int[]) AND job_id = $2`,
        [cids, jobId]
      );
      if (rows.length !== cids.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Một số container không thuộc job #${jobId}`,
        });
      }
    }

    // Pre-check: none of the requested containers is already in another LIVE
    // booking. Surfaces a user-friendly list of cont_numbers vs. letting the
    // UNIQUE(container_id) on the link table error out anonymously.
    const allCids = norm.map(r => r.container_id);
    const { rows: dupRows } = await client.query(`
      SELECT tbc.container_id, jc.cont_number
      FROM truck_booking_containers tbc
      JOIN truck_bookings tb ON tb.id = tbc.booking_id
      JOIN job_containers jc ON jc.id = tbc.container_id
      WHERE tb.deleted_at IS NULL
        AND tbc.container_id = ANY($1::int[])
    `, [allCids]);
    if (dupRows.length > 0) {
      await client.query('ROLLBACK');
      const names = dupRows.map(r => r.cont_number || `#${r.container_id}`).join(', ');
      return res.status(400).json({
        error: `Container ${names} đã thuộc booking khác. Hãy xóa booking cũ trước.`,
      });
    }

    // Insert each booking + its single M:N link row. nextBookingCode is called
    // per-row so each row picks up codes generated by earlier rows in this
    // same transaction (PG read-committed visibility within the txn).
    const createdIds = [];
    for (const r of norm) {
      const bookingCode = await nextBookingCode(client, r.job_id);
      const { rows: bRows } = await client.query(
        `INSERT INTO truck_bookings
           (job_id, booking_code, transport_company_id, transport_name,
            planned_datetime, delivery_location, note,
            receiver_name, receiver_phone, bbbg_note,
            created_by)
         VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [r.job_id, bookingCode, r.planned_datetime, r.delivery_location, r.note,
         r.receiver_name, r.receiver_phone, r.bbbg_note, req.user.id]
      );
      const bookingId = bRows[0].id;
      await client.query(
        `INSERT INTO truck_booking_containers (booking_id, container_id) VALUES ($1, $2)`,
        [bookingId, r.container_id]
      );
      createdIds.push(bookingId);
    }

    await client.query('COMMIT');

    // Load and return all created bookings (post-commit, separate read).
    const created = [];
    for (const id of createdIds) {
      const row = await loadBookingById(db, id);
      if (row) created.push(row);
    }
    res.status(201).json(created);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/truck-bookings/batch error:', err.message);
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
