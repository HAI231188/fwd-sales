// Shared date / time formatters — single source for the previously-duplicated
// fmtDate / fmtDt / toDatetimeLocal copies that lived across the dashboards/modals.
//
// TIMEZONE (L3, extended 2026-06-15): the company operates ONLY in Vietnam.
// Storage is UTC (TIMESTAMPTZ); ALL display + datetime-input handling is pinned
// to Asia/Ho_Chi_Minh (fixed +07:00, no DST) so a value entered as 10:30 reads
// back as exactly 10:30 regardless of the viewer's machine timezone.
//   - READ/display  -> the fmt* helpers below format in Asia/Ho_Chi_Minh.
//   - INPUT value   -> toDatetimeLocal() renders the stored instant as the VN
//                      "YYYY-MM-DDTHH:mm" string a datetime input expects.
//   - WRITE/save    -> vnLocalToIso() turns that naive string into a VN-anchored
//                      ISO ("...+07:00") so storage is unambiguous (no session-TZ
//                      dependence). This is the save-side counterpart to L3.
// localDateStr (LOCAL parts, used by the L3 sales follow-up/stats date-compare)
// is intentionally NOT changed.
//
// Reference outputs for the instant 2026-06-01 10:05 Asia/Ho_Chi_Minh:
//   fmtDate              -> "1/6/2026"          (unpadded, vi-VN)
//   fmtDatePadded        -> "01/06/2026"        (2-digit, year)
//   fmtDateTime          -> "10:05 01-06"       (time-first, NO year, dash)
//   fmtDateTimeYear      -> "10:05 01/06/2026"  (time-first, with year)
//   fmtDateTimeDateFirst -> "01/06/2026 10:05"  (date-first)
//   toDatetimeLocal      -> "2026-06-01T10:05"  (datetime-input value, VN)
//   vnLocalToIso         -> "2026-06-01T10:05:00+07:00"  (wire value to backend)

const VN_TZ = 'Asia/Ho_Chi_Minh';

// Vietnam-time parts {y,mo,d,h,mi} of a stored instant, or null if unparseable.
function vnParts(val) {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  if (p.hour === '24') p.hour = '00'; // some engines emit 24 for midnight
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

// Unpadded date "D/M/YYYY" in Vietnam time. null/empty -> "—".
export function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN', { timeZone: VN_TZ });
}

// Padded date "DD/MM/YYYY" in Vietnam time. null/empty -> "". invalid -> String(input).
export function fmtDatePadded(d) {
  if (!d) return '';
  try {
    const date = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('vi-VN', { timeZone: VN_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(d); }
}

// Date+time, time-first, NO year: "HH:mm DD-MM" in Vietnam time. null/empty -> "—".
export function fmtDateTime(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    timeZone: VN_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Date+time, time-first, WITH year: "HH:mm DD/MM/YYYY" in Vietnam time. null/empty -> "—".
export function fmtDateTimeYear(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    timeZone: VN_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Date+time, date-first: "DD/MM/YYYY HH:mm" in Vietnam time. null/invalid -> "—".
export function fmtDateTimeDateFirst(val) {
  if (!val) return '—';
  const p = vnParts(val);
  if (!p) return '—';
  return `${p.d}/${p.mo}/${p.y} ${p.h}:${p.mi}`;
}

// "YYYY-MM-DD" from LOCAL date parts — NEVER toISOString (UTC) per L3.
// Intentionally left on local parts (the sales follow-up/stats compare path).
export function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Stored instant -> "YYYY-MM-DDTHH:mm" in Vietnam time, for a datetime input's
// `value` (datetime-local / DateTimeInput24h). Empty/invalid -> "".
export function toDatetimeLocal(val) {
  if (!val) return '';
  const p = vnParts(val);
  if (!p) return '';
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}`;
}

// Naive "YYYY-MM-DDTHH:mm[:ss]" (what a date/time input emits) -> Vietnam-anchored
// ISO "YYYY-MM-DDTHH:mm:ss+07:00" for the backend, so storage is unambiguous.
// Vietnam is fixed +07:00 (no DST). Already-anchored (offset/Z) values pass
// through unchanged (idempotent). Empty -> null. Date-only / unmatched -> as-is.
export function vnLocalToIso(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(str)) return str; // already TZ-anchored
  const m = str.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return str;
  const [, date, hh, mi, ss] = m;
  return `${date}T${hh}:${mi}:${ss || '00'}+07:00`;
}
