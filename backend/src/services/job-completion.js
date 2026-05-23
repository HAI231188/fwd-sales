// Shared helper: decide whether a job should auto-flip to status='completed'
// based on its sub-task state. Called from multiple route files (jobs.js,
// truck-bookings.js, …) — kept in one place per L19 (single source of truth
// for derived status logic).
//
// Phase 5 CP4.5 update: truck side is now sourced from the new 8-status
// get_truck_booking_status() — `hoan_thanh` means every alive booking has
// actual_datetime IS NOT NULL (the new "delivery actually happened" signal).
// Previous `da_giao_xong` was a vehicle-assignment milestone, NOT a delivery
// signal, and incorrectly triggered job completion before delivery occurred.
// jobs.completed_at is now stamped with NOW() at the same time as the status
// flip.

async function checkAndCompleteJob(client, jobId, changedBy, recordHistory) {
  const { rows } = await client.query(`
    SELECT j.id, j.status, j.service_type, j.destination,
           jt.completed_at    AS tk_completed_at,
           jt.cost_entered_at AS tk_cost_entered_at,
           get_truck_booking_status(j.id) AS truck_booking_status,
           ja.ops_id,
           -- Per-task OPS state (2026-05-23). NULL task_id → task not required.
           (SELECT id              FROM job_ops_task
              WHERE job_id = j.id AND task_type = 'thong_quan') AS tq_task_id,
           (SELECT cost_entered_at FROM job_ops_task
              WHERE job_id = j.id AND task_type = 'thong_quan') AS tq_cost_entered_at,
           (SELECT id              FROM job_ops_task
              WHERE job_id = j.id AND task_type = 'doi_lenh')   AS dl_task_id,
           (SELECT completed       FROM job_ops_task
              WHERE job_id = j.id AND task_type = 'doi_lenh')   AS dl_completed,
           (SELECT cost_entered_at FROM job_ops_task
              WHERE job_id = j.id AND task_type = 'doi_lenh')   AS dl_cost_entered_at
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
  const truckDone = j.truck_booking_status === 'hoan_thanh';

  // Per-task OPS state (2026-05-23). If a task row doesn't exist for this job,
  // the task is "not required" → treated as satisfied. This makes the gate
  // degrade gracefully for non-HP jobs (no auto-task rows) and any job that
  // legitimately doesn't need an OPS step.
  //   thong_quan done = cost_entered_at ticked (no separate done — tk_status
  //                     already represents the digital "cleared" event)
  //   doi_lenh   done = completed flag AND cost_entered_at ticked
  const tqRequired = j.tq_task_id !== null;
  const tqDone     = !tqRequired || !!j.tq_cost_entered_at;
  const dlRequired = j.dl_task_id !== null;
  const dlDone     = !dlRequired || (!!j.dl_completed && !!j.dl_cost_entered_at);

  let ready = false;
  if (j.service_type === 'tk')         ready = tkDone;
  else if (j.service_type === 'truck') ready = truckDone;
  else if (j.service_type === 'both')  ready = tkDone && truckDone;

  // Per-task OPS gate (replaces the old `destination='hai_phong' && truck/both`
  // gate which incorrectly excluded HP tk-only jobs that DID get OPS assigned —
  // see THẠCH HIỂN jobs 25/26 audit). Task-row presence is the source of truth:
  //   - HP auto-task rule places rows for tk(+thong_quan,+doi_lenh) /
  //     truck(+doi_lenh) / both(+thong_quan,+doi_lenh).
  //   - For non-HP jobs no task rows exist → tqRequired=false, dlRequired=false
  //     → gate passes trivially → non-HP behavior unchanged.
  if (ready) ready = tqDone && dlDone;

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

module.exports = { checkAndCompleteJob };
