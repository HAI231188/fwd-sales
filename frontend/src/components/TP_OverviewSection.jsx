import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getJobOverview } from '../api';

const PRESETS = [
  { label: '7 ngày', value: '7d' },
  { label: '30 ngày', value: '30d' },
  { label: 'Tháng này', value: 'month' },
  { label: 'Tùy chọn', value: 'custom' },
];

const COLORS = ['#22c55e', '#3b82f6', '#d97706', '#ef4444', '#7c3aed', '#ec4899'];

function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildRange(preset, customFrom, customTo) {
  const now = new Date();
  if (preset === '7d') {
    const from = new Date(now); from.setDate(from.getDate() - 6);
    return { from: localDate(from), to: localDate(now) };
  }
  if (preset === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: localDate(from), to: localDate(now) };
  }
  if (preset === 'custom') {
    return { from: customFrom, to: customTo };
  }
  // 30d default
  const from = new Date(now); from.setDate(from.getDate() - 29);
  return { from: localDate(from), to: localDate(now) };
}

function fmtDay(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

const CustomLineTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
};

const CustomBarTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.fill }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
};

const RADIAN = Math.PI / 180;
function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }) {
  if (percent < 0.05) return null;
  const r = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="white" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

export default function TP_OverviewSection() {
  const [preset, setPreset] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(() => buildRange(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const rangeReady = preset !== 'custom' || (customFrom && customTo);

  const { data, isLoading } = useQuery({
    queryKey: ['jobOverview', range],
    queryFn: () => getJobOverview(range),
    enabled: !!rangeReady,
  });

  const dailyData = useMemo(() => {
    if (!data?.daily_stats) return [];
    return data.daily_stats.map(d => ({ ...d, day: fmtDay(d.date) }));
  }, [data]);

  const staffData = useMemo(() => {
    if (!data?.staff_distribution) return [];
    return data.staff_distribution;
  }, [data]);

  const staffNames = useMemo(() => {
    const names = new Set();
    staffData.forEach(row => Object.keys(row).forEach(k => { if (k !== 'date' && k !== 'day') names.add(k); }));
    return [...names];
  }, [staffData]);

  const statusData = useMemo(() => {
    if (!data?.completion_status) return [];
    return data.completion_status;
  }, [data]);

  const totalStatus = statusData.reduce((s, d) => s + (d.value || 0), 0);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700 }}>Tổng quan</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => (
            <button
              key={p.value}
              onClick={() => setPreset(p.value)}
              className={`btn btn-sm ${preset === p.value ? 'btn-primary' : 'btn-ghost'}`}
              style={{ fontSize: 12 }}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <>
              <input type="date" className="form-input" style={{ width: 140, fontSize: 12, padding: '4px 8px' }}
                value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
              <span style={{ color: 'var(--text-2)', fontSize: 12 }}>–</span>
              <input type="date" className="form-input" style={{ width: 140, fontSize: 12, padding: '4px 8px' }}
                value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>

          {/* Chart 1: Job trend line */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 12 }}>Số job theo thời gian</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={dailyData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-2)' }} allowDecimals={false} />
                <Tooltip content={<CustomLineTooltip />} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="created" name="Tạo mới" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="completed" name="Hoàn thành" stroke="#22c55e" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 2: Stacked bar by staff */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 12 }}>Phân bổ job theo nhân viên</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={staffData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--text-2)' }} allowDecimals={false} />
                <Tooltip content={<CustomBarTooltip />} />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                {staffNames.map((name, i) => (
                  <Bar key={name} dataKey={name} name={name} stackId="a" fill={COLORS[i % COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Chart 3: Donut — completion status */}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 12 }}>Trạng thái hoàn thành</div>
            <div style={{ position: 'relative' }}>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    dataKey="value"
                    labelLine={false}
                    label={renderCustomLabel}
                  >
                    {statusData.map((entry, i) => (
                      <Cell key={entry.name} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(val, name) => [val, name]} />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
              {totalStatus > 0 && (
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%, -60%)',
                  textAlign: 'center', pointerEvents: 'none',
                }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{totalStatus}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-2)' }}>job</div>
                </div>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
