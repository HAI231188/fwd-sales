'use strict';

// Hạn lệnh guard — refuses a truck-plan save whose delivery date falls AFTER the
// job's hạn lệnh. This is a DATA-CORRECTNESS mechanism, not a demurrage guard:
// free-time extensions are granted in real life but never entered into the app,
// so the stale hạn lệnh silently poisons every downstream signal that reads it
// (the DD T1 "Quá hạn đặt KH xe" tier, BBBG, the planning mail). Blocking the
// save forces the responsible department to correct the value.
//
// Shared by ALL THREE endpoints that write truck_bookings.planned_datetime
// (POST /, PATCH /:id, POST /batch) per L30 — one predicate, never re-copied
// per handler. Guarding fewer than three would make the block bypassable.
//
// ── SCOPE (deliberately narrow) ─────────────────────────────────────────────
//   • FCL only        — an LCL booking is a container-less whole-lot leg with no
//                       per-container free time (L20/L38). Never fires on LCL.
//   • hàng nhập only  — for export the same column is a CUTOFF, i.e. the exact
//                       opposite concern (L19). Never fires on export.
//   • han_lenh must be present AND sane (VN year within 2020..2030). NULL or
//     garbage (there is a live row with year 0226) => cannot evaluate => ALLOW.
//     The guard never blocks on missing or corrupt data.
//
// ── THE COMPARISON — VN CALENDAR DATES, NEVER RAW TIMESTAMPS ────────────────
// An import han_lenh is submitted as a bare 'YYYY-MM-DD' (an <input type="date">
// value; vnLocalToIso deliberately passes date-only strings through untouched),
// so Postgres parses it at the SESSION timezone — Etc/UTC on Railway — landing
// it at 00:00 UTC == 07:00 Asia/Ho_Chi_Minh. 322 of 324 live import rows sit at
// exactly 07:00 VN; that 07:00 is a STORAGE ARTIFACT, not a business time.
//
// A raw `planned_datetime > han_lenh` therefore flags every same-day delivery
// after 07:00 VN — and 08:00/13:00/17:00/19:00/21:00 are the common planned
// times, so that is essentially all of them. Measured against live data the raw
// comparison over-flags by 42 bookings / 29 jobs (~35% false positives).
//
// Comparing the VN CALENDAR DATE removes that entirely: hạn lệnh is a DAY
// deadline for import, so a delivery at 17:00 on the hạn lệnh day is ON TIME.

const { vnParts } = require('../utils/vnTime');

// A hạn lệnh outside this window is a data-entry typo (live example: year 0226),
// not a deadline. Treated as unusable => allow, never block on garbage.
const HAN_LENH_MIN_YEAR = 2020;
const HAN_LENH_MAX_YEAR = 2030;

// "YYYY-MM-DD" — the Vietnam calendar date of a stored instant (or of any value
// `new Date()` accepts), or null when empty/unparseable. Zero-padded, so plain
// string comparison on the result is chronological.
//
// Applied to the RAW submitted value this agrees with what Postgres will store
// in both wire shapes: a VN-anchored "...+07:00" (what every frontend caller
// sends, via vnLocalToIso) resolves to the same instant here and in PG; a naive
// "YYYY-MM-DDTHH:mm" from a direct API caller is read as UTC by both Node (the
// server runs in UTC) and PG's UTC session, so both land on the same VN date.
function vnDateStr(val) {
  const p = vnParts(val);
  return p ? `${p.year}-${p.month}-${p.day}` : null;
}

// Is this hạn lệnh usable as a deadline at all? NULL / unparseable / outside
// 2020..2030 => false => the guard stands down for that job.
function hanLenhUsable(hanLenh) {
  const d = vnDateStr(hanLenh);
  if (!d) return false;
  const year = Number(d.slice(0, 4));
  return year >= HAN_LENH_MIN_YEAR && year <= HAN_LENH_MAX_YEAR;
}

// Does this job fall in the guard's scope at all? FCL + hàng nhập only.
function jobInGuardScope(job) {
  return !!job && job.cargo_type === 'fcl' && job.import_export === 'import';
}

// The core predicate. TRUE only when the planned delivery lands on a LATER VN
// calendar day than the hạn lệnh. Same-day (any hour) is NOT late.
function isPlanLate(plannedDatetime, hanLenh) {
  if (!hanLenhUsable(hanLenh)) return false;
  const planned = vnDateStr(plannedDatetime);
  if (!planned) return false;                 // unparseable date => cannot evaluate
  return planned > vnDateStr(hanLenh);        // "YYYY-MM-DD" compare == chronological
}

// Do two values land on the SAME Vietnam calendar day?
//
// This is how PATCH tells "changed" from "unchanged", and it must NOT be raw
// string equality: the client round-trips a stored instant through
// toDatetimeLocal -> vnLocalToIso, so a submitted "2026-09-05T17:00:00+07:00"
// is textually nothing like the stored "2026-09-05T10:00:00.000Z" while meaning
// the same instant. Comparing on the VN DATE also means a time-only tweak
// (08:00 -> 17:00, same day) counts as unchanged — correct, because the date is
// what the verdict depends on, so the verdict cannot have moved.
function isSameVnDate(a, b) {
  const da = vnDateStr(a);
  return da !== null && da === vnDateStr(b);
}

// Whole days late, for the message. Both args are VN "YYYY-MM-DD" strings.
function daysBetween(fromDate, toDate) {
  const ms = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

// "DD/MM/YYYY" from a VN "YYYY-MM-DD" key.
function vnKeyToDisplay(key) {
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

// "DD/MM/YYYY HH:mm" in VN time.
function vnDisplayDateTime(val) {
  const p = vnParts(val);
  return p ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : '—';
}

// ── The DB-backed check ─────────────────────────────────────────────────────
// checks: [{ jobId, plannedDatetime, containerIds?: number[] }]
//   Pass ONLY the dates that are new or actually being changed — an untouched
//   stored date must never be re-validated (that is what lets an existing late
//   plan keep saving when the carrier / số xe / cost is edited).
//
// Returns { ok: true } or { ok: false, error, code, violations }.
// Every violating container is named in ONE message: the caller rejects the
// WHOLE save, so a DD is never left guessing which row failed (and never ends
// up with a half-saved plan — the L38 failure mode).
async function checkPlansAgainstHanLenh(client, checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { ok: true };

  const jobIds = [...new Set(checks.map(c => Number(c.jobId)).filter(Number.isFinite))];
  if (jobIds.length === 0) return { ok: true };

  const { rows: jobRows } = await client.query(
    `SELECT id, job_code, cargo_type, import_export, han_lenh
       FROM jobs WHERE id = ANY($1::int[])`,
    [jobIds]
  );
  const jobById = new Map(jobRows.map(j => [j.id, j]));

  const violations = [];
  for (const c of checks) {
    const job = jobById.get(Number(c.jobId));
    if (!jobInGuardScope(job)) continue;               // LCL / export / unknown job
    if (!isPlanLate(c.plannedDatetime, job.han_lenh)) continue;
    violations.push({
      job,
      plannedDatetime: c.plannedDatetime,
      containerIds: (Array.isArray(c.containerIds) ? c.containerIds : [])
        .map(Number).filter(Number.isFinite),
    });
  }
  if (violations.length === 0) return { ok: true };

  // Container numbers for the message. Looked up ONLY once something is late,
  // so the happy path costs a single jobs query.
  const contIds = [...new Set(violations.flatMap(v => v.containerIds))];
  let contNameById = new Map();
  if (contIds.length > 0) {
    const { rows: contRows } = await client.query(
      `SELECT id, cont_number FROM job_containers WHERE id = ANY($1::int[])`,
      [contIds]
    );
    contNameById = new Map(contRows.map(r => [r.id, r.cont_number]));
  }

  // Group by job so a multi-job batch reads cleanly.
  const byJob = new Map();
  for (const v of violations) {
    const arr = byJob.get(v.job.id) || [];
    arr.push(v);
    byJob.set(v.job.id, arr);
  }

  const blocks = [];
  for (const [, vs] of byJob) {
    const job = vs[0].job;
    const hanKey = vnDateStr(job.han_lenh);
    const hanTxt = vnKeyToDisplay(hanKey);
    const lines = vs.map(v => {
      const names = v.containerIds
        .map(id => contNameById.get(id))
        .filter(n => n && String(n).trim());
      const who = names.length > 0 ? `Cont ${names.join(', ')}` : 'Kế hoạch giao';
      const late = daysBetween(hanKey, vnDateStr(v.plannedDatetime));
      return `• ${who}: dự kiến giao ${vnDisplayDateTime(v.plannedDatetime)}`
           + ` — sau hạn lệnh ${hanTxt} (trễ ${late} ngày)`;
    });
    blocks.push(`Job ${job.job_code || `#${job.id}`} — hạn lệnh ${hanTxt}:\n${lines.join('\n')}`);
  }

  return {
    ok: false,
    code: 'HAN_LENH_EXCEEDED',
    violations,
    error:
      'Ngày giao dự kiến nằm sau hạn lệnh — cần cập nhật lại hạn lệnh trước khi lưu kế hoạch.\n'
      + blocks.join('\n') + '\n'
      + 'Nếu hạn lệnh đã được gia hạn, vui lòng cập nhật lại Hạn lệnh trên job rồi lưu lại kế hoạch. '
      + 'Chưa có dòng nào được lưu.',
  };
}

module.exports = {
  HAN_LENH_MIN_YEAR,
  HAN_LENH_MAX_YEAR,
  vnDateStr,
  hanLenhUsable,
  jobInGuardScope,
  isPlanLate,
  isSameVnDate,
  checkPlansAgainstHanLenh,
};
