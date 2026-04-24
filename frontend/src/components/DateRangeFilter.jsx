import { useState } from 'react';

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const today = () => localDate(new Date());
const daysAgo = n => localDate(new Date(Date.now() - n * 86400000));

// '3d' preset sends no dates — backend defaults to last 3 days.
const PRESETS = [
  { key: '3d',    label: '3 ngày',    getDates: () => ({}) },
  { key: '7d',    label: '7 ngày',    getDates: () => ({ from_date: daysAgo(6), to_date: today() }) },
  { key: '30d',   label: '30 ngày',   getDates: () => ({ from_date: daysAgo(29), to_date: today() }) },
  { key: 'month', label: 'Tháng này', getDates: () => {
    const d = new Date();
    return { from_date: localDate(new Date(d.getFullYear(), d.getMonth(), 1)), to_date: today() };
  }},
  { key: 'custom', label: 'Tùy chọn', getDates: null },
];

// onChange({ from_date?, to_date? }) — called whenever range changes
export default function DateRangeFilter({ onChange }) {
  const [preset, setPreset] = useState('3d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function selectPreset(p) {
    setPreset(p.key);
    if (p.getDates) onChange(p.getDates());
  }

  function applyCustom() {
    onChange({ from_date: from || undefined, to_date: to || undefined });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {PRESETS.map(p => (
        <button key={p.key}
          className={`btn btn-sm ${preset === p.key ? 'btn-primary' : 'btn-ghost'}`}
          style={{ fontSize: 11, padding: '3px 10px' }}
          onClick={() => selectPreset(p)}>
          {p.label}
        </button>
      ))}
      {preset === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }} />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>→</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }} />
          <button className="btn btn-primary btn-sm" style={{ fontSize: 11 }} onClick={applyCustom}>
            Áp dụng
          </button>
        </div>
      )}
    </div>
  );
}
