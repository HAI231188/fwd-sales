'use strict';

// ── Single source of truth for the OPS weekly-rotation mapping (L30) ──
// P0 FOUNDATION (2026-06-18) — NOT yet wired into any write/assignment path.
// Nothing calls this in P0; create-seeding / reconcile / reassign are unchanged.
// P1 will route task ownership through getWeekRotation().
//
// Two role='ops' users alternate responsibilities each ISO week (Mon–Sun):
// one does `thong_quan`, the other does `doi_lenh`. The doi_lenh person is ALSO
// the owner of `viec_khac` and `ops_hp` tasks — there is no extra logic here;
// callers that seed those tasks simply use `doiLenhOpsId`. Documented for P1.
//
// Parity:  even ISO week → { thongQuan: a, doiLenh: b };  odd week → swapped.
//
// The rotation pair (a, b) is configured in log_settings(ops_rotation_a/_b).
// L32 fallback: a slot that is NULL or points to a DISABLED user falls back to
// the lowest-id ACTIVE role='ops' user. With ONE active OPS, both roles collapse
// to that user; with ZERO active OPS, both are null and a warning is logged
// (the caller must handle null — but no write path calls this in P0).
//
// ISO week is computed on the VN-LOCAL calendar day (Asia/Ho_Chi_Minh) so the
// Sun→Mon boundary flips at VN midnight, not UTC midnight (L3). The server runs
// in UTC on Railway; raw local getters would shift the day −7h and could bucket
// a Monday-morning VN instant into the previous week.
//
// Pure read: no writes, no side effects. `db` is any pg pool/client (.query).

const { vnParts } = require('../utils/vnTime');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ISO 8601 week number (1–53) for a calendar day given as Y/M/D integers.
// Anchored at UTC midnight (Date.UTC) so the server's own TZ never shifts the
// weekday — the VN wall-clock day was already resolved via vnParts upstream.
function isoWeekNumber(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (d.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);        // Thursday decides the ISO year
  const isoYear = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));   // Jan 4 is always in ISO week 1
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  jan4.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3);
  return 1 + Math.round((d - jan4) / WEEK_MS);
}

// VN-local ISO week number for an instant (Date | ISO string | epoch ms).
// Returns null for an empty/invalid input.
function vnIsoWeek(date) {
  const p = vnParts(date);
  if (!p) return null;
  return isoWeekNumber(Number(p.year), Number(p.month), Number(p.day));
}

// Resolve { thongQuanOpsId, doiLenhOpsId } for the ISO week containing `date`.
async function getWeekRotation(date, db) {
  const week = vnIsoWeek(date);

  // Active OPS pool (L32 — never a disabled user), lowest id first.
  const { rows: actives } = await db.query(
    `SELECT id FROM users WHERE role = 'ops' AND disabled_at IS NULL ORDER BY id`
  );
  const activeIds = actives.map(r => r.id);
  const lowest = activeIds.length ? activeIds[0] : null;
  const activeSet = new Set(activeIds);

  // Configured pair from the single-row log_settings (id=1).
  const { rows: cfg } = await db.query(
    `SELECT ops_rotation_a, ops_rotation_b FROM log_settings WHERE id = 1`
  );
  const a = cfg[0] ? cfg[0].ops_rotation_a : null;
  const b = cfg[0] ? cfg[0].ops_rotation_b : null;

  // A slot is valid only if it points to an active OPS user; otherwise fall
  // back to the lowest-id active OPS (L32). Both collapse to `lowest` when only
  // one active OPS exists; both become null when zero exist.
  const resolve = slot => (slot != null && activeSet.has(slot)) ? slot : lowest;
  const slotA = resolve(a);
  const slotB = resolve(b);

  if (slotA == null || slotB == null || week == null) {
    if (slotA == null || slotB == null) {
      console.warn('[ops-rotation] no active OPS users — getWeekRotation returns null');
    }
    return { thongQuanOpsId: null, doiLenhOpsId: null };
  }

  // Even week → a=thong_quan, b=doi_lenh; odd week → swapped.
  return week % 2 === 0
    ? { thongQuanOpsId: slotA, doiLenhOpsId: slotB }
    : { thongQuanOpsId: slotB, doiLenhOpsId: slotA };
}

module.exports = { getWeekRotation, vnIsoWeek, isoWeekNumber };
