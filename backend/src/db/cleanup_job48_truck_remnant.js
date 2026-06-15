// ─── ONE-TIME DATA FIX — clear orphaned DD assignment on job LG26060097 (#48) ──
//
// Job LG26060097 (id 48) was created as service_type='both' (tk+truck) then edited
// to 'tk'. The PUT /jobs/:id handler only does ADD-direction back-fills, so the
// truck side was left orphaned: job_assignments.dieu_do_id stayed set, and the
// Điều Độ dashboard (which selects jobs by dieu_do_id, no service_type filter)
// kept showing it. Audit confirmed the ONLY truck-side remnant is the stale
// dieu_do_id — NO truck_bookings, NO truck_booking_containers, NO legacy job_truck
// row, NO carrier email_history. The 2 job_containers are legitimate cargo for the
// TK declaration and are intentionally NOT touched.
//
// This clears job_assignments.dieu_do_id → NULL for #48 so it leaves DD scope.
//
// SAFE BY DEFAULT — no flag = DRY RUN (verifies + prints the plan, writes nothing).
//   DRY RUN:
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_job48_truck_remnant.js
//   REAL RUN (single transaction, ROLLBACK on any error):
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_job48_truck_remnant.js --confirm
//
// MANUAL one-shot ONLY. NOT wired into start.js. A drift guard ABORTS (no changes)
// if #48 is no longer service_type='tk' with a set dieu_do_id and zero live
// truck_bookings — so re-running after the state changed is a safe no-op.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');
const { recordHistory } = require('../services/job-history');

const JOB_CODE = 'LG26060097';
const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const client = await db.pool.connect();
  try {
    // ── Load current state ──────────────────────────────────────────────────
    const { rows: jrows } = await client.query(
      `SELECT j.id, j.job_code, j.service_type, j.status, (j.deleted_at IS NOT NULL) AS deleted,
              ja.dieu_do_id,
              (SELECT COUNT(*)::int FROM truck_bookings tb
                 WHERE tb.job_id = j.id AND tb.deleted_at IS NULL) AS live_bookings,
              (SELECT COUNT(*)::int FROM job_truck jt WHERE jt.job_id = j.id) AS job_truck_rows
         FROM jobs j
         LEFT JOIN job_assignments ja ON ja.job_id = j.id
        WHERE j.job_code = $1`,
      [JOB_CODE]
    );

    console.log(`\n========================================================`);
    console.log(`JOB #48 (${JOB_CODE}) DD-REMNANT CLEANUP — ${CONFIRM ? 'REAL RUN (--confirm)' : 'DRY RUN'}`);
    console.log(`========================================================`);

    const j = jrows[0];
    if (!j) {
      console.error(`\n❌ ABORT — job ${JOB_CODE} not found. No changes made.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nCurrent state:`);
    console.log(`  id              ${j.id}`);
    console.log(`  service_type    ${j.service_type}`);
    console.log(`  status          ${j.status}   deleted=${j.deleted}`);
    console.log(`  dieu_do_id      ${j.dieu_do_id === null ? '(null)' : j.dieu_do_id}`);
    console.log(`  live_bookings   ${j.live_bookings}`);
    console.log(`  job_truck_rows  ${j.job_truck_rows}`);

    // ── Drift guard ─────────────────────────────────────────────────────────
    const problems = [];
    if (j.deleted) problems.push('job is soft-deleted');
    if (j.service_type !== 'tk') problems.push(`service_type is '${j.service_type}', expected 'tk'`);
    if (j.dieu_do_id === null) problems.push('dieu_do_id is already NULL (nothing to clear)');
    if (j.live_bookings !== 0) problems.push(`live_bookings=${j.live_bookings}, expected 0 (a real booking exists — do NOT silently clear)`);
    if (j.job_truck_rows !== 0) problems.push(`job_truck_rows=${j.job_truck_rows}, expected 0 (unexpected legacy row)`);
    if (problems.length) {
      console.error(`\n❌ ABORT — state drifted from the audited snapshot. No changes made:`);
      problems.forEach(p => console.error('   - ' + p));
      process.exitCode = 1;
      return;
    }

    console.log(`\nPlan:`);
    console.log(`  UPDATE job_assignments SET dieu_do_id = NULL WHERE job_id = ${j.id}   (was ${j.dieu_do_id})`);
    console.log(`  + job_history audit row (field 'truck_side_cleared')`);

    if (!CONFIRM) {
      console.log(`\n========================================================`);
      console.log(`DRY RUN — nothing changed. Re-run with --confirm to apply:`);
      console.log(`  node /app/backend/src/db/cleanup_job48_truck_remnant.js --confirm`);
      console.log(`========================================================`);
      return;
    }

    // ── REAL RUN — single transaction ───────────────────────────────────────
    await client.query('BEGIN');
    try {
      const upd = await client.query(
        `UPDATE job_assignments SET dieu_do_id = NULL
          WHERE job_id = $1 AND dieu_do_id IS NOT NULL`,
        [j.id]
      );
      console.log(`\n  cleared dieu_do_id on ${upd.rowCount} job_assignments row(s)`);
      await recordHistory(
        client, j.id, null, 'truck_side_cleared',
        `dieu_do_id=${j.dieu_do_id}`,
        'dieu_do_id=NULL (one-off data fix: service_type both→tk left DD assignment orphaned)'
      );
      await client.query('COMMIT');
      console.log('  ✅ COMMIT — committed.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  ❌ ROLLBACK — error, NO changes made:', err.message);
      process.exitCode = 1;
      return;
    }

    // ── Verify ──────────────────────────────────────────────────────────────
    const { rows: after } = await client.query(
      `SELECT ja.dieu_do_id FROM job_assignments ja WHERE ja.job_id = $1`, [j.id]
    );
    console.log(`\nAfter: dieu_do_id = ${after[0]?.dieu_do_id === null ? '(null) ✅ — job left DD scope' : after[0]?.dieu_do_id}`);
    console.log('\n✅ Cleanup complete.');
  } catch (err) {
    console.error('❌ cleanup failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main();
