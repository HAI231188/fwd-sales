const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const CUS_ROLES = ['cus', 'cus1', 'cus2', 'cus3'];
const AUTO_CUS_ROLES = ['cus1', 'cus2', 'cus3'];
const LOG_ROLES = ['truong_phong_log', 'dieu_do', 'cus', 'cus1', 'cus2', 'cus3', 'ops'];

async function recordHistory(client, jobId, changedBy, fieldName, oldValue, newValue) {
  if (String(oldValue) === String(newValue)) return;
  await client.query(
    `INSERT INTO job_history (job_id, changed_by, field_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, changedBy, fieldName,
     oldValue != null ? String(oldValue) : null,
     newValue != null ? String(newValue) : null]
  );
}

async function autoAssignCus(client) {
  const { rows } = await client.query(`
    SELECT u.id, u.name,
      COUNT(DISTINCT jt.job_id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL) AS tk_count,
      COALESCE(SUM(
        (CASE WHEN j2.other_services->>'ktcl' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'kiem_dich' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'hun_trung' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'co' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'khac' = 'true' THEN 1 ELSE 0 END)
      ) FILTER (WHERE j2.status = 'pending' AND j2.deleted_at IS NULL), 0) AS svc_count
    FROM users u
    LEFT JOIN job_tk jt ON jt.cus_id = u.id
    LEFT JOIN jobs j ON j.id = jt.job_id
    LEFT JOIN job_assignments ja2 ON ja2.cus_id = u.id
    LEFT JOIN jobs j2 ON j2.id = ja2.job_id
    WHERE u.role = ANY($1)
    GROUP BY u.id, u.name
    ORDER BY (
      COUNT(DISTINCT jt.job_id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL) +
      COALESCE(SUM(
        (CASE WHEN j2.other_services->>'ktcl' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'kiem_dich' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'hun_trung' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'co' = 'true' THEN 1 ELSE 0 END) +
        (CASE WHEN j2.other_services->>'khac' = 'true' THEN 1 ELSE 0 END)
      ) FILTER (WHERE j2.status = 'pending' AND j2.deleted_at IS NULL), 0)
    ) ASC
    LIMIT 1
  `, [AUTO_CUS_ROLES]);
  return rows[0] || null;
}

// GET /api/jobs/stats
router.get('/stats', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  try {
    if (role === 'truong_phong_log') {
      const [total, waitingAssign, deadlinePending, overdue, warnSoon, missingInfo, deleteReqs, staff] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL`),
        db.query(`
          SELECT COUNT(*) AS v FROM jobs j
          WHERE j.status = 'pending' AND j.deleted_at IS NULL
            AND j.service_type IN ('tk','both')
            AND (
              j.assignment_mode = 'manual'
              OR NOT EXISTS (SELECT 1 FROM job_assignments ja WHERE ja.job_id = j.id AND ja.cus_id IS NOT NULL)
            )`),
        db.query(`
          SELECT COUNT(*) AS v FROM (
            SELECT j.id FROM jobs j
            LEFT JOIN job_assignments ja ON ja.job_id = j.id
            WHERE j.status = 'pending' AND j.deleted_at IS NULL
              AND (ja.cus_confirm_status = 'adjustment_requested' OR j.deadline IS NULL)
          ) x`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND deadline < NOW()`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND (pol IS NULL OR pod IS NULL OR cont_number IS NULL)`),
        db.query(`SELECT COUNT(*) AS v FROM job_delete_requests WHERE status = 'pending'`),
        db.query(`
          SELECT u.id, u.name, u.role, u.code, u.avatar_color,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL) AS pending,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()) AS overdue,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND ja.cus_confirm_status = 'pending') AS awaiting_confirm,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours') AS warning
          FROM users u
          LEFT JOIN job_assignments ja ON (ja.cus_id = u.id OR ja.ops_id = u.id)
          LEFT JOIN jobs j ON j.id = ja.job_id
          WHERE u.role = ANY($1)
          GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
          ORDER BY u.role, u.name
        `, [['cus','cus1','cus2','cus3','ops','dieu_do']]),
      ]);
      res.json({
        total_pending:    parseInt(total.rows[0].v),
        waiting_assign:   parseInt(waitingAssign.rows[0].v),
        deadline_pending: parseInt(deadlinePending.rows[0].v),
        overdue:          parseInt(overdue.rows[0].v),
        warn_soon:        parseInt(warnSoon.rows[0].v),
        missing_info:     parseInt(missingInfo.rows[0].v),
        delete_requests:  parseInt(deleteReqs.rows[0].v),
        staff:            staff.rows,
      });
    } else if (role === 'dieu_do') {
      const [total, daDat, chuaDat, warnOverdue] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL`),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.transport_name IS NOT NULL AND jt.vehicle_number IS NOT NULL`),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.planned_datetime IS NOT NULL AND (jt.transport_name IS NULL OR jt.transport_name = '')`),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.planned_datetime <= NOW() + INTERVAL '24 hours'`),
      ]);
      res.json({
        total_active:    parseInt(total.rows[0].v),
        da_dat_xe:       parseInt(daDat.rows[0].v),
        chua_dat_xe:     parseInt(chuaDat.rows[0].v),
        warn_overdue:    parseInt(warnOverdue.rows[0].v),
        chua_hoan_thanh: parseInt(total.rows[0].v),
      });
    } else if (CUS_ROLES.includes(role)) {
      const [total, choXacNhan, sapHan, quaHan] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.deleted_at IS NULL AND ja.cus_confirm_status = 'pending'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()`, [userId]),
      ]);
      res.json({
        total_active:  parseInt(total.rows[0].v),
        cho_xac_nhan:  parseInt(choXacNhan.rows[0].v),
        sap_han:       parseInt(sapHan.rows[0].v),
        qua_han:       parseInt(quaHan.rows[0].v),
      });
    } else if (role === 'ops') {
      const [total, choDoiLenh, choTQ, sapHan, quaHan] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_ops_task jot JOIN jobs j ON j.id = jot.job_id WHERE jot.ops_id = $1 AND jot.completed = FALSE AND j.deleted_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id JOIN job_tk jt ON jt.job_id = j.id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.tk_status = 'dang_lam'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()`, [userId]),
      ]);
      res.json({
        total_managing: parseInt(total.rows[0].v),
        cho_doi_lenh:   parseInt(choDoiLenh.rows[0].v),
        cho_thong_quan: parseInt(choTQ.rows[0].v),
        sap_han:        parseInt(sapHan.rows[0].v),
        qua_han:        parseInt(quaHan.rows[0].v),
      });
    } else {
      res.json({});
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/deadline-requests
router.get('/deadline-requests', requireAuth, async (req, res) => {
  try {
    const { rows: requests } = await db.query(`
      SELECT dr.*, j.job_code, j.customer_name, j.deadline AS current_deadline,
             u.name AS requested_by_name
      FROM job_deadline_requests dr
      JOIN jobs j ON j.id = dr.job_id
      JOIN users u ON u.id = dr.requested_by
      WHERE dr.status = 'pending' AND j.deleted_at IS NULL
      ORDER BY dr.id DESC
    `);
    const { rows: noDeadline } = await db.query(`
      SELECT j.id AS job_id, j.job_code, j.customer_name, j.created_at
      FROM jobs j
      WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline IS NULL
        AND NOT EXISTS (SELECT 1 FROM job_deadline_requests dr WHERE dr.job_id = j.id AND dr.status = 'pending')
      ORDER BY j.created_at DESC
    `);
    const { rows: deleteRequests } = await db.query(`
      SELECT dr.*, j.job_code, j.customer_name, u.name AS requested_by_name
      FROM job_delete_requests dr
      JOIN jobs j ON j.id = dr.job_id
      JOIN users u ON u.id = dr.requested_by
      WHERE dr.status = 'pending' AND j.deleted_at IS NULL
      ORDER BY dr.created_at DESC
    `);
    res.json({ requests, no_deadline: noDeadline, delete_requests: deleteRequests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/staff-workload
router.get('/staff-workload', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.name, u.role, u.code, u.avatar_color,
        COUNT(DISTINCT jt.job_id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL) AS tk_active,
        COALESCE(SUM(
          (CASE WHEN j2.other_services->>'ktcl' = 'true' THEN 1 ELSE 0 END) +
          (CASE WHEN j2.other_services->>'kiem_dich' = 'true' THEN 1 ELSE 0 END) +
          (CASE WHEN j2.other_services->>'hun_trung' = 'true' THEN 1 ELSE 0 END) +
          (CASE WHEN j2.other_services->>'co' = 'true' THEN 1 ELSE 0 END) +
          (CASE WHEN j2.other_services->>'khac' = 'true' THEN 1 ELSE 0 END)
        ) FILTER (WHERE j2.status = 'pending' AND j2.deleted_at IS NULL), 0) AS svc_load
      FROM users u
      LEFT JOIN job_tk jt ON jt.cus_id = u.id
      LEFT JOIN jobs j ON j.id = jt.job_id
      LEFT JOIN job_assignments ja2 ON ja2.cus_id = u.id
      LEFT JOIN jobs j2 ON j2.id = ja2.job_id
      WHERE u.role = ANY($1)
      GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
      ORDER BY u.role, u.name
    `, [AUTO_CUS_ROLES]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/users/log-staff
router.get('/users/log-staff', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, name, role, code, avatar_color
      FROM users WHERE role = ANY($1)
      ORDER BY role, name
    `, [LOG_ROLES]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/delete-requests  (truong_phong_log only — also returned inside /deadline-requests)
router.get('/delete-requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(`
      SELECT dr.*, j.job_code, j.customer_name, u.name AS requested_by_name
      FROM job_delete_requests dr
      JOIN jobs j ON j.id = dr.job_id
      JOIN users u ON u.id = dr.requested_by
      WHERE dr.status = 'pending' AND j.deleted_at IS NULL
      ORDER BY dr.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/
router.get('/', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  const { tab } = req.query;
  const isCompleted = tab === 'completed';

  const conditions = [];
  const params = [];
  let idx = 1;

  conditions.push(`j.deleted_at IS NULL`);
  conditions.push(`j.status = $${idx++}`);
  params.push(isCompleted ? 'completed' : 'pending');
  if (isCompleted) {
    conditions.push(`j.updated_at >= NOW() - INTERVAL '3 days'`);
  }

  if (role === 'dieu_do') {
    conditions.push(`j.service_type IN ('truck','both')`);
  } else if (CUS_ROLES.includes(role)) {
    conditions.push(`ja.cus_id = $${idx++}`);
    params.push(userId);
  } else if (role === 'ops') {
    conditions.push(`ja.ops_id = $${idx++}`);
    params.push(userId);
  } else if (role === 'sales') {
    conditions.push(`j.sales_id = $${idx++}`);
    params.push(userId);
  }

  const WHERE = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name,
        u_created.name AS created_by_name,
        ja.id AS assignment_id, ja.cus_id, ja.ops_id,
        ja.cus_confirm_status, ja.assignment_mode AS ja_mode,
        ja.adjustment_reason, ja.adjustment_deadline_proposed,
        u_cus.name AS cus_name, u_cus.code AS cus_code, u_cus.avatar_color AS cus_color,
        u_ops.name AS ops_name, u_ops.code AS ops_code, u_ops.avatar_color AS ops_color,
        jt.id AS tk_id, jt.tk_status, jt.tk_number, jt.tk_flow,
        jt.tk_datetime, jt.tq_datetime, jt.services_completed,
        jt.delivery_datetime, jt.delivery_location, jt.truck_booked,
        jt.completed_at AS tk_completed_at, jt.notes AS tk_notes,
        jtr.id AS truck_id, jtr.transport_name, jtr.planned_datetime, jtr.actual_datetime,
        jtr.vehicle_number, jtr.pickup_location,
        jtr.delivery_location AS truck_delivery_location,
        jtr.cost, jtr.completed_at AS truck_completed_at, jtr.notes AS truck_notes
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      ${WHERE}
      ORDER BY j.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/
router.post('/', requireAuth, async (req, res) => {
  const {
    job_code, customer_id, customer_name, customer_address, customer_tax_code,
    sales_id, pol, pod, bill_number, cont_number, cont_type, seal_number,
    etd, eta, tons, cbm, deadline, service_type, other_services, assignment_mode,
  } = req.body;

  if (!customer_name || !service_type) {
    return res.status(400).json({ error: 'Tên khách hàng và loại dịch vụ là bắt buộc' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO jobs (
        job_code, customer_id, customer_name, customer_address, customer_tax_code,
        sales_id, pol, pod, bill_number, cont_number, cont_type, seal_number,
        etd, eta, tons, cbm, deadline, service_type, other_services,
        assignment_mode, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      job_code || null, customer_id || null, customer_name,
      customer_address || null, customer_tax_code || null,
      sales_id || null, pol || null, pod || null, bill_number || null,
      cont_number || null, cont_type || null, seal_number || null,
      etd || null, eta || null, tons || null, cbm || null,
      deadline || null, service_type,
      JSON.stringify(other_services || {}),
      assignment_mode || 'auto', req.user.id,
    ]);

    const job = rows[0];

    if (customer_id) {
      await client.query(`
        UPDATE customer_pipeline SET stage = 'booked', updated_at = NOW()
        WHERE customer_id = $1 AND stage != 'booked'
      `, [customer_id]);
    }

    if (service_type === 'truck' || service_type === 'both') {
      await client.query(`INSERT INTO job_truck (job_id) VALUES ($1)`, [job.id]);
    }

    const isTk = service_type === 'tk' || service_type === 'both';
    const mode = assignment_mode || 'auto';

    if (isTk && mode === 'auto') {
      const cus = await autoAssignCus(client);
      if (cus) {
        await client.query(`
          INSERT INTO job_assignments (job_id, cus_id, assigned_by, assignment_mode)
          VALUES ($1, $2, $3, 'auto')
        `, [job.id, cus.id, req.user.id]);
        await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [job.id, cus.id]);
        await recordHistory(client, job.id, req.user.id, 'cus_assigned', null, cus.name);
      }
    } else if (isTk) {
      await client.query(`INSERT INTO job_tk (job_id) VALUES ($1)`, [job.id]);
    }

    await recordHistory(client, job.id, req.user.id, 'job_created', null, customer_name);
    await client.query('COMMIT');
    res.status(201).json(job);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/jobs/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name, u_created.name AS created_by_name,
        ja.id AS assignment_id, ja.cus_id, ja.ops_id,
        ja.cus_confirm_status, ja.assignment_mode AS ja_mode,
        ja.adjustment_reason, ja.adjustment_deadline_proposed,
        u_cus.name AS cus_name, u_cus.code AS cus_code,
        u_ops.name AS ops_name, u_ops.code AS ops_code
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });

    const [tkR, truckR, opsR, histR] = await Promise.all([
      db.query(`SELECT jt.*, u.name AS cus_name FROM job_tk jt LEFT JOIN users u ON u.id = jt.cus_id WHERE jt.job_id = $1`, [req.params.id]),
      db.query(`SELECT * FROM job_truck WHERE job_id = $1`, [req.params.id]),
      db.query(`SELECT jot.*, u.name AS ops_name FROM job_ops_task jot LEFT JOIN users u ON u.id = jot.ops_id WHERE jot.job_id = $1`, [req.params.id]),
      db.query(`SELECT jh.*, u.name AS changed_by_name FROM job_history jh LEFT JOIN users u ON u.id = jh.changed_by WHERE jh.job_id = $1 ORDER BY jh.changed_at DESC`, [req.params.id]),
    ]);

    res.json({ ...rows[0], tk: tkR.rows[0] || null, truck: truckR.rows[0] || null, ops_tasks: opsR.rows, history: histR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id
router.put('/:id', requireAuth, async (req, res) => {
  const FIELDS = ['job_code','customer_name','customer_address','customer_tax_code',
    'pol','pod','bill_number','cont_number','cont_type','seal_number',
    'etd','eta','tons','cbm','deadline','service_type','other_services','assignment_mode','status'];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }

    const sets = []; const params = []; let idx = 1;
    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      const val = f === 'other_services' ? JSON.stringify(req.body[f]) : req.body[f];
      sets.push(`${f} = $${idx++}`);
      params.push(val);
      await recordHistory(client, req.params.id, req.user.id, f, cur[0][f], val);
    }
    if (!sets.length) { await client.query('ROLLBACK'); return res.json(cur[0]); }
    sets.push(`updated_at = NOW()`);
    params.push(req.params.id);
    const { rows } = await client.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/jobs/:id  (truong_phong_log only — soft delete)
router.delete('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE jobs SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    await recordHistory(client, req.params.id, req.user.id, 'deleted', null, 'deleted');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/assign
router.post('/:id/assign', requireAuth, async (req, res) => {
  const { cus_id, ops_id } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(`SELECT * FROM job_assignments WHERE job_id = $1`, [req.params.id]);

    if (existing[0]) {
      const sets = []; const params = []; let idx = 1;
      if (cus_id !== undefined) { sets.push(`cus_id = $${idx++}`); params.push(cus_id); }
      if (ops_id !== undefined) { sets.push(`ops_id = $${idx++}`); params.push(ops_id); }
      sets.push(`assigned_by = $${idx++}`, `assigned_at = NOW()`, `assignment_mode = 'manual'`, `cus_confirm_status = 'pending'`);
      params.push(req.user.id, req.params.id);
      await client.query(`UPDATE job_assignments SET ${sets.join(', ')} WHERE job_id = $${idx} RETURNING *`, params);
    } else {
      await client.query(`
        INSERT INTO job_assignments (job_id, cus_id, ops_id, assigned_by, assignment_mode)
        VALUES ($1, $2, $3, $4, 'manual')
      `, [req.params.id, cus_id || null, ops_id || null, req.user.id]);
    }

    if (cus_id) {
      const { rows: tkEx } = await client.query(`SELECT id FROM job_tk WHERE job_id = $1`, [req.params.id]);
      if (tkEx[0]) {
        await client.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [cus_id, req.params.id]);
      } else {
        await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [req.params.id, cus_id]);
      }
      const { rows: cu } = await client.query(`SELECT name FROM users WHERE id = $1`, [cus_id]);
      await recordHistory(client, req.params.id, req.user.id, 'cus_assigned', null, cu[0]?.name);
    }
    if (ops_id) {
      const { rows: ou } = await client.query(`SELECT name FROM users WHERE id = $1`, [ops_id]);
      await recordHistory(client, req.params.id, req.user.id, 'ops_assigned', null, ou[0]?.name);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/confirm
router.patch('/:id/confirm', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE job_assignments SET cus_confirm_status = 'confirmed', cus_confirmed_at = NOW()
      WHERE job_id = $1 AND cus_id = $2
    `, [req.params.id, req.user.id]);
    await recordHistory(client, req.params.id, req.user.id, 'cus_confirmed', 'pending', 'confirmed');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/request-deadline
router.patch('/:id/request-deadline', requireAuth, async (req, res) => {
  const { proposed_deadline, reason } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: job } = await client.query(`SELECT deadline FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!job[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    await client.query(`
      INSERT INTO job_deadline_requests (job_id, requested_by, current_deadline, proposed_deadline, reason)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.params.id, req.user.id, job[0]?.deadline, proposed_deadline, reason]);
    await client.query(`
      UPDATE job_assignments SET cus_confirm_status = 'adjustment_requested',
        adjustment_reason = $1, adjustment_deadline_proposed = $2
      WHERE job_id = $3 AND cus_id = $4
    `, [reason, proposed_deadline, req.params.id, req.user.id]);
    await recordHistory(client, req.params.id, req.user.id, 'deadline_adj_requested', null, proposed_deadline);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/deadline-requests/:rid/review
router.patch('/deadline-requests/:rid/review', requireAuth, async (req, res) => {
  const { action, new_deadline } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dr } = await client.query(`SELECT * FROM job_deadline_requests WHERE id = $1`, [req.params.rid]);
    if (!dr[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }

    await client.query(`
      UPDATE job_deadline_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3
    `, [action, req.user.id, req.params.rid]);

    if (action === 'approved') {
      const dl = new_deadline || dr[0].proposed_deadline;
      await client.query(`UPDATE jobs SET deadline = $1, updated_at = NOW() WHERE id = $2`, [dl, dr[0].job_id]);
      await client.query(`UPDATE job_assignments SET cus_confirm_status = 'confirmed' WHERE job_id = $1`, [dr[0].job_id]);
      await recordHistory(client, dr[0].job_id, req.user.id, 'deadline', dr[0].current_deadline, dl);
    } else {
      await client.query(`UPDATE job_assignments SET cus_confirm_status = 'pending' WHERE job_id = $1`, [dr[0].job_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/delete-requests/:rid/review  (truong_phong_log only)
router.patch('/delete-requests/:rid/review', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const { action } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dr } = await client.query(`SELECT * FROM job_delete_requests WHERE id = $1`, [req.params.rid]);
    if (!dr[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }

    await client.query(
      `UPDATE job_delete_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3`,
      [action, req.user.id, req.params.rid]
    );

    if (action === 'approved') {
      await client.query(
        `UPDATE jobs SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [dr[0].job_id]
      );
      await recordHistory(client, dr[0].job_id, req.user.id, 'deleted', null, 'approved_delete_request');
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/set-deadline
router.patch('/:id/set-deadline', requireAuth, async (req, res) => {
  const { deadline } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT deadline FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }
    await client.query(`UPDATE jobs SET deadline = $1, updated_at = NOW() WHERE id = $2`, [deadline, req.params.id]);
    await recordHistory(client, req.params.id, req.user.id, 'deadline', cur[0]?.deadline, deadline);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/tk
router.patch('/:id/tk', requireAuth, async (req, res) => {
  const FIELDS = ['tk_datetime','tk_number','tk_flow','tk_status','tq_datetime',
    'services_completed','delivery_datetime','delivery_location','truck_booked','notes'];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM job_tk WHERE job_id = $1`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy TK' }); }

    const sets = []; const params = []; let idx = 1;
    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      const val = f === 'services_completed' ? JSON.stringify(req.body[f]) : req.body[f];
      sets.push(`${f} = $${idx++}`);
      params.push(val);
      await recordHistory(client, req.params.id, req.user.id, `tk_${f}`, cur[0][f], val);
    }
    if (!sets.length) { await client.query('ROLLBACK'); return res.json(cur[0]); }
    params.push(req.params.id);
    const { rows } = await client.query(`UPDATE job_tk SET ${sets.join(', ')} WHERE job_id = $${idx} RETURNING *`, params);

    const terminalStatuses = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (req.body.tk_status && terminalStatuses.includes(req.body.tk_status) && !cur[0].completed_at) {
      await client.query(`UPDATE job_tk SET completed_at = NOW() WHERE job_id = $1`, [req.params.id]);
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/truck
router.patch('/:id/truck', requireAuth, async (req, res) => {
  const FIELDS = ['transport_name','planned_datetime','actual_datetime',
    'vehicle_number','pickup_location','delivery_location','cost','notes'];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM job_truck WHERE job_id = $1`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy truck' }); }

    const sets = []; const params = []; let idx = 1;
    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      sets.push(`${f} = $${idx++}`);
      params.push(req.body[f]);
      await recordHistory(client, req.params.id, req.user.id, `truck_${f}`, cur[0][f], req.body[f]);
    }
    if (!sets.length) { await client.query('ROLLBACK'); return res.json(cur[0]); }
    params.push(req.params.id);
    const { rows } = await client.query(`UPDATE job_truck SET ${sets.join(', ')} WHERE job_id = $${idx} RETURNING *`, params);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/truck/complete
router.patch('/:id/truck/complete', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE job_truck SET completed_at = NOW() WHERE job_id = $1 AND completed_at IS NULL RETURNING *`,
      [req.params.id]
    );
    await recordHistory(client, req.params.id, req.user.id, 'truck_completed', null, 'completed');
    await client.query('COMMIT');
    res.json(rows[0] || {});
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/ops-task
router.post('/:id/ops-task', requireAuth, async (req, res) => {
  const { ops_id, content, port, deadline } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO job_ops_task (job_id, ops_id, content, port, deadline)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [req.params.id, ops_id || null, content, port || null, deadline || null]);

    if (ops_id) {
      const { rows: ja } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [req.params.id]);
      if (ja[0]) {
        await client.query(`UPDATE job_assignments SET ops_id = $1 WHERE job_id = $2`, [ops_id, req.params.id]);
      } else {
        await client.query(`INSERT INTO job_assignments (job_id, ops_id, assigned_by) VALUES ($1,$2,$3)`, [req.params.id, ops_id, req.user.id]);
      }
      const { rows: ou } = await client.query(`SELECT name FROM users WHERE id = $1`, [ops_id]);
      await recordHistory(client, req.params.id, req.user.id, 'ops_task_created', null, ou[0]?.name);
    }
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/ops-task/:tid/complete
router.patch('/ops-task/:tid/complete', requireAuth, async (req, res) => {
  const { notes } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE job_ops_task SET completed = TRUE, completed_at = NOW(), notes = COALESCE($1, notes)
       WHERE id = $2 RETURNING *`,
      [notes || null, req.params.tid]
    );
    if (rows[0]) {
      await recordHistory(client, rows[0].job_id, req.user.id, 'ops_task_completed', 'false', 'true');
    }
    await client.query('COMMIT');
    res.json(rows[0] || {});
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/delete-request
router.post('/:id/delete-request', requireAuth, async (req, res) => {
  const { reason } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: job } = await client.query(`SELECT id FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!job[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    await client.query(
      `INSERT INTO job_delete_requests (job_id, requested_by, reason) VALUES ($1, $2, $3)`,
      [req.params.id, req.user.id, reason || null]
    );
    await recordHistory(client, req.params.id, req.user.id, 'delete_requested', null, String(req.user.id));
    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/complete
router.patch('/:id/complete', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    await recordHistory(client, req.params.id, req.user.id, 'status', 'pending', 'completed');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
