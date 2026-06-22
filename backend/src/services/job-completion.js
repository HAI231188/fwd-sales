// Shared helpers for job completion logic. Single source of truth per L19.
// Called from multiple routes (jobs.js, truck-bookings.js).
//
// Two completion paths exist for production-shaped jobs:
//
//   AUTO (service_type='tk' only):
//     CUS/OPS tick endpoints call `checkAndCompleteJob`, which derives ready
//     from tk_done + OPS task state. Stamps jobs.completed_at = NOW() and
//     flips status to 'completed'.
//
//   MANUAL via PUT /api/jobs/:id (service_type IN ('truck','both')):
//     DD enters "TH ngày giờ" → PUT body {completed_at: <ts>}. That route
//     stamps the body timestamp (honoring DD's actual delivery time) AFTER
//     running its own guards including `checkOpsTasksDone` (2026-05-23 fix
//     for the OPS-gate bypass on truck/both HP jobs).
//
// REVIVED for truck/both (2026-05-24 DD-split):
//   Previously truckDone was `truck_booking_status === 'hoan_thanh'` which was
//   structurally false for pending jobs (hoan_thanh ⇐ jobs.completed_at set,
//   which we were trying to set — circular). Now the plpgsql function returns
//   the new state 'dd_da_xong' when dd_completed_at IS NOT NULL AND
//   completed_at IS NULL → truckDone reaches true via the dd_da_xong branch
//   while the job is still pending. checkAndCompleteJob now handles all 3
//   service_types (tk/truck/both) under a single set of gates.
//
//   Companion entry point: PUT /api/jobs/:id sets dd_completed_at then calls
//   this function (jobs.js completed_at branch). Either DD stamping their
//   "TH ngày giờ" OR CUS/OPS finishing the last tick can be the trigger that
//   flips jobs.completed_at + status='completed'.

// Per-task OPS done check (2026-05-23). Re-used by both completion paths:
//   - checkAndCompleteJob (the auto-tk path)
//   - PUT /api/jobs/:id completed_at guard (the DD truck/both path)
//
// Returns { ready: bool, missing: string[] }. `missing` contains Vietnamese
// user-facing messages — empty when ready=true.
//
// Semantics (mirror auto-task INSERT rule for HP jobs):
//   thong_quan done = cost_entered_at ticked (no separate "done" flag —
//                     tk_status already represents the digital "cleared" event)
//   doi_lenh   done = completed=TRUE AND cost_entered_at ticked
//   Task row absence ⇒ task not required ⇒ treated as satisfied. This makes
//   the helper degrade gracefully for non-HP jobs (no auto-task rows) and
//   ad-hoc TP-created rows that don't follow the standard task_type enum.
async function checkOpsTasksDone(client, jobId) {
  const { rows: [r] } = await client.query(`
    SELECT
      (SELECT id              FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'thong_quan') AS tq_task_id,
      (SELECT cost_entered_at FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'thong_quan') AS tq_cost_entered_at,
      (SELECT id              FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'doi_lenh')   AS dl_task_id,
      (SELECT completed       FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'doi_lenh')   AS dl_completed,
      (SELECT cost_entered_at FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'doi_lenh')   AS dl_cost_entered_at,
      -- ops_hp (Step 1) — the single free-text OPS task on an OPS-only job.
      -- Done = completed flag AND cost ticked, same shape as doi_lenh.
      (SELECT id              FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'ops_hp')     AS oh_task_id,
      (SELECT completed       FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'ops_hp')     AS oh_completed,
      (SELECT cost_entered_at FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'ops_hp')     AS oh_cost_entered_at,
      -- viec_khac (P1 2026-06-22) — TP-added free-text task. Two-tick like
      -- doi_lenh (done + cost). EXISTS-tolerant: vk_task_id is null for every
      -- job without one (i.e. all jobs until P3 ships the creation UI), so this
      -- gate is satisfied by default and changes nothing for current jobs.
      (SELECT id              FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'viec_khac')  AS vk_task_id,
      (SELECT completed       FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'viec_khac')  AS vk_completed,
      (SELECT cost_entered_at FROM job_ops_task
         WHERE job_id = $1 AND task_type = 'viec_khac')  AS vk_cost_entered_at
  `, [jobId]);
  const tqRequired = r.tq_task_id !== null;
  const tqDone     = !tqRequired || !!r.tq_cost_entered_at;
  const dlRequired = r.dl_task_id !== null;
  const dlDone     = !dlRequired || (!!r.dl_completed && !!r.dl_cost_entered_at);
  // oh_task_id is null for every non-ops_hp job → ohRequired false → ohDone true,
  // so normal tk/truck/both jobs are completely unaffected by this gate.
  const ohRequired = r.oh_task_id !== null;
  const ohDone     = !ohRequired || (!!r.oh_completed && !!r.oh_cost_entered_at);
  // viec_khac (P1) — same two-tick shape as doi_lenh; vk_task_id null ⇒ not
  // required ⇒ done, so jobs without a viec_khac task are unaffected.
  const vkRequired = r.vk_task_id !== null;
  const vkDone     = !vkRequired || (!!r.vk_completed && !!r.vk_cost_entered_at);
  const missing = [];
  if (!tqDone) missing.push('OPS chưa nhập cost thông quan');
  if (!dlDone) {
    if (!r.dl_completed)       missing.push('OPS chưa đổi lệnh xong');
    if (!r.dl_cost_entered_at) missing.push('OPS chưa nhập cost đổi lệnh');
  }
  if (!ohDone) {
    if (!r.oh_completed)       missing.push('OPS chưa hoàn thành việc');
    if (!r.oh_cost_entered_at) missing.push('OPS chưa nhập cost');
  }
  if (!vkDone) {
    if (!r.vk_completed)       missing.push('OPS chưa hoàn thành việc khác');
    if (!r.vk_cost_entered_at) missing.push('OPS chưa nhập cost việc khác');
  }
  return { ready: tqDone && dlDone && ohDone && vkDone, missing };
}

async function checkAndCompleteJob(client, jobId, changedBy, recordHistory) {
  const { rows } = await client.query(`
    SELECT j.id, j.status, j.service_type, j.destination,
           jt.completed_at    AS tk_completed_at,
           jt.cost_entered_at AS tk_cost_entered_at,
           get_truck_booking_status(j.id) AS truck_booking_status,
           ja.ops_id
    FROM jobs j
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    LEFT JOIN job_assignments ja ON ja.job_id = j.id
    WHERE j.id = $1 AND j.deleted_at IS NULL
  `, [jobId]);
  if (!rows[0]) return false;
  const j = rows[0];
  if (j.status === 'completed') return false;

  // tkDone (2026-05-21): requires BOTH terminal tk_status (which stamps
  // job_tk.completed_at) AND CUS's "Nhập cost" tick (job_tk.cost_entered_at).
  // Affects service_type='tk' and 'both'; 'truck' branch doesn't use tkDone.
  const tkDone    = !!j.tk_completed_at && !!j.tk_cost_entered_at;
  // 2026-05-24 DD-split: truckDone now reads via the new dd_da_xong state
  // (DD has stamped dd_completed_at) OR hoan_thanh (job already completed).
  // No longer circular — reachable for pending truck/both jobs.
  const truckDone = ['dd_da_xong', 'hoan_thanh'].includes(j.truck_booking_status);

  let ready = false;
  if (j.service_type === 'tk')         ready = tkDone;
  else if (j.service_type === 'truck') ready = truckDone;
  else if (j.service_type === 'both')  ready = tkDone && truckDone;
  // ops_hp (Step 1) — OPS-only job. No tk/truck/DD involvement; the sole gate
  // is the ops_hp task (done + cost), enforced by the checkOpsTasksDone block
  // below. Set ready=true here so that gate is the single deciding factor.
  else if (j.service_type === 'ops_hp') ready = true;

  // OPS per-task gate (delegates to checkOpsTasksDone for single-source logic).
  // Only effective for service_type='tk' here — the truck/both ready expressions
  // above already return false due to truckDone circularity, so this gate is
  // unreachable for those job shapes. PUT /:id enforces the same gate for
  // truck/both (where the actual completion happens).
  if (ready) {
    const opsCheck = await checkOpsTasksDone(client, jobId);
    if (!opsCheck.ready) ready = false;
  }

  // Non-HP manual OPS assignment follow-up: the 4 manual TP-assign endpoints
  // (POST /:id/assign, /:id/manual-assign, /:id/ops-task, /:id/reassign-ops)
  // can set ja.ops_id without seeding job_ops_task rows for non-HP destinations.
  // Such jobs will pass this gate without waiting for OPS. The clean fix is to
  // extend those endpoints to seed task rows whenever ops_id is set; deferred
  // to a follow-up to keep this change focused. Production currently has 0
  // such jobs (audit query confirmed).

  if (!ready) return false;

  await client.query(
    `UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [jobId]
  );
  if (recordHistory) {
    await recordHistory(client, jobId, changedBy, 'status', 'pending', 'completed');
  }
  return true;
}

module.exports = { checkAndCompleteJob, checkOpsTasksDone };
