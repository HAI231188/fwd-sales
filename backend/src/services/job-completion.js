// Shared helper: decide whether a job should auto-flip to status='completed'
// based on its sub-task state. Called from multiple route files (jobs.js,
// truck-bookings.js, …) — kept in one place per L19 (single source of truth
// for derived status logic).
//
// Phase 4 update: truck side is sourced from get_truck_booking_status() —
// `da_giao_xong` means all containers covered by bookings AND every booking
// has a vehicle. The legacy job_truck.completed_at column is no longer read.

async function checkAndCompleteJob(client, jobId, changedBy, recordHistory) {
  const { rows } = await client.query(`
    SELECT j.id, j.status, j.service_type, j.destination,
           jt.completed_at  AS tk_completed_at,
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

  const tkDone    = !!j.tk_completed_at;
  const truckDone = j.truck_booking_status === 'da_giao_xong';
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
    `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
    [jobId]
  );
  if (recordHistory) {
    await recordHistory(client, jobId, changedBy, 'status', 'pending', 'completed');
  }
  return true;
}

module.exports = { checkAndCompleteJob };
