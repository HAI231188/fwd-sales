'use strict';

// ── Single source of truth for service_type/destination edit reconciliation ──
// (L35). Replaces the three ad-hoc per-direction blocks that used to live inline
// in PUT /api/jobs/:id (TK back-fill / OPS back-fill / both·truck→tk REMOVE).
//
// From the NEW (svc, dest) state it derives the desired TK / TRUCK / OPS sides
// and reconciles each against the prior state:
//   • GAIN  (now needed, wasn't) → back-fill rows + assign an owner.
//   • LOSE  (was needed, now not) → clean rows + clear the assignment, behind a
//     GUARD that BLOCKS (never silently destroys) committed/sent/completed work.
//
// LLM-free: the CUS suggestion (`suggestCus`, a network call) is computed by the
// CALLER before BEGIN and passed in as opts.cusSuggestion — mirrors POST create
// and keeps the network call out of the DB transaction. The DD round-robin is
// pure SQL and runs here (safe inside the txn). The booking soft-delete reuses
// the DELETE /api/truck-bookings/:id Option-B logic (L20). All assignment/delete
// logic is the canonical one, not a reimplementation.
//
// Returns { blocked: false } on success, or { blocked: true, status, code, error }
// when a LOSE guard fires — the caller then ROLLBACKs and returns the response.
// (The helper never touches `res` and does no writes before a guard can fire.)

const { recordHistory } = require('./job-history');

const TK_SET = ['tk', 'both'];
const TRUCK_SET = ['truck', 'both'];
const STD_SVC = ['tk', 'truck', 'both'];
const hasTk = svc => TK_SET.includes(svc);
const hasTruck = svc => TRUCK_SET.includes(svc);

async function reconcileJobSides(client, jobId, opts) {
  const { oldSvc, newSvc, oldDest, newDest, cusSuggestion,
          actingUserId, customerName, jobCode } = opts;

  // Only the standard LOG service types are reconciled here. 'ops_hp' is a
  // separate OPS-only model with its own task lifecycle — leave it untouched.
  if (!STD_SVC.includes(newSvc) || !STD_SVC.includes(oldSvc)) {
    return { blocked: false };
  }

  const newHP = newDest === 'hai_phong';
  const tkDesired = hasTk(newSvc), tkWas = hasTk(oldSvc);
  const truckDesired = hasTruck(newSvc), truckWas = hasTruck(oldSvc);
  const tqDesired = newHP && tkDesired;   // thong_quan: tk/both at Hải Phòng
  const dlDesired = newHP;                // doi_lenh: any HP job (tk/truck/both)

  const tkGain = tkDesired && !tkWas;
  const tkLose = !tkDesired && tkWas;
  const truckGain = truckDesired && !truckWas;
  const truckLose = !truckDesired && truckWas;

  const jobLabel = jobCode || `#${jobId}`;
  const notifyAssigned = async (userId) => {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, job_id)
       VALUES ($1, 'ai_job_assigned', 'AI phân job mới', $2, $3)`,
      [userId, `Bạn được phân job ${jobLabel} - ${customerName || ''}`, jobId]);
  };
  const ensureAssignmentRow = async () => {
    const { rows } = await client.query(`SELECT id FROM job_assignments WHERE job_id = $1`, [jobId]);
    if (!rows[0]) await client.query(`INSERT INTO job_assignments (job_id) VALUES ($1)`, [jobId]);
  };

  // ─── GUARD PHASE — evaluate every block BEFORE any write ─────────────────
  if (truckLose) {
    const { rows: mailed } = await client.query(
      `SELECT booking_code FROM truck_bookings
        WHERE job_id = $1 AND deleted_at IS NULL AND mail_group_id IS NOT NULL ORDER BY id`,
      [jobId]);
    if (mailed.length) {
      const codes = mailed.map(b => b.booking_code).filter(Boolean).join(', ') || '(?)';
      return { blocked: true, status: 409, code: 'TRUCK_BOOKING_MAILED',
        error: `Không thể bỏ phần truck: job có booking đã gửi mail cho nhà xe (${codes}). ` +
               'Vui lòng HỦY booking (gửi mail hủy cho nhà xe) trước, rồi mới đổi loại dịch vụ.' };
    }
  }
  if (tkLose) {
    const { rows: prog } = await client.query(
      `SELECT 1 FROM job_tk
        WHERE job_id = $1 AND (
              tk_status IS DISTINCT FROM 'chua_truyen'
           OR tk_number IS NOT NULL OR tk_datetime IS NOT NULL OR tq_datetime IS NOT NULL
           OR delivery_datetime IS NOT NULL OR completed_at IS NOT NULL)
        LIMIT 1`,
      [jobId]);
    if (prog.length) {
      return { blocked: true, status: 409, code: 'TK_WORK_IN_PROGRESS',
        error: 'Không thể đổi sang chỉ truck: job đã có nghiệp vụ TK (tờ khai/thông quan). ' +
               'Vui lòng xử lý/hủy phần TK trước khi đổi loại dịch vụ.' };
    }
  }

  // ─── APPLY PHASE — no guard can fire past here ──────────────────────────

  // TK side
  if (tkGain) {
    const { rows: tkEx } = await client.query(`SELECT id FROM job_tk WHERE job_id = $1`, [jobId]);
    if (cusSuggestion && cusSuggestion.user_id) {
      // Auto mode — apply the pre-computed CUS suggestion exactly like POST create.
      await ensureAssignmentRow();
      await client.query(
        `UPDATE job_assignments SET cus_id = $1, cus_confirm_status = 'pending', assignment_mode = 'auto'
          WHERE job_id = $2`, [cusSuggestion.user_id, jobId]);
      if (!tkEx[0]) await client.query(`INSERT INTO job_tk (job_id, cus_id) VALUES ($1, $2)`, [jobId, cusSuggestion.user_id]);
      else await client.query(`UPDATE job_tk SET cus_id = $1 WHERE job_id = $2`, [cusSuggestion.user_id, jobId]);
      await notifyAssigned(cusSuggestion.user_id);
      await recordHistory(client, jobId, actingUserId, 'cus_assigned', null, cusSuggestion.user_name || String(cusSuggestion.user_id));
    } else if (!tkEx[0]) {
      // Manual mode / no suggestion — ensure the row, leave unassigned → waiting_cus.
      await client.query(`INSERT INTO job_tk (job_id) VALUES ($1)`, [jobId]);
    }
    await recordHistory(client, jobId, actingUserId, 'tk_side_added', oldSvc, newSvc);
  } else if (tkLose) {
    // Guard passed → TK untouched. Clear CUS scope + remove the empty job_tk row.
    const c = await client.query(`UPDATE job_assignments SET cus_id = NULL WHERE job_id = $1 AND cus_id IS NOT NULL`, [jobId]);
    const d = await client.query(`DELETE FROM job_tk WHERE job_id = $1`, [jobId]);
    if (c.rowCount || d.rowCount) {
      await recordHistory(client, jobId, actingUserId, 'tk_side_cleared',
        `${oldSvc} (cus_cleared=${c.rowCount}, job_tk=${d.rowCount})`, newSvc);
    }
  }

  // TRUCK side
  if (truckGain) {
    // DD round-robin — mirrors POST /api/jobs create (jobs.js:1562-1565): least
    // pending-load DD, RANDOM tiebreak. Pure SQL → safe inside the transaction.
    const { rows: dd } = await client.query(
      `SELECT u.id FROM users u WHERE u.role = 'dieu_do' AND u.disabled_at IS NULL
        ORDER BY (
          SELECT COUNT(*) FROM job_assignments ja2 JOIN jobs j2 ON j2.id = ja2.job_id
           WHERE ja2.dieu_do_id = u.id AND j2.status = 'pending' AND j2.deleted_at IS NULL
        ) ASC, RANDOM() LIMIT 1`);
    const ddUserId = dd[0]?.id || null;
    if (ddUserId) {
      await ensureAssignmentRow();
      await client.query(`UPDATE job_assignments SET dieu_do_id = $1 WHERE job_id = $2`, [ddUserId, jobId]);
      await notifyAssigned(ddUserId);
      await recordHistory(client, jobId, actingUserId, 'dieu_do_assigned', null, String(ddUserId));
    }
    // ddUserId null (no active DD) → job surfaces in the waiting_dd safety pool.
  } else if (truckLose) {
    // Reuse the DELETE /api/truck-bookings/:id Option-B logic (L20): soft-delete
    // each live booking + HARD-delete its link rows so the containers free up.
    const { rows: bks } = await client.query(
      `SELECT id FROM truck_bookings WHERE job_id = $1 AND deleted_at IS NULL ORDER BY id`, [jobId]);
    for (const b of bks) {
      await client.query(`UPDATE truck_bookings SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [b.id]);
      await client.query(`DELETE FROM truck_booking_containers WHERE booking_id = $1`, [b.id]);
    }
    const dd = await client.query(`UPDATE job_assignments SET dieu_do_id = NULL WHERE job_id = $1 AND dieu_do_id IS NOT NULL`, [jobId]);
    const jt = await client.query(`DELETE FROM job_truck WHERE job_id = $1`, [jobId]);
    if (bks.length || dd.rowCount || jt.rowCount) {
      await recordHistory(client, jobId, actingUserId, 'truck_side_cleared',
        `${oldSvc} (bookings=${bks.length}, dd_cleared=${dd.rowCount}, job_truck=${jt.rowCount})`, newSvc);
    }
  }

  // OPS side (destination-aware). Uses the current ops_id; if none, the
  // back-filled task is unassigned → waiting_ops (matches existing behavior).
  const { rows: jaRow } = await client.query(`SELECT ops_id FROM job_assignments WHERE job_id = $1`, [jobId]);
  const opsUserId = jaRow[0]?.ops_id || null;
  const ensureOpsTask = async (taskType) => {
    await client.query(
      `INSERT INTO job_ops_task (job_id, ops_id, task_type) VALUES ($1, $2, $3)
       ON CONFLICT (job_id, task_type) WHERE task_type IS NOT NULL DO NOTHING`,
      [jobId, opsUserId, taskType]);
  };
  // Remove a now-unneeded task type, but NEVER delete one with committed work
  // (completed OR cost entered) — keep it + record a warning instead.
  const removeOpsTask = async (taskType) => {
    const { rows: tasks } = await client.query(
      `SELECT id, (completed = TRUE OR cost_entered_at IS NOT NULL) AS done
         FROM job_ops_task WHERE job_id = $1 AND task_type = $2`, [jobId, taskType]);
    for (const t of tasks) {
      if (t.done) {
        await recordHistory(client, jobId, actingUserId, 'ops_task_kept_completed',
          taskType, `kept — task already done/cost-entered despite ${newSvc}/${newDest}`);
      } else {
        await client.query(`DELETE FROM job_ops_task WHERE id = $1`, [t.id]);
        await recordHistory(client, jobId, actingUserId, 'ops_task_removed',
          taskType, `removed — no longer needed (${newSvc}/${newDest})`);
      }
    }
  };
  if (tqDesired) await ensureOpsTask('thong_quan'); else await removeOpsTask('thong_quan');
  if (dlDesired) await ensureOpsTask('doi_lenh');  else await removeOpsTask('doi_lenh');

  return { blocked: false };
}

module.exports = { reconcileJobSides };
