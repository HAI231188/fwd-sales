// Shared date / time formatters — single source for the previously-duplicated
// fmtDate / fmtDt copies that lived in 15 components.
//
// IMPORTANT: these variants are NOT interchangeable. The prior local copies
// genuinely diverged in padding, field order, separators, year presence, and
// null placeholder. To keep every screen byte-for-byte identical (this is a
// pure dedup, NOT a redesign), each call site imports the variant that
// reproduces its exact previous output — usually aliased to its old local name
// (e.g. `import { fmtDateTime as fmtDt } from '../utils/dateFmt'`).
//
// Reference outputs for 2026-06-01 10:05 (Asia/Ho_Chi_Minh):
//   fmtDate              -> "1/6/2026"          (unpadded, vi-VN default)
//   fmtDatePadded        -> "01/06/2026"        (2-digit, year)
//   fmtDateTime          -> "10:05 01-06"       (time-first, NO year, dash)
//   fmtDateTimeYear      -> "10:05 01/06/2026"  (time-first, with year)
//   fmtDateTimeDateFirst -> "01/06/2026 10:05"  (date-first, manual pad)
//   localDateStr(Date)   -> "2026-06-01"        (LOCAL parts, per L3)

// Unpadded date "D/M/YYYY" via vi-VN default. null/empty -> "—".
// Used by all dashboards + most modals' fmtDate.
export function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}

// Padded date "DD/MM/YYYY". null/empty -> "". Accepts Date or string;
// invalid date falls back to String(input). Used by the quote displays.
export function fmtDatePadded(d) {
  if (!d) return '';
  try {
    const date = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(d); }
}

// Date+time, time-first, NO year: "HH:mm DD-MM" via vi-VN toLocaleString.
// null/empty -> "—". The most common fmtDt variant.
export function fmtDateTime(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Date+time, time-first, WITH year: "HH:mm DD/MM/YYYY" via vi-VN toLocaleString.
// null/empty -> "—". Used by JobDetailModal / CustomerEditModal / CustomerJobsModal.
export function fmtDateTimeYear(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Date+time, date-first, manual padding: "DD/MM/YYYY HH:mm".
// null or invalid -> "—". Used by CancelMailConfirmModal.
export function fmtDateTimeDateFirst(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "YYYY-MM-DD" from LOCAL date parts — NEVER toISOString (UTC) per L3.
export function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
