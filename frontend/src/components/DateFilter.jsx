import { useState } from 'react';
import { format, startOfMonth, subDays } from 'date-fns';

const PRESETS = [
  { key: 'today', label: 'Hôm nay' },
  { key: '7days', label: '7 ngày' },
  { key: 'month', label: 'Tháng này' },
  { key: 'custom', label: 'Tùy chọn' },
];

export function useDateFilter() {
  const [preset, setPreset] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const today = format(new Date(), 'yyyy-MM-dd');

  const getRange = () => {
    switch (preset) {
      case 'today': return { startDate: today, endDate: today };
      case '7days': return { startDate: format(subDays(new Date(), 6), 'yyyy-MM-dd'), endDate: today };
      case 'month': return { startDate: format(startOfMonth(new Date()), 'yyyy-MM-dd'), endDate: today };
      case 'custom': return { startDate: customStart || today, endDate: customEnd || today };
      default: return { startDate: today, endDate: today };
    }
  };

  return { preset, setPreset, customStart, setCustomStart, customEnd, setCustomEnd, getRange };
}

export default function DateFilter({ preset, setPreset, customStart, setCustomStart, customEnd, setCustomEnd }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '10px 14px',
      marginBottom: 24,
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500, marginRight: 4 }}>📅 Lọc:</span>
      {PRESETS.map(p => (
        <button
          key={p.key}
          className={`btn btn-sm ${preset === p.key ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setPreset(p.key)}
          style={{ fontSize: 13 }}
        >
          {p.label}
        </button>
      ))}

      {preset === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
          <input
            type="date"
            className="form-input"
            value={customStart}
            onChange={e => setCustomStart(e.target.value)}
            style={{ width: 150, padding: '6px 10px', fontSize: 13 }}
          />
          <span style={{ color: 'var(--text-2)', fontSize: 13 }}>→</span>
          <input
            type="date"
            className="form-input"
            value={customEnd}
            onChange={e => setCustomEnd(e.target.value)}
            style={{ width: 150, padding: '6px 10px', fontSize: 13 }}
          />
        </div>
      )}
    </div>
  );
}
