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
           COALESCE(ja.ops_done, FALSE) AS ops_done
    FROM jobs j
    LEFT JOIN job_tk jt ON jt.job_id = j.id
    LEFT JOIN job_assignments ja ON ja.job_id = j.id
    WHERE j.id = $1 AND j.deleted_at IS NULL
  `, [jobId]);
  if (!rows[0]) return false;
  const j = rows[0];
  if (j.status === 'completed') return false;

  // tkDone (2026-05-21): now requires BOTH terminal tk_status (which stamps
  // job_tk.completed_at) AND CUS's "Nhập cost" tick (job_tk.cost_entered_at).
  // Cost-tick order is independent of tk_status (mirrors M2 revenue-tick).
  // Affects service_type='tk' and 'both'; 'truck' branch doesn't use tkDone.
  const tkDone    = !!j.tk_completed_at && !!j.tk_cost_entered_at;
  const truckDone = j.truck_booking_status === 'hoan_thanh';
  const opsDone   = !!j.ops_done;

  let ready = false;
  if (j.service_type === 'tk')         ready = tkDone;
  else if (j.service_type === 'truck') ready = truckDone;
  else if (j.service_type === 'both')  ready = tkDone && truckDone;

  if (ready
      && j.destination === 'hai_phong'
      && (j.service_type === 'truck' || j.service_type === 'both')) {
    ready = ready && opsDone;
  }

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
