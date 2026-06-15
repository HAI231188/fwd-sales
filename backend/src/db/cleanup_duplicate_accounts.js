// ─── ONE-TIME DATA CLEANUP — collapse duplicate role accounts (2026-06-15) ───
//
// A batch of duplicate accounts was created today (2026-06-15 02:55) for roles
// cus / cus1 / cus2 / cus3, dieu_do, and truong_phong_log. The ORIGINAL accounts
// (the *.log accounts from 05-08) hold the live jobs + history. In ONE transaction
// this script:
//   1. REASSIGNS dispatch from the duplicate DD ('dd') to the original ('tpl.log')
//      — every job_assignments.dieu_do_id on the duplicate (the live DD jobs, i.e.
//      #46/#47), plus jobs.dd_completed_by if any completed job ever pointed at it.
//   2. RENAMES display names (users.name ONLY — username + role untouched):
//      cus.log → 'CUS 1', cus1.log → 'CUS 2', cus2.log → 'CUS 3'.
//   3. DISABLES (disabled_at = NOW(); REVERSIBLE — NOT deleted) the 6 duplicates:
//      cus1, cus2, cus3, dd, tpl, cus.
//   4. Prints a per-role snapshot of the ACTIVE accounts that remain.
//
// Every id is resolved by USERNAME at runtime; the ids in comments are only
// cross-checked against the resolved values, never trusted blindly. The run
// ABORTS (no changes) if any expected username is missing or any role doesn't
// match the expected snapshot.
//
// SAFE BY DEFAULT — no flag = DRY RUN (reads + prints the plan, writes nothing).
//
//   DRY RUN:
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_duplicate_accounts.js
//   REAL RUN (guarded by --confirm; single transaction, ROLLBACK on any error):
//     railway ssh --service fwd-sales -- node /app/backend/src/db/cleanup_duplicate_accounts.js --confirm
//
// MANUAL one-shot ONLY. NOT wired into start.js — never runs on deploy. Nothing is
// hard-deleted. Never touches sales / ops / admin / ke_toan accounts, and never
// touches the username or role of any kept account.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

const CONFIRM = process.argv.includes('--confirm');

// Kept vs duplicate DD (resolved by username; expected ids are cross-check only).
const ORIG_DD_USERNAME = 'tpl.log';   // expected id 6    — kept DD
const DUP_DD_USERNAME  = 'dd';        // expected id 5177 — duplicate DD (disabled after reassign)

// [username, newName, expectedRole] — display-name rename, users.name column ONLY.
const RENAMES = [
  ['cus.log',  'CUS 1', 'cus1'],   // expected id 3
  ['cus1.log', 'CUS 2', 'cus2'],   // expected id 4
  ['cus2.log', 'CUS 3', 'cus3'],   // expected id 5
];

// [username, expectedRole] — duplicates to DISABLE (reversible, NOT deleted).
const DISABLE = [
  ['cus1', 'cus1'],              // expected id 5174
  ['cus2', 'cus2'],              // expected id 5175
  ['cus3', 'cus3'],              // expected id 5176
  ['dd',   'dieu_do'],           // expected id 5177 (after its jobs move in step 1)
  ['tpl',  'truong_phong_log'],  // expected id 5172
  ['cus',  'cus'],               // expected id 5173 (duplicate supervisor)
];

// Accounts that MUST remain active — asserted at the end of a real run.
const KEEP_ACTIVE = ['mng.cus', 'mng.log', 'tpl.log', 'cus.log', 'cus1.log', 'cus2.log'];

const SNAPSHOT_ROLES = ['cus', 'cus1', 'cus2', 'cus3', 'dieu_do', 'truong_phong_log'];

async function resolveUsers(client) {
  const names = [...new Set([
    ORIG_DD_USERNAME, DUP_DD_USERNAME,
    ...RENAMES.map(r => r[0]),
    ...DISABLE.map(d => d[0]),
    ...KEEP_ACTIVE,
  ])];
  const { rows } = await client.query(
    `SELECT id, username, name, role, disabled_at FROM users WHERE username = ANY($1)`, [names]);
  const byName = Object.fromEntries(rows.map(r => [r.username, r]));
  const missing = names.filter(n => !byName[n]);
  return { byName, missing };
}

async function roleRows(client) {
  const { rows } = await client.query(
    `SELECT id, username, name, role, disabled_at FROM users WHERE role = ANY($1) ORDER BY role, created_at`,
    [SNAPSHOT_ROLES]);
  return rows;
}

// Active-after-cleanup accounts per role. `previewDisabledIds` (a Set) simulates the
// disable step for the DRY-RUN prediction; `renameMap` (id->newName) shows post-rename
// names. Pass both null for an AFTER snapshot read straight from committed data.
function roleActiveLines(rows, previewDisabledIds, renameMap) {
  const out = {};
  for (const role of SNAPSHOT_ROLES) out[role] = [];
  for (const r of rows) {
    const activeAfter = r.disabled_at === null && !(previewDisabledIds && previewDisabledIds.has(r.id));
    if (!activeAfter || !out[r.role]) continue;
    const name = (renameMap && renameMap[r.id]) || r.name;
    out[r.role].push(`${r.id} ${r.username} ("${name}")`);
  }
  return out;
}

async function main() {
  const client = await db.pool.connect();
  try {
    const { byName, missing } = await resolveUsers(client);
    if (missing.length) {
      console.error(`\n❌ ABORT — expected usernames not found: ${missing.join(', ')}. No changes made.`);
      process.exitCode = 1;
      return;
    }

    // ── Resolve + validate roles (snapshot-drift guard) ─────────────────────
    const origDd = byName[ORIG_DD_USERNAME];
    const dupDd  = byName[DUP_DD_USERNAME];
    const problems = [];
    for (const [u, , role] of RENAMES) if (byName[u].role !== role) problems.push(`${u} role=${byName[u].role} expected ${role}`);
    for (const [u, role] of DISABLE)   if (byName[u].role !== role) problems.push(`${u} role=${byName[u].role} expected ${role}`);
    if (origDd.role !== 'dieu_do') problems.push(`${ORIG_DD_USERNAME} role=${origDd.role} expected dieu_do`);
    if (dupDd.role  !== 'dieu_do') problems.push(`${DUP_DD_USERNAME} role=${dupDd.role} expected dieu_do`);
    if (problems.length) {
      console.error('\n❌ ABORT — role mismatch (snapshot drift). No changes made:');
      problems.forEach(p => console.error('   - ' + p));
      process.exitCode = 1;
      return;
    }

    // ── Read current state for the plan ─────────────────────────────────────
    const { rows: ddJobs } = await client.query(
      `SELECT job_id, dieu_do_id FROM job_assignments WHERE dieu_do_id = $1 ORDER BY job_id`, [dupDd.id]);
    const { rows: ddCompleted } = await client.query(
      `SELECT id FROM jobs WHERE dd_completed_by = $1 ORDER BY id`, [dupDd.id]);

    const renameMap = Object.fromEntries(RENAMES.map(([u, newName]) => [byName[u].id, newName]));

    console.log(`\n========================================================`);
    console.log(`DUPLICATE-ACCOUNT CLEANUP — ${CONFIRM ? 'REAL RUN (--confirm)' : 'DRY RUN'}`);
    console.log(`========================================================`);
    console.log(`\nResolved by username (cross-checking the snapshot ids):`);
    console.log(`  kept DD       ${ORIG_DD_USERNAME.padEnd(10)} -> id ${origDd.id}`);
    console.log(`  duplicate DD  ${DUP_DD_USERNAME.padEnd(10)} -> id ${dupDd.id}`);

    console.log(`\n[1] REASSIGN dispatch  duplicate DD (id ${dupDd.id}) -> original (id ${origDd.id}):`);
    if (ddJobs.length === 0) console.log(`      job_assignments.dieu_do_id: (none on the duplicate — nothing to move)`);
    ddJobs.forEach(j => console.log(`      job #${j.job_id}: dieu_do_id ${j.dieu_do_id} -> ${origDd.id}`));
    if (ddCompleted.length) ddCompleted.forEach(j => console.log(`      job #${j.id}: dd_completed_by ${dupDd.id} -> ${origDd.id}`));
    else console.log(`      jobs.dd_completed_by: (none)`);

    console.log(`\n[2] RENAME display name (users.name only — username/role untouched):`);
    RENAMES.forEach(([u, newName]) => console.log(`      ${u.padEnd(10)} (id ${byName[u].id}) "${byName[u].name}" -> "${newName}"`));

    console.log(`\n[3] DISABLE duplicates (disabled_at = NOW(); reversible, NOT deleted):`);
    const disableIds = new Set();
    DISABLE.forEach(([u]) => {
      const usr = byName[u];
      if (usr.disabled_at !== null) { console.log(`      ${u.padEnd(10)} (id ${usr.id}) — already disabled, SKIP`); return; }
      disableIds.add(usr.id);
      console.log(`      ${u.padEnd(10)} (id ${usr.id}, role ${usr.role}) -> disabled`);
    });

    // ── Predicted role snapshot ─────────────────────────────────────────────
    const allRoleRows = await roleRows(client);
    const preview = roleActiveLines(allRoleRows, disableIds, renameMap);
    console.log(`\n[4] PREDICTED active accounts per role AFTER cleanup:`);
    for (const role of SNAPSHOT_ROLES) {
      console.log(`      ${role.padEnd(18)} ${preview[role].join('  |  ') || '(none)'}`);
    }

    if (!CONFIRM) {
      console.log(`\n========================================================`);
      console.log(`DRY RUN — nothing changed. Re-run with --confirm to apply:`);
      console.log(`  node /app/backend/src/db/cleanup_duplicate_accounts.js --confirm`);
      console.log(`========================================================`);
      return;
    }

    // ── REAL RUN — single transaction; ROLLBACK on any error ────────────────
    console.log(`\n──────── APPLYING (single transaction) ────────`);
    await client.query('BEGIN');
    try {
      const r1 = await client.query(
        `UPDATE job_assignments SET dieu_do_id = $1 WHERE dieu_do_id = $2`, [origDd.id, dupDd.id]);
      console.log(`  [1] job_assignments.dieu_do_id moved: ${r1.rowCount} row(s)`);
      const r1b = await client.query(
        `UPDATE jobs SET dd_completed_by = $1 WHERE dd_completed_by = $2`, [origDd.id, dupDd.id]);
      console.log(`  [1] jobs.dd_completed_by moved:       ${r1b.rowCount} row(s)`);

      for (const [u, newName] of RENAMES) {
        const r = await client.query(`UPDATE users SET name = $1 WHERE id = $2`, [newName, byName[u].id]);
        console.log(`  [2] ${u.padEnd(10)} -> name "${newName}": ${r.rowCount} row(s)`);
      }

      for (const [u] of DISABLE) {
        const r = await client.query(
          `UPDATE users SET disabled_at = NOW() WHERE id = $1 AND disabled_at IS NULL`, [byName[u].id]);
        console.log(`  [3] ${u.padEnd(10)} disabled: ${r.rowCount} row(s)`);
      }

      await client.query('COMMIT');
      console.log('  ✅ COMMIT — all changes committed.');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('  ❌ ROLLBACK — error, NO changes made:', err.message);
      process.exitCode = 1;
      return;
    }

    // ── AFTER verification (read committed data) ────────────────────────────
    const afterRows = await roleRows(client);
    const after = roleActiveLines(afterRows, null, null);
    console.log(`\n──────── AFTER — active (disabled_at IS NULL) accounts per role ────────`);
    for (const role of SNAPSHOT_ROLES) {
      console.log(`  ${role.padEnd(18)} ${after[role].join('  |  ') || '(none)'}`);
    }

    if (ddJobs.length) {
      const { rows: jobCheck } = await client.query(
        `SELECT ja.job_id, ja.dieu_do_id, u.username FROM job_assignments ja
         LEFT JOIN users u ON u.id = ja.dieu_do_id
         WHERE ja.job_id = ANY($1) ORDER BY ja.job_id`, [ddJobs.map(j => j.job_id)]);
      console.log(`\n  Reassigned DD jobs now point to:`);
      jobCheck.forEach(j => console.log(`    job #${j.job_id}: dieu_do_id ${j.dieu_do_id} (${j.username})`));
    }

    const keptDisabled = KEEP_ACTIVE.filter(u => {
      const r = afterRows.find(x => x.username === u);
      return r && r.disabled_at !== null;
    });
    if (keptDisabled.length) console.warn(`  ⚠️ WARNING — kept accounts unexpectedly disabled: ${keptDisabled.join(', ')}`);
    else console.log(`  ✅ All kept accounts (${KEEP_ACTIVE.join(', ')}) remain active.`);

    console.log('\n✅ Duplicate-account cleanup complete.');
  } catch (err) {
    console.error('❌ cleanup failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main();
