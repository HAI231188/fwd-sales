// Single source of truth for role-based access-control arrays.
//
// Previously these arrays were duplicated across route files (LOG_ROLES in
// jobs.js + customers.js + search.js; PLAN_ROLES in jobs.js + truck-bookings.js;
// WRITE_ROLES + canWrite in transport.js + truck-bookings.js). Adding a new role
// meant editing several places, and drift made ACL silently inconsistent.
// All consumers now import from here. The role tokens match the role enum in
// db/schema.sql.
//
// NOTE: ordering within each array is irrelevant — every consumer uses these
// via Array.includes() or SQL `= ANY($1)`, both order-independent.

// LOG team — Trưởng phòng LOG + Điều độ + CUS (+ variants) + OPS.
const LOG_ROLES = ['truong_phong_log', 'dieu_do', 'cus', 'cus1', 'cus2', 'cus3', 'ops'];

// CUS roles (customer-service desk + the three auto-assignable variants).
const CUS_ROLES = ['cus', 'cus1', 'cus2', 'cus3'];

// Auto-assignable CUS variants only (cus1/cus2/cus3) — used by AI assignment.
const AUTO_CUS_ROLES = ['cus1', 'cus2', 'cus3'];

// "Đặt kế hoạch xe" surface roles — PlanDeliveryModal is shared by CUS / DieuDo
// / TP; its read endpoints (available-containers, past-delivery-locations,
// past-receivers) must allow this whole set. `ops` is intentionally excluded
// (no plan-write role).
//
// `sales` REMOVED 2026-09-05 (hạn lệnh guard): a plan-save can now be REFUSED
// when the delivery date falls after the job's hạn lệnh, and the only way to
// clear it is to edit jobs.han_lenh — which canEditJob (services/job-access.js)
// grants to TP/lead, the assigned CUS, the assigned DD and the owner-sales
// only. A sales user is not necessarily the owner of the job they were
// planning, so they could be blocked with no way to unblock themselves.
// Removal is safe on the evidence: ZERO truck_bookings have EVER been created
// by a role='sales' user (all-time creator breakdown — dieu_do 390, cus1 75,
// cus3 16, truong_phong_log 4, cus2 1, sales 0), and no sales-reachable page
// mounts PlanDeliveryModal (it opens only from LogDashboardCus /
// LogDashboardDieuDo / LogDashboardTP).
const PLAN_ROLES = ['dieu_do', 'truong_phong_log', 'lead',
                    'cus', 'cus1', 'cus2', 'cus3'];

// Carrier-side write roles for transport companies + truck-booking CRUD.
const WRITE_ROLES = ['dieu_do', 'truong_phong_log'];

// Single-role groups (provided as the canonical source so future call sites
// reference these instead of bare string literals).
const SALES_ROLES = ['sales'];
const LEAD_ROLES = ['lead'];
const KT_ROLES = ['ke_toan'];

// App-wide administrator (2026-06-11) — manages users across every department,
// distinct from truong_phong_log. Only admins reach /api/admin/*.
const ADMIN_ROLES = ['admin'];

// Full set of assignable role values — mirrors users_role_check in schema.sql.
// The admin user-management endpoints validate create/change-role against this.
const ALL_ROLES = ['sales', 'lead', 'truong_phong_log', 'dieu_do',
  'cus', 'cus1', 'cus2', 'cus3', 'ops', 'ke_toan', 'admin'];

// Shared predicate — identical in transport.js and truck-bookings.js before
// this refactor. Returns true when the request's user holds a WRITE_ROLES role.
function canWrite(req) { return WRITE_ROLES.includes(req.user?.role); }

module.exports = {
  LOG_ROLES,
  CUS_ROLES,
  AUTO_CUS_ROLES,
  PLAN_ROLES,
  WRITE_ROLES,
  SALES_ROLES,
  LEAD_ROLES,
  KT_ROLES,
  ADMIN_ROLES,
  ALL_ROLES,
  canWrite,
};
