// Job-level authorization — single source of truth for who may VIEW or EDIT a
// job. Used by GET /api/jobs/:id, PUT /api/jobs/:id, and PATCH /api/jobs/:id/tk
// so the three surfaces never drift (per L30 — shared logic lives in services/,
// never re-copied per handler).
//
// ACCESS MODEL (owner-decided, ĐỢT 1 security fix):
//
//   VIEW — broad, by DEPARTMENT (a whole dept sees each other's jobs):
//     sales        → only own jobs            (job.sales_id === user.id)
//     cus*         → any job with a TK part   (service_type ∈ {tk, both})
//     dieu_do      → any job with a truck part (service_type ∈ {truck, both})
//     ops          → any HP job               (destination === 'hai_phong')
//     truong_phong_log / lead / ke_toan → everything
//     (no field-level masking — if you can see the job, you see cost + customer)
//
//   EDIT — strict, by ASSIGNMENT (only the assigned user for that dept + TP/lead):
//     sales        → own job   (job.sales_id === user.id)
//     cus*         → assigned   (assignment.cus_id === user.id)
//     dieu_do      → assigned   (assignment.dieu_do_id === user.id)
//     ops          → blocked from PUT /:id entirely (handled in the route)
//     truong_phong_log / lead → anything
//     Only TP/lead may change ownership (sales_id) or force status (anti job-stealing).
//
// `assignment` is a job_assignments row { cus_id, ops_id, dieu_do_id } or null.
// For VIEW it is an optional safety widening (a personally-assigned user can
// always see their job even if the dept rule wouldn't otherwise match, e.g. a
// legacy job with a NULL destination). It never grants more than the dept rule
// where the dept rule already allows.

const { CUS_ROLES } = require('../constants/roles');

const TP = 'truong_phong_log';
const LEAD = 'lead';
const KE_TOAN = 'ke_toan';

function isTpLead(role) {
  return role === TP || role === LEAD;
}

// VIEW — see the dept rules above. `assignment` optional (null-safe).
function canViewJob(user, job, assignment = null) {
  if (!user || !job) return false;
  const { role, id } = user;
  if (isTpLead(role) || role === KE_TOAN) return true;
  if (role === 'sales') return job.sales_id === id;
  if (CUS_ROLES.includes(role)) {
    return ['tk', 'both'].includes(job.service_type) || (!!assignment && assignment.cus_id === id);
  }
  if (role === 'dieu_do') {
    return ['truck', 'both'].includes(job.service_type) || (!!assignment && assignment.dieu_do_id === id);
  }
  if (role === 'ops') {
    return job.destination === 'hai_phong' || (!!assignment && assignment.ops_id === id);
  }
  return false;
}

// EDIT — strict by assignment. `assignment` is a job_assignments row or null.
function canEditJob(user, job, assignment) {
  if (!user || !job) return false;
  const { role, id } = user;
  if (isTpLead(role)) return true;
  if (role === 'sales') return job.sales_id === id;
  if (CUS_ROLES.includes(role)) return !!assignment && assignment.cus_id === id;
  if (role === 'dieu_do') return !!assignment && assignment.dieu_do_id === id;
  // ops is blocked from PUT /:id in the route; every other role denied here.
  return false;
}

// TK edit (PATCH /:id/tk) — assigned CUS + TP/lead. OPS is handled separately in
// the route (status-only narrowing), so it is NOT granted here.
function canEditJobTk(user, assignment) {
  if (!user) return false;
  const { role, id } = user;
  if (isTpLead(role)) return true;
  if (CUS_ROLES.includes(role)) return !!assignment && assignment.cus_id === id;
  return false;
}

// Only TP/lead may reassign ownership (sales_id) or force status.
function canReassignOwnerOrStatus(user) {
  return !!user && isTpLead(user.role);
}

module.exports = {
  canViewJob,
  canEditJob,
  canEditJobTk,
  canReassignOwnerOrStatus,
  isTpLead,
};
