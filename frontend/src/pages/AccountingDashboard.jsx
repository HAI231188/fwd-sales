// KT3 — Accounting (Kế toán công nợ) dashboard skeleton.
//
// Layout: 3 tiers
//   Tầng 1: 4 KPI cards (pending_check / checked / debit_sent / tổng công nợ)
//   Tầng 2: 2 Recharts (30-day completion line + status donut) — desktop only,
//           hidden at ≤768px to keep mobile from overflowing.
//   Tầng 3: 4 sub-tab pills + overdue toggle (debit_sent only) + placeholder
//           content — KT4 will swap the placeholder for the real job table.
//
// Polling: both stats and the active sub-tab list refetch every 30s.

import { useState, useEffect, Component } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import Navbar from '../components/Navbar';
import { getAccountingStats, getAccountingJobs } from '../api';

// ─── Mobile detection hook ─────────────────────────────────────────────────
// Tầng 2 is hidden at ≤768px. Using JS rather than CSS because the chart
// libraries do not unmount cleanly via `display: none` (ResponsiveContainer
// recomputes on every resize and can flicker).
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= 768
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isMobile;
}

// ─── ChartErrorBoundary ────────────────────────────────────────────────────
// Mirrors TP_OverviewSection's pattern (lines 10-25). Catches any render
// error inside the chart subtree so a single bad data point doesn't blank
// the whole dashboard.
class ChartErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 14 }}>Không thể tải biểu đồ</div>
          <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-3)' }}>
            {String(this.state.error.message)}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Sub-tab config ────────────────────────────────────────────────────────
const SUB_TABS = [
  { key: 'pending_check', label: '🟡 Chờ xử lý',    color: 'var(--warning)', bg: '#fffbeb', border: '#fde68a', countKey: 'pending_check' },
  { key: 'checked',       label: '✅ Đã kiểm tra',  color: 'var(--info)',    bg: '#eff6ff', border: '#bfdbfe', countKey: 'checked' },
  { key: 'debit_sent',    label: '📧 Đã gửi debit', color: 'var(--primary)', bg: '#f0fdf4', border: '#bbf7d0', countKey: 'debit_sent' },
  { key: 'paid',          label: '💵 Đã thu',       color: '#16a34a',        bg: '#dcfce7', border: '#86efac', countKey: 'paid' },
];

// Donut palette — matches the SUB_TABS colors so the legend reads naturally
// next to the sub-tab buttons.
const DONUT_PALETTE = ['#d97706', '#3b82f6', '#16a34a', '#10b981'];

// Format the YYYY-MM-DD date string into the short DD/MM the X axis renders.
function fmtTick(d) {
  if (!d || typeof d !== 'string' || d.length < 10) return d;
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

export default function AccountingDashboard() {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState('pending_check');
  const [showOnlyOverdue, setShowOnlyOverdue] = useState(false);

  const statsQ = useQuery({
    queryKey: ['accounting', 'stats'],
    queryFn: getAccountingStats,
    refetchInterval: 30000,
  });
  const stats = statsQ.data || { counts: {}, completed_per_day_30d: [] };
  const counts = stats.counts || {};
  const overdueCount = counts.debit_sent_overdue || 0;

  // The overdue toggle is only meaningful on the debit_sent tab; reset it
  // when the user switches away to avoid stale query params.
  useEffect(() => {
    if (activeTab !== 'debit_sent' && showOnlyOverdue) setShowOnlyOverdue(false);
  }, [activeTab, showOnlyOverdue]);

  const tabQ = useQuery({
    queryKey: ['accounting', 'jobs', activeTab, showOnlyOverdue],
    queryFn: () => getAccountingJobs({
      tab: activeTab,
      ...(activeTab === 'debit_sent' && showOnlyOverdue ? { overdue: 'true' } : {}),
    }),
    refetchInterval: 30000,
  });
  const tabData = tabQ.data || [];

  // Donut input. Skip debit_sent_overdue (sub-count, not its own slice).
  const donutData = [
    { name: 'Chờ xử lý',    value: counts.pending_check || 0 },
    { name: 'Đã kiểm tra',  value: counts.checked || 0 },
    { name: 'Đã gửi debit', value: counts.debit_sent || 0 },
    { name: 'Đã thu',       value: counts.paid || 0 },
  ];
  const donutTotal = donutData.reduce((s, x) => s + x.value, 0);

  // Card 3 click jumps to debit_sent sub-tab; if there are overdue rows,
  // pre-select the overdue toggle so KT lands on the actionable subset.
  function onCard3Click() {
    setActiveTab('debit_sent');
    if (overdueCount > 0) setShowOnlyOverdue(true);
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px 60px' }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginBottom: 4 }}>
            💼 Kế Toán Công Nợ
          </h1>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            Quản lý lifecycle công nợ phải thu — kiểm tra, gửi debit, thu tiền
          </p>
          {statsQ.dataUpdatedAt > 0 && (
            <p style={{ color: 'var(--text-3)', fontSize: 11, margin: '4px 0 0' }}>
              Cập nhật lúc {new Date(statsQ.dataUpdatedAt).toLocaleTimeString('vi-VN')}
            </p>
          )}
        </div>

        {/* ───── TẦNG 1: 4 KPI cards ───── */}
        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <KpiCard
            icon="🟡" label="Chờ xử lý"
            value={statsQ.isLoading ? '...' : (counts.pending_check ?? 0)}
            color="var(--warning)"
            onClick={() => setActiveTab('pending_check')}
          />
          <KpiCard
            icon="✅" label="Đã kiểm tra"
            value={statsQ.isLoading ? '...' : (counts.checked ?? 0)}
            color="var(--info)"
            onClick={() => setActiveTab('checked')}
          />
          <KpiCard
            icon="📧" label="Đã gửi debit chờ thu"
            value={statsQ.isLoading ? '...' : (counts.debit_sent ?? 0)}
            color="var(--primary)"
            sub={overdueCount > 0
              ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>🔴 {overdueCount} quá hạn</span>
              : null}
            onClick={onCard3Click}
          />
          <KpiCard
            icon="💰" label="Tổng công nợ"
            value="—"
            color="var(--text-3)"
            sub={<span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>(Phase 2)</span>}
          />
        </div>

        {/* ───── TẦNG 2: 2 charts (desktop only) ───── */}
        {!isMobile && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
            marginBottom: 24,
          }}>
            {/* Line chart: 30-day completion */}
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                📈 Hoàn thành 30 ngày qua
              </div>
              <ChartErrorBoundary>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={stats.completed_per_day_30d}
                    margin={{ top: 8, right: 16, left: -8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tickFormatter={fmtTick} fontSize={11} />
                    <YAxis allowDecimals={false} fontSize={11} />
                    <Tooltip
                      labelFormatter={fmtTick}
                      formatter={(v) => [`${v} job(s)`, 'Hoàn thành']}
                    />
                    <Line type="monotone" dataKey="count" stroke="#16a34a" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </ChartErrorBoundary>
            </div>

            {/* Donut chart: status distribution */}
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                🥧 Phân bổ trạng thái
              </div>
              <ChartErrorBoundary>
                <div style={{ position: 'relative' }}>
                  <ResponsiveContainer width="100%" height={240}>
                    <PieChart>
                      <Pie
                        data={donutData}
                        cx="50%" cy="50%"
                        innerRadius={50} outerRadius={80}
                        dataKey="value" nameKey="name"
                        paddingAngle={donutTotal > 0 ? 2 : 0}
                      >
                        {donutData.map((_, idx) => (
                          <Cell key={idx} fill={DONUT_PALETTE[idx % DONUT_PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend verticalAlign="bottom" iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center label — total of the 4 slices. */}
                  <div style={{
                    position: 'absolute',
                    top: 'calc(50% - 24px)', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    textAlign: 'center', pointerEvents: 'none',
                  }}>
                    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                      {donutTotal}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-2)' }}>Tổng</div>
                  </div>
                </div>
              </ChartErrorBoundary>
            </div>
          </div>
        )}

        {/* ───── TẦNG 3: 4 sub-tab nav + (debit_sent only) overdue toggle ───── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Sub-tab pill row */}
          <div style={{
            display: 'flex', gap: 8, flexWrap: 'wrap',
            padding: '14px 16px', borderBottom: '1px solid var(--border)',
          }}>
            {SUB_TABS.map(s => {
              const isActive = activeTab === s.key;
              const count = counts[s.countKey];
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveTab(s.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 14px',
                    background: isActive ? s.bg : 'var(--bg-card)',
                    border: `1.5px solid ${isActive ? s.color : 'var(--border)'}`,
                    borderRadius: 'var(--radius)',
                    color: isActive ? s.color : 'var(--text-2)',
                    fontFamily: 'var(--font)',
                    fontSize: 13, fontWeight: isActive ? 600 : 500,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span>{s.label}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>
                    ({statsQ.isLoading ? '…' : (count ?? 0)})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Overdue toggle — debit_sent tab only */}
          {activeTab === 'debit_sent' && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={showOnlyOverdue}
                  onChange={e => setShowOnlyOverdue(e.target.checked)}
                />
                🔴 Chỉ xem quá hạn (&gt;30 ngày)
                {overdueCount > 0 && (
                  <span style={{
                    marginLeft: 4,
                    background: 'var(--danger-dim)', color: 'var(--danger)',
                    borderRadius: 10, padding: '1px 8px',
                    fontSize: 11, fontWeight: 600,
                  }}>{overdueCount}</span>
                )}
              </label>
            </div>
          )}

          {/* Placeholder content — KT4 will swap in <FilteredTable> with the
              real columns + action buttons. */}
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
            {tabQ.isLoading
              ? 'Đang tải...'
              : tabData.length === 0
                ? 'Không có job nào'
                : `${tabData.length} job(s) — KT4 sẽ render bảng tại đây`}
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── KpiCard — local helper ────────────────────────────────────────────────
// Inline instead of using the shared <StatCard> because (a) we need a custom
// `sub` slot (the "🔴 N quá hạn" + "(Phase 2)" sub-lines), and (b) clicks
// dispatch tab-state changes, not the StatCard's drilldown contract.
function KpiCard({ icon, label, value, color, sub, onClick }) {
  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        padding: '16px 18px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{label}</span>
      </div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 28, fontWeight: 700, color, lineHeight: 1.1,
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12 }}>{sub}</div>
      )}
    </div>
  );
}
