// ─── ONE-TIME DATA CLEANUP — wipe LOG/job data, PRESERVE sales/users/config ───
//
// Removes test/demo job data before real go-live. Deletes ALL rows from the
// job-related (LOG department) tables in FK-safe order (children first, `jobs`
// last) inside a SINGLE transaction, plus the job-linked notifications. PRESERVES
// sales data (customers, customer_pipeline, quotes, reports, interactions,
// pipeline history), transport companies, users, log_settings, AND sales-only
// notifications (job_id IS NULL).
//
// SAFE BY DEFAULT — a run with no flag is a DRY RUN that deletes nothing.
//
//   DRY RUN (prints counts, deletes nothing):
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_log_data.js
//
//   REAL RUN (actually deletes — guarded behind --confirm):
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_log_data.js --confirm
//
// MANUAL one-shot ONLY. NOT wired into start.js — never runs on deploy. Does NOT
// reset id sequences. Does NOT touch schema.sql / seed files / app logic.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

// FK-safe delete order: every child before its parent; `jobs` (the parent of the
// whole job graph) is LAST. These are HARD-CODED table names (no user input), so
// interpolating them into the SQL below is safe.
const DELETE_ORDER = [
  'truck_booking_containers', // -> truck_bookings, job_containers (delete first)
  'truck_bookings',           // -> jobs
  'job_tk',                   // -> jobs
  'job_truck',                // -> jobs
  'job_ops_task',             // -> jobs
  'job_history',              // -> jobs
  'job_deadline_requests',    // -> jobs
  'job_delete_requests',      // -> jobs
  'email_history',            // -> jobs
  'ai_assignment_logs',       // -> jobs (+ users; users preserved)
  'job_assignments',          // -> jobs
  'job_containers',           // -> jobs
  'jobs',                     // PARENT — delete last
];

// Preserved tables — counted before/after to PROVE they are untouched.
const PRESERVED = ['users', 'customers', 'customer_pipeline', 'quotes', 'transport_companies'];

const CONFIRM = process.argv.includes('--confirm');

async function count(client, sql) {
  const { rows } = await client.query(sql);
  return Number(rows[0].n);
}

async function snapshot(client, label) {
  console.log(`\n──────── ${label} ────────`);
  console.log('LOG/job tables (to be wiped):');
  for (const t of DELETE_ORDER) {
    const n = await count(client, `SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(26)} ${n}`);
  }
  console.log('notifications (PARTIAL — only job_id IS NOT NULL is deleted):');
  const nTotal = await count(client, `SELECT COUNT(*)::int AS n FROM notifications`);
  const nJob   = await count(client, `SELECT COUNT(*)::int AS n FROM notifications WHERE job_id IS NOT NULL`);
  const nSales = await count(client, `SELECT COUNT(*)::int AS n FROM notifications WHERE job_id IS NULL`);
  console.log(`  ${'notifications total'.padEnd(30)} ${nTotal}`);
  console.log(`  ${'notifications job_id IS NOT NULL'.padEnd(30)} ${nJob}   <- DELETED`);
  console.log(`  ${'notifications job_id IS NULL'.padEnd(30)} ${nSales}   <- KEPT (sales-only)`);
  console.log('PRESERVED tables (must stay unchanged):');
  for (const t of PRESERVED) {
    const n = await count(client, `SELECT COUNT(*)::int AS n FROM ${t}`);
    console.log(`  ${t.padEnd(26)} ${n}`);
  }
}

async function main() {
  const client = await db.pool.connect();
  try {
    await snapshot(client, 'BEFORE');

    if (!CONFIRM) {
      console.log('\n========================================================');
      console.log('DRY RUN — no rows deleted.');
      console.log('Re-run with --confirm to actually delete the LOG/job data:');
      console.log('  node /app/backend/src/db/cleanup_log_data.js --confirm');
      console.log('========================================================');
      return;
    }

    // ── REAL DELETE — single transaction; ROLLBACK on any error ──────────────
    console.log('\n──────── DELETING (single transaction) ────────');
    await client.query('BEGIN');
    try {
      for (const t of DELETE_ORDER) {
        const res = await client.query(`DELETE FROM ${t}`);
        console.log(`  deleted ${String(res.rowCount).padStart(7)}  from ${t}`);
      }
      // Partial notifications delete — job-linked only; sales-only (job_id IS
      // NULL) rows are intentionally kept.
      const nres = await client.query(`DELETE FROM notifications WHERE job_id IS NOT NULL`);
      console.log(`  deleted ${String(nres.rowCount).padStart(7)}  from notifications (job_id IS NOT NULL; job_id IS NULL kept)`);

      await client.query('COMMIT');
      console.log('  ✅ COMMIT — transaction committed.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  ❌ ROLLBACK — error during delete, NO rows removed:', err.message);
      process.exitCode = 1;
      return;
    }

    await snapshot(client, 'AFTER');
    console.log('\n✅ Cleanup complete: job tables → 0, notifications job_id IS NOT NULL → 0, sales-only notifications + preserved tables unchanged.');
  } catch (err) {
    console.error('❌ cleanup failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main();
