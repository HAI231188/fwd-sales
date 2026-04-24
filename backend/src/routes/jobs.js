const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { suggestCus, suggestOps } = require('../services/ai-assignment');

// In-memory suggestion cache (60s TTL) — invalidated on manual assignment
let suggestionCache = { data: null, ts: 0 };

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

function withTimeout(promise, ms) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}


// GET /api/jobs/stats
router.get('/stats', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  try {
    if (role === 'truong_phong_log') {
      const [total, waitingCus, waitingOps, cusConfirmPend, deadlineAdj, noDeadline, overdue, warnSoon, missingInfo, deleteReqs, staff] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL`),
        db.query(`
          SELECT COUNT(*) AS v FROM jobs j
          LEFT JOIN job_assignments ja ON ja.job_id = j.id
          WHERE j.status = 'pending' AND j.deleted_at IS NULL
            AND j.service_type IN ('tk','both')
            AND (ja.cus_id IS NULL OR ja.id IS NULL)`),
        db.query(`
          SELECT COUNT(*) AS v FROM jobs j
          LEFT JOIN job_assignments ja ON ja.job_id = j.id
          WHERE j.status = 'pending' AND j.deleted_at IS NULL
            AND j.destination = 'hai_phong'
            AND j.service_type IN ('truck','both')
            AND (ja.ops_id IS NULL OR ja.id IS NULL)`),
        db.query(`
          SELECT COUNT(*) AS v FROM job_assignments ja
          JOIN jobs j ON j.id = ja.job_id
          WHERE j.status = 'pending' AND j.deleted_at IS NULL
            AND ja.cus_id IS NOT NULL AND ja.cus_confirm_status = 'pending'`),
        db.query(`
          SELECT COUNT(*) AS v FROM job_assignments ja
          JOIN jobs j ON j.id = ja.job_id
          WHERE j.status = 'pending' AND j.deleted_at IS NULL
            AND ja.cus_confirm_status = 'adjustment_requested'`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND deadline IS NULL`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND deadline < NOW()`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`),
        db.query(`SELECT COUNT(*) AS v FROM jobs WHERE status = 'pending' AND deleted_at IS NULL AND (pol IS NULL OR pod IS NULL OR cont_number IS NULL OR han_lenh IS NULL)`),
        db.query(`SELECT COUNT(*) AS v FROM job_delete_requests WHERE status = 'pending'`),
        db.query(`
          SELECT u.id, u.name, u.role, u.code, u.avatar_color,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL) AS pending,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()) AS overdue,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND ja.cus_id IS NOT NULL AND ja.cus_confirm_status = 'pending') AS awaiting_confirm,
            COUNT(ja.id) FILTER (WHERE j.status = 'pending' AND j.deleted_at IS NULL AND (
              (u.role != 'dieu_do' AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours')
              OR (u.role = 'dieu_do'
                  AND jtr.planned_datetime IS NOT NULL
                  AND jtr.planned_datetime <= NOW() + INTERVAL '24 hours'
                  AND (jtr.transport_name IS NULL OR jtr.transport_name = '')
                  AND jtr.completed_at IS NULL)
            )) AS warning
          FROM users u
          LEFT JOIN job_assignments ja ON (ja.cus_id = u.id OR ja.ops_id = u.id OR ja.dieu_do_id = u.id)
          LEFT JOIN jobs j ON j.id = ja.job_id
          LEFT JOIN job_truck jtr ON jtr.job_id = j.id
          WHERE u.role = ANY($1)
          GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
          ORDER BY u.role, u.name
        `, [['cus','cus1','cus2','cus3','ops','dieu_do']]),
      ]);
      res.json({
        total_pending:         parseInt(total.rows[0].v),
        waiting_cus:           parseInt(waitingCus.rows[0].v),
        waiting_ops:           parseInt(waitingOps.rows[0].v),
        cus_confirm_pending:   parseInt(cusConfirmPend.rows[0].v),
        deadline_adj_requests: parseInt(deadlineAdj.rows[0].v),
        no_deadline:           parseInt(noDeadline.rows[0].v),
        overdue:               parseInt(overdue.rows[0].v),
        warn_soon:             parseInt(warnSoon.rows[0].v),
        missing_info:          parseInt(missingInfo.rows[0].v),
        delete_requests:       parseInt(deleteReqs.rows[0].v),
        staff:                 staff.rows,
      });
    } else if (role === 'dieu_do') {
      const [total, daDat, chuaDat, warnOverdue] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.transport_name IS NOT NULL AND jt.vehicle_number IS NOT NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.planned_datetime IS NOT NULL AND (jt.transport_name IS NULL OR jt.transport_name = '')`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_truck jt JOIN jobs j ON j.id = jt.job_id JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.completed_at IS NULL AND jt.planned_datetime <= NOW() + INTERVAL '24 hours'`, [userId]),
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
    const [pendingConf, requests, noDeadline, deleteRequests] = await Promise.all([
      db.query(`
        SELECT ja.job_id, j.job_code, j.customer_name, j.deadline, j.created_at,
               u_cus.name AS cus_name,
               u_ops.name AS ops_name,
               al.reason AS ai_reason
        FROM job_assignments ja
        JOIN jobs j ON j.id = ja.job_id
        LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
        LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
        LEFT JOIN LATERAL (
          SELECT reason FROM ai_assignment_logs
          WHERE job_id = ja.job_id AND role = 'cus'
          ORDER BY id DESC LIMIT 1
        ) al ON true
        WHERE ja.cus_id IS NOT NULL AND ja.cus_confirm_status = 'pending' AND j.status = 'pending' AND j.deleted_at IS NULL
        ORDER BY j.created_at DESC
      `),
      db.query(`
        SELECT dr.*, j.job_code, j.customer_name, j.deadline AS current_deadline,
               u.name AS requested_by_name
        FROM job_deadline_requests dr
        JOIN jobs j ON j.id = dr.job_id
        JOIN users u ON u.id = dr.requested_by
        WHERE dr.status = 'pending' AND j.deleted_at IS NULL
        ORDER BY dr.id DESC
      `),
      db.query(`
        SELECT j.id AS job_id, j.job_code, j.customer_name, j.created_at
        FROM jobs j
        WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline IS NULL
          AND NOT EXISTS (SELECT 1 FROM job_deadline_requests dr WHERE dr.job_id = j.id AND dr.status = 'pending')
        ORDER BY j.created_at DESC
      `),
      db.query(`
        SELECT dr.*, j.job_code, j.customer_name, u.name AS requested_by_name
        FROM job_delete_requests dr
        JOIN jobs j ON j.id = dr.job_id
        JOIN users u ON u.id = dr.requested_by
        WHERE dr.status = 'pending' AND j.deleted_at IS NULL
        ORDER BY dr.created_at DESC
      `),
    ]);
    res.json({
      pending_confirmations: pendingConf.rows,
      requests:              requests.rows,
      no_deadline:           noDeadline.rows,
      delete_requests:       deleteRequests.rows,
    });
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
  const ALL_STAFF_ROLES = [...LOG_ROLES, 'sales', 'lead'];
  try {
    const { rows } = await db.query(`
      SELECT id, name, role, code, avatar_color
      FROM users WHERE role = ANY($1)
      ORDER BY role, name
    `, [ALL_STAFF_ROLES]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/customer-search?q=...
router.get('/customer-search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const { rows } = await db.query(`
      SELECT cp.id AS pipeline_id, cp.customer_id, cp.sales_id,
        cp.company_name AS customer_name, cp.contact_person, cp.phone,
        u.name AS sales_name,
        COALESCE(c.address, (SELECT j.customer_address FROM jobs j
          WHERE (j.customer_id = cp.customer_id OR LOWER(j.customer_name) = LOWER(cp.company_name))
            AND j.customer_address IS NOT NULL AND j.deleted_at IS NULL
          ORDER BY j.created_at DESC LIMIT 1)) AS customer_address,
        COALESCE(c.tax_code, (SELECT j.customer_tax_code FROM jobs j
          WHERE (j.customer_id = cp.customer_id OR LOWER(j.customer_name) = LOWER(cp.company_name))
            AND j.customer_tax_code IS NOT NULL AND j.deleted_at IS NULL
          ORDER BY j.created_at DESC LIMIT 1)) AS customer_tax_code
      FROM customer_pipeline cp
      LEFT JOIN users u ON u.id = cp.sales_id
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE cp.stage = 'booked' AND cp.company_name ILIKE $1
      ORDER BY cp.company_name
      LIMIT 10
    `, [`%${q}%`]);
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

// GET /api/jobs/settings  (truong_phong_log only)
router.get('/settings', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(`SELECT * FROM log_settings WHERE id = 1`);
    res.json(rows[0] || { id: 1, assignment_mode: 'auto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/settings/assignment-mode  (truong_phong_log only)
router.patch('/settings/assignment-mode', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const { assignment_mode } = req.body;
  if (!['auto', 'manual'].includes(assignment_mode)) return res.status(400).json({ error: 'Chế độ không hợp lệ' });
  try {
    await db.query(
      `UPDATE log_settings SET assignment_mode = $1, updated_by = $2, updated_at = NOW() WHERE id = 1`,
      [assignment_mode, req.user.id]
    );
    res.json({ ok: true, assignment_mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/waiting-assignments  (truong_phong_log only)
// Returns waiting_cus and waiting_ops with AI suggestions per job (60s in-memory cache)
router.get('/waiting-assignments', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const now = Date.now();
    if (suggestionCache.data && now - suggestionCache.ts < 60000) {
      return res.json(suggestionCache.data);
    }

    const [cusJobs, opsJobs] = await Promise.all([
      db.query(`
        SELECT j.id, j.job_code, j.customer_name, j.service_type, j.etd, j.eta,
               j.deadline, j.created_at, j.pol, j.pod, j.destination, j.other_services
        FROM jobs j
        LEFT JOIN job_assignments ja ON ja.job_id = j.id
        WHERE j.status = 'pending' AND j.deleted_at IS NULL
          AND j.service_type IN ('tk','both')
          AND (ja.cus_id IS NULL OR ja.id IS NULL)
        ORDER BY j.created_at ASC
        LIMIT 10
      `),
      db.query(`
        SELECT j.id, j.job_code, j.customer_name, j.service_type, j.etd, j.eta,
               j.deadline, j.created_at, j.pol, j.pod, j.destination, j.other_services
        FROM jobs j
        LEFT JOIN job_assignments ja ON ja.job_id = j.id
        WHERE j.status = 'pending' AND j.deleted_at IS NULL
          AND j.destination = 'hai_phong'
          AND j.service_type IN ('truck','both')
          AND (ja.ops_id IS NULL OR ja.id IS NULL)
        ORDER BY j.created_at ASC
        LIMIT 10
      `),
    ]);

    const [cusWithAI, opsWithAI] = await Promise.all([
      Promise.all(cusJobs.rows.map(async job => {
        const s = await withTimeout(suggestCus(job, db.pool).catch(() => null), 3000);
        return { ...job, ai_suggestion: s };
      })),
      Promise.all(opsJobs.rows.map(async job => {
        const s = await withTimeout(suggestOps(job, db.pool).catch(() => null), 3000);
        return { ...job, ai_suggestion: s };
      })),
    ]);

    const result = { waiting_cus: cusWithAI, waiting_ops: opsWithAI };
    suggestionCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/filtered?type=...  — all LOG roles
router.get('/filtered', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  const { type } = req.query;

  const params = [];
  let idx = 1;
  let baseWhere = '';
  let extraWhere = '';

  if (role === 'truong_phong_log') {
    // no base restriction
  } else if (CUS_ROLES.includes(role)) {
    baseWhere = `AND ja.cus_id = $${idx++}`;
    params.push(userId);
  } else if (role === 'dieu_do') {
    baseWhere = `AND ja.dieu_do_id = $${idx++}`;
    params.push(userId);
  } else if (role === 'ops') {
    baseWhere = `AND ja.ops_id = $${idx++}`;
    params.push(userId);
  } else {
    return res.status(403).json({ error: 'Không có quyền' });
  }

  switch (type) {
    // TP filters
    case 'warning':   extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`; break;
    case 'missing':   extraWhere = `AND (j.pol IS NULL OR j.pod IS NULL OR j.cont_number IS NULL OR j.han_lenh IS NULL)`; break;
    case 'overdue':   extraWhere = `AND j.deadline < NOW()`; break;
    // CUS filters
    case 'cus_waiting_confirm': extraWhere = `AND ja.cus_id IS NOT NULL AND ja.cus_confirm_status = 'pending'`; break;
    case 'cus_near_deadline':   extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`; break;
    case 'cus_overdue':         extraWhere = `AND j.deadline < NOW()`; break;
    // DieuDo filters
    case 'truck_total':
    case 'truck_pending':    extraWhere = `AND jtr.completed_at IS NULL`; break;
    case 'truck_booked':     extraWhere = `AND jtr.transport_name IS NOT NULL AND jtr.vehicle_number IS NOT NULL`; break;
    case 'truck_not_booked': extraWhere = `AND jtr.planned_datetime IS NOT NULL AND (jtr.transport_name IS NULL OR jtr.transport_name = '')`; break;
    case 'truck_warning':    extraWhere = `AND jtr.completed_at IS NULL AND jtr.planned_datetime <= NOW() + INTERVAL '24 hours'`; break;
    // OPS filters
    case 'ops_waiting_tq_doilenh': extraWhere = `AND jt.tk_status = 'dang_lam'`; break;
    case 'ops_waiting_doilenh':
      extraWhere = `AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.ops_id = $1 AND jot.completed = FALSE)`;
      break;
    case 'ops_near_deadline': extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`; break;
    case 'ops_overdue':       extraWhere = `AND j.deadline < NOW()`; break;
    // default: no extra filter (pending, cus_active, ops_total, etc.)
  }

  try {
    const { rows } = await db.query(`
      SELECT j.id, j.job_code, j.created_at, j.customer_name, j.deadline, j.han_lenh,
             j.pol, j.pod, j.cont_number, j.service_type, j.si_number,
             ja.cus_id, cus.name AS cus_name,
             ja.ops_id, ops.name AS ops_name,
             ja.cus_confirm_status,
             jt.tk_status, jt.tk_flow, jt.tq_datetime, jt.tk_number, jt.tk_datetime, jt.notes AS tk_notes,
             jtr.transport_name, jtr.vehicle_number, jtr.planned_datetime,
             jtr.delivery_location AS truck_delivery_location, jtr.cost,
             jtr.completed_at AS truck_completed_at,
             (SELECT string_agg(jot.content, '; ' ORDER BY jot.id)
              FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.completed = FALSE) AS ops_tasks_pending,
             TRIM(
               CASE WHEN j.pol IS NULL THEN 'POL ' ELSE '' END ||
               CASE WHEN j.pod IS NULL THEN 'POD ' ELSE '' END ||
               CASE WHEN j.cont_number IS NULL THEN 'Số cont ' ELSE '' END ||
               CASE WHEN j.han_lenh IS NULL THEN 'Hạn lệnh' ELSE '' END
             ) AS missing_fields
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON true
      LEFT JOIN users cus ON cus.id = ja.cus_id
      LEFT JOIN users ops ON ops.id = ja.ops_id
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      WHERE j.status = 'pending' AND j.deleted_at IS NULL ${baseWhere} ${extraWhere}
      ORDER BY j.deadline ASC NULLS LAST, j.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/
router.get('/', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  const { tab, from_date, to_date } = req.query;
  const isCompleted = tab === 'completed';

  const conditions = [];
  const params = [];
  let idx = 1;

  conditions.push(`j.deleted_at IS NULL`);
  conditions.push(`j.status = $${idx++}`);
  params.push(isCompleted ? 'completed' : 'pending');

  if (isCompleted) {
    // Feature 2: date range — default last 3 days when no params supplied
    if (from_date) {
      conditions.push(`j.updated_at >= $${idx++}::date`);
      params.push(from_date.replace(/'/g, ''));
    }
    if (to_date) {
      conditions.push(`j.updated_at < $${idx++}::date + INTERVAL '1 day'`);
      params.push(to_date.replace(/'/g, ''));
    }
    if (!from_date && !to_date) {
      conditions.push(`j.updated_at >= NOW() - INTERVAL '3 days'`);
    }
    // Feature 1: no role filtering for completed tab — all LOG roles see all completed jobs
  } else {
    if (role === 'dieu_do') {
      conditions.push(`ja.dieu_do_id = $${idx++}`);
      params.push(userId);
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
  }

  const WHERE = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name,
        u_created.name AS created_by_name,
        ja.id AS assignment_id, ja.cus_id, ja.ops_id, ja.dieu_do_id,
        ja.cus_confirm_status, ja.assignment_mode AS ja_mode,
        ja.adjustment_reason, ja.adjustment_deadline_proposed,
        u_cus.name AS cus_name, u_cus.code AS cus_code, u_cus.avatar_color AS cus_color,
        u_ops.name AS ops_name, u_ops.code AS ops_code, u_ops.avatar_color AS ops_color,
        u_dd.name AS dieu_do_name, u_dd.code AS dieu_do_code, u_dd.avatar_color AS dieu_do_color,
        jt.id AS tk_id, jt.tk_status, jt.tk_number, jt.tk_flow,
        jt.tk_datetime, jt.tq_datetime, jt.services_completed,
        jt.delivery_datetime, jt.delivery_location, jt.truck_booked,
        jt.completed_at AS tk_completed_at, jt.notes AS tk_notes,
        jtr.id AS truck_id, jtr.transport_name, jtr.planned_datetime, jtr.actual_datetime,
        jtr.vehicle_number, jtr.pickup_location,
        jtr.delivery_location AS truck_delivery_location,
        jtr.cost, jtr.completed_at AS truck_completed_at, jtr.notes AS truck_notes,
        COALESCE((
          SELECT json_agg(json_build_object(
            'id', jc.id, 'cont_number', jc.cont_number,
            'cont_type', jc.cont_type, 'seal_number', jc.seal_number
          ) ORDER BY jc.id)
          FROM job_containers jc WHERE jc.job_id = j.id
        ), '[]'::json) AS containers
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON true
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_dd ON u_dd.id = ja.dieu_do_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      ${WHERE}
      ORDER BY j.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/jobs error (role=' + role + '):', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/
router.post('/', requireAuth, async (req, res) => {
  const {
    job_code, customer_id, customer_name, customer_address, customer_tax_code,
    sales_id, pol, pod, cont_number, cont_type, seal_number,
    etd, eta, tons, cbm, deadline, service_type, other_services,
    is_new_customer, cargo_type, so_kien, kg, containers, destination, han_lenh,
    si_number, mbl_no, hbl_no,
  } = req.body;

  if (!customer_name || !service_type) {
    return res.status(400).json({ error: 'Tên khách hàng và loại dịch vụ là bắt buộc' });
  }

  try {
    // Read assignment mode from DB before starting transaction
    const settingsRes = await db.query(`SELECT assignment_mode FROM log_settings WHERE id = 1`);
    const mode = settingsRes.rows[0]?.assignment_mode || 'auto';
    const isTk = service_type === 'tk' || service_type === 'both';
    const needsOps = destination === 'hai_phong' && (service_type === 'truck' || service_type === 'both');

    let cusSuggestion = null;
    let opsSuggestion = null;

    if (mode === 'auto') {
      await Promise.all([
        isTk ? suggestCus({ customer_name, service_type, pol, pod, other_services, destination }, db.pool)
                 .then(r => { cusSuggestion = r; }).catch(e => console.error('suggestCus:', e.message))
             : Promise.resolve(),
        needsOps ? suggestOps({ customer_name, service_type, destination }, db.pool)
                     .then(r => { opsSuggestion = r; }).catch(e => console.error('suggestOps:', e.message))
                 : Promise.resolve(),
      ]);
    }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      INSERT INTO jobs (
        job_code, customer_id, customer_name, customer_address, customer_tax_code,
        sales_id, pol, pod, cont_number, cont_type, seal_number,
        etd, eta, tons, cbm, deadline, service_type, other_services,
        cargo_type, so_kien, kg, destination, created_by, han_lenh,
        si_number, mbl_no, hbl_no
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
      RETURNING *
    `, [
      job_code || null, customer_id || null, customer_name,
      customer_address || null, customer_tax_code || null,
      sales_id || null, pol || null, pod || null,
      cont_number || null, cont_type || null, seal_number || null,
      etd || null, eta || null, tons || null, cbm || null,
      deadline || null, service_type,
      JSON.stringify(other_services || {}),
      cargo_type || 'fcl', so_kien || null, kg || null,
      destination || null, req.user.id, han_lenh || null,
      si_number || null, mbl_no || null, hbl_no || null,
    ]);

    const job = rows[0];

    if (Array.isArray(containers) && containers.length > 0) {
      for (const c of containers) {
        if (!c.cont_type) continue;
        await client.query(
          `INSERT INTO job_containers (job_id, cont_number, cont_type, seal_number) VALUES ($1,$2,$3,$4)`,
          [job.id, c.cont_number || null, c.cont_type, c.seal_number || null]
        );
      }
    }

    if (customer_id) {
      await client.query(`
        UPDATE customer_pipeline SET stage = 'booked', updated_at = NOW()
        WHERE customer_id = $1 AND stage != 'booked'
      `, [customer_id]);
    } else if (is_new_customer && sales_id && customer_name) {
      await client.query(`
        INSERT INTO customer_pipeline (sales_id, company_name, stage)
        VALUES ($1, $2, 'booked')
        ON CONFLICT (sales_id, LOWER(company_name)) DO UPDATE SET stage = 'booked', updated_at = NOW()
      `, [sales_id, customer_name]);
    }

    if (service_type === 'truck' || service_type === 'both') {
      await client.query(`INSERT INTO job_truck (job_id) VALUES ($1)`, [job.id]);
    }

    // Điều Độ assignment for truck/both jobs
    const isDieuDo = service_type === 'truck' || service_type === 'both';
    let ddUserId = null;
    if (isDieuDo) {
      const ddRes = await client.query(`
        SELECT u.id FROM users u WHERE u.role = 'dieu_do'
        ORDER BY (
          SELECT COUNT(*) FROM job_assignments ja2
          JOIN jobs j2 ON j2.id = ja2.job_id
          WHERE ja2.dieu_do_id = u.id AND j2.status = 'pending' AND j2.deleted_at IS NULL
        ) ASC, RANDOM()
        LIMIT 1
      `);
      ddUserId = ddRes.rows[0]?.id || null;
    }

    // TK / CUS assignment
    if (isTk) {
      if (mode === 'auto' && cusSuggestion) {
        await client.query(`
          INSERT INTO job_assignments (job_id, cus_id, assigned_by, assignment_mode, cus_confirm_status)
          VALUES ($1, $2, $3, 'auto', 'pending')
        `, [job.id, cusSuggestion.user_id, req.user.id]);
        await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [job.id, cusSuggestion.user_id]);
        await client.query(`
          INSERT INTO notifications (user_id, type, title, body, job_id)
          VALUES ($1, 'job_assigned', 'Phân công TK mới', $2, $3)
        `, [cusSuggestion.user_id, `Bạn được phân công TK cho ${customer_name} (AI tự động)`, job.id]);
        await recordHistory(client, job.id, req.user.id, 'cus_assigned', null, cusSuggestion.user_name || String(cusSuggestion.user_id));
      } else {
        // Manual mode or AI failed — leave unassigned, appears in "Chờ phân CUS"
        await client.query(`INSERT INTO job_tk (job_id) VALUES ($1)`, [job.id]);
      }
    }

    // OPS assignment for Hải Phòng truck jobs
    if (needsOps && mode === 'auto' && opsSuggestion) {
      const { rows: jaEx } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [job.id]);
      if (jaEx[0]) {
        await client.query(`UPDATE job_assignments SET ops_id = $1 WHERE job_id = $2`, [opsSuggestion.user_id, job.id]);
      } else {
        await client.query(`
          INSERT INTO job_assignments (job_id, ops_id, assigned_by, assignment_mode)
          VALUES ($1, $2, $3, 'auto')
        `, [job.id, opsSuggestion.user_id, req.user.id]);
      }
      await client.query(`
        INSERT INTO notifications (user_id, type, title, body, job_id)
        VALUES ($1, 'job_assigned', 'Phân công OPS mới', $2, $3)
      `, [opsSuggestion.user_id, `Bạn được phân công OPS cho ${customer_name} tại Hải Phòng`, job.id]);
      await recordHistory(client, job.id, req.user.id, 'ops_assigned', null, opsSuggestion.user_name || String(opsSuggestion.user_id));
    }

    // Điều Độ assignment: set dieu_do_id on the job_assignments row
    if (isDieuDo && ddUserId) {
      const { rows: jaEx2 } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [job.id]);
      if (jaEx2[0]) {
        await client.query(`UPDATE job_assignments SET dieu_do_id = $1 WHERE job_id = $2`, [ddUserId, job.id]);
      } else {
        await client.query(`
          INSERT INTO job_assignments (job_id, dieu_do_id, assigned_by, assignment_mode)
          VALUES ($1, $2, $3, 'auto')
        `, [job.id, ddUserId, req.user.id]);
      }
      await client.query(`
        INSERT INTO notifications (user_id, type, title, body, job_id)
        VALUES ($1, 'job_assigned', 'Phân công Điều Độ mới', $2, $3)
      `, [ddUserId, `Bạn được phân công điều độ cho ${customer_name}`, job.id]);
      await recordHistory(client, job.id, req.user.id, 'dieu_do_assigned', null, String(ddUserId));
    }

    await recordHistory(client, job.id, req.user.id, 'job_created', null, customer_name);
    await client.query('COMMIT');

    // Log AI assignments after commit so FK is satisfied
    const logPs = [];
    if (cusSuggestion) logPs.push(
      db.query(`INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used) VALUES ($1,$2,'cus',$3,$4,$5)`,
        [job.id, cusSuggestion.user_id, cusSuggestion.reason, cusSuggestion.cost || 0, cusSuggestion.fallback || false])
    );
    if (opsSuggestion) logPs.push(
      db.query(`INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used) VALUES ($1,$2,'ops',$3,$4,$5)`,
        [job.id, opsSuggestion.user_id, opsSuggestion.reason, opsSuggestion.cost || 0, opsSuggestion.fallback || false])
    );
    await Promise.all(logPs).catch(e => console.error('AI log failed:', e.message));

    res.status(201).json(job);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name, u_created.name AS created_by_name,
        ja.id AS assignment_id, ja.cus_id, ja.ops_id, ja.dieu_do_id,
        ja.cus_confirm_status, ja.assignment_mode AS ja_mode,
        ja.adjustment_reason, ja.adjustment_deadline_proposed,
        u_cus.name AS cus_name, u_cus.code AS cus_code,
        u_ops.name AS ops_name, u_ops.code AS ops_code,
        u_dd.name AS dieu_do_name, u_dd.code AS dieu_do_code
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_dd ON u_dd.id = ja.dieu_do_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });

    const [tkR, truckR, opsR, histR, contsR] = await Promise.all([
      db.query(`SELECT jt.*, u.name AS cus_name FROM job_tk jt LEFT JOIN users u ON u.id = jt.cus_id WHERE jt.job_id = $1`, [req.params.id]),
      db.query(`SELECT * FROM job_truck WHERE job_id = $1`, [req.params.id]),
      db.query(`SELECT jot.*, u.name AS ops_name FROM job_ops_task jot LEFT JOIN users u ON u.id = jot.ops_id WHERE jot.job_id = $1`, [req.params.id]),
      db.query(`SELECT jh.*, u.name AS changed_by_name FROM job_history jh LEFT JOIN users u ON u.id = jh.changed_by WHERE jh.job_id = $1 ORDER BY jh.changed_at DESC`, [req.params.id]),
      db.query(`SELECT id, cont_number, cont_type, seal_number FROM job_containers WHERE job_id = $1 ORDER BY id`, [req.params.id]),
    ]);

    res.json({ ...rows[0], tk: tkR.rows[0] || null, truck: truckR.rows[0] || null, ops_tasks: opsR.rows, history: histR.rows, containers: contsR.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/jobs/:id
router.put('/:id', requireAuth, async (req, res) => {
  if (req.user.role === 'ops')
    return res.status(403).json({ error: 'Không có quyền chỉnh sửa thông tin job' });
  if (req.body.deadline !== undefined && req.user.role !== 'truong_phong_log')
    return res.status(403).json({ error: 'Chỉ Trưởng phòng mới được đổi deadline' });

  const FIELDS = ['job_code','customer_name','customer_address','customer_tax_code',
    'pol','pod','cont_number','cont_type','seal_number',
    'etd','eta','tons','cbm','deadline','service_type','other_services','status',
    'cargo_type','so_kien','kg','destination','han_lenh','si_number','mbl_no','hbl_no',
    'ops_partner','sales_id'];

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

    let containersUpdated = false;
    if (Array.isArray(req.body.containers)) {
      await client.query(`DELETE FROM job_containers WHERE job_id = $1`, [req.params.id]);
      for (const c of req.body.containers) {
        if (c.cont_type) {
          await client.query(
            `INSERT INTO job_containers (job_id, cont_number, cont_type, seal_number) VALUES ($1,$2,$3,$4)`,
            [req.params.id, c.cont_number || null, c.cont_type, c.seal_number || null]
          );
        }
      }
      await recordHistory(client, req.params.id, req.user.id, 'containers', null, 'updated');
      containersUpdated = true;
    }

    if (!sets.length && !containersUpdated) { await client.query('ROLLBACK'); return res.json(cur[0]); }
    if (sets.length) {
      sets.push(`updated_at = NOW()`);
      params.push(req.params.id);
      await client.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $${idx}`, params);
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

// POST /api/jobs/:id/manual-assign  (truong_phong_log only)
router.post('/:id/manual-assign', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const { cus_id, ops_id } = req.body;
  if (!cus_id && !ops_id) return res.status(400).json({ error: 'Cần cus_id hoặc ops_id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: job } = await client.query(`SELECT * FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!job[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }

    const { rows: existing } = await client.query(`SELECT * FROM job_assignments WHERE job_id = $1`, [req.params.id]);
    if (existing[0]) {
      const sets = []; const params = []; let idx = 1;
      if (cus_id !== undefined) { sets.push(`cus_id = $${idx++}`); params.push(cus_id); }
      if (ops_id !== undefined) { sets.push(`ops_id = $${idx++}`); params.push(ops_id); }
      sets.push(`assigned_by = $${idx++}`, `assigned_at = NOW()`, `assignment_mode = 'manual'`, `cus_confirm_status = 'confirmed'`);
      params.push(req.user.id, req.params.id);
      await client.query(`UPDATE job_assignments SET ${sets.join(', ')} WHERE job_id = $${idx}`, params);
    } else {
      await client.query(`
        INSERT INTO job_assignments (job_id, cus_id, ops_id, assigned_by, assignment_mode, cus_confirm_status)
        VALUES ($1, $2, $3, $4, 'manual', 'confirmed')
      `, [req.params.id, cus_id || null, ops_id || null, req.user.id]);
    }

    if (cus_id) {
      const { rows: tkEx } = await client.query(`SELECT id FROM job_tk WHERE job_id = $1`, [req.params.id]);
      if (tkEx[0]) {
        await client.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [cus_id, req.params.id]);
      } else {
        await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [req.params.id, cus_id]);
      }
      await client.query(`
        INSERT INTO notifications (user_id, type, title, body, job_id)
        VALUES ($1, 'job_assigned', 'Phân công TK mới', $2, $3)
      `, [cus_id, `Bạn được phân công TK cho ${job[0].customer_name} (TP phân công)`, req.params.id]);
      await client.query(`
        INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used)
        VALUES ($1, $2, 'cus', 'Manual assignment by TP', 0, true)
      `, [req.params.id, cus_id]);
      await recordHistory(client, req.params.id, req.user.id, 'cus_assigned', null, String(cus_id));
    }

    if (ops_id) {
      await client.query(`
        INSERT INTO notifications (user_id, type, title, body, job_id)
        VALUES ($1, 'job_assigned', 'Phân công OPS mới', $2, $3)
      `, [ops_id, `Bạn được phân công OPS cho ${job[0].customer_name} (TP phân công)`, req.params.id]);
      await client.query(`
        INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used)
        VALUES ($1, $2, 'ops', 'Manual assignment by TP', 0, true)
      `, [req.params.id, ops_id]);
      await recordHistory(client, req.params.id, req.user.id, 'ops_assigned', null, String(ops_id));
    }

    await client.query('COMMIT');
    suggestionCache = { data: null, ts: 0 }; // invalidate cache
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/refresh-suggestion  (truong_phong_log only)
router.post('/:id/refresh-suggestion', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const { type = 'cus' } = req.body;
  try {
    const { rows } = await db.query(`SELECT * FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });
    const job = rows[0];

    const fn = type === 'ops' ? suggestOps : suggestCus;
    const suggestion = await withTimeout(fn(job, db.pool).catch(() => null), 10000);

    suggestionCache = { data: null, ts: 0 };
    res.json({ suggestion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/deadline-requests/:rid/review
router.patch('/deadline-requests/:rid/review', requireAuth, async (req, res) => {
  const { action, new_deadline } = req.body;
  const client = await db.pool.connect();
  let drJobId;
  let existingCusId;

  try {
    await client.query('BEGIN');
    const { rows: dr } = await client.query(`SELECT * FROM job_deadline_requests WHERE id = $1`, [req.params.rid]);
    if (!dr[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }
    drJobId = dr[0].job_id;

    await client.query(`
      UPDATE job_deadline_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3
    `, [action, req.user.id, req.params.rid]);

    if (action === 'approved') {
      const dl = new_deadline || dr[0].proposed_deadline;
      await client.query(`UPDATE jobs SET deadline = $1, updated_at = NOW() WHERE id = $2`, [dl, dr[0].job_id]);
      await recordHistory(client, dr[0].job_id, req.user.id, 'deadline', dr[0].current_deadline, dl);
    }

    // Always set confirmed — TP review replaces CUS re-confirmation
    await client.query(`UPDATE job_assignments SET cus_confirm_status = 'confirmed' WHERE job_id = $1`, [dr[0].job_id]);
    const { rows: ja } = await client.query(`SELECT cus_id FROM job_assignments WHERE job_id = $1`, [dr[0].job_id]);
    existingCusId = ja[0]?.cus_id || null;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  // After commit: assign CUS if missing, then notify
  try {
    let notifyUserId = existingCusId;

    if (!existingCusId) {
      const { rows: jobRows } = await db.query(`SELECT * FROM jobs WHERE id = $1`, [drJobId]);
      if (jobRows[0]) {
        const suggestion = await suggestCus(jobRows[0], db.pool).catch(() => null);
        if (suggestion) {
          const ac = await db.pool.connect();
          try {
            await ac.query('BEGIN');
            const { rows: jaEx } = await ac.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [drJobId]);
            if (jaEx[0]) {
              await ac.query(`UPDATE job_assignments SET cus_id = $1, assignment_mode = 'auto', cus_confirm_status = 'pending' WHERE job_id = $2`, [suggestion.user_id, drJobId]);
            } else {
              await ac.query(`INSERT INTO job_assignments (job_id, cus_id, assigned_by, assignment_mode, cus_confirm_status) VALUES ($1,$2,$3,'auto','pending')`, [drJobId, suggestion.user_id, req.user.id]);
            }
            const { rows: tkEx } = await ac.query(`SELECT id FROM job_tk WHERE job_id = $1`, [drJobId]);
            if (tkEx[0]) {
              await ac.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [suggestion.user_id, drJobId]);
            } else {
              await ac.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1,$2)`, [drJobId, suggestion.user_id]);
            }
            await ac.query('COMMIT');
            notifyUserId = suggestion.user_id;
            await db.query(`INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used) VALUES ($1,$2,'cus',$3,$4,$5)`,
              [drJobId, suggestion.user_id, suggestion.reason, suggestion.cost || 0, suggestion.fallback || false]);
          } catch (e) {
            await ac.query('ROLLBACK');
            console.error('CUS auto-assign after review failed:', e.message);
          } finally {
            ac.release();
          }
        }
      }
    }

    if (notifyUserId) {
      const body = action === 'approved'
        ? 'Trưởng phòng đã duyệt yêu cầu điều chỉnh deadline'
        : 'Trưởng phòng đã từ chối yêu cầu điều chỉnh deadline. Tiếp tục theo deadline ban đầu.';
      await db.query(`INSERT INTO notifications (user_id, type, title, body, job_id) VALUES ($1,'deadline_reviewed','Deadline được xem xét',$2,$3)`,
        [notifyUserId, body, drJobId]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Post-review handling failed:', err.message);
    res.json({ ok: true }); // main update already committed
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
