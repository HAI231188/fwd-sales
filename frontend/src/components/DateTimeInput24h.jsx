import { useState, useMemo, useEffect } from 'react';
import { toDatetimeLocal, vnLocalToIso } from '../utils/dateFmt';

// DateTimeInput24h — replacement for <input type="datetime-local"> when we
// need a deterministic 24-hour picker without browser locale leakage and
// without minute granularity.
//
// Renders: [date picker] [hour <select> 00–23, suffix ":00"]
// Emits:   "YYYY-MM-DDTHH:00" or "" (matches the wire format the rest of the
//          app and the backend already use, so callers don't need to adapt).
//
// Props:
//   value     — string, "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS...]". Minute
//               and seconds are tolerated on input (we strip them) but the
//               output is always :00.
//   onChange  — (string) => void. Called with "" when date is cleared, or
//               "YYYY-MM-DDTHH:00" when a date is present. Never emits with
//               an empty date + non-empty hour — see spec.
//   required  — bool, forwarded to <input type="date">.
//   disabled  — bool, applied to both inputs.
//
// Internal hour state: localHour lets the user pick the hour before picking
// a date, even though we don't emit until the date is set. Re-syncs from
// `value` when it changes externally (e.g. modal pre-fill).

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const hh = String(h).padStart(2, '0');
  return { value: hh, label: `${hh}:00` };
});

export default function DateTimeInput24h({ value, onChange, required, disabled }) {
  const parsed = useMemo(() => {
    // Normalize ANY incoming form (raw UTC ISO from the backend, a VN-anchored
    // ISO from a prior edit, or a naive local string) to the VN "YYYY-MM-DDTHH:mm"
    // wall-clock, so the picker shows Vietnam time regardless of source/browser.
    const local = value ? toDatetimeLocal(value) : '';
    const dateMatch = local.match(/^(\d{4}-\d{2}-\d{2})/);
    const hourMatch = local.match(/T(\d{2})/);
    return {
      date: dateMatch ? dateMatch[1] : '',
      hour: hourMatch ? hourMatch[1] : '08',
    };
  }, [value]);

  // Local hour state — lets the user spin the hour select even before a
  // date is picked. Re-syncs whenever the parsed hour from `value` changes.
  const [localHour, setLocalHour] = useState(parsed.hour);
  useEffect(() => { setLocalHour(parsed.hour); }, [parsed.hour]);

  const date = parsed.date;

  // Emit a Vietnam-anchored ISO ("...+07:00") so storage is unambiguous (the
  // naive "YYYY-MM-DDTHH:00" would otherwise be stored in the UTC session TZ
  // and shift +7h on read-back). Cleared date still emits "" (callers null it).
  function setDate(newDate) {
    if (!newDate) { onChange?.(''); return; }
    onChange?.(vnLocalToIso(`${newDate}T${localHour}:00`));
  }
  function setHour(newHour) {
    setLocalHour(newHour);
    // Only emit when a date is already present — without a date the value
    // would be malformed ("T08:00") which the backend wouldn't accept.
    if (date) onChange?.(vnLocalToIso(`${date}T${newHour}:00`));
  }

  const baseInp = {
    padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, minWidth: 0, boxSizing: 'border-box',
    background: disabled ? 'var(--bg)' : '#fff',
    color: disabled ? 'var(--text-3)' : 'var(--text)',
  };

  return (
    <div style={{ display: 'flex', gap: 6, minWidth: 0, width: '100%' }}>
      <input type="date"
        style={{ ...baseInp, flex: '1 1 0' }}
        value={date}
        onChange={e => setDate(e.target.value)}
        required={required}
        disabled={disabled} />
      <select
        style={{ ...baseInp, width: 88, flex: '0 0 auto', cursor: disabled ? 'not-allowed' : 'pointer' }}
        value={localHour}
        onChange={e => setHour(e.target.value)}
        disabled={disabled}
        aria-label="Giờ">
        {HOUR_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
