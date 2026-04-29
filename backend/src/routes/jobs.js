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

// ─── Auto job completion check ────────────────────────────────────────────────
// Call after any sub-task completion event (CUS HT, DieuDo HT, OPS done).
// Decides whether the parent job is fully done based on service_type, destination,
// sub-task completed_at columns, and ja.ops_done.
async function checkAndCompleteJob(client, jobId, changedBy) {
  const { rows } = await client.query(`
    SELECT j.id, j.status, j.service_type, j.destination,
           jt.completed_at  AS tk_completed_at,
           jtr.completed_at AS truck_completed_at,
           COALESCE(ja.ops_done, FALSE) AS ops_done
    FROM jobs j
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    LEFT JOIN job_truck jtr ON jtr.job_id = j.id
    LEFT JOIN job_assignments ja ON ja.job_id = j.id
    WHERE j.id = $1 AND j.deleted_at IS NULL
  `, [jobId]);
  if (!rows[0]) return false;
  const j = rows[0];
  if (j.status === 'completed') return false;

  const tkDone    = !!j.tk_completed_at;
  const truckDone = !!j.truck_completed_at;
  const opsDone   = !!j.ops_done;

  let ready = false;
  if (j.service_type === 'tk')         ready = tkDone;
  else if (j.service_type === 'truck') ready = truckDone;
  else if (j.service_type === 'both')  ready = tkDone && truckDone;

  // Hai Phong destination + truck involvement also requires OPS sign-off
  if (ready
      && j.destination === 'hai_phong'
      && (j.service_type === 'truck' || j.service_type === 'both')) {
    ready = ready && opsDone;
  }

  if (!ready) return false;

  await client.query(
    `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
    [jobId]
  );
  await recordHistory(client, jobId, changedBy, 'status', 'pending', 'completed');
  return true;
}

// ─── Staff stats query helpers ─────────────────────────────────────────────────
// scope: { userId } → single row for that user; {} → all matching role users.
function queryCusStaffStats(scope) {
  const where = scope.userId ? `u.id = $1` : `u.role = ANY($1)`;
  const params = scope.userId ? [scope.userId] : [['cus','cus1','cus2','cus3']];
  return db.query(`
    SELECT u.id, u.name, u.role, u.code, u.avatar_color,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('tk','both')) AS pending_tk,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND ja.cus_confirm_status = 'pending') AS awaiting_confirm,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND (jt.tk_status IS NULL OR jt.tk_status = 'chua_truyen')) AS chua_truyen,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jt.tk_status = 'dang_lam') AS dang_tq,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()) AS overdue,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours') AS near_deadline,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND (
        j.han_lenh IS NULL
        OR jt.tk_flow IS NULL OR jt.tk_flow = ''
        OR jt.tk_number IS NULL OR jt.tk_number = ''
        OR jt.tk_datetime IS NULL
        OR (ja.ops_id IS NULL AND (j.ops_partner IS NULL OR j.ops_partner = ''))
      )) AS missing_info
    FROM users u
    LEFT JOIN job_assignments ja ON ja.cus_id = u.id
    LEFT JOIN jobs j ON j.id = ja.job_id
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    WHERE ${where}
    GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
    ORDER BY u.name
  `, params);
}

function queryDieuDoStaffStats(scope) {
  const where = scope.userId ? `u.id = $1` : `u.role = 'dieu_do'`;
  const params = scope.userId ? [scope.userId] : [];
  return db.query(`
    SELECT u.id, u.name, u.role, u.code, u.avatar_color,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL) AS pending_dd,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.planned_datetime IS NULL) AS no_plan,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.planned_datetime IS NOT NULL) AS has_plan,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.transport_name IS NOT NULL) AS booked,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.planned_datetime IS NOT NULL AND jtr.transport_name IS NULL) AS plan_no_truck,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.planned_datetime BETWEEN NOW() AND NOW() + INTERVAL '16 hours' AND jtr.transport_name IS NULL) AS urgent_no_truck,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND jtr.planned_datetime < NOW() AND jtr.completed_at IS NULL) AS overdue_delivery
    FROM users u
    LEFT JOIN job_assignments ja ON ja.dieu_do_id = u.id
    LEFT JOIN jobs j ON j.id = ja.job_id
    LEFT JOIN job_truck jtr ON jtr.job_id = j.id
    WHERE ${where}
    GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
    ORDER BY u.name
  `, params);
}

function queryOpsStaffStats(scope) {
  const where = scope.userId ? `u.id = $1` : `u.role = 'ops'`;
  const params = scope.userId ? [scope.userId] : [];
  return db.query(`
    SELECT u.id, u.name, u.role, u.code, u.avatar_color,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL) AS managing,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('tk','both') AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE) AS tq_doi_lenh,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('truck','both') AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE) AS doi_lenh,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '4 hours' AND (jt.tk_status IS NULL OR jt.tk_status IN ('chua_truyen','dang_lam'))) AS near_deadline
    FROM users u
    LEFT JOIN job_assignments ja ON ja.ops_id = u.id
    LEFT JOIN jobs j ON j.id = ja.job_id
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    WHERE ${where}
    GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
    ORDER BY u.name
  `, params);
}


// GET /api/jobs/stats
router.get('/stats', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  try {
    if (role === 'truong_phong_log') {
      const [total, waitingCus, waitingOps, cusConfirmPend, deadlineAdj, noDeadline, overdue, warnSoon, missingInfo, deleteReqs, cusStats, dieuDoStats, opsStats, tkPend, truckPend] = await Promise.all([
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
        queryCusStaffStats({}),
        queryDieuDoStaffStats({}),
        queryOpsStaffStats({}),
        db.query(`SELECT COUNT(*) AS v FROM jobs j LEFT JOIN job_tk jt ON jt.job_id = j.id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('tk','both') AND (jt.id IS NULL OR jt.completed_at IS NULL)`),
        db.query(`SELECT COUNT(*) AS v FROM jobs j LEFT JOIN job_truck jtr ON jtr.job_id = j.id WHERE j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('truck','both') AND (jtr.id IS NULL OR jtr.completed_at IS NULL)`),
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
        cus_stats:             cusStats.rows,
        dieu_do_stats:         dieuDoStats.rows,
        ops_stats:             opsStats.rows,
        tk_pending:            parseInt(tkPend.rows[0].v),
        truck_pending:         parseInt(truckPend.rows[0].v),
      });
    } else if (role === 'dieu_do') {
      const BASE = `FROM job_truck jt JOIN jobs j ON j.id = jt.job_id JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`;
      const [tongJob, coKhXe, chuaKhXe, datXe, canhBaoVanTai, canhBaoDoiLenh, canhBaoHoanThanh, sapHan, dieuDoStats] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v ${BASE}`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.planned_datetime IS NOT NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.planned_datetime IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.transport_name IS NOT NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.planned_datetime BETWEEN NOW() AND NOW() + INTERVAL '24 hours' AND (jt.transport_name IS NULL OR jt.transport_name = '')`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.transport_name IS NOT NULL AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND jt.planned_datetime < NOW()`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`, [userId]),
        queryDieuDoStaffStats({ userId }),
      ]);
      const cv = r => parseInt(r.rows[0].v);
      res.json({
        tong_job:                 cv(tongJob),
        tong_co_kh_xe:            cv(coKhXe),
        tong_chua_kh_xe:          cv(chuaKhXe),
        da_dat_xe_co_kh:          cv(coKhXe),
        da_dat_xe_da_dat:         cv(datXe),
        canh_bao_chua_van_tai:    cv(canhBaoVanTai),
        canh_bao_chua_doi_lenh:   cv(canhBaoDoiLenh),
        canh_bao_chua_hoan_thanh: cv(canhBaoHoanThanh),
        sap_han:                  cv(sapHan),
        dieu_do_stats:            dieuDoStats.rows,
      });
    } else if (CUS_ROLES.includes(role)) {
      const [total, choXacNhan, sapHan, quaHan, cusStats] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.deleted_at IS NULL AND ja.cus_confirm_status = 'pending'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()`, [userId]),
        queryCusStaffStats({ userId }),
      ]);
      res.json({
        total_active:  parseInt(total.rows[0].v),
        cho_xac_nhan:  parseInt(choXacNhan.rows[0].v),
        sap_han:       parseInt(sapHan.rows[0].v),
        qua_han:       parseInt(quaHan.rows[0].v),
        cus_stats:     cusStats.rows,
      });
    } else if (role === 'ops') {
      const [total, choTqDoiLenh, choDoiLenh, sapHan, quaHan, opsStats] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.destination = 'hai_phong' AND j.service_type IN ('tk','both') AND COALESCE(ja.ops_done, FALSE) = FALSE`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.destination = 'hai_phong' AND j.service_type IN ('truck','both') AND COALESCE(ja.ops_done, FALSE) = FALSE`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline < NOW()`, [userId]),
        queryOpsStaffStats({ userId }),
      ]);
      res.json({
        total_managing:  parseInt(total.rows[0].v),
        cho_tq_doi_lenh: parseInt(choTqDoiLenh.rows[0].v),
        cho_doi_lenh:    parseInt(choDoiLenh.rows[0].v),
        sap_han:         parseInt(sapHan.rows[0].v),
        qua_han:         parseInt(quaHan.rows[0].v),
        ops_stats:       opsStats.rows,
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

// GET /api/jobs/overview?from=DATE&to=DATE  (truong_phong_log only)
router.get('/overview', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });

  let { from, to } = req.query;
  if (from) from = from.replace(/'/g, '');
  if (to) to = to.replace(/'/g, '');

  const fromClause = from ? `'${from}'::date` : `NOW() - INTERVAL '30 days'`;
  const toClause   = to   ? `'${to}'::date + INTERVAL '1 day'` : `NOW() + INTERVAL '1 day'`;

  try {
    const [dailyCreated, dailyCompleted, staffDist, completionStatus] = await Promise.all([
      // Daily created count
      db.query(`
        SELECT TO_CHAR(j.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS date,
               COUNT(*) AS created
        FROM jobs j
        WHERE j.deleted_at IS NULL
          AND j.created_at >= ${fromClause}
          AND j.created_at < ${toClause}
        GROUP BY 1 ORDER BY 1
      `),
      // Daily completed count
      db.query(`
        SELECT TO_CHAR(j.updated_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS date,
               COUNT(*) AS completed
        FROM jobs j
        WHERE j.status = 'completed' AND j.deleted_at IS NULL
          AND j.updated_at >= ${fromClause}
          AND j.updated_at < ${toClause}
        GROUP BY 1 ORDER BY 1
      `),
      // Staff distribution — CUS + OPS + DieuDo
      db.query(`
        SELECT u.id, u.name, u.role,
          COUNT(CASE WHEN j.status = 'pending' AND j.deleted_at IS NULL THEN 1 END) AS pending,
          COUNT(CASE WHEN j.status = 'completed' AND j.deleted_at IS NULL
                          AND j.updated_at >= ${fromClause}
                          AND j.updated_at < ${toClause} THEN 1 END) AS completed
        FROM users u
        LEFT JOIN job_assignments ja ON (
          (u.role IN ('cus','cus1','cus2','cus3') AND ja.cus_id = u.id) OR
          (u.role = 'ops' AND ja.ops_id = u.id) OR
          (u.role = 'dieu_do' AND ja.dieu_do_id = u.id)
        )
        LEFT JOIN jobs j ON j.id = ja.job_id
        WHERE u.role IN ('cus','cus1','cus2','cus3','ops','dieu_do')
        GROUP BY u.id, u.name, u.role
        ORDER BY u.role, u.name
      `),
      // Completion status for jobs in range
      db.query(`
        SELECT
          COUNT(CASE WHEN j.status = 'completed' AND j.deadline IS NOT NULL AND j.updated_at <= j.deadline THEN 1 END) AS on_time,
          COUNT(CASE WHEN j.status = 'completed' AND j.deadline IS NOT NULL AND j.updated_at > j.deadline THEN 1 END) AS late,
          COUNT(CASE WHEN j.status = 'pending' THEN 1 END) AS in_progress
        FROM jobs j
        WHERE j.deleted_at IS NULL
          AND j.created_at >= ${fromClause}
          AND j.created_at < ${toClause}
      `),
    ]);

    // Merge daily created/completed into single array covering full date range
    const dateMap = {};
    dailyCreated.rows.forEach(r => { dateMap[r.date] = { date: r.date, created: parseInt(r.created), completed: 0 }; });
    dailyCompleted.rows.forEach(r => {
      if (dateMap[r.date]) dateMap[r.date].completed = parseInt(r.completed);
      else dateMap[r.date] = { date: r.date, created: 0, completed: parseInt(r.completed) };
    });
    const daily_stats = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));

    const cs = completionStatus.rows[0] || {};
    res.json({
      daily_stats,
      staff_distribution: staffDist.rows.map(r => ({
        name: r.name, role: r.role,
        pending: parseInt(r.pending), completed: parseInt(r.completed),
      })),
      completion_status: {
        on_time:     parseInt(cs.on_time || 0),
        late:        parseInt(cs.late || 0),
        in_progress: parseInt(cs.in_progress || 0),
      },
    });
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

  // staff_* filters: TP can pass any staff_id; other LOG roles can only pass their own.
  if (typeof type === 'string' && type.startsWith('staff_')) {
    const staffId = parseInt(req.query.staff_id, 10);
    if (!staffId) return res.status(400).json({ error: 'staff_id required' });
    if (role !== 'truong_phong_log') {
      // Non-TP: enforce staff_id === own user.id, and the filter family must match the role
      if (staffId !== userId) return res.status(403).json({ error: 'Không có quyền' });
      const isCusFilter = type.startsWith('staff_cus_');
      const isDdFilter  = type.startsWith('staff_dd_');
      const isOpsFilter = type.startsWith('staff_ops_');
      const allowed =
        (CUS_ROLES.includes(role) && isCusFilter) ||
        (role === 'dieu_do' && isDdFilter) ||
        (role === 'ops' && isOpsFilter);
      if (!allowed) return res.status(403).json({ error: 'Không có quyền' });
    }
    let staffField;
    switch (type) {
      case 'staff_cus_pending_tk':
        staffField = 'cus_id';
        extraWhere = `AND j.service_type IN ('tk','both')`;
        break;
      case 'staff_cus_awaiting_confirm':
        staffField = 'cus_id';
        extraWhere = `AND ja.cus_confirm_status = 'pending'`;
        break;
      case 'staff_cus_chua_truyen':
        staffField = 'cus_id';
        extraWhere = `AND (jt.tk_status IS NULL OR jt.tk_status = 'chua_truyen')`;
        break;
      case 'staff_cus_dang_tq':
        staffField = 'cus_id';
        extraWhere = `AND jt.tk_status = 'dang_lam'`;
        break;
      case 'staff_cus_overdue':
        staffField = 'cus_id';
        extraWhere = `AND j.deadline < NOW()`;
        break;
      case 'staff_cus_near_deadline':
        staffField = 'cus_id';
        extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`;
        break;
      case 'staff_cus_missing_info':
        staffField = 'cus_id';
        extraWhere = `AND (
          j.han_lenh IS NULL
          OR jt.tk_flow IS NULL OR jt.tk_flow = ''
          OR jt.tk_number IS NULL OR jt.tk_number = ''
          OR jt.tk_datetime IS NULL
          OR (ja.ops_id IS NULL AND (j.ops_partner IS NULL OR j.ops_partner = ''))
        )`;
        break;
      case 'staff_dd_pending':
        staffField = 'dieu_do_id';
        break;
      case 'staff_dd_no_plan':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.planned_datetime IS NULL`;
        break;
      case 'staff_dd_has_plan':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.planned_datetime IS NOT NULL`;
        break;
      case 'staff_dd_booked':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.transport_name IS NOT NULL`;
        break;
      case 'staff_dd_plan_no_truck':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.planned_datetime IS NOT NULL AND jtr.transport_name IS NULL`;
        break;
      case 'staff_dd_urgent_no_truck':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.planned_datetime BETWEEN NOW() AND NOW() + INTERVAL '16 hours' AND jtr.transport_name IS NULL`;
        break;
      case 'staff_dd_overdue_delivery':
        staffField = 'dieu_do_id';
        extraWhere = `AND jtr.planned_datetime < NOW() AND jtr.completed_at IS NULL`;
        break;
      case 'staff_ops_managing':
        staffField = 'ops_id';
        break;
      case 'staff_ops_tq_doi_lenh':
        staffField = 'ops_id';
        extraWhere = `AND j.service_type IN ('tk','both') AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE`;
        break;
      case 'staff_ops_doi_lenh':
        staffField = 'ops_id';
        extraWhere = `AND j.service_type IN ('truck','both') AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE`;
        break;
      case 'staff_ops_near_deadline':
        staffField = 'ops_id';
        extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '4 hours' AND (jt.tk_status IS NULL OR jt.tk_status IN ('chua_truyen','dang_lam'))`;
        break;
      default:
        return res.status(400).json({ error: 'Unknown staff filter' });
    }
    baseWhere = `AND ja.${staffField} = $${idx++}`;
    params.push(staffId);

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
                 CASE WHEN j.han_lenh IS NULL THEN 'Hạn lệnh ' ELSE '' END ||
                 CASE WHEN jt.tk_flow IS NULL THEN 'Luồng TK ' ELSE '' END ||
                 CASE WHEN jt.tk_number IS NULL THEN 'Số TK ' ELSE '' END ||
                 CASE WHEN jt.tk_datetime IS NULL THEN 'Ngày TK ' ELSE '' END ||
                 CASE WHEN ja.ops_id IS NULL AND j.ops_partner IS NULL THEN 'OPS' ELSE '' END
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
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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
    case 'overdue':        extraWhere = `AND j.deadline < NOW()`; break;
    case 'tp_tk_pending':    extraWhere = `AND j.service_type IN ('tk','both') AND (jt.id IS NULL OR jt.completed_at IS NULL)`; break;
    case 'tp_truck_pending': extraWhere = `AND j.service_type IN ('truck','both') AND (jtr.id IS NULL OR jtr.completed_at IS NULL)`; break;
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
    case 'dd_co_kh_xe':      extraWhere = `AND jtr.planned_datetime IS NOT NULL`; break;
    case 'dd_chua_kh_xe':    extraWhere = `AND jtr.planned_datetime IS NULL`; break;
    case 'dd_canh_bao_chua_van_tai':   extraWhere = `AND jtr.planned_datetime BETWEEN NOW() AND NOW() + INTERVAL '24 hours' AND (jtr.transport_name IS NULL OR jtr.transport_name = '')`; break;
    case 'dd_canh_bao_chua_doi_lenh':  extraWhere = `AND jtr.transport_name IS NOT NULL AND j.destination = 'hai_phong' AND COALESCE(ja.ops_done, FALSE) = FALSE`; break;
    case 'dd_canh_bao_chua_hoan_thanh':extraWhere = `AND jtr.planned_datetime < NOW()`; break;
    case 'dd_sap_han':       extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`; break;
    // OPS filters — must match the corresponding stat-card WHERE clauses exactly (CLAUDE.md L5)
    case 'ops_waiting_tq_doilenh':
      extraWhere = `AND j.destination = 'hai_phong' AND j.service_type IN ('tk','both') AND COALESCE(ja.ops_done, FALSE) = FALSE`;
      break;
    case 'ops_waiting_doilenh':
      extraWhere = `AND j.destination = 'hai_phong' AND j.service_type IN ('truck','both') AND COALESCE(ja.ops_done, FALSE) = FALSE`;
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
        ja.ops_done, ja.ops_done_at,
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
        ), '[]'::json) AS containers,
        COALESCE((
          SELECT json_agg(json_build_object(
            'id', jot.id, 'task_type', jot.task_type, 'content', jot.content,
            'port', jot.port, 'deadline', jot.deadline,
            'completed', jot.completed, 'completed_at', jot.completed_at, 'notes', jot.notes
          ) ORDER BY jot.id)
          FROM job_ops_task jot WHERE jot.job_id = j.id
        ), '[]'::json) AS ops_tasks
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

    // Auto-generate job_ops_task rows for Hải Phòng truck/both jobs
    if (destination === 'hai_phong' && (service_type === 'truck' || service_type === 'both')) {
      const opsUserId = opsSuggestion?.user_id || null;
      if (service_type === 'both') {
        await client.query(
          `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'thong_quan_doi_lenh')`,
          [job.id, opsUserId]
        );
      }
      await client.query(
        `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'doi_lenh')`,
        [job.id, opsUserId]
      );
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
        ja.ops_done, ja.ops_done_at,
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
  const isOps = req.user.role === 'ops';
  const FIELDS = isOps
    ? ['tk_status']
    : ['tk_datetime','tk_number','tk_flow','tk_status','tq_datetime',
       'services_completed','delivery_datetime','delivery_location','truck_booked','notes'];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM job_tk WHERE job_id = $1`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy TK' }); }

    // Validate truck_booked precondition: cannot tick without delivery info
    if (req.body.truck_booked === true) {
      const newDeliveryDt  = req.body.delivery_datetime !== undefined ? req.body.delivery_datetime : cur[0].delivery_datetime;
      const newDeliveryLoc = req.body.delivery_location !== undefined ? req.body.delivery_location : cur[0].delivery_location;
      if (!newDeliveryDt || !newDeliveryLoc) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Nhập thời gian và địa điểm giao trước khi đặt xe' });
      }
    }

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

    // Sync to job_truck when CUS ticks "Đặt xe"
    if (req.body.truck_booked === true) {
      const plannedDt    = rows[0].delivery_datetime;
      const deliveryLoc  = rows[0].delivery_location;
      const { rows: trk } = await client.query(`SELECT id FROM job_truck WHERE job_id = $1`, [req.params.id]);
      if (trk[0]) {
        await client.query(
          `UPDATE job_truck SET planned_datetime = $1, delivery_location = $2 WHERE job_id = $3`,
          [plannedDt, deliveryLoc, req.params.id]
        );
      } else {
        await client.query(
          `INSERT INTO job_truck (job_id, planned_datetime, delivery_location) VALUES ($1, $2, $3)`,
          [req.params.id, plannedDt, deliveryLoc]
        );
      }
      await recordHistory(client, req.params.id, req.user.id, 'truck_synced_from_tk', null, `${plannedDt} | ${deliveryLoc}`);
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

// PATCH /api/jobs/:id/truck/complete  — DieuDo marks the truck side complete
router.patch('/:id/truck/complete', requireAuth, async (req, res) => {
  if (req.user.role !== 'dieu_do') {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ja } = await client.query(
      `SELECT dieu_do_id FROM job_assignments WHERE job_id = $1`,
      [req.params.id]
    );
    if (!ja[0] || ja[0].dieu_do_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Không có quyền' });
    }
    const { rows } = await client.query(
      `UPDATE job_truck SET completed_at = NOW() WHERE job_id = $1 AND completed_at IS NULL RETURNING *`,
      [req.params.id]
    );
    await recordHistory(client, req.params.id, req.user.id, 'truck_completed', null, 'completed');
    const completed = await checkAndCompleteJob(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, truck: rows[0] || {}, job_completed: completed });
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

// POST /api/jobs/:id/ops-done
router.post('/:id/ops-done', requireAuth, async (req, res) => {
  if (req.user.role !== 'ops') return res.status(403).json({ error: 'Không có quyền' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: jobRows } = await client.query(
      `SELECT j.service_type, jt.tk_status FROM jobs j LEFT JOIN job_tk jt ON jt.job_id = j.id WHERE j.id = $1 AND j.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!jobRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    const { service_type, tk_status } = jobRows[0];
    const needsTkCheck = service_type === 'tk' || service_type === 'both';
    const terminalStatuses = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (needsTkCheck && !terminalStatuses.includes(tk_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'TK chưa thông quan / giải phóng / bảo quan' });
    }
    await client.query(
      `UPDATE job_assignments SET ops_done = TRUE, ops_done_at = NOW() WHERE job_id = $1`,
      [req.params.id]
    );
    await client.query(
      `UPDATE job_ops_task SET completed = TRUE, completed_at = NOW() WHERE job_id = $1 AND completed = FALSE`,
      [req.params.id]
    );
    await recordHistory(client, req.params.id, req.user.id, 'ops_done', 'false', 'true');
    const completed = await checkAndCompleteJob(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/complete  — CUS marks the TK side complete
router.patch('/:id/complete', requireAuth, async (req, res) => {
  if (!CUS_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT j.id, j.han_lenh, j.ops_partner,
             jt.id AS tk_id, jt.tk_flow, jt.tk_number, jt.tk_datetime, jt.tk_status, jt.completed_at AS tk_completed_at,
             ja.cus_id, ja.ops_id
      FROM jobs j
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    const j = rows[0];

    if (j.cus_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Không có quyền' });
    }

    const terminal = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (!terminal.includes(j.tk_status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'TK chưa thông quan / giải phóng / bảo quan' });
    }

    const missing = [];
    if (!j.han_lenh)    missing.push('Hạn lệnh');
    if (!j.tk_flow)     missing.push('Luồng TK');
    if (!j.tk_number)   missing.push('Số TK');
    if (!j.tk_datetime) missing.push('Ngày TK');
    if (!j.ops_id && !j.ops_partner) missing.push('OPS');
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Vui lòng nhập đủ thông tin: ${missing.join(', ')}` });
    }

    if (!j.tk_completed_at) {
      await client.query(
        `UPDATE job_tk SET completed_at = NOW() WHERE job_id = $1`,
        [req.params.id]
      );
      await recordHistory(client, req.params.id, req.user.id, 'tk_completed', null, 'CUS hoàn thành phần TK');
    }

    const completed = await checkAndCompleteJob(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
