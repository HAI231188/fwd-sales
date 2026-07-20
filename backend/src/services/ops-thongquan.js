'use strict';
// Hải Phòng OPS "thông quan" task skip logic (2026-07-20). Single source of
// truth (L30) for WHETHER a thong_quan job_ops_task should exist + an idempotent
// reconcile that creates/deletes it. Đổi lệnh (doi_lenh) is NEVER touched here.
//
// Two skip paths:
//   PATH A (jobs.skip_ops_thongquan = TRUE): manual hard skip — wins over B.
//   PATH B (job_tk.tk_flow = 'xanh'): auto skip on green channel. A later change
//          to vàng/đỏ RE-CREATES the task via the normal weekly rotation.
// Not-yet-set luồng (NULL) counts as NOT xanh → task wanted, so a normal HP
// tk/both job still gets thong_quan at creation exactly as before.

const { getWeekRotation } = require('./ops-rotation');
const { recordHistory } = require('./job-history');

// Pure predicate — should this job have a thong_quan task right now?
// (thong_quan only applies to tk/both at Hải Phòng.)
function thongQuanWanted({ destination, service_type, skip_ops_thongquan, tk_flow }) {
  if (destination !== 'hai_phong') return false;
  if (service_type !== 'tk' && service_type !== 'both') return false;
  if (skip_ops_thongquan) return false;   // PATH A — manual hard skip wins
  if (tk_flow === 'xanh') return false;    // PATH B — green channel, no clearance task
  return true;
}

// Idempotent reconcile of the single thong_quan task for one job. Safe to run
// repeatedly (never duplicates — partial UNIQUE(job_id, task_type)). Creates via
// the weekly rotation when wanted+absent; deletes when unwanted+present UNLESS
// OPS already progressed it (completed OR cost entered) → keep it + history
// (L35 precedent — no silent data loss). Returns { action }.
async function reconcileThongQuanTask(client, jobId, actingUserId) {
  const { rows } = await client.query(`
    SELECT j.job_code, j.customer_name, j.destination, j.service_type, j.skip_ops_thongquan,
           jt.tk_flow,
           t.id AS tq_id, t.completed AS tq_completed, t.cost_entered_at AS tq_cost
      FROM jobs j
      LEFT JOIN job_tk jt ON jt.job_id = j.id
      LEFT JOIN job_ops_task t ON t.job_id = j.id AND t.task_type = 'thong_quan'
     WHERE j.id = $1 AND j.deleted_at IS NULL
  `, [jobId]);
  if (!rows[0]) return { action: 'none' };
  const j = rows[0];
  const wanted = thongQuanWanted(j);
  const exists = j.tq_id !== null;

  if (wanted && !exists) {
    // Re-create via the same weekly rotation a fresh HP job would use.
    const rot = await getWeekRotation(new Date(), client);
    const owner = (rot && rot.thongQuanOpsId) || null;
    const { rows: ins } = await client.query(
      `INSERT INTO job_ops_task (job_id, ops_id, task_type, assigned_at, assigned_by)
       VALUES ($1, $2, 'thong_quan', NOW(), $3)
       ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING
       RETURNING id`,
      [jobId, owner, actingUserId]);
    if (!ins[0]) return { action: 'none' }; // raced — a thong_quan row already exists
    await recordHistory(client, jobId, actingUserId, 'ops_thongquan_created', null, 'luồng vàng/đỏ → cần thông quan');
    if (owner) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message, job_id)
         VALUES ($1, 'ai_job_assigned', 'OPS thông quan', $2, $3)`,
        [owner, `Bạn được phân thông quan job ${j.job_code || `#${jobId}`} - ${j.customer_name || ''}`, jobId]);
    }
    return { action: 'created', owner };
  }

  if (!wanted && exists) {
    if (j.tq_completed || j.tq_cost) {
      // OPS already did work — KEEP the task, never destroy it silently (L35).
      await recordHistory(client, jobId, actingUserId, 'ops_thongquan_kept_progressed', null,
        'giữ lại — OPS đã có dữ liệu (completed/cost) dù luồng xanh / bỏ thông quan');
      return { action: 'kept_progressed' };
    }
    await client.query(`DELETE FROM job_ops_task WHERE job_id = $1 AND task_type = 'thong_quan'`, [jobId]);
    await recordHistory(client, jobId, actingUserId, 'ops_thongquan_skipped', 'thong_quan', null);
    return { action: 'deleted' };
  }
  return { action: 'noop' };
}

module.exports = { thongQuanWanted, reconcileThongQuanTask };
