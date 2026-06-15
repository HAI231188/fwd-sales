const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { suggestCus, suggestOps } = require('../services/ai-assignment');
const { buildBbbgPdf } = require('../services/bbbg-pdf');
const { checkAndCompleteJob: _checkAndCompleteJob, checkOpsTasksDone } = require('../services/job-completion');
const { recordHistory } = require('../services/job-history');
const { CUS_ROLES, AUTO_CUS_ROLES, LOG_ROLES, PLAN_ROLES } = require('../constants/roles');
const { canViewJob, canEditJob, canEditJobTk, canReassignOwnerOrStatus } = require('../services/job-access');
const { fmtVnDeadline } = require('../utils/vnTime');

// In-memory suggestion cache (60s TTL) — invalidated on manual assignment
let suggestionCache = { data: null, ts: 0 };

function withTimeout(promise, ms) {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

// ─── Auto job completion check ────────────────────────────────────────────────
// Call after any sub-task completion event (CUS HT, DieuDo HT, OPS done).
// Decides whether the parent job is fully done based on service_type, destination,
// sub-task completed_at columns, and ja.ops_done.
// Phase 4: moved to services/job-completion.js — single source of truth so
// truck-bookings.js can reuse it without duplicating the SQL. This thin
// wrapper preserves the local 3-arg call signature used by existing call sites.
async function checkAndCompleteJob(client, jobId, changedBy) {
  return _checkAndCompleteJob(client, jobId, changedBy, recordHistory);
}

// P2 — validate an assignment target before writing it: the id must exist, be
// ACTIVE (disabled_at IS NULL), and hold one of the allowed roles. Returns
// { ok: true } or { ok: false, error: '<vi message>' }. Used by the assign /
// manual-assign / reassign-cus / reassign-ops handlers so a disabled or
// wrong-role user can never be assigned (even via a crafted/stale id).
async function validateAssignee(client, userId, allowedRoles, label) {
  const { rows } = await client.query(
    `SELECT id, role, disabled_at FROM users WHERE id = $1`, [userId]
  );
  if (!rows[0]) return { ok: false, error: `Không tìm thấy ${label}` };
  if (rows[0].disabled_at) return { ok: false, error: `${label} đã bị khóa — không thể phân job` };
  if (!allowedRoles.includes(rows[0].role)) return { ok: false, error: `Người dùng không đúng vai trò ${label}` };
  return { ok: true };
}

// ─── Staff stats query helpers ─────────────────────────────────────────────────
// scope: { userId } → single row for that user; {} → all matching role users.
function queryCusStaffStats(scope) {
  const where = scope.userId ? `u.id = $1` : `u.role = ANY($1)`;
  const params = scope.userId ? [scope.userId] : [CUS_ROLES];
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
    WHERE (${where}) AND u.disabled_at IS NULL
    GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
    ORDER BY u.name
  `, params);
}

function queryDieuDoStaffStats(scope) {
  const where = scope.userId ? `u.id = $1` : `u.role = 'dieu_do'`;
  const params = scope.userId ? [scope.userId] : [];
  // CP6.1 — refactored per spec table. The first + last column count
  // jobs (DISTINCT); the middle six count BOOKINGS. The job→booking
  // join is LEFT so a DD user with assignments but no bookings still
  // appears (with booking counts = 0).
  //
  // "Sắp giao chưa đặt xe" semantic changed: was han_lenh-within-24h
  // on chua_dat_kh jobs; now per-booking planned_datetime within 12h
  // on bookings still missing a carrier (per spec).
  //
  // "Giao rồi chưa hoàn thành" also changed: now per-booking, gated on
  // missing ticks (the CP6.1 sign-off gates) rather than the derived
  // du_xe_cho_giao enum.
  return db.query(`
    SELECT u.id, u.name, u.role, u.code, u.avatar_color,
      COUNT(DISTINCT j.id) FILTER (
        WHERE j.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
      ) AS pending_dd,
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
          AND (tb.planned_datetime IS NULL
            OR tb.delivery_location IS NULL OR tb.delivery_location = '')
      ) AS no_plan,
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
          AND tb.planned_datetime IS NOT NULL
          AND tb.delivery_location IS NOT NULL AND tb.delivery_location <> ''
      ) AS has_plan,
      -- CP6.2.1 — "Đặt xe" semantically means "chốt vận tải" (carrier picked),
      -- NOT "số xe assigned". The vehicle_number tick lives in the separate
      -- 'Đã có xe' / 'Chưa có xe' progression. So:
      --   • booked            = transport_company_id IS NOT NULL (carrier set;
      --                          vehicle may or may not be assigned yet)
      --   • plan_no_truck     = has plan AND transport_company_id IS NULL
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
          AND tb.transport_company_id IS NOT NULL
      ) AS booked,
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
          AND tb.planned_datetime IS NOT NULL
          AND tb.delivery_location IS NOT NULL AND tb.delivery_location <> ''
          AND tb.transport_company_id IS NULL
      ) AS plan_no_truck,
      -- "Sắp giao chưa đặt xe" — per-booking planned_datetime within 12h
      -- on bookings still missing a carrier (CP6.1 semantic).
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.status <> 'completed' AND j.deleted_at IS NULL
          AND tb.planned_datetime > NOW()
          AND tb.planned_datetime <= NOW() + INTERVAL '12 hours'
          AND tb.transport_company_id IS NULL
      ) AS urgent_no_truck,
      -- "Giao rồi chưa hoàn thành" — vehicles assigned but DD hasn't ticked
      -- both sign-offs yet AND the job is still pending (CP6.1).
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL AND j.completed_at IS NULL AND j.deleted_at IS NULL
          AND tb.vehicle_number IS NOT NULL AND tb.vehicle_number <> ''
          AND (NOT tb.invoice_lifting_ticked OR NOT tb.cost_entered_ticked)
      ) AS overdue_delivery,
      -- CP6.6 — "Chậm Cost": bookings where carrier is locked in and the
      -- planned delivery date is >3 days past, but the booking's paperwork
      -- (nâng hạ tick, cost tick, actual_datetime) is still incomplete.
      -- Counts BOOKINGS (not jobs) so a job with 2 carriers can register
      -- as 2 separate "Chậm Cost" rows. Job completion is implicitly
      -- excluded — completion requires all 3 ticks present.
      COUNT(*) FILTER (
        WHERE tb.id IS NOT NULL
          AND tb.deleted_at IS NULL
          AND j.status <> 'completed'
          AND j.deleted_at IS NULL
          AND tb.transport_company_id IS NOT NULL
          AND tb.planned_datetime IS NOT NULL
          AND tb.planned_datetime < NOW() - INTERVAL '3 days'
          AND (
            tb.invoice_lifting_ticked = FALSE
            OR tb.cost_entered_ticked = FALSE
            OR tb.actual_datetime IS NULL
          )
      ) AS cham_cost
    FROM users u
    LEFT JOIN job_assignments ja ON ja.dieu_do_id = u.id
    LEFT JOIN jobs j ON j.id = ja.job_id
    LEFT JOIN truck_bookings tb ON tb.job_id = j.id AND tb.deleted_at IS NULL
    WHERE (${where}) AND u.disabled_at IS NULL
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
      -- Per-task pending counts (2026-05-23): pending = task row exists and is not done.
      --   tq pending = thong_quan row exists with cost_entered_at IS NULL
      --   dl pending = doi_lenh   row exists with completed=FALSE OR cost_entered_at IS NULL
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('tk','both') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'thong_quan' AND jot.cost_entered_at IS NULL)) AS tq_doi_lenh,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.service_type IN ('truck','both') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))) AS doi_lenh,
      COUNT(*) FILTER (WHERE j.id IS NOT NULL AND j.status = 'pending' AND j.deleted_at IS NULL AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '4 hours' AND (jt.tk_status IS NULL OR jt.tk_status IN ('chua_truyen','dang_lam'))) AS near_deadline
    FROM users u
    LEFT JOIN job_assignments ja ON ja.ops_id = u.id
    LEFT JOIN jobs j ON j.id = ja.job_id
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    WHERE (${where}) AND u.disabled_at IS NULL
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
            AND j.service_type IN ('tk','truck','both','ops_hp')
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
      // Phase 4: BASE no longer JOINs job_truck. All DD stats derive from
      // get_truck_booking_status(j.id) so a single source of truth governs
      // staff stats + dashboard tabs + drilldowns.
      const BASE = `FROM jobs j JOIN job_assignments ja ON ja.job_id = j.id WHERE ja.dieu_do_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`;
      // Phase 5 Step 1: container-level booked / unbooked counts. The pair is
      // symmetric (EXISTS vs NOT EXISTS) and L5-locked to the drilldowns
      // 'dd_ke_hoach_da_dat' / 'dd_ke_hoach_chua_dat' in /filtered below.
      const CONT_BASE = `
        FROM job_containers jc
        JOIN jobs j ON j.id = jc.job_id
        JOIN job_assignments ja ON ja.job_id = j.id
        WHERE ja.dieu_do_id = $1
          AND j.status = 'pending'
          AND j.deleted_at IS NULL`;
      const BOOKED_EXISTS = `
        EXISTS (
          SELECT 1 FROM truck_booking_containers tbc
            JOIN truck_bookings tb ON tb.id = tbc.booking_id
           WHERE tbc.container_id = jc.id AND tb.deleted_at IS NULL
        )`;
      // Phase 5 Step 1 add-on: per-day delivery buckets. Joins all the way
      // through the booking link so each container's "planned delivery day"
      // is read from its (single) active booking. Dates in Vietnam tz.
      const BOOKED_CONT_BASE = `
        FROM job_containers jc
        JOIN jobs j ON j.id = jc.job_id
        JOIN job_assignments ja ON ja.job_id = j.id
        JOIN truck_booking_containers tbc ON tbc.container_id = jc.id
        JOIN truck_bookings tb ON tb.id = tbc.booking_id
        WHERE ja.dieu_do_id = $1
          AND j.status = 'pending'
          AND j.deleted_at IS NULL
          AND tb.deleted_at IS NULL`;
      const VN_BOOK_DATE = `(tb.planned_datetime AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
      const VN_TODAY     = `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
      const [tongJob, coKhXe, chuaKhXe, datXe, canhBaoVanTai, canhBaoDoiLenh, canhBaoHoanThanh, sapHan, dieuDoStats,
             jobChuaHt, keHoachDaDat, keHoachChuaDat,
             khQuaHan, khHomNay, khD1, khD2, khD3, khD4, khD5] = await Promise.all([
        db.query(`SELECT COUNT(*) AS v ${BASE}`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) NOT IN ('chua_dat_kh','dd_da_xong','hoan_thanh')`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) = 'chua_dat_kh'`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) NOT IN ('chua_dat_kh','dd_da_xong','hoan_thanh')`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) = 'chua_dat_kh' AND j.han_lenh BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) NOT IN ('chua_dat_kh','dd_da_xong','hoan_thanh') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND get_truck_booking_status(j.id) = 'du_xe_cho_giao'`, [userId]),
        db.query(`SELECT COUNT(*) AS v ${BASE} AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`, [userId]),
        queryDieuDoStaffStats({ userId }),
        // Phase 5 Step 1 — new counts driving Card 1.
        db.query(`SELECT COUNT(DISTINCT j.id) AS v ${BASE}`, [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${CONT_BASE} AND ${BOOKED_EXISTS}`, [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${CONT_BASE} AND NOT ${BOOKED_EXISTS}`, [userId]),
        // Phase 5 Step 1 add-on — Kế hoạch trả hàng (per-day delivery buckets).
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} <  ${VN_TODAY}`,        [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} =  ${VN_TODAY}`,        [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} = (${VN_TODAY} + 1)`,   [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} = (${VN_TODAY} + 2)`,   [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} = (${VN_TODAY} + 3)`,   [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} = (${VN_TODAY} + 4)`,   [userId]),
        db.query(`SELECT COUNT(DISTINCT jc.id) AS v ${BOOKED_CONT_BASE} AND ${VN_BOOK_DATE} = (${VN_TODAY} + 5)`,   [userId]),
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
        // Phase 5 Step 1 — Card 1 redesign (job + container-level breakdown).
        job_chua_hoan_thanh:      cv(jobChuaHt),
        ke_hoach_da_dat:          cv(keHoachDaDat),
        ke_hoach_chua_dat:        cv(keHoachChuaDat),
        // Phase 5 Step 1 add-on — Kế hoạch trả hàng (per-day, Vietnam tz).
        ke_hoach_qua_han:         cv(khQuaHan),
        ke_hoach_hom_nay:         cv(khHomNay),
        ke_hoach_d1:              cv(khD1),
        ke_hoach_d2:              cv(khD2),
        ke_hoach_d3:              cv(khD3),
        ke_hoach_d4:              cv(khD4),
        ke_hoach_d5:              cv(khD5),
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
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.destination = 'hai_phong' AND j.service_type IN ('tk','both') AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'thong_quan' AND jot.cost_entered_at IS NULL)`, [userId]),
        db.query(`SELECT COUNT(*) AS v FROM job_assignments ja JOIN jobs j ON j.id = ja.job_id WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL AND j.destination = 'hai_phong' AND j.service_type IN ('truck','both') AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))`, [userId]),
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
      WHERE u.role = ANY($1) AND u.disabled_at IS NULL
      GROUP BY u.id, u.name, u.role, u.code, u.avatar_color
      ORDER BY u.role, u.name
    `, [CUS_ROLES]);
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
      FROM users WHERE role = ANY($1) AND disabled_at IS NULL
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
        cp.company_full_name, cp.invoice_address,
        cp.tax_code AS pipeline_tax_code,
        u.name AS sales_name,
        COALESCE(c.address, (SELECT j.customer_address FROM jobs j
          WHERE (j.customer_id = cp.customer_id OR LOWER(j.customer_name) = LOWER(cp.company_name))
            AND j.customer_address IS NOT NULL AND j.deleted_at IS NULL
          ORDER BY j.created_at DESC LIMIT 1),
          NULLIF(cp.invoice_address, '')) AS customer_address,
        COALESCE(c.tax_code, (SELECT j.customer_tax_code FROM jobs j
          WHERE (j.customer_id = cp.customer_id OR LOWER(j.customer_name) = LOWER(cp.company_name))
            AND j.customer_tax_code IS NOT NULL AND j.deleted_at IS NULL
          ORDER BY j.created_at DESC LIMIT 1),
          NULLIF(cp.tax_code, '')) AS customer_tax_code
      FROM customer_pipeline cp
      LEFT JOIN users u ON u.id = cp.sales_id
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE cp.stage = 'booked' AND cp.deleted_at IS NULL AND cp.company_name ILIKE $1
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

// GET /api/jobs/settings  (truong_phong_log + admin)
router.get('/settings', requireAuth, async (req, res) => {
  if (!['truong_phong_log', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(`SELECT * FROM log_settings WHERE id = 1`);
    res.json(rows[0] || { id: 1, assignment_mode: 'auto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/settings/assignment-mode  (truong_phong_log + admin)
router.patch('/settings/assignment-mode', requireAuth, async (req, res) => {
  if (!['truong_phong_log', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Không có quyền' });
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
          AND j.service_type IN ('tk','truck','both','ops_hp')
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
        WHERE u.role IN ('cus','cus1','cus2','cus3','ops','dieu_do') AND u.disabled_at IS NULL
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

    // CP6.2 — booking-level staff_dd_* drilldowns. Each filter is keyed
    // 1:1 to a column in the refactored queryDieuDoStaffStats SQL so the
    // drilldown row set always matches the stat count (L5). Returns one
    // row per booking; frontend JobListModal uses its BOOKING_LEVEL
    // column set for these filter types.
    const STAFF_DD_BOOKING_TYPES = new Set([
      'staff_dd_no_plan',
      'staff_dd_has_plan',
      'staff_dd_booked',
      'staff_dd_plan_no_truck',
      'staff_dd_urgent_no_truck',
      'staff_dd_overdue_delivery',
      // CP6.6 — replaces legacy 'staff_dd_quan_ly_dat_xe'. See switch below.
      'staff_dd_cham_cost',
    ]);
    if (STAFF_DD_BOOKING_TYPES.has(type)) {
      const staffId = parseInt(req.query.staff_id, 10);
      // staff_id check already happened earlier in this block.
      let where;
      let order;
      switch (type) {
        case 'staff_dd_no_plan':
          where = `AND (tb.planned_datetime IS NULL
                    OR tb.delivery_location IS NULL OR tb.delivery_location = '')`;
          order = `ORDER BY j.job_code ASC NULLS LAST, tb.booking_code ASC NULLS LAST`;
          break;
        case 'staff_dd_has_plan':
          where = `AND tb.planned_datetime IS NOT NULL
                   AND tb.delivery_location IS NOT NULL AND tb.delivery_location <> ''`;
          order = `ORDER BY j.job_code ASC NULLS LAST, tb.booking_code ASC NULLS LAST`;
          break;
        // CP6.2.1 — match the corrected stat FILTER predicates exactly.
        case 'staff_dd_booked':
          where = `AND tb.transport_company_id IS NOT NULL`;
          order = `ORDER BY j.job_code ASC NULLS LAST, tb.booking_code ASC NULLS LAST`;
          break;
        case 'staff_dd_plan_no_truck':
          where = `AND tb.planned_datetime IS NOT NULL
                   AND tb.delivery_location IS NOT NULL AND tb.delivery_location <> ''
                   AND tb.transport_company_id IS NULL`;
          order = `ORDER BY j.job_code ASC NULLS LAST, tb.booking_code ASC NULLS LAST`;
          break;
        case 'staff_dd_urgent_no_truck':
          where = `AND tb.planned_datetime > NOW()
                   AND tb.planned_datetime <= NOW() + INTERVAL '12 hours'
                   AND tb.transport_company_id IS NULL`;
          order = `ORDER BY tb.planned_datetime ASC`;
          break;
        case 'staff_dd_overdue_delivery':
          // j.completed_at IS NULL here rather than j.status check —
          // matches the CP6.1 stat-count formula one-to-one.
          where = `AND tb.vehicle_number IS NOT NULL AND tb.vehicle_number <> ''
                   AND (NOT tb.invoice_lifting_ticked OR NOT tb.cost_entered_ticked)
                   AND j.completed_at IS NULL`;
          order = `ORDER BY j.updated_at DESC`;
          break;
        case 'staff_dd_cham_cost':
          // CP6.6 — mirror the cham_cost FILTER in queryDieuDoStaffStats
          // exactly. Earliest overdue first so the most-urgent rows sit on top.
          where = `AND tb.transport_company_id IS NOT NULL
                   AND tb.planned_datetime IS NOT NULL
                   AND tb.planned_datetime < NOW() - INTERVAL '3 days'
                   AND (
                     tb.invoice_lifting_ticked = FALSE
                     OR tb.cost_entered_ticked = FALSE
                     OR tb.actual_datetime IS NULL
                   )`;
          order = `ORDER BY tb.planned_datetime ASC`;
          break;
      }
      try {
        const { rows } = await db.query(`
          SELECT
            tb.id AS booking_id,
            tb.booking_code,
            tb.job_id AS id,
            j.job_code,
            j.customer_name,
            j.import_export,
            j.han_lenh,
            tb.transport_company_id,
            tb.transport_name,
            tb.vehicle_number,
            tb.planned_datetime,
            tb.delivery_location AS truck_delivery_location,
            tb.cost,
            tb.receiver_name,
            tb.receiver_phone,
            tb.invoice_lifting_ticked,
            tb.cost_entered_ticked,
            tb.actual_datetime,
            get_truck_booking_status(j.id) AS booking_status,
            COALESCE((
              SELECT string_agg(
                COALESCE(jc.cont_number, '?') || ' (' || jc.cont_type || ')',
                ', ' ORDER BY jc.id
              )
              FROM truck_booking_containers tbc
              JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id
            ), '') AS cont_info
          FROM truck_bookings tb
          JOIN jobs j ON j.id = tb.job_id
          JOIN job_assignments ja ON ja.job_id = j.id
          WHERE tb.deleted_at IS NULL
            AND j.deleted_at IS NULL
            AND j.status <> 'completed'
            AND ja.dieu_do_id = $1
            ${where}
          ${order}
        `, [staffId]);
        return res.json(rows);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
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
      // CP6.2 — staff_dd_* drilldowns split into two paths to match the
      // refactored stat counts in queryDieuDoStaffStats (CP6.1):
      //   • staff_dd_pending → job-level (handled by the existing per-job
      //     SELECT below the switch).
      //   • everything else → booking-level (handled by the early
      //     STAFF_DD_BOOKING_TYPES branch added above).
      // CP6.6 — legacy 'staff_dd_quan_ly_dat_xe' (job-level) was removed;
      // its replacement 'staff_dd_cham_cost' is booking-level (in the Set above).
      case 'staff_dd_pending':
        staffField = 'dieu_do_id';
        break;
      case 'staff_ops_managing':
        staffField = 'ops_id';
        break;
      case 'staff_ops_tq_doi_lenh':
        staffField = 'ops_id';
        extraWhere = `AND j.service_type IN ('tk','both') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'thong_quan' AND jot.cost_entered_at IS NULL)`;
        break;
      case 'staff_ops_doi_lenh':
        staffField = 'ops_id';
        extraWhere = `AND j.service_type IN ('truck','both') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))`;
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
               j.import_export,
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
                 CASE WHEN j.han_lenh IS NULL THEN
                   CASE WHEN j.import_export = 'import' THEN 'Hạn lệnh ' ELSE 'Cutoff time ' END
                 ELSE '' END ||
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

  // ─── Phase 5 Step 1 + add-on: booking-level drilldowns (FLAT — one row per
  // booking). Shared SELECT shape; only the WHERE date predicate differs across
  // the 8 booking-level filterTypes. Aliases tb.job_id AS id so JobListModal's
  // row click still opens JobDetailModal for the parent job.
  const BOOKING_LEVEL_TYPES = [
    'dd_kh_da_dat_chi_tiet',
    'dd_kh_qua_han', 'dd_kh_today',
    'dd_kh_d1', 'dd_kh_d2', 'dd_kh_d3', 'dd_kh_d4', 'dd_kh_d5',
  ];
  if (BOOKING_LEVEL_TYPES.includes(type)) {
    if (role !== 'dieu_do' && role !== 'truong_phong_log') {
      return res.status(403).json({ error: 'Không có quyền' });
    }
    const bParams = [];
    let bIdx = 1;
    let bScope = '';
    if (role === 'dieu_do') {
      bScope = `AND ja.dieu_do_id = $${bIdx++}`;
      bParams.push(userId);
    }
    const VN_BOOK_DATE = `(tb.planned_datetime AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    const VN_TODAY     = `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    let dateWhere = '';
    switch (type) {
      case 'dd_kh_qua_han':  dateWhere = `AND ${VN_BOOK_DATE} <  ${VN_TODAY}`; break;
      case 'dd_kh_today':    dateWhere = `AND ${VN_BOOK_DATE} =  ${VN_TODAY}`; break;
      case 'dd_kh_d1':       dateWhere = `AND ${VN_BOOK_DATE} = (${VN_TODAY} + 1)`; break;
      case 'dd_kh_d2':       dateWhere = `AND ${VN_BOOK_DATE} = (${VN_TODAY} + 2)`; break;
      case 'dd_kh_d3':       dateWhere = `AND ${VN_BOOK_DATE} = (${VN_TODAY} + 3)`; break;
      case 'dd_kh_d4':       dateWhere = `AND ${VN_BOOK_DATE} = (${VN_TODAY} + 4)`; break;
      case 'dd_kh_d5':       dateWhere = `AND ${VN_BOOK_DATE} = (${VN_TODAY} + 5)`; break;
      // 'dd_kh_da_dat_chi_tiet' — no date filter (all booked plans)
    }
    try {
      const { rows } = await db.query(`
        SELECT
          tb.id AS booking_id,
          tb.booking_code,
          tb.job_id AS id,
          j.job_code,
          j.customer_name,
          j.import_export,
          j.han_lenh,
          tb.transport_company_id,
          tb.transport_name,
          tb.vehicle_number,
          tb.planned_datetime,
          tb.delivery_location AS truck_delivery_location,
          tb.cost,
          tb.receiver_name,
          tb.receiver_phone,
          tb.invoice_lifting_ticked,
          tb.cost_entered_ticked,
          get_truck_booking_status(j.id) AS booking_status,
          COALESCE((
            SELECT string_agg(
              COALESCE(jc.cont_number, '?') || ' (' || jc.cont_type || ')',
              ', ' ORDER BY jc.id
            )
            FROM truck_booking_containers tbc
            JOIN job_containers jc ON jc.id = tbc.container_id
            WHERE tbc.booking_id = tb.id
          ), '') AS cont_info
        FROM truck_bookings tb
        JOIN jobs j ON j.id = tb.job_id
        LEFT JOIN LATERAL (
          SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
        ) ja ON true
        WHERE tb.deleted_at IS NULL
          AND j.deleted_at IS NULL
          AND j.status = 'pending'
          ${bScope}
          ${dateWhere}
        ORDER BY tb.planned_datetime ASC NULLS LAST, tb.id ASC
      `, bParams);
      return res.json(rows);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
    // DieuDo filters — Phase 5 CP4.5: migrated to 8-status enum. 'hoan_thanh'
    // is now the true completion signal (= all bookings have actual_datetime).
    case 'truck_total':      break;
    // 2026-05-24 DD-split: "DD still has work to do" excludes 'dd_da_xong' too.
    case 'truck_pending':    extraWhere = `AND get_truck_booking_status(j.id) NOT IN ('dd_da_xong','hoan_thanh')`; break;
    case 'truck_booked':     extraWhere = `AND get_truck_booking_status(j.id) = 'du_xe_cho_giao'`; break;
    case 'truck_not_booked': extraWhere = `AND get_truck_booking_status(j.id) = 'dat_kh_1_phan'`; break;
    case 'truck_warning':    extraWhere = `AND get_truck_booking_status(j.id) NOT IN ('dd_da_xong','hoan_thanh') AND j.han_lenh BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`; break;
    case 'dd_co_kh_xe':      extraWhere = `AND get_truck_booking_status(j.id) NOT IN ('chua_dat_kh','dd_da_xong','hoan_thanh')`; break;
    case 'dd_chua_kh_xe':    extraWhere = `AND get_truck_booking_status(j.id) = 'chua_dat_kh'`; break;
    // Phase 5 Step 1: container-level coverage drilldowns. L5-locked to the
    // ke_hoach_da_dat / ke_hoach_chua_dat stat counts above.
    case 'dd_ke_hoach_da_dat':
      extraWhere = `AND EXISTS (
        SELECT 1 FROM job_containers jc
          JOIN truck_booking_containers tbc ON tbc.container_id = jc.id
          JOIN truck_bookings tb ON tb.id = tbc.booking_id
         WHERE jc.job_id = j.id AND tb.deleted_at IS NULL
      )`;
      break;
    case 'dd_ke_hoach_chua_dat':
      extraWhere = `AND EXISTS (
        SELECT 1 FROM job_containers jc
         WHERE jc.job_id = j.id
           AND NOT EXISTS (
             SELECT 1 FROM truck_booking_containers tbc
               JOIN truck_bookings tb ON tb.id = tbc.booking_id
              WHERE tbc.container_id = jc.id AND tb.deleted_at IS NULL
           )
      )`;
      break;
    case 'dd_canh_bao_chua_van_tai':   extraWhere = `AND get_truck_booking_status(j.id) = 'chua_dat_kh' AND j.han_lenh BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`; break;
    case 'dd_canh_bao_chua_doi_lenh':  extraWhere = `AND get_truck_booking_status(j.id) NOT IN ('chua_dat_kh','dd_da_xong','hoan_thanh') AND j.destination = 'hai_phong' AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))`; break;
    case 'dd_canh_bao_chua_hoan_thanh':extraWhere = `AND get_truck_booking_status(j.id) = 'du_xe_cho_giao'`; break;
    case 'dd_sap_han':       extraWhere = `AND j.deadline BETWEEN NOW() AND NOW() + INTERVAL '48 hours'`; break;
    // OPS filters — must match the corresponding stat-card WHERE clauses exactly (CLAUDE.md L5)
    case 'ops_waiting_tq_doilenh':
      extraWhere = `AND j.destination = 'hai_phong' AND j.service_type IN ('tk','both') AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'thong_quan' AND jot.cost_entered_at IS NULL)`;
      break;
    case 'ops_waiting_doilenh':
      extraWhere = `AND j.destination = 'hai_phong' AND j.service_type IN ('truck','both') AND EXISTS (SELECT 1 FROM job_ops_task jot WHERE jot.job_id = j.id AND jot.task_type = 'doi_lenh' AND (jot.completed = FALSE OR jot.cost_entered_at IS NULL))`;
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
               CASE WHEN j.han_lenh IS NULL THEN
                 CASE WHEN j.import_export = 'import' THEN 'Hạn lệnh' ELSE 'Cutoff time' END
               ELSE '' END
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
  // M2 — 4 tab modes:
  //   'pending'          (default) — pending jobs, role-scoped by assignment
  //   'completed'        — LOG-completed jobs, date filter on j.updated_at
  //   'revenue_pending'  — completed jobs awaiting Sales revenue-tick (FIFO,
  //                        no date filter — entire queue must be visible)
  //   'revenue_entered'  — Sales has ticked, date filter on j.completed_at
  //                        (default last 7 days)
  const isCompleted      = tab === 'completed';
  const isRevenuePending = tab === 'revenue_pending';
  const isRevenueEntered = tab === 'revenue_entered';

  const conditions = [];
  const params = [];
  let idx = 1;

  conditions.push(`j.deleted_at IS NULL`);

  // M2 — Sales role: ALWAYS filter by own sales_id across every tab. Fixes
  // prior gap where tab='completed' had no role filter and exposed every
  // sales' jobs to one sales user. Sales identity is the user's own id;
  // LOG roles (truong_phong_log/dieu_do/cus*/ops) + 'lead' are unaffected.
  if (role === 'sales') {
    conditions.push(`j.sales_id = $${idx++}`);
    params.push(userId);
  }

  if (isCompleted) {
    conditions.push(`j.status = 'completed'`);
    // Date filter on j.updated_at — default last 3 days when no params supplied.
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
    // LOG roles see all completed jobs. Sales filter applied above.
  } else if (isRevenuePending) {
    // M2 — completed jobs awaiting Sales revenue-tick. No date filter (FIFO queue).
    conditions.push(`j.status = 'completed'`);
    conditions.push(`j.revenue_entered_at IS NULL`);
  } else if (isRevenueEntered) {
    // M2 — Sales has already ticked. Date filter applies to j.completed_at
    // (job-completion date, NOT updated_at and NOT revenue_entered_at) so
    // Sales can review what they ticked for a given completion period.
    // Default last 7 days when no params supplied.
    conditions.push(`j.revenue_entered_at IS NOT NULL`);
    if (from_date) {
      conditions.push(`j.completed_at >= $${idx++}::date`);
      params.push(from_date.replace(/'/g, ''));
    }
    if (to_date) {
      conditions.push(`j.completed_at < $${idx++}::date + INTERVAL '1 day'`);
      params.push(to_date.replace(/'/g, ''));
    }
    if (!from_date && !to_date) {
      conditions.push(`j.completed_at >= NOW() - INTERVAL '7 days'`);
    }
  } else {
    // tab='pending' (default) — role-scoped by assignment for LOG roles.
    conditions.push(`j.status = 'pending'`);
    if (role === 'dieu_do') {
      conditions.push(`ja.dieu_do_id = $${idx++}`);
      params.push(userId);
    } else if (CUS_ROLES.includes(role)) {
      conditions.push(`ja.cus_id = $${idx++}`);
      params.push(userId);
    } else if (role === 'ops') {
      conditions.push(`ja.ops_id = $${idx++}`);
      params.push(userId);
    }
    // role === 'sales' already handled by the unified guard above.
  }

  // M2 — tab-aware ORDER BY. Pending/completed unchanged (latest job first);
  // revenue_pending sorts oldest-first so Sales clears the FIFO queue; revenue
  // _entered sorts newest tick first so recent activity sits on top.
  const orderBy = isRevenuePending
    ? 'j.completed_at ASC'
    : isRevenueEntered
      ? 'j.revenue_entered_at DESC'
      : 'j.created_at DESC';

  const WHERE = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name,
        u_created.name AS created_by_name,
        u_revenue.name AS revenue_entered_by_name,
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
        jt.cost_entered_at, jt.cost_entered_by,
        jtr.id AS truck_id, jtr.transport_name, jtr.transport_company_id,
        tc.name AS tc_name,
        jtr.planned_datetime, jtr.actual_datetime,
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
            'completed', jot.completed, 'completed_at', jot.completed_at, 'notes', jot.notes,
            -- Per-task model (2026-05-23): cost tick state per task row.
            'cost_entered_at', jot.cost_entered_at, 'cost_entered_by', jot.cost_entered_by
          ) ORDER BY jot.id)
          FROM job_ops_task jot WHERE jot.job_id = j.id
        ), '[]'::json) AS ops_tasks,
        -- Phase 2: truck-booking summary. Status comes from the plpgsql function
        -- so dashboards stay aligned on a single source of truth (L20). The
        -- legacy jtr.* fields above are kept until Phase 3 UI migrates.
        get_truck_booking_status(j.id) AS truck_booking_status,
        COALESCE((
          SELECT COUNT(*)::int FROM truck_bookings
           WHERE job_id = j.id AND deleted_at IS NULL
        ), 0) AS truck_bookings_count,
        -- Booked-container count (distinct containers in any live booking).
        -- Drives the "booked/total" coverage badge in the Quản lý đặt xe table.
        COALESCE((
          SELECT COUNT(DISTINCT tbc.container_id)::int
            FROM truck_booking_containers tbc
            JOIN truck_bookings tb ON tb.id = tbc.booking_id
           WHERE tb.job_id = j.id AND tb.deleted_at IS NULL
        ), 0) AS truck_booked_containers_count,
        -- DD sign-off tick aggregates (CP6.1) — supports DD's status pill
        -- upgrade + CUS's "DD xong chưa?" cue + TP's full-detail DD column.
        -- bookings_total_alive: count of alive bookings (denominator)
        -- bookings_with_invoice_lifting / bookings_with_cost_entered: numerators
        COALESCE((
          SELECT COUNT(*)::int FROM truck_bookings
           WHERE job_id = j.id AND deleted_at IS NULL
        ), 0) AS bookings_total_alive,
        COALESCE((
          SELECT COUNT(*)::int FROM truck_bookings
           WHERE job_id = j.id AND deleted_at IS NULL AND invoice_lifting_ticked
        ), 0) AS bookings_with_invoice_lifting,
        COALESCE((
          SELECT COUNT(*)::int FROM truck_bookings
           WHERE job_id = j.id AND deleted_at IS NULL AND cost_entered_ticked
        ), 0) AS bookings_with_cost_entered,
        -- Phase 4.1: earliest active booking exposed as first_booking_* so the
        -- DD main grid can inline-edit it without a second fetch. Pattern matches
        -- the bbbg-data LATERAL (earliest by planned_datetime, then id).
        tb_first.id                  AS first_booking_id,
        tb_first.booking_code        AS first_booking_code,
        tb_first.transport_name      AS first_booking_transport,
        tb_first.vehicle_number      AS first_booking_vehicle,
        tb_first.planned_datetime    AS first_booking_planned,
        tb_first.actual_datetime     AS first_booking_actual,
        tb_first.pickup_location     AS first_booking_pickup,
        tb_first.delivery_location   AS first_booking_delivery,
        tb_first.cost                AS first_booking_cost,
        tb_first.notes               AS first_booking_notes,
        tb_first.transport_company_id AS first_booking_transport_company_id
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON true
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_dd ON u_dd.id = ja.dieu_do_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      LEFT JOIN users u_revenue ON u_revenue.id = j.revenue_entered_by
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      LEFT JOIN transport_companies tc ON tc.id = jtr.transport_company_id
      LEFT JOIN LATERAL (
        SELECT id, booking_code, transport_company_id, transport_name, vehicle_number,
               planned_datetime, actual_datetime,
               pickup_location, delivery_location, cost, notes
          FROM truck_bookings
         WHERE job_id = j.id AND deleted_at IS NULL
         ORDER BY planned_datetime ASC NULLS LAST, id ASC
         LIMIT 1
      ) tb_first ON true
      ${WHERE}
      ORDER BY ${orderBy}
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
    // CP4.2.1 — BBBG shipping document fields. All optional; render as blank
    // on BBBG when null.
    shipper, vessel, voy, shipping_line, goods_description,
    // Invoice info (L15) — sent by CreateJobModal in "Khách mới" mode.
    company_full_name, invoice_address, invoice_tax_code,
    // Loại lô — required by the form; default 'export' as defensive fallback.
    import_export,
    // ops_hp (Step 1) — free-text OPS work description for an OPS-only job.
    ops_hp_note,
  } = req.body;

  if (!customer_name || !service_type) {
    return res.status(400).json({ error: 'Tên khách hàng và loại dịch vụ là bắt buộc' });
  }
  const importExport = import_export || 'export';
  if (!['export', 'import'].includes(importExport)) {
    return res.status(400).json({ error: "Loại lô phải là 'export' hoặc 'import'" });
  }
  // Hạn lệnh / Cutoff guard — required on create. Mirror frontend message so
  // the user sees the same phrasing whether they bypass the client or not.
  // Storage shape: 'YYYY-MM-DD' (nhập) or 'YYYY-MM-DDTHH:MM' (xuất); Postgres
  // parses both into the existing TIMESTAMPTZ column.
  if (!han_lenh || !String(han_lenh).trim()) {
    return res.status(400).json({
      error: importExport === 'import' ? 'Vui lòng nhập Hạn lệnh' : 'Vui lòng nhập Cutoff time',
    });
  }

  try {
    // Read assignment mode from DB before starting transaction
    const settingsRes = await db.query(`SELECT assignment_mode FROM log_settings WHERE id = 1`);
    const mode = settingsRes.rows[0]?.assignment_mode || 'auto';
    const isTk = service_type === 'tk' || service_type === 'both';
    // ops_hp (Step 1) — OPS-only job. isTk stays false (no CUS/TK row), isDieuDo
    // stays false (no DD). ops_hp implies HP, so it always needs OPS regardless
    // of the destination value the form happens to send.
    const isOpsHp = service_type === 'ops_hp';
    const needsOps = isOpsHp || (destination === 'hai_phong' && ['tk','truck','both'].includes(service_type));

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
        si_number, mbl_no, hbl_no, import_export,
        shipper, vessel, voy, shipping_line, goods_description,
        ops_hp_note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
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
      importExport,
      shipper || null, vessel || null, voy || null,
      shipping_line || null, goods_description || null,
      ops_hp_note || null,
    ]);

    const job = rows[0];

    if (Array.isArray(containers) && containers.length > 0) {
      for (const c of containers) {
        if (!c.cont_type) continue;
        const w = c.weight_tons;
        const wNum = (w === '' || w == null) ? null : Number(w);
        await client.query(
          `INSERT INTO job_containers
             (job_id, cont_number, cont_type, seal_number, weight_tons)
           VALUES ($1, $2, $3, $4, $5)`,
          [job.id, c.cont_number || null, c.cont_type, c.seal_number || null,
           (Number.isFinite(wNum) ? wNum : null)]
        );
      }
    }

    // Pipeline ownership transfer (L14).
    // When sales_id is provided, the customer (matched by lowered name or customer_id FK)
    // should belong to ONLY that sales user. Any pipeline rows owned by other sales for
    // the same customer are wiped — including child `customers` interaction rows (manual
    // DELETE since the FK is SET NULL not CASCADE). pipeline_history + pipeline_delete_requests
    // cascade automatically.
    let pipelineTransfer = { transferredFromSales: [], wasNewlyInserted: false, customerName: customer_name };
    if (sales_id && customer_name) {
      const { rows: others } = await client.query(
        `SELECT cp.id, cp.sales_id, u.name AS sales_name
           FROM customer_pipeline cp
           LEFT JOIN users u ON u.id = cp.sales_id
          WHERE cp.sales_id != $1
            AND cp.deleted_at IS NULL
            AND ( LOWER(cp.company_name) = LOWER($2)
                  OR ($3::int IS NOT NULL AND cp.customer_id = $3::int) )`,
        [sales_id, customer_name, customer_id || null]
      );
      for (const r of others) {
        await client.query(`DELETE FROM customers WHERE pipeline_id = $1`, [r.id]);
        await client.query(`DELETE FROM customer_pipeline WHERE id = $1`, [r.id]);
        pipelineTransfer.transferredFromSales.push({ sales_id: r.sales_id, sales_name: r.sales_name });
      }
      // ON CONFLICT preserves existing invoice fields (DO UPDATE only sets stage/updated_at).
      // New rows get the values from the form; if the form didn't supply them, default ''.
      // The `WHERE deleted_at IS NULL` predicate matches the partial unique index
      // `idx_pipeline_sales_company_active` — required by Postgres ON CONFLICT inference.
      // Without this, a soft-deleted pipeline would NOT collide and re-INSERT would fail;
      // with this, soft-deleted rows are ignored, so the same (sales,company) can be re-added.
      const { rows: upserted } = await client.query(
        `INSERT INTO customer_pipeline
           (sales_id, company_name, customer_id, stage,
            company_full_name, invoice_address, tax_code)
         VALUES ($1, $2, $3, 'booked', $4, $5, $6)
         ON CONFLICT (sales_id, LOWER(company_name)) WHERE deleted_at IS NULL
           DO UPDATE SET stage = 'booked', updated_at = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`,
        [
          sales_id, customer_name, customer_id || null,
          (company_full_name || '').toString().trim(),
          (invoice_address   || '').toString().trim(),
          (invoice_tax_code  || '').toString().trim(),
        ]
      );
      pipelineTransfer.wasNewlyInserted = !!upserted[0]?.was_inserted;

      // BACKFILL pipeline snapshot (per owner spec May 2026):
      // TPL auto-fills invoice fields from customer-level data when the
      // pipeline snapshot is empty. Persist those values back so the
      // next job creation finds them pre-populated — the DB cleans itself
      // over time, one job at a time.
      //
      // Safety: COALESCE(NULLIF(existing, ''), $new) only fills empty
      // snapshots. Existing values are NEVER overwritten — so a re-submit
      // with a different value is a no-op, and an INSERT branch (row just
      // born with the form's values already in place) is also a no-op.
      //
      // Same transaction as the UPSERT above and the job INSERT — atomic
      // with the rest of POST /api/jobs.
      if (upserted[0]?.id) {
        await client.query(
          `UPDATE customer_pipeline
             SET company_full_name = COALESCE(NULLIF(company_full_name, ''), $1),
                 invoice_address   = COALESCE(NULLIF(invoice_address,   ''), $2),
                 tax_code          = COALESCE(NULLIF(tax_code,          ''), $3),
                 updated_at        = NOW()
           WHERE id = $4
             AND deleted_at IS NULL`,
          [
            (company_full_name || '').toString().trim() || null,
            (invoice_address   || '').toString().trim() || null,
            (invoice_tax_code  || '').toString().trim() || null,
            upserted[0].id,
          ]
        );
      }
    }

    // Phase 2: job_truck is deprecated. Truck planning lives on truck_bookings now
    // (one job → N bookings). DD creates bookings via POST /api/truck-bookings
    // after the job exists. We no longer auto-seed a job_truck row on job create.
    //
    // Legacy PATCH /:id/truck + PATCH /:id/tk (truck_booked sync) still write to
    // job_truck for backward compat with existing frontend code paths — those
    // paths will be removed in a later phase once all readers migrate.
    // (no-op here)

    // Điều Độ assignment for truck/both jobs
    const isDieuDo = service_type === 'truck' || service_type === 'both';
    let ddUserId = null;
    if (isDieuDo) {
      const ddRes = await client.query(`
        SELECT u.id FROM users u WHERE u.role = 'dieu_do' AND u.disabled_at IS NULL
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
          INSERT INTO notifications (user_id, type, title, message, job_id)
          VALUES ($1, 'ai_job_assigned', 'AI phân job mới', $2, $3)
        `, [cusSuggestion.user_id, `Bạn được phân job ${job.job_code || `#${job.id}`} - ${customer_name}`, job.id]);
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
        INSERT INTO notifications (user_id, type, title, message, job_id)
        VALUES ($1, 'ai_job_assigned', 'AI phân job mới', $2, $3)
      `, [opsSuggestion.user_id, `Bạn được phân job ${job.job_code || `#${job.id}`} - ${customer_name}`, job.id]);
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
        INSERT INTO notifications (user_id, type, title, message, job_id)
        VALUES ($1, 'ai_job_assigned', 'AI phân job mới', $2, $3)
      `, [ddUserId, `Bạn được phân job ${job.job_code || `#${job.id}`} - ${customer_name}`, job.id]);
      await recordHistory(client, job.id, req.user.id, 'dieu_do_assigned', null, String(ddUserId));
    }

    // Auto-generate job_ops_task rows for Hải Phòng jobs (per-task model 2026-05-23).
    //   tk    → 'thong_quan' + 'doi_lenh' (OPS does TQ paperwork pickup AND đổi lệnh hộ khách)
    //   truck → 'doi_lenh'
    //   both  → 'thong_quan' + 'doi_lenh'
    // Rule: has TK (tk/both) → needs thong_quan; ANY HP job → needs doi_lenh.
    // Idempotent via partial UNIQUE (job_id, task_type) WHERE task_type IS NOT NULL.
    if (isOpsHp) {
      // ops_hp (Step 1) — seed ONE free-text OPS task. This is the single unit
      // OPS ticks (done + cost) to complete the job. NO thong_quan/doi_lenh.
      const opsUserId = opsSuggestion?.user_id || null;
      await client.query(
        `INSERT INTO job_ops_task (job_id, ops_id, task_type, content) VALUES ($1, $2, 'ops_hp', $3)
         ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
        [job.id, opsUserId, ops_hp_note || null]
      );
    } else if (destination === 'hai_phong' && ['tk','truck','both'].includes(service_type)) {
      const opsUserId = opsSuggestion?.user_id || null;
      if (service_type === 'tk' || service_type === 'both') {
        await client.query(
          `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'thong_quan')
           ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
          [job.id, opsUserId]
        );
      }
      await client.query(
        `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'doi_lenh')
         ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
        [job.id, opsUserId]
      );
    }

    await recordHistory(client, job.id, req.user.id, 'job_created', null, customer_name);

    // Trigger G: notify all TP when a sales user creates a job
    if (req.user.role === 'sales') {
      const { rows: tps } = await client.query(`SELECT id FROM users WHERE role = 'truong_phong_log' AND disabled_at IS NULL`);
      const { rows: salesU } = await client.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
      const salesName = salesU[0]?.name || 'Sales';
      for (const tp of tps) {
        await client.query(
          `INSERT INTO notifications (user_id, type, title, message, job_id)
           VALUES ($1, 'new_job_created', 'Job mới được tạo', $2, $3)`,
          [tp.id, `${salesName} vừa tạo job ${job.job_code || `#${job.id}`} - ${customer_name}`, job.id]
        );
      }
    }

    // Pipeline transfer notifications + history (L14).
    if (sales_id && customer_name) {
      const actor = (await client.query(`SELECT name FROM users WHERE id = $1`, [req.user.id])).rows[0]?.name || 'Người dùng';
      const newSales = (await client.query(`SELECT name FROM users WHERE id = $1`, [sales_id])).rows[0]?.name || 'Sales';
      if (pipelineTransfer.transferredFromSales.length > 0) {
        for (const old of pipelineTransfer.transferredFromSales) {
          await client.query(
            `INSERT INTO notifications (user_id, type, title, message, job_id)
             VALUES ($1, 'pipeline_transferred_out', 'Khách bị chuyển khỏi pipeline', $2, $3)`,
            [old.sales_id, `Khách ${customer_name} đã được chuyển khỏi pipeline của bạn bởi ${actor}`, job.id]
          );
        }
        await client.query(
          `INSERT INTO notifications (user_id, type, title, message, job_id)
           VALUES ($1, 'pipeline_transferred_in', 'Khách được chuyển vào pipeline', $2, $3)`,
          [sales_id, `Khách ${customer_name} đã được thêm vào pipeline của bạn (stage Đã booking)`, job.id]
        );
        const oldNames = pipelineTransfer.transferredFromSales.map(o => o.sales_name).filter(Boolean).join(', ') || '(unknown)';
        await recordHistory(client, job.id, req.user.id, 'pipeline_transferred', oldNames, newSales);
      } else if (pipelineTransfer.wasNewlyInserted) {
        await client.query(
          `INSERT INTO notifications (user_id, type, title, message, job_id)
           VALUES ($1, 'pipeline_added', 'Khách mới vào pipeline', $2, $3)`,
          [sales_id, `Khách ${customer_name} đã được thêm vào pipeline của bạn (stage Đã booking)`, job.id]
        );
      }
    }

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
    // LATERAL JOIN customer_pipeline (L15) so invoice info is on the response.
    // Match on LOWER(company_name) = LOWER(j.customer_name) and prefer the
    // pipeline owned by this job's sales_id when present (avoids picking a
    // stale pipeline if the same company exists under multiple sales).
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name AS sales_name, u_created.name AS created_by_name,
        ja.id AS assignment_id, ja.cus_id, ja.ops_id, ja.dieu_do_id,
        ja.cus_confirm_status, ja.assignment_mode AS ja_mode,
        ja.adjustment_reason, ja.adjustment_deadline_proposed,
        ja.ops_done, ja.ops_done_at,
        u_cus.name AS cus_name, u_cus.code AS cus_code,
        u_ops.name AS ops_name, u_ops.code AS ops_code,
        u_dd.name AS dieu_do_name, u_dd.code AS dieu_do_code,
        cp_inv.company_full_name AS invoice_company_name,
        cp_inv.tax_code          AS invoice_tax_code,
        cp_inv.invoice_address   AS invoice_address
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_dd ON u_dd.id = ja.dieu_do_id
      LEFT JOIN users u_sales ON u_sales.id = j.sales_id
      LEFT JOIN users u_created ON u_created.id = j.created_by
      LEFT JOIN LATERAL (
        SELECT cp.company_full_name, cp.tax_code, cp.invoice_address
          FROM customer_pipeline cp
         WHERE LOWER(cp.company_name) = LOWER(j.customer_name)
           AND cp.deleted_at IS NULL
         ORDER BY (cp.sales_id = j.sales_id) DESC NULLS LAST, cp.id DESC
         LIMIT 1
      ) cp_inv ON true
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });

    // B1 (ĐỢT 1 security fix) — VIEW scope by department/ownership. The SELECT
    // above already exposes sales_id, service_type, destination, and the
    // assignment ids (ja.cus_id/ops_id/dieu_do_id) on rows[0]. No field masking:
    // if canViewJob passes, the full payload (incl. cost + customer) is returned.
    const _assignment = {
      cus_id: rows[0].cus_id,
      ops_id: rows[0].ops_id,
      dieu_do_id: rows[0].dieu_do_id,
    };
    if (!canViewJob(req.user, rows[0], _assignment)) {
      return res.status(403).json({ error: 'Không có quyền xem công việc này' });
    }

    const [tkR, truckR, opsR, histR, contsR] = await Promise.all([
      db.query(`SELECT jt.*, u.name AS cus_name FROM job_tk jt LEFT JOIN users u ON u.id = jt.cus_id WHERE jt.job_id = $1`, [req.params.id]),
      db.query(`SELECT * FROM job_truck WHERE job_id = $1`, [req.params.id]),
      db.query(`SELECT jot.*, u.name AS ops_name FROM job_ops_task jot LEFT JOIN users u ON u.id = jot.ops_id WHERE jot.job_id = $1`, [req.params.id]),
      db.query(`SELECT jh.*, u.name AS changed_by_name FROM job_history jh LEFT JOIN users u ON u.id = jh.changed_by WHERE jh.job_id = $1 ORDER BY jh.changed_at DESC`, [req.params.id]),
      db.query(`SELECT id, cont_number, cont_type, seal_number, weight_tons FROM job_containers WHERE job_id = $1 ORDER BY id`, [req.params.id]),
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

  const BASE_FIELDS = ['job_code','customer_name','customer_address','customer_tax_code',
    'pol','pod','cont_number','cont_type','seal_number',
    'etd','eta','tons','cbm','deadline','service_type','other_services','status',
    'cargo_type','so_kien','kg','destination','han_lenh','si_number','mbl_no','hbl_no',
    'ops_partner','sales_id',
    // CP4.2.1 — BBBG shipping document fields, editable post-create.
    'shipper','vessel','voy','shipping_line','goods_description',
    // L19 reversed 2026-05-20: import_export is editable post-create so the user
    // can switch the displayed date semantic (cutoff vs hạn lệnh). Existing
    // han_lenh value is preserved; only the label/input type follows the toggle.
    'import_export'];
  // B2 (ĐỢT 1 security fix) — only TP/lead may change ownership (sales_id) or
  // force status. Strip both for every other caller so an assigned dept user
  // (or owner-sales) can edit job info but cannot steal a job or force-complete
  // it via the generic field loop. The DD completion flow (body.completed_at)
  // is unaffected — it writes dd_completed_at, not status.
  const FIELDS = canReassignOwnerOrStatus(req.user)
    ? BASE_FIELDS
    : BASE_FIELDS.filter(f => f !== 'sales_id' && f !== 'status');

  // import_export validation guard — mirror POST behavior at jobs.js:1349-1352.
  // Only fires when the field is present in the body; absent leaves the row's
  // existing value intact.
  if (req.body.import_export !== undefined &&
      !['export', 'import'].includes(req.body.import_export)) {
    return res.status(400).json({ error: "Loại lô phải là 'export' hoặc 'import'" });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }

    // B2 (ĐỢT 1 security fix) — EDIT scope by assignment. Only the assigned dept
    // user (CUS=cus_id / DD=dieu_do_id), the owner-sales (sales_id), or TP/lead
    // may edit. Mirrors the job_assignments lookup used by PATCH /:id/complete.
    // (ops is already blocked above at the top of the handler.)
    const { rows: _ja } = await client.query(
      `SELECT cus_id, ops_id, dieu_do_id FROM job_assignments WHERE job_id = $1`,
      [req.params.id]
    );
    if (!canEditJob(req.user, cur[0], _ja[0] || null)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Không có quyền chỉnh sửa công việc này' });
    }

    // han_lenh / Cutoff guard — mirror POST behavior. Only fires when the field
    // is explicitly present in the body; absent fields leave the existing value
    // intact (partial-update friendly). The error label follows import_export —
    // since import_export is now editable too (L19 reversed 2026-05-20), prefer
    // the payload's new value when present, otherwise fall back to the row's.
    if (req.body.han_lenh !== undefined) {
      const v = req.body.han_lenh;
      if (!v || !String(v).trim()) {
        await client.query('ROLLBACK');
        const effectiveImpExp = req.body.import_export ?? cur[0].import_export;
        return res.status(400).json({
          error: effectiveImpExp === 'import'
            ? 'Vui lòng nhập Hạn lệnh'
            : 'Vui lòng nhập Cutoff time',
        });
      }
    }

    const sets = []; const params = []; let idx = 1;
    const handledByGuard = new Set();

    // 2026-05-24 DD-split — `completed_at` body is now interpreted as DD's
    // "TH ngày giờ" stamp and writes to jobs.dd_completed_at (NOT jobs.completed_at).
    // checkAndCompleteJob is called after the stamp; it auto-flips jobs.completed_at
    // ONLY when CUS + DD + OPS are all done (truckDone now reads via dd_da_xong/
    // hoan_thanh state). This decouples DD's progress from whole-job completion.
    // Setting to null clears DD's stamp WITHOUT touching jobs.status / completed_at
    // (matches the CUS/OPS un-tick "don't auto-uncomplete" policy).
    let ddStampedAt = null; // 2026-05-24: tracks whether DD just stamped a non-null
                            // dd_completed_at so we can call checkAndCompleteJob
                            // after the UPDATE runs (CUS + OPS may already be done).
    if (req.body.completed_at !== undefined) {
      const raw = req.body.completed_at;
      const ts = (raw === '' || raw == null) ? null : raw;
      if (ts !== null) {
        const { rows: [s] } = await client.query(
          `SELECT get_truck_booking_status($1) AS status`, [req.params.id]
        );
        // Guard #1: DD must reach du_xe_cho_giao (or already past — dd_da_xong /
        // hoan_thanh) before stamping. dd_da_xong added so DD can re-stamp /
        // adjust the timestamp after the first commit.
        if (!['du_xe_cho_giao', 'dd_da_xong', 'hoan_thanh'].includes(s.status)) {
          await client.query('ROLLBACK');
          const labels = {
            chua_dat_kh:          'Chưa đặt KH',
            dat_kh_1_phan:        'Đặt KH 1 phần',
            du_kh_chua_chot_vt:   'Đủ KH, chưa chốt VT',
            du_kh_chot_vt_1_phan: 'Đủ KH, chốt VT 1 phần',
            du_vt_chua_co_xe:     'Đủ VT, chưa có xe',
            du_vt_co_xe_1_phan:   'Đủ VT, có xe 1 phần',
          };
          const label = labels[s.status] || s.status;
          return res.status(400).json({
            error: `Không thể hoàn thành job. Trạng thái hiện tại: ${label}. ` +
                   'Vui lòng đặt đủ kế hoạch, chốt vận tải, và nhập số xe trước.',
            code: 'JOB_NOT_READY_TO_COMPLETE',
            current_status: s.status,
          });
        }
        // CP6.1 — secondary guard: every alive booking must have both
        // sign-off ticks set. Surfaces 3 specific error codes so the
        // frontend can show a precise toast.
        const { rows: [tk] } = await client.query(`
          SELECT
            COUNT(*) FILTER (WHERE NOT invoice_lifting_ticked) AS missing_inv,
            COUNT(*) FILTER (WHERE NOT cost_entered_ticked)    AS missing_cost
          FROM truck_bookings
          WHERE job_id = $1 AND deleted_at IS NULL
        `, [req.params.id]);
        const missingInv  = Number(tk.missing_inv)  > 0;
        const missingCost = Number(tk.missing_cost) > 0;
        if (missingInv || missingCost) {
          await client.query('ROLLBACK');
          if (missingInv && missingCost) {
            return res.status(400).json({
              error: "Vui lòng tick 'Nâng hạ' và 'Cost hệ thống' cho tất cả container trước khi hoàn thành",
              code: 'MISSING_BOTH_TICKS',
            });
          }
          if (missingInv) {
            return res.status(400).json({
              error: "Vui lòng tick 'Nâng hạ' cho tất cả container trước khi hoàn thành",
              code: 'MISSING_INVOICE_LIFTING',
            });
          }
          return res.status(400).json({
            error: "Vui lòng tick 'Cost hệ thống' cho tất cả container trước khi hoàn thành",
            code: 'MISSING_COST_ENTERED',
          });
        }
        // Guard #4 (2026-05-23): OPS per-task gate. DD must wait until OPS
        // thong_quan/doi_lenh tasks are done before stamping dd_completed_at.
        // checkAndCompleteJob will re-check this gate when deciding whether to
        // auto-flip jobs.completed_at, but stamping dd_completed_at represents
        // DD's commitment that their portion is fully done — OPS must finish first.
        const opsCheck = await checkOpsTasksDone(client, req.params.id);
        if (!opsCheck.ready) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: opsCheck.missing.join(', '),
            code: 'OPS_TASKS_INCOMPLETE',
          });
        }
        // 2026-05-24 DD-split — stamp dd_completed_at + dd_completed_by.
        // Do NOT write jobs.completed_at or status here; checkAndCompleteJob
        // below auto-flips the job to 'completed' only when CUS + DD + OPS all done.
        sets.push(`dd_completed_at = $${idx++}`); params.push(ts);
        sets.push(`dd_completed_by = $${idx++}`); params.push(req.user.id);
        await recordHistory(client, req.params.id, req.user.id, 'dd_completed_at', cur[0].dd_completed_at, ts);
        ddStampedAt = ts;
      } else {
        // Uncomplete: clear DD's stamp only. Per the "don't auto-uncomplete"
        // policy (matches CUS/OPS un-tick paths), do NOT touch jobs.completed_at
        // or status. If the job already auto-flipped to completed, it stays
        // completed; admin can reverse via a separate path if needed.
        sets.push(`dd_completed_at = NULL`);
        sets.push(`dd_completed_by = NULL`);
        await recordHistory(client, req.params.id, req.user.id, 'dd_completed_at', cur[0].dd_completed_at, null);
      }
      // status is intentionally NOT touched in the DD-stamp flow — leave it for
      // the generic loop or checkAndCompleteJob to manage.
      handledByGuard.add('status');
    }

    for (const f of FIELDS) {
      if (req.body[f] === undefined) continue;
      if (handledByGuard.has(f)) continue;
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

    // Trigger #3 (broadcast from PATCH /set-deadline): TP changed an existing
    // deadline by ≥ 1 hour via the general updater → CUS must re-confirm.
    if (req.body.deadline !== undefined) {
      const oldDeadline = cur[0].deadline;
      const newDeadline = req.body.deadline;
      const oldMs = oldDeadline ? new Date(oldDeadline).getTime() : null;
      const newMs = newDeadline ? new Date(newDeadline).getTime() : null;
      const shouldNotify =
        oldMs !== null && newMs !== null && Math.abs(newMs - oldMs) >= 3600 * 1000;

      if (shouldNotify) {
        await client.query(
          `UPDATE job_assignments
              SET cus_confirm_status = 'pending',
                  adjustment_reason = NULL,
                  adjustment_deadline_proposed = NULL
            WHERE job_id = $1`,
          [req.params.id]
        );
        const { rows: ja } = await client.query(
          `SELECT cus_id FROM job_assignments WHERE job_id = $1`,
          [req.params.id]
        );
        const cusId = ja[0]?.cus_id || null;
        if (cusId) {
          const jc = cur[0].job_code || `#${req.params.id}`;
          const dl = fmtVnDeadline(newDeadline);
          await client.query(
            `INSERT INTO notifications (user_id, type, title, message, job_id)
             VALUES ($1, 'deadline_request', 'TP yêu cầu xác nhận deadline', $2, $3)`,
            [cusId, `Trưởng phòng đặt deadline mới cho job ${jc}: ${dl}`, req.params.id]
          );
        }
        await recordHistory(
          client, req.params.id, req.user.id,
          'deadline_request_sent_via_put', oldDeadline, newDeadline
        );
      }
    }

    // Fix A — back-fill job_tk when service_type changes to include TK.
    // Root cause from audit: a job created with service_type='truck' has no
    // job_tk row; if later edited to 'tk' or 'both', the CUS dashboard renders
    // an editable tk_number cell but PATCH /:id/tk returns 404 because no row
    // exists. Ensure the row exists here. Pattern matches the existence-then-
    // INSERT used elsewhere in this file (jobs.js:1994-1999, 2120-2124) since
    // job_tk has no UNIQUE(job_id) — can't use ON CONFLICT.
    //
    // POST inserts only (job_id) [+ optional cus_id from AI suggestion] —
    // we mirror that minimal shape here.
    const effectiveSvc = req.body.service_type ?? cur[0].service_type;
    if (effectiveSvc === 'tk' || effectiveSvc === 'both') {
      const { rows: tkEx } = await client.query(
        `SELECT id FROM job_tk WHERE job_id = $1`,
        [req.params.id]
      );
      if (!tkEx[0]) {
        await client.query(
          `INSERT INTO job_tk (job_id) VALUES ($1)`,
          [req.params.id]
        );
        await recordHistory(client, req.params.id, req.user.id,
          'job_tk_backfilled', null, 'auto on service_type change');
      }
    }

    // Per-task model (2026-05-23): back-fill job_ops_task when destination/
    // service_type changes such that the job newly needs OPS tasks (HP + tk/
    // truck/both). Idempotent via partial UNIQUE on (job_id, task_type).
    //   tk/both → ensure 'thong_quan' + 'doi_lenh'
    //   truck   → ensure 'doi_lenh'
    // Per spec: do NOT delete tasks if job changes away (out of scope).
    const effectiveDest = req.body.destination ?? cur[0].destination;
    if (effectiveDest === 'hai_phong' && ['tk','truck','both'].includes(effectiveSvc)) {
      const { rows: jaRow } = await client.query(
        `SELECT ops_id FROM job_assignments WHERE job_id = $1`,
        [req.params.id]
      );
      const opsUserId = jaRow[0]?.ops_id || null;
      if (effectiveSvc === 'tk' || effectiveSvc === 'both') {
        await client.query(
          `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'thong_quan')
           ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
          [req.params.id, opsUserId]
        );
      }
      await client.query(
        `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'doi_lenh')
         ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
        [req.params.id, opsUserId]
      );
    }

    // 2026-05-24 DD-split: if DD just stamped a non-null dd_completed_at, try
    // to auto-complete the whole job. checkAndCompleteJob re-checks tkDone +
    // truckDone (now reads dd_da_xong / hoan_thanh via the updated function) +
    // OPS task gate. Stamps jobs.completed_at + status='completed' only when
    // all 3 depts are done; otherwise the job stays pending and DD's pill
    // shows 'dd_da_xong'.
    let jobCompleted = false;
    if (ddStampedAt) {
      jobCompleted = await checkAndCompleteJob(client, req.params.id, req.user.id);
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      // DD-stamp flow returns explicit flags so the frontend can pick the
      // right toast ("Job hoàn thành" vs "Đã chốt TH — chờ CUS/OPS").
      ...(req.body.completed_at !== undefined ? {
        dd_completed: !!ddStampedAt,
        job_completed: jobCompleted,
      } : {}),
    });
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
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const { cus_id, ops_id } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // P2 — reject disabled / wrong-role assignment targets.
    if (cus_id) {
      const v = await validateAssignee(client, cus_id, CUS_ROLES, 'CUS');
      if (!v.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    }
    if (ops_id) {
      const v = await validateAssignee(client, ops_id, ['ops'], 'OPS');
      if (!v.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    }
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

    const { rows: jobMeta } = await client.query(`SELECT job_code, customer_name FROM jobs WHERE id = $1`, [req.params.id]);
    const jc = jobMeta[0]?.job_code || `#${req.params.id}`;
    const jn = jobMeta[0]?.customer_name || '';

    if (cus_id) {
      const { rows: tkEx } = await client.query(`SELECT id FROM job_tk WHERE job_id = $1`, [req.params.id]);
      if (tkEx[0]) {
        await client.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [cus_id, req.params.id]);
      } else {
        await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [req.params.id, cus_id]);
      }
      const { rows: cu } = await client.query(`SELECT name FROM users WHERE id = $1`, [cus_id]);
      await recordHistory(client, req.params.id, req.user.id, 'cus_assigned', null, cu[0]?.name);
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)`,
        [cus_id, `Trưởng phòng phân bạn job ${jc} - ${jn}`, req.params.id]
      );
    }
    if (ops_id) {
      const { rows: ou } = await client.query(`SELECT name FROM users WHERE id = $1`, [ops_id]);
      await recordHistory(client, req.params.id, req.user.id, 'ops_assigned', null, ou[0]?.name);
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)`,
        [ops_id, `Trưởng phòng phân bạn job ${jc} - ${jn}`, req.params.id]
      );
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

    // Trigger E: notify all TP that CUS proposed a new deadline
    const { rows: meta } = await client.query(`SELECT job_code FROM jobs WHERE id = $1`, [req.params.id]);
    const { rows: cusU } = await client.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
    const cusName = cusU[0]?.name || 'CUS';
    const jc = meta[0]?.job_code || `#${req.params.id}`;
    const dl = fmtVnDeadline(proposed_deadline);
    const { rows: tps } = await client.query(`SELECT id FROM users WHERE role = 'truong_phong_log' AND disabled_at IS NULL`);
    for (const tp of tps) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'deadline_proposed', 'CUS đề xuất deadline mới', $2, $3)`,
        [tp.id, `${cusName} đề xuất deadline cho job ${jc}: ${dl}`, req.params.id]
      );
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

    // P2 — reject disabled / wrong-role assignment targets.
    if (cus_id) {
      const v = await validateAssignee(client, cus_id, CUS_ROLES, 'CUS');
      if (!v.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    }
    if (ops_id) {
      const v = await validateAssignee(client, ops_id, ['ops'], 'OPS');
      if (!v.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: v.error }); }
    }

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
        INSERT INTO notifications (user_id, type, title, message, job_id)
        VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)
      `, [cus_id, `Trưởng phòng phân bạn job ${job[0].job_code || `#${req.params.id}`} - ${job[0].customer_name}`, req.params.id]);
      await client.query(`
        INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used)
        VALUES ($1, $2, 'cus', 'Manual assignment by TP', 0, true)
      `, [req.params.id, cus_id]);
      await recordHistory(client, req.params.id, req.user.id, 'cus_assigned', null, String(cus_id));
    }

    if (ops_id) {
      await client.query(`
        INSERT INTO notifications (user_id, type, title, message, job_id)
        VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)
      `, [ops_id, `Trưởng phòng phân bạn job ${job[0].job_code || `#${req.params.id}`} - ${job[0].customer_name}`, req.params.id]);
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

// PATCH /api/jobs/:id/reassign-cus  (truong_phong_log only)
// Reassign CUS for a pending job whose TK is not yet completed.
// Preserves all job_tk data so the new CUS sees the existing work.
router.patch('/:id/reassign-cus', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const newCusId = parseInt(req.body?.new_cus_id, 10);
  if (!newCusId) return res.status(400).json({ error: 'Thiếu new_cus_id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: jrows } = await client.query(`
      SELECT j.id, j.job_code, j.status, j.deleted_at,
             ja.cus_id AS old_cus_id,
             jt.completed_at AS tk_completed_at
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      WHERE j.id = $1
    `, [req.params.id]);
    const j = jrows[0];
    if (!j || j.deleted_at) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    if (j.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Job không ở trạng thái pending, không thể đổi CUS' }); }
    if (j.tk_completed_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'TK đã hoàn thành, không thể đổi CUS' }); }

    const { rows: nu } = await client.query(`SELECT id, name, role, disabled_at FROM users WHERE id = $1`, [newCusId]);
    if (!nu[0] || !CUS_ROLES.includes(nu[0].role)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Người dùng không phải CUS' }); }
    if (nu[0].disabled_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'CUS đã bị khóa — không thể phân job' }); }

    const { rows: ou } = await client.query(`SELECT name FROM users WHERE id = $1`, [j.old_cus_id]);
    const oldName = ou[0]?.name || '(chưa có)';
    const newName = nu[0].name;
    const jc = j.job_code || `#${j.id}`;

    // Update or insert assignment row. job_tk rows are NOT touched — preserves
    // tk_status, tk_number, tk_flow, etc. so the new CUS sees existing work.
    const { rows: jaEx } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [req.params.id]);
    let updated;
    if (jaEx[0]) {
      const { rows: u } = await client.query(`
        UPDATE job_assignments
           SET cus_id = $1,
               cus_confirm_status = 'pending',
               cus_confirmed_at = NULL,
               adjustment_reason = NULL,
               adjustment_deadline_proposed = NULL,
               assigned_by = $2,
               assigned_at = NOW()
         WHERE job_id = $3
         RETURNING *
      `, [newCusId, req.user.id, req.params.id]);
      updated = u[0];
    } else {
      const { rows: u } = await client.query(`
        INSERT INTO job_assignments (job_id, cus_id, assigned_by, assignment_mode, cus_confirm_status)
        VALUES ($1, $2, $3, 'manual', 'pending')
        RETURNING *
      `, [req.params.id, newCusId, req.user.id]);
      updated = u[0];
    }

    // Keep job_tk.cus_id in sync if a tk row exists.
    await client.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [newCusId, req.params.id]);

    await recordHistory(client, req.params.id, req.user.id, 'cus_reassigned', oldName, newName);

    // Notify new CUS
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, job_id)
       VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)`,
      [newCusId, `Trưởng phòng phân bạn job ${jc}`, req.params.id]
    );
    // Notify old CUS (if any)
    if (j.old_cus_id && j.old_cus_id !== newCusId) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'job_reassigned', 'Job đã chuyển', $2, $3)`,
        [j.old_cus_id, `Job ${jc} đã được chuyển sang CUS khác`, req.params.id]
      );
    }

    await client.query('COMMIT');
    suggestionCache = { data: null, ts: 0 };
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/reassign-ops  (truong_phong_log only)
// Reassign OPS for a pending job whose OPS work is not yet done.
// Wipes job_ops_task and recreates a fresh task per service_type/destination rule.
router.patch('/:id/reassign-ops', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
  const newOpsId = parseInt(req.body?.new_ops_id, 10);
  if (!newOpsId) return res.status(400).json({ error: 'Thiếu new_ops_id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: jrows } = await client.query(`
      SELECT j.id, j.job_code, j.status, j.deleted_at, j.service_type, j.destination,
             ja.ops_id AS old_ops_id
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      WHERE j.id = $1
    `, [req.params.id]);
    const j = jrows[0];
    if (!j || j.deleted_at) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    if (j.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Job không ở trạng thái pending, không thể đổi OPS' }); }
    // Per-task model (2026-05-23): reassign-ops always wipes and recreates tasks
    // for the new OPS, regardless of prior progress (owner spec: RESET all tasks).
    // Legacy ja.ops_done guard removed — ops_done is no longer authoritative.

    const { rows: nu } = await client.query(`SELECT id, name, role, disabled_at FROM users WHERE id = $1`, [newOpsId]);
    if (!nu[0] || nu[0].role !== 'ops') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Người dùng không phải OPS' }); }
    if (nu[0].disabled_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'OPS đã bị khóa — không thể phân job' }); }

    const { rows: ou } = await client.query(`SELECT name FROM users WHERE id = $1`, [j.old_ops_id]);
    const oldName = ou[0]?.name || '(chưa có)';
    const newName = nu[0].name;
    const jc = j.job_code || `#${j.id}`;

    const { rows: jaEx } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [req.params.id]);
    if (jaEx[0]) {
      await client.query(`
        UPDATE job_assignments
           SET ops_id = $1,
               ops_done = FALSE,
               ops_done_at = NULL,
               assigned_by = $2,
               assigned_at = NOW()
         WHERE job_id = $3
      `, [newOpsId, req.user.id, req.params.id]);
    } else {
      await client.query(`
        INSERT INTO job_assignments (job_id, ops_id, assigned_by, assignment_mode, ops_done)
        VALUES ($1, $2, $3, 'manual', FALSE)
      `, [req.params.id, newOpsId, req.user.id]);
    }

    // Wipe and recreate ops tasks per the per-task model (2026-05-23).
    //   tk/both → 'thong_quan' + 'doi_lenh'
    //   truck   → 'doi_lenh' only
    // Per owner: reassign-ops RESETS all tasks for the new OPS — wipe + recreate
    // (completed=FALSE, cost_entered_at=NULL by column defaults).
    await client.query(`DELETE FROM job_ops_task WHERE job_id = $1`, [req.params.id]);
    if (j.destination === 'hai_phong' && ['tk', 'truck', 'both'].includes(j.service_type)) {
      if (j.service_type === 'tk' || j.service_type === 'both') {
        await client.query(
          `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'thong_quan')`,
          [req.params.id, newOpsId]
        );
      }
      await client.query(
        `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, 'doi_lenh')`,
        [req.params.id, newOpsId]
      );
    }

    await recordHistory(client, req.params.id, req.user.id, 'ops_reassigned', oldName, newName);

    // Notify new OPS
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, job_id)
       VALUES ($1, 'manual_job_assigned', 'TP phân job mới', $2, $3)`,
      [newOpsId, `Trưởng phòng phân bạn job ${jc}`, req.params.id]
    );
    // Notify old OPS (if any)
    if (j.old_ops_id && j.old_ops_id !== newOpsId) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'job_reassigned', 'Job đã chuyển', $2, $3)`,
        [j.old_ops_id, `Job ${jc} đã được chuyển sang OPS khác`, req.params.id]
      );
    }

    await client.query('COMMIT');
    suggestionCache = { data: null, ts: 0 };
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
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
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
    // CP6.5 (M3) — shared so AI-assigned path and existing-CUS path use the
    // exact same notification copy.
    const notifMsg = action === 'approved'
      ? 'Trưởng phòng đã duyệt yêu cầu điều chỉnh deadline'
      : 'Trưởng phòng đã từ chối yêu cầu điều chỉnh deadline. Tiếp tục theo deadline ban đầu.';
    let notifyUserId = existingCusId;
    let notifiedInAcTxn = false;  // when AI path commits, notification already shipped inside ac.

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
            // CP6.5 (M3) — audit log + notification inside the same transaction
            // as the assignment so they roll back together on failure.
            await ac.query(`INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used) VALUES ($1,$2,'cus',$3,$4,$5)`,
              [drJobId, suggestion.user_id, suggestion.reason, suggestion.cost || 0, suggestion.fallback || false]);
            await ac.query(`INSERT INTO notifications (user_id, type, title, message, job_id) VALUES ($1,'deadline_reviewed','Deadline được xem xét',$2,$3)`,
              [suggestion.user_id, notifMsg, drJobId]);
            await ac.query('COMMIT');
            notifyUserId = suggestion.user_id;
            notifiedInAcTxn = true;
          } catch (e) {
            await ac.query('ROLLBACK');
            console.error('CUS auto-assign after review failed:', e.message);
          } finally {
            ac.release();
          }
        }
      }
    }

    // Existing-CUS path: no transaction context here, notification stays
    // standalone. AI path already inserted its notification inside ac.
    if (notifyUserId && !notifiedInAcTxn) {
      await db.query(`INSERT INTO notifications (user_id, type, title, message, job_id) VALUES ($1,'deadline_reviewed','Deadline được xem xét',$2,$3)`,
        [notifyUserId, notifMsg, drJobId]);
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

    // Trigger G: notify the original requester of the decision
    if (dr[0].requested_by) {
      const { rows: meta } = await client.query(`SELECT job_code FROM jobs WHERE id = $1`, [dr[0].job_id]);
      const jc = meta[0]?.job_code || `#${dr[0].job_id}`;
      const isApproved = action === 'approved';
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'delete_decision', $2, $3, $4)`,
        [
          dr[0].requested_by,
          isApproved ? 'Yêu cầu xóa được duyệt' : 'Yêu cầu xóa bị từ chối',
          isApproved
            ? `Trưởng phòng đã duyệt xóa job ${jc}`
            : `Trưởng phòng đã từ chối xóa job ${jc}`,
          dr[0].job_id,
        ]
      );
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

// PATCH /api/jobs/:id/set-deadline  (truong_phong_log only)
router.patch('/:id/set-deadline', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log')
    return res.status(403).json({ error: 'Chỉ Trưởng phòng mới được đặt deadline' });

  const { deadline } = req.body;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT deadline, job_code FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy' }); }

    const oldDeadline = cur[0].deadline;
    await client.query(
      `UPDATE jobs SET deadline = $1, updated_at = NOW() WHERE id = $2`,
      [deadline, req.params.id]
    );

    // Trigger #3: TP changed an existing deadline by ≥ 1 hour → CUS must re-confirm
    const oldMs = oldDeadline ? new Date(oldDeadline).getTime() : null;
    const newMs = deadline   ? new Date(deadline).getTime()   : null;
    const shouldNotify =
      oldMs !== null && newMs !== null && Math.abs(newMs - oldMs) >= 3600 * 1000;

    if (shouldNotify) {
      await client.query(
        `UPDATE job_assignments
            SET cus_confirm_status = 'pending',
                adjustment_reason = NULL,
                adjustment_deadline_proposed = NULL
          WHERE job_id = $1`,
        [req.params.id]
      );
      const { rows: ja } = await client.query(
        `SELECT cus_id FROM job_assignments WHERE job_id = $1`,
        [req.params.id]
      );
      const cusId = ja[0]?.cus_id || null;
      if (cusId) {
        const jc = cur[0].job_code || `#${req.params.id}`;
        const dl = fmtVnDeadline(deadline);
        await client.query(
          `INSERT INTO notifications (user_id, type, title, message, job_id)
           VALUES ($1, 'deadline_request', 'TP yêu cầu xác nhận deadline', $2, $3)`,
          [cusId, `Trưởng phòng đặt deadline mới cho job ${jc}: ${dl}`, req.params.id]
        );
      }
      await recordHistory(
        client, req.params.id, req.user.id,
        'deadline_request_sent', oldDeadline, deadline
      );
    }

    await recordHistory(client, req.params.id, req.user.id, 'deadline', oldDeadline, deadline);

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
  const role = req.user.role;
  const isOps = role === 'ops';
  const isCus = CUS_ROLES.includes(role);
  const isTpLead = role === 'truong_phong_log' || role === 'lead';
  // B3 (ĐỢT 1 security fix) — role allowlist: CUS + TP/lead may edit the TK
  // record; OPS keeps its legacy status-only narrowing. Every other role (sales,
  // dieu_do, ke_toan, ...) is rejected — previously ANY authed user could rewrite
  // any job's customs declaration by id.
  if (!isOps && !isCus && !isTpLead) {
    return res.status(403).json({ error: 'Không có quyền chỉnh sửa TK' });
  }
  const FIELDS = isOps
    ? ['tk_status']
    : ['tk_datetime','tk_number','tk_flow','tk_status','tq_datetime',
       'services_completed','delivery_datetime','delivery_location','truck_booked','notes'];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(`SELECT * FROM job_tk WHERE job_id = $1`, [req.params.id]);
    if (!cur[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy TK' }); }

    // B3 — assigned-CUS gate (mirror PATCH /:id/complete:3254). A CUS may only
    // edit TK on a job assigned to them; TP/lead bypass. OPS is status-only and
    // keeps its existing (un-scoped) behavior per spec.
    if (isCus) {
      const { rows: _ja } = await client.query(
        `SELECT cus_id FROM job_assignments WHERE job_id = $1`,
        [req.params.id]
      );
      if (!canEditJobTk(req.user, _ja[0] || null)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Không có quyền chỉnh sửa TK của công việc này' });
      }
    }

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

    // Phase 4: the legacy "truck_booked sync to job_truck" block has been removed.
    // CUS ticking "Đặt xe" no longer pre-seeds a job_truck row — DD creates a
    // booking via POST /api/truck-bookings when they're ready. The tk row's
    // truck_booked flag is still flipped above (in the FIELDS loop) for any
    // legacy reader that hasn't migrated; no downstream side effect needed.

    // Trigger-gap fix (2026-05-21): every other side-completion event calls
    // checkAndCompleteJob (truck/complete:2719, ops-done:2861, truck-bookings
    // vehicle transition:403); the TK side did not, leaving TK-only jobs stuck
    // at status='pending' after CUS marked terminal status. Idempotent — the
    // helper early-returns when status === 'completed' already.
    await checkAndCompleteJob(client, req.params.id, req.user.id);

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/jobs/:id/tk-cost-tick ──────────────────────────────────────────
// CUS marks "đã nhập cost" — independent of tk_status (CUS may tick before or
// after Thông quan/Giải phóng/Bảo quản). Mirrors the M2 revenue-tick contract
// at /api/jobs/:id/revenue-tick — same shape, different scope (CUS-side TK
// completion instead of Sales-side revenue recognition). PATCH stamps; DELETE
// clears. PATCH calls checkAndCompleteJob so the job auto-flips when both
// tk_completed_at + cost_entered_at are set.
router.patch('/:id/tk-cost-tick', requireAuth, async (req, res) => {
  const allowed = ['cus','cus1','cus2','cus3','lead','truong_phong_log'];
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền tick cost' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT jt.id, jt.job_id, jt.cost_entered_at, j.deleted_at
         FROM job_tk jt
         LEFT JOIN jobs j ON j.id = jt.job_id
        WHERE jt.job_id = $1`,
      [req.params.id]
    );
    if (!cur[0] || cur[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy TK của job' });
    }
    if (cur[0].cost_entered_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cost đã được tick trước đó' });
    }
    const { rows } = await client.query(
      `UPDATE job_tk
          SET cost_entered_at = NOW(),
              cost_entered_by = $1
        WHERE job_id = $2
        RETURNING *`,
      [req.user.id, req.params.id]
    );
    await recordHistory(
      client, req.params.id, req.user.id,
      'cost_entered', null, rows[0].cost_entered_at?.toISOString?.() || 'NOW()'
    );
    const completed = await checkAndCompleteJob(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, tk: rows[0], job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/jobs/:id/tk-cost-tick ─────────────────────────────────────────
// Un-tick. Clears cost_entered_at/by. Does NOT auto-uncomplete the job —
// matches the M2 revenue un-tick precedent (a completed job stays completed).
router.delete('/:id/tk-cost-tick', requireAuth, async (req, res) => {
  const allowed = ['cus','cus1','cus2','cus3','lead','truong_phong_log'];
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền bỏ tick cost' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT jt.id, jt.job_id, jt.cost_entered_at, j.deleted_at
         FROM job_tk jt
         LEFT JOIN jobs j ON j.id = jt.job_id
        WHERE jt.job_id = $1`,
      [req.params.id]
    );
    if (!cur[0] || cur[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy TK của job' });
    }
    if (!cur[0].cost_entered_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cost chưa được tick' });
    }
    const prev = cur[0].cost_entered_at;
    const { rows } = await client.query(
      `UPDATE job_tk
          SET cost_entered_at = NULL,
              cost_entered_by = NULL
        WHERE job_id = $1
        RETURNING *`,
      [req.params.id]
    );
    await recordHistory(
      client, req.params.id, req.user.id,
      'cost_entered', prev?.toISOString?.() || String(prev), null
    );
    await client.query('COMMIT');
    res.json({ ok: true, tk: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/truck — REMOVED (Phase 4). Use POST/PATCH /api/truck-bookings instead.

// PATCH /api/jobs/:id/truck/complete  — DieuDo marks the truck side complete
router.patch('/:id/truck/complete', requireAuth, async (req, res) => {
  if (req.user.role !== 'dieu_do') {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT j.id, j.service_type, j.destination,
             ja.dieu_do_id,
             -- Per-task model (2026-05-23): "OPS đã đổi lệnh xong" =
             -- doi_lenh task completed AND cost ticked. Falls back to TRUE
             -- when no doi_lenh task row exists (non-HP / not required).
             COALESCE((
               SELECT (completed = TRUE AND cost_entered_at IS NOT NULL)
               FROM job_ops_task
               WHERE job_id = j.id AND task_type = 'doi_lenh'
             ), TRUE) AS dl_done,
             jtr.transport_name, jtr.vehicle_number, jtr.planned_datetime,
             jtr.delivery_location, jtr.cost, jtr.completed_at
      FROM jobs j
      LEFT JOIN job_assignments ja ON ja.job_id = j.id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Không tìm thấy job' }); }
    const j = rows[0];

    if (j.dieu_do_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Không có quyền' });
    }

    const missing = [];
    if (!j.transport_name || !String(j.transport_name).trim()) missing.push('vận tải');
    if (!j.vehicle_number || !String(j.vehicle_number).trim()) missing.push('số xe');
    if (!j.planned_datetime) missing.push('giờ giao');
    if (!j.delivery_location || !String(j.delivery_location).trim()) missing.push('địa điểm giao');
    if (j.cost === null || j.cost === undefined || Number(j.cost) <= 0) missing.push('cước phí');
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Vui lòng nhập đủ thông tin: ${missing.join(', ')}` });
    }

    if (j.destination === 'hai_phong'
        && (j.service_type === 'truck' || j.service_type === 'both')
        && !j.dl_done) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'OPS chưa đổi lệnh xong' });
    }

    let truckRow = null;
    if (!j.completed_at) {
      const { rows: upd } = await client.query(
        `UPDATE job_truck SET completed_at = NOW() WHERE job_id = $1 AND completed_at IS NULL RETURNING *`,
        [req.params.id]
      );
      truckRow = upd[0] || null;
      await recordHistory(client, req.params.id, req.user.id, 'truck_completed', null, 'DieuDo hoàn thành phần truck');
    }
    const completed = await checkAndCompleteJob(client, req.params.id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, truck: truckRow || {}, job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/jobs/:id/ops-task
router.post('/:id/ops-task', requireAuth, async (req, res) => {
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
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
  if (req.user.role !== 'truong_phong_log') return res.status(403).json({ error: 'Không có quyền' });
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

    // Trigger F: notify all TP that someone requested deletion
    const { rows: meta } = await client.query(`SELECT job_code, customer_name FROM jobs WHERE id = $1`, [req.params.id]);
    const { rows: requesterU } = await client.query(`SELECT name FROM users WHERE id = $1`, [req.user.id]);
    const requesterName = requesterU[0]?.name || 'Người dùng';
    const jc = meta[0]?.job_code || `#${req.params.id}`;
    const reasonText = reason || 'Không có lý do';
    const { rows: tps } = await client.query(`SELECT id FROM users WHERE role = 'truong_phong_log' AND disabled_at IS NULL`);
    for (const tp of tps) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'delete_request', 'Yêu cầu xóa job', $2, $3)`,
        [tp.id, `${requesterName} yêu cầu xóa job ${jc}. Lý do: ${reasonText}`, req.params.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =================================================================
// OPS per-task tick endpoints (2026-05-23, replaces POST /ops-done).
// Per-task model:
//   thong_quan task → ONE tick: cost_entered_at (no separate done — tk_status
//                     owns the digital "cleared" event).
//   doi_lenh   task → TWO ticks: completed flag (đổi lệnh xong) + cost.
// Precondition: when the job has TK (service_type tk/both), ALL ticks require
// tk_status ∈ {thong_quan, giai_phong, bao_quan}.
// Auth: 'ops' role + self-assignment (ja.ops_id === req.user.id), mirrors the
// retired POST /:id/ops-done auth.
// Each endpoint calls checkAndCompleteJob so the job auto-flips when all
// required OPS + CUS + truck conditions are met.
// =================================================================
// ops_hp (Step 1) — an OPS-only job's single free-text task. Has BOTH a done
// flag and a cost tick (like doi_lenh), so it appears in OPS_TASK_TYPES (cost
// endpoints) AND OPS_DONE_TASK_TYPES (done endpoints). thong_quan stays
// cost-only (no done flag — tk_status owns its "cleared" event).
const OPS_TASK_TYPES = ['thong_quan', 'doi_lenh', 'ops_hp'];
const OPS_DONE_TASK_TYPES = ['doi_lenh', 'ops_hp'];
const TK_TERMINAL_STATUSES = ['thong_quan', 'giai_phong', 'bao_quan'];

async function loadOpsTaskContext(client, jobId, taskType) {
  const { rows } = await client.query(
    `SELECT j.id, j.service_type, jt.tk_status, ja.ops_id,
            jot.id AS task_id, jot.completed, jot.cost_entered_at
       FROM jobs j
       LEFT JOIN job_tk jt           ON jt.job_id = j.id
       LEFT JOIN job_assignments ja  ON ja.job_id = j.id
       LEFT JOIN job_ops_task jot    ON jot.job_id = j.id AND jot.task_type = $2
      WHERE j.id = $1 AND j.deleted_at IS NULL`,
    [jobId, taskType]
  );
  return rows[0] || null;
}

function isOpsAuthorized(user, ctx) {
  if (!ctx) return { ok: false, code: 404, error: 'Không tìm thấy job' };
  if (user.role !== 'ops') return { ok: false, code: 403, error: 'Không có quyền' };
  if (ctx.ops_id !== user.id) return { ok: false, code: 403, error: 'Không có quyền' };
  return { ok: true };
}

function checkTkPrecondition(ctx) {
  // When the job has TK (tk/both), every OPS tick (thong_quan + doi_lenh)
  // requires tk_status terminal. Truck-only jobs are free of this gate.
  const hasTk = ctx.service_type === 'tk' || ctx.service_type === 'both';
  if (hasTk && !TK_TERMINAL_STATUSES.includes(ctx.tk_status)) {
    return { ok: false, code: 400, error: 'TK chưa thông quan / giải phóng / bảo quan' };
  }
  return { ok: true };
}

// PATCH /api/jobs/:id/ops-task/:taskType/done   — only valid for 'doi_lenh'
router.patch('/:id/ops-task/:taskType/done', requireAuth, async (req, res) => {
  const { id, taskType } = req.params;
  if (!OPS_DONE_TASK_TYPES.includes(taskType)) {
    return res.status(400).json({ error: 'Task này không có thao tác done' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadOpsTaskContext(client, id, taskType);
    const auth = isOpsAuthorized(req.user, ctx);
    if (!auth.ok) { await client.query('ROLLBACK'); return res.status(auth.code).json({ error: auth.error }); }
    if (!ctx.task_id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task không tồn tại cho job này' }); }
    const pre = checkTkPrecondition(ctx);
    if (!pre.ok) { await client.query('ROLLBACK'); return res.status(pre.code).json({ error: pre.error }); }
    if (ctx.completed) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Task đã được đánh dấu xong' }); }
    await client.query(
      `UPDATE job_ops_task SET completed = TRUE, completed_at = NOW() WHERE id = $1`,
      [ctx.task_id]
    );
    await recordHistory(client, id, req.user.id, `${taskType}_done`, 'false', 'true');
    const completed = await checkAndCompleteJob(client, id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/jobs/:id/ops-task/:taskType/done  — un-tick đổi lệnh done
router.delete('/:id/ops-task/:taskType/done', requireAuth, async (req, res) => {
  const { id, taskType } = req.params;
  if (!OPS_DONE_TASK_TYPES.includes(taskType)) {
    return res.status(400).json({ error: 'Task này không có thao tác done' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadOpsTaskContext(client, id, taskType);
    const auth = isOpsAuthorized(req.user, ctx);
    if (!auth.ok) { await client.query('ROLLBACK'); return res.status(auth.code).json({ error: auth.error }); }
    if (!ctx.task_id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task không tồn tại cho job này' }); }
    if (!ctx.completed) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Task chưa được đánh dấu xong' }); }
    await client.query(
      `UPDATE job_ops_task SET completed = FALSE, completed_at = NULL WHERE id = $1`,
      [ctx.task_id]
    );
    await recordHistory(client, id, req.user.id, `${taskType}_done`, 'true', 'false');
    // Per spec: do NOT auto-uncomplete the job here. If the job already flipped
    // to status='completed', leave it; checkAndCompleteJob early-returns on
    // already-completed jobs anyway.
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/jobs/:id/ops-task/:taskType/cost   — 'thong_quan' or 'doi_lenh'
router.patch('/:id/ops-task/:taskType/cost', requireAuth, async (req, res) => {
  const { id, taskType } = req.params;
  if (!OPS_TASK_TYPES.includes(taskType)) {
    return res.status(400).json({ error: 'Loại task không hợp lệ' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadOpsTaskContext(client, id, taskType);
    const auth = isOpsAuthorized(req.user, ctx);
    if (!auth.ok) { await client.query('ROLLBACK'); return res.status(auth.code).json({ error: auth.error }); }
    if (!ctx.task_id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task không tồn tại cho job này' }); }
    const pre = checkTkPrecondition(ctx);
    if (!pre.ok) { await client.query('ROLLBACK'); return res.status(pre.code).json({ error: pre.error }); }
    if (ctx.cost_entered_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cost đã được nhập' }); }
    await client.query(
      `UPDATE job_ops_task SET cost_entered_at = NOW(), cost_entered_by = $2 WHERE id = $1`,
      [ctx.task_id, req.user.id]
    );
    await recordHistory(client, id, req.user.id, `${taskType}_cost`, null, 'entered');
    const completed = await checkAndCompleteJob(client, id, req.user.id);
    await client.query('COMMIT');
    res.json({ ok: true, job_completed: completed });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/jobs/:id/ops-task/:taskType/cost  — un-tick cost
router.delete('/:id/ops-task/:taskType/cost', requireAuth, async (req, res) => {
  const { id, taskType } = req.params;
  if (!OPS_TASK_TYPES.includes(taskType)) {
    return res.status(400).json({ error: 'Loại task không hợp lệ' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadOpsTaskContext(client, id, taskType);
    const auth = isOpsAuthorized(req.user, ctx);
    if (!auth.ok) { await client.query('ROLLBACK'); return res.status(auth.code).json({ error: auth.error }); }
    if (!ctx.task_id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Task không tồn tại cho job này' }); }
    if (!ctx.cost_entered_at) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cost chưa được nhập' }); }
    await client.query(
      `UPDATE job_ops_task SET cost_entered_at = NULL, cost_entered_by = NULL WHERE id = $1`,
      [ctx.task_id]
    );
    await recordHistory(client, id, req.user.id, `${taskType}_cost`, 'entered', null);
    // Per spec: do NOT auto-uncomplete the job.
    await client.query('COMMIT');
    res.json({ ok: true });
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
      SELECT j.id, j.han_lenh, j.ops_partner, j.import_export,
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
    if (!j.han_lenh)    missing.push(j.import_export === 'import' ? 'Hạn lệnh' : 'Cutoff time');
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

// ─── M2 — Sales revenue-tick endpoints ─────────────────────────────────────
// Sales marks a LOG-completed job as "đã nhập thu" (revenue entered into the
// external accounting software). Both endpoints share the same validation
// chain: role=sales → job exists + alive → own job → tick-state precondition.
// Each runs in its own transaction; on any failure ROLLBACK + JSON error.
//
// Validation order (matches M2 spec):
//   1. req.user.role === 'sales'         → 403
//   2. job exists AND deleted_at IS NULL → 404
//   3. job.sales_id === req.user.id      → 403
//   4. job.completed_at IS NOT NULL      → 400  (PATCH only — LOG must finish first)
//   5. revenue_entered_at state          → 400  (already-ticked for PATCH, not-ticked for DELETE)
//
// Response shape: 200 with the bare jobs row (RETURNING *). Frontend should
// invalidate the React Query cache to refetch the denormalized GET /api/jobs
// shape (same pattern as PATCH /:id/tk, PATCH /:id/truck/complete, etc.).
async function fetchJobForRevenue(client, id) {
  const { rows } = await client.query(
    `SELECT id, sales_id, completed_at, revenue_entered_at, deleted_at
       FROM jobs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

router.patch('/:id/revenue-tick', requireAuth, async (req, res) => {
  if (req.user.role !== 'sales') {
    return res.status(403).json({ error: 'Chỉ Sales mới có thể nhập thu' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForRevenue(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (job.sales_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Job này không thuộc về bạn' });
    }
    if (!job.completed_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa hoàn thành' });
    }
    if (job.revenue_entered_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job đã được nhập thu trước đó' });
    }
    const { rows } = await client.query(
      `UPDATE jobs
          SET revenue_entered_at = NOW(),
              revenue_entered_by = $1,
              updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING *`,
      [req.user.id, req.params.id]
    );
    await recordHistory(
      client, req.params.id, req.user.id,
      'revenue_entered_at', null, rows[0].revenue_entered_at?.toISOString?.() || 'NOW()'
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.delete('/:id/revenue-tick', requireAuth, async (req, res) => {
  if (req.user.role !== 'sales') {
    return res.status(403).json({ error: 'Chỉ Sales mới có thể bỏ tick' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForRevenue(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (job.sales_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Job này không thuộc về bạn' });
    }
    if (!job.revenue_entered_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa được nhập thu' });
    }
    const prevTs = job.revenue_entered_at?.toISOString?.() || String(job.revenue_entered_at);
    const { rows } = await client.query(
      `UPDATE jobs
          SET revenue_entered_at = NULL,
              revenue_entered_by = NULL,
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [req.params.id]
    );
    await recordHistory(
      client, req.params.id, req.user.id,
      'revenue_entered_at', prevTs, null
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── BBBG (Biên Bản Bàn Giao) — generate-on-demand, no persistence ──────────
function isBbbgRole(req) {
  return req.user.role === 'dieu_do' || req.user.role === 'truong_phong_log';
}

// GET /api/jobs/:id/bbbg-data — auto-fill payload for the BBBG modal.
// Optional ?booking_id=X — when supplied, prefill from THAT booking + restrict
// the container list to that booking's containers. Validates ownership (booking
// must belong to this job).  Otherwise: earliest active booking, all containers
// of the job (legacy behavior).
router.get('/:id/bbbg-data', requireAuth, async (req, res) => {
  if (!isBbbgRole(req)) return res.status(403).json({ error: 'Không có quyền' });
  const bookingId = req.query.booking_id ? parseInt(req.query.booking_id, 10) : null;
  if (req.query.booking_id && !Number.isFinite(bookingId)) {
    return res.status(400).json({ error: 'booking_id không hợp lệ' });
  }
  try {
    // Phase 4.1: when booking_id is supplied, prefer that specific booking
    // (validate it belongs to this job). Otherwise fall back to earliest.
    const tbLateral = bookingId
      ? `LEFT JOIN LATERAL (
            SELECT delivery_location, transport_name, vehicle_number, planned_datetime, id
              FROM truck_bookings
             WHERE id = ${bookingId} AND job_id = j.id AND deleted_at IS NULL
          ) tb ON true`
      : `LEFT JOIN LATERAL (
            SELECT delivery_location, transport_name, vehicle_number, planned_datetime, id
              FROM truck_bookings
             WHERE job_id = j.id AND deleted_at IS NULL
             ORDER BY planned_datetime ASC NULLS LAST, id ASC
             LIMIT 1
          ) tb ON true`;
    const { rows: jobRows } = await db.query(`
      SELECT j.id, j.job_code, j.customer_id, j.customer_name, j.customer_address,
             j.customer_tax_code, j.cargo_type, j.tons, j.kg, j.so_kien, j.cbm,
             j.hbl_no, j.mbl_no, j.si_number,
             tb.delivery_location AS truck_delivery, tb.transport_name,
             tb.vehicle_number, tb.planned_datetime, tb.id AS booking_id,
             jt.delivery_location AS tk_delivery,
             cp.company_full_name, cp.tax_code AS pipeline_tax_code, cp.invoice_address
        FROM jobs j
        ${tbLateral}
        LEFT JOIN job_tk    jt  ON jt.job_id  = j.id
        LEFT JOIN LATERAL (
          SELECT company_full_name, tax_code, invoice_address
          FROM customer_pipeline
          WHERE LOWER(company_name) = LOWER(j.customer_name)
            AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1
        ) cp ON true
       WHERE j.id = $1 AND j.deleted_at IS NULL
    `, [req.params.id]);
    if (!jobRows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });
    const job = jobRows[0];

    // If caller requested a specific booking but it doesn't belong to this job,
    // tb.id will be NULL — surface a 404 rather than silently fall back.
    if (bookingId && !job.booking_id) {
      return res.status(404).json({ error: 'Booking không thuộc job này hoặc đã bị xóa' });
    }

    // Container list: scoped to the specific booking when one is targeted,
    // otherwise all containers of the job.
    const { rows: containers } = bookingId
      ? await db.query(
          `SELECT jc.id, jc.cont_number, jc.cont_type, jc.seal_number
             FROM job_containers jc
             JOIN truck_booking_containers tbc ON tbc.container_id = jc.id
            WHERE jc.job_id = $1 AND tbc.booking_id = $2
            ORDER BY jc.id`,
          [req.params.id, bookingId]
        )
      : await db.query(
          `SELECT id, cont_number, cont_type, seal_number FROM job_containers WHERE job_id = $1 ORDER BY id`,
          [req.params.id]
        );

    // Past delivery locations for this customer (Phase 4: prefer truck_bookings;
    // legacy job_truck UNION'd for any data created before Phase 2). Same shape
    // as GET /:id/past-delivery-locations — kept inline here to avoid coupling.
    const { rows: pastLocations } = await db.query(`
      SELECT loc AS delivery_location, MAX(used) AS last_used FROM (
        SELECT tb.delivery_location AS loc, MAX(tb.created_at) AS used
          FROM truck_bookings tb
          JOIN jobs j ON j.id = tb.job_id
         WHERE LOWER(j.customer_name) = LOWER($1) AND j.id <> $2
           AND tb.deleted_at IS NULL
           AND tb.delivery_location IS NOT NULL AND tb.delivery_location <> ''
         GROUP BY tb.delivery_location
        UNION ALL
        SELECT jtr.delivery_location AS loc, MAX(j.created_at) AS used
          FROM jobs j
          JOIN job_truck jtr ON jtr.job_id = j.id
         WHERE LOWER(j.customer_name) = LOWER($1) AND j.id <> $2
           AND j.deleted_at IS NULL
           AND jtr.delivery_location IS NOT NULL AND jtr.delivery_location <> ''
         GROUP BY jtr.delivery_location
      ) u
      GROUP BY loc
      ORDER BY last_used DESC
      LIMIT 5
    `, [job.customer_name, req.params.id]);

    const isFcl = (job.cargo_type || 'fcl') === 'fcl';
    const weightValue = isFcl ? job.tons : job.kg;
    const weightUnit  = isFcl ? 'TONS'   : 'KGS';

    res.json({
      job_id: job.id,
      job_code: job.job_code || `#${job.id}`,
      consignee: job.customer_name || '',
      delivery_address: job.customer_address || '',
      hbl_no: job.hbl_no || '',
      mbl_no: job.mbl_no || '',
      cargo_type: job.cargo_type || 'fcl',
      weight_value: weightValue != null ? Number(weightValue) : null,
      weight_unit: weightUnit,
      so_kien: job.so_kien != null ? Number(job.so_kien) : null,
      cbm: job.cbm != null ? Number(job.cbm) : null,
      containers,
      suggested_delivery_location: job.truck_delivery || job.tk_delivery || (pastLocations[0]?.delivery_location || ''),
      past_delivery_locations: pastLocations.map(r => r.delivery_location),
      // Invoice info from customer_pipeline (L15) — empty strings if no pipeline match.
      invoice_company_name: job.company_full_name || '',
      invoice_tax_code:     job.pipeline_tax_code || '',
      invoice_address:      job.invoice_address   || '',
    });
  } catch (err) {
    console.error('GET /bbbg-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/bbbg-pdf — accepts form payload, streams PDF binary
router.post('/:id/bbbg-pdf', requireAuth, async (req, res) => {
  if (!isBbbgRole(req)) return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows: jobRows } = await db.query(
      `SELECT id, job_code, customer_name FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!jobRows[0]) return res.status(404).json({ error: 'Không tìm thấy job' });

    const data = req.body || {};
    const invoiceCompanyName = (data.invoice_company_name || '').toString().trim();
    const invoiceTaxCode     = (data.invoice_tax_code     || '').toString().trim();
    const invoiceAddress     = (data.invoice_address      || '').toString().trim();

    // Save-as-default: persist to ALL matching customer_pipeline rows (one customer
    // can be in multiple pipelines per L14). Failure here is non-fatal — PDF still
    // generates, we just log a warning. Must run BEFORE we set headers/stream the PDF.
    if (data.save_as_default === true) {
      try {
        const r = await db.query(
          `UPDATE customer_pipeline
              SET company_full_name = $1,
                  tax_code          = $2,
                  invoice_address   = $3,
                  updated_at        = NOW()
            WHERE LOWER(company_name) = LOWER($4)
            RETURNING id`,
          [invoiceCompanyName, invoiceTaxCode, invoiceAddress, jobRows[0].customer_name || '']
        );
        if (r.rows.length === 0) {
          console.warn('[bbbg-pdf] save_as_default: no pipeline rows matched customer_name=' +
            JSON.stringify(jobRows[0].customer_name));
        }
      } catch (saveErr) {
        console.warn('[bbbg-pdf] save_as_default failed (PDF still generated):', saveErr.message);
      }
    }

    const safeJobCode = (data.job_code || jobRows[0].job_code || `${jobRows[0].id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const datePart = new Date().toISOString().slice(0, 10);
    const filename = `BBBG_${safeJobCode}_${datePart}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const pdf = buildBbbgPdf({
      job_code:         data.job_code         || jobRows[0].job_code || `#${jobRows[0].id}`,
      today_date:       data.today_date       || new Date().toLocaleDateString('vi-VN'),
      consignee:        data.consignee        || '',
      shipper:          data.shipper          || '',
      vessel:           data.vessel           || '',
      voy:              data.voy              || '',
      from_:            data.from_            || data.from || '',
      terminal:         data.terminal         || '',
      hbl_no:           data.hbl_no           || '',
      mbl_no:           data.mbl_no           || '',
      description:      data.description      || 'AS PER BILL',
      containers:       Array.isArray(data.containers) ? data.containers : [],
      weight_value:     data.weight_value,
      weight_unit:      data.weight_unit      || '',
      so_kien:          data.so_kien,
      delivery_company: data.delivery_company || '',
      delivery_address: data.delivery_address || '',
      recipient_name:   data.recipient_name   || '',
      delivery_time:    data.delivery_time    || '',
      delivery_date:    data.delivery_date    || '',
      remarks:          data.remarks          || '',
      creator_name:     req.user.name         || '',
      // Invoice info — pdf service skips the section if all 3 are empty.
      invoice_company_name: invoiceCompanyName,
      invoice_tax_code:     invoiceTaxCode,
      invoice_address:      invoiceAddress,
    });
    pdf.pipe(res);
  } catch (err) {
    console.error('POST /bbbg-pdf error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Truck-booking helpers — job-scoped GETs (Phase 2) ─────────────────────────
// Lives under /api/jobs/:id/... per spec URL, but the bookings themselves are
// CRUDed via /api/truck-bookings (see routes/truck-bookings.js).

// GET /api/jobs/:id/truck-booking-status
// Phase 5 CP4.5 — returns one of 8 strings:
//   'chua_dat_kh' | 'dat_kh_1_phan' | 'du_kh_chua_chot_vt' |
//   'du_kh_chot_vt_1_phan' | 'du_vt_chua_co_xe' | 'du_vt_co_xe_1_phan' |
//   'du_xe_cho_giao' | 'hoan_thanh'.
// Logic lives in the plpgsql function so the four dashboards stay aligned
// on a single source of truth (L20). Any authenticated user can read.
router.get('/:id/truck-booking-status', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  try {
    const { rows } = await db.query(
      `SELECT get_truck_booking_status($1) AS status`, [id]
    );
    res.json({ status: rows[0]?.status || 'chua_dat_kh' });
  } catch (err) {
    console.error('GET /:id/truck-booking-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id/available-containers
// Containers belonging to this job that are NOT yet in any LIVE booking.
// Consumed by the DD booking-create modal AND by PlanDeliveryModal (the
// shared "Đặt kế hoạch xe" surface used by CUS/DieuDo/TP). Guard widened to
// PLAN_ROLES — reading the container list is strictly less privileged than
// POST /api/truck-bookings/batch, which CUS already calls.
router.get('/:id/available-containers', requireAuth, async (req, res) => {
  if (!PLAN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  try {
    const { rows } = await db.query(`
      SELECT jc.id, jc.cont_number, jc.cont_type, jc.seal_number
        FROM job_containers jc
       WHERE jc.job_id = $1
         AND jc.id NOT IN (
           SELECT tbc.container_id
             FROM truck_booking_containers tbc
             JOIN truck_bookings tb ON tb.id = tbc.booking_id
            WHERE tb.deleted_at IS NULL
         )
       ORDER BY jc.id
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /:id/available-containers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id/past-delivery-locations
// Top 5 distinct delivery_location strings used in prior bookings for the
// same customer (by name match — customer_id often NULL on legacy rows).
// Powers the autocomplete in the BookingModal create form. Sources from
// truck_bookings (new) with a UNION fallback to legacy job_truck so any
// pre-Phase-2 data still surfaces during the transition window.
router.get('/:id/past-delivery-locations', requireAuth, async (req, res) => {
  // PLAN_ROLES — PlanDeliveryModal's delivery-location autocomplete is shared
  // with CUS (L10 broadcast: same fix as available-containers above).
  if (!PLAN_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  try {
    const { rows: jr } = await db.query(
      `SELECT customer_name FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [id]
    );
    if (!jr[0]) return res.json([]);
    const name = jr[0].customer_name;
    const { rows } = await db.query(`
      SELECT loc, MAX(used) AS last_used FROM (
        SELECT tb.delivery_location AS loc, MAX(tb.created_at) AS used
          FROM truck_bookings tb
          JOIN jobs j ON j.id = tb.job_id
         WHERE LOWER(j.customer_name) = LOWER($1)
           AND tb.deleted_at IS NULL
           AND tb.delivery_location IS NOT NULL
           AND tb.delivery_location <> ''
           AND j.id <> $2
         GROUP BY tb.delivery_location
        UNION ALL
        SELECT jtr.delivery_location AS loc, MAX(j.created_at) AS used
          FROM jobs j
          JOIN job_truck jtr ON jtr.job_id = j.id
         WHERE LOWER(j.customer_name) = LOWER($1)
           AND j.deleted_at IS NULL
           AND jtr.delivery_location IS NOT NULL
           AND jtr.delivery_location <> ''
           AND j.id <> $2
         GROUP BY jtr.delivery_location
      ) u
      GROUP BY loc
      ORDER BY last_used DESC
      LIMIT 5
    `, [name, id]);
    res.json(rows.map(r => r.loc));
  } catch (err) {
    console.error('GET /:id/past-delivery-locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
