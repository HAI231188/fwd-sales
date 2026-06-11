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
// / TP / Sales; its read endpoints (available-containers, past-delivery-locations)
// must allow this whole set. `ops` is intentionally excluded (no plan-write role).
const PLAN_ROLES = ['dieu_do', 'truong_phong_log', 'lead', 'sales',
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
