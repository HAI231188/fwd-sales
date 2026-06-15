'use strict';

// ── Single source of truth for BACKEND Vietnam-time datetime rendering (L3) ──
//
// Storage is UTC TIMESTAMPTZ and the server process runs in UTC on Railway, so
// Date#getHours()/getDate() — and timeZone-less toLocaleString — print UTC: −7h
// (19:00 VN → 12:00), and a VN-midnight value day-shifts to the previous
// calendar day. EVERY backend renderer of a STORED datetime (emails, BBBG PDF,
// notifications) must format through this module instead of local getters.
//
// Vietnam = Asia/Ho_Chi_Minh, fixed +07:00, no DST. This mirrors the semantics
// of the frontend utils/dateFmt.js but is a separate runtime — the two are
// intentionally NOT shared across the frontend/backend boundary.

const VN_TZ = 'Asia/Ho_Chi_Minh';

// Cached formatter — built once, reused. 'en-GB' + hour12:false gives the
// zero-padded 24-hour parts we assemble into DD/MM/YYYY HH:mm ourselves.
const VN_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// Extract VN-local wall-clock parts. Returns { year, month, day, hour, minute }
// (all zero-padded strings) or null for empty/invalid input.
function vnParts(val) {
  if (!val) return null;
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  const p = {};
  for (const part of VN_PARTS_FMT.formatToParts(d)) p[part.type] = part.value;
  // hour12:false can surface '24' at midnight on some engines — normalize to 00.
  return {
    year: p.year, month: p.month, day: p.day,
    hour: p.hour === '24' ? '00' : p.hour, minute: p.minute,
  };
}

// "DD/MM/YYYY HH:mm" — full datetime. Empty/invalid → `empty` (default '—').
function fmtVnDateTime(val, empty = '—') {
  const v = vnParts(val);
  return v ? `${v.day}/${v.month}/${v.year} ${v.hour}:${v.minute}` : empty;
}

// "DD/MM/YYYY" — date only.  Empty/invalid → `empty` (default '—').
function fmtVnDate(val, empty = '—') {
  const v = vnParts(val);
  return v ? `${v.day}/${v.month}/${v.year}` : empty;
}

// han_lenh (L19): 'import' = date only "DD/MM/YYYY"; 'export' = full datetime
// "DD/MM/YYYY HH:mm". Same column, sibling-driven format. Empty/invalid → `empty`.
function fmtVnHanLenh(val, impExp, empty = '—') {
  return impExp === 'import' ? fmtVnDate(val, empty) : fmtVnDateTime(val, empty);
}

// "DD/MM" — short date for the mail subject. Empty/invalid → `empty` (default '').
function fmtVnShortDate(val, empty = '') {
  const v = vnParts(val);
  return v ? `${v.day}/${v.month}` : empty;
}

// "DD/MM, HH:mm" (vi-VN locale) — the in-app deadline-notification wording.
// Kept as a distinct formatter so the existing notification text stays
// byte-identical (no year, locale comma) while the time renders in VN tz.
const VN_DEADLINE_FMT = new Intl.DateTimeFormat('vi-VN', {
  timeZone: VN_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
function fmtVnDeadline(val, empty = '') {
  if (!val) return empty;
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return empty;
  return VN_DEADLINE_FMT.format(d);
}

module.exports = {
  VN_TZ,
  vnParts,
  fmtVnDateTime,
  fmtVnDate,
  fmtVnHanLenh,
  fmtVnShortDate,
  fmtVnDeadline,
};
