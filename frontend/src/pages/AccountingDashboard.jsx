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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import Navbar from '../components/Navbar';
import FilteredTable from '../components/FilteredTable';
import JobDetailModal from '../components/JobDetailModal';
import DateRangeFilter from '../components/DateRangeFilter';
import {
  getAccountingStats, getAccountingJobs,
  accountingCheck, accountingDebitSent, accountingPaymentReceived,
  accountingReturnToLog, accountingReturnToSales,
} from '../api';
import { fmtDate, fmtDateTime as fmtDt } from '../utils/dateFmt';

// ─── Constants ─────────────────────────────────────────────────────────────
const OVERDUE_DAYS       = 30; // Sub-tab 3: red badge if debit_sent_at + 30d
const WAITING_DEBIT_WARN = 3;  // Sub-tab 2: red badge if accounting_checked_at + 3d

const SVC_LABEL = { tk: 'TK', truck: 'Xe', both: 'TK+Xe', ops_hp: 'OPS HP' };

function fmtCargo(j) {
  if (j.cargo_type === 'lcl') {
    const parts = [];
    if (j.so_kien) parts.push(`${j.so_kien} kiện`);
    if (j.kg) parts.push(`${j.kg}kg`);
    if (j.cbm) parts.push(`${j.cbm}CBM`);
    return 'LCL' + (parts.length ? ' - ' + parts.join('/') : '');
  }
  const conts = Array.isArray(j.containers) ? j.containers : [];
  if (conts.length) {
    const grouped = {};
    conts.forEach(c => { grouped[c.cont_type] = (grouped[c.cont_type] || 0) + 1; });
    return Object.entries(grouped).map(([t, n]) => `${t} x${n}`).join(', ');
  }
  if (j.cont_number) return `${j.cont_number}${j.cont_type ? ' / ' + j.cont_type : ''}`;
  return '—';
}

// Days-since helpers used for the red overdue / warning badges in Sub-tabs
// 2 and 3 (since-checked, since-debit-sent) plus Sub-tab 4's elapsed metric.
function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}
function daysBetween(start, end) {
  if (!start || !end) return null;
  return Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 86400000);
}

// ─── Column arrays — keys consumed by the shared cell() switch below ──────
// label = display in header + as filter dropdown title (if filterType set).
// Filter dropdowns added only on the always-useful columns (job_code, customer)
// to keep the header lean.
const COLS_PENDING_CHECK = [
  { key: 'stt',              label: '#' },
  { key: 'job_code',         label: 'Số job',          filterType: 'text' },
  { key: 'si_number',        label: 'Mã SI',           filterType: 'text' },
  { key: 'import_export',    label: 'Loại' },
  { key: 'customer_name',    label: 'Tên khách',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',          label: 'DV' },
  { key: 'cargo',            label: 'Cont-Loại' },
  { key: 'completed_at',     label: 'Ngày hoàn thành' },
  { key: 'revenue_entered_at', label: 'Ngày Sales tick' },
  { key: 'sales_name',       label: 'Sales' },
  { key: 'returned_badge',   label: 'Trả về' },
];

const COLS_CHECKED = [
  { key: 'stt',                       label: '#' },
  { key: 'job_code',                  label: 'Số job',          filterType: 'text' },
  { key: 'si_number',                 label: 'Mã SI',           filterType: 'text' },
  { key: 'import_export',             label: 'Loại' },
  { key: 'customer_name',             label: 'Tên khách',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',                   label: 'DV' },
  { key: 'completed_at',              label: 'Ngày hoàn thành' },
  { key: 'accounting_checked_at',     label: 'Ngày KT kiểm' },
  { key: 'accounting_checked_by_name',label: 'Người kiểm' },
  { key: 'days_since_checked',        label: 'Số ngày từ kiểm' },
];

const COLS_DEBIT_SENT = [
  { key: 'stt',                   label: '#' },
  { key: 'job_code',              label: 'Số job',         filterType: 'text' },
  { key: 'si_number',             label: 'Mã SI',          filterType: 'text' },
  { key: 'import_export',         label: 'Loại' },
  { key: 'customer_name',         label: 'Tên khách',      filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',               label: 'DV' },
  { key: 'debit_sent_at',         label: 'Ngày gửi debit' },
  { key: 'days_since_debit_sent', label: 'Số ngày chờ thu' },
  { key: 'debit_sent_by_name',    label: 'Người gửi debit' },
];

const COLS_PAID = [
  { key: 'stt',                      label: '#' },
  { key: 'job_code',                 label: 'Số job',           filterType: 'text' },
  { key: 'si_number',                label: 'Mã SI',            filterType: 'text' },
  { key: 'import_export',            label: 'Loại' },
  { key: 'customer_name',            label: 'Tên khách',        filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',                  label: 'DV' },
  { key: 'debit_sent_at',            label: 'Ngày gửi debit' },
  { key: 'payment_received_at',      label: 'Ngày thu' },
  { key: 'payment_received_by_name', label: 'Người thu' },
  { key: 'days_debit_to_payment',    label: 'Số ngày từ debit đến thu' },
];

// ─── Mobile card frame — shared shape across all 4 sub-tabs ────────────────
// Mirrors TPCard / CusCard / OpsCard / SalesCard from Phase B1-B3 and M4.
// Caller passes `codeColor` (green for paid; default info-blue otherwise)
// and `accent` (orange `4px solid` left border + tint when KT bounced the
// job back — only used by Sub-tab 1's pending_check cards).
function AccountingCard({ job: j, codeColor, onOpen, body, accent }) {
  const imp = j.import_export === 'import';
  const baseBg     = accent ? 'rgba(249,115,22,0.10)' : undefined;
  const leftBorder = accent ? '4px solid #ea580c'     : undefined;
  return (
    <div className="data-card" onClick={onOpen} style={{
      background: baseBg, borderLeft: leftBorder,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {accent && (
            <span style={{
              background: '#ea580c', color: '#fff', borderRadius: 6,
              padding: '1px 8px', fontSize: 10, fontWeight: 700,
            }}>🟠 KT trả về</span>
          )}
          <div style={{
            fontWeight: 700, fontSize: 15,
            color: codeColor || 'var(--info)',
            fontFamily: 'var(--font-display)',
            cursor: onOpen ? 'pointer' : 'default',
          }}>
            {j.job_code || `#${j.id}`}
          </div>
        </div>
        <span style={{
          background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
          color: imp ? '#d97706' : '#16a34a',
          borderRadius: 6, padding: '2px 10px',
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
        }}>{imp ? 'Nhập' : 'Xuất'}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
        <span style={{ color: 'var(--text-2)', fontSize: 11 }}>Khách: </span>
        <strong>{j.customer_name || '—'}</strong>
      </div>
      <div style={{ height: 1, background: 'var(--border)', margin: '6px 0 8px' }} />
      {body}
    </div>
  );
}

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
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState('pending_check');
  const [showOnlyOverdue, setShowOnlyOverdue] = useState(false);
  // KT4 — JobDetailModal trigger from any sub-tab's Số job click.
  const [detailJobId, setDetailJobId] = useState(null);
  // KT4 — date range for the paid tab. DateRangeFilter seeds this on mount
  // via its defaultPreset='30d' useEffect (DateRangeFilter.jsx), so the
  // first query fires with explicit dates rather than backend-default.
  const [paidDateRange, setPaidDateRange] = useState({});

  // KT5 — five action mutations. mutateAsync is returned to the modal so
  // its local busy guard (ktBusy) can await completion regardless of
  // success/failure. invalidateQueries(['accounting']) refetches every
  // accounting-namespaced query (stats + the active sub-tab list), so the
  // sub-tab the action moves the job out of refreshes immediately and the
  // KPI counts in Tầng 1 retick.
  const invalidate = () => qc.invalidateQueries({ queryKey: ['accounting'] });

  const checkMut = useMutation({
    mutationFn: (id) => accountingCheck(id),
    onSuccess: (job) => {
      toast.success(`Đã kiểm tra job ${job?.job_code || ''}`.trim());
      invalidate(); setDetailJobId(null);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi kiểm tra'),
  });
  const debitMut = useMutation({
    mutationFn: ({ id, sentAt })   => accountingDebitSent(id, sentAt),
    onSuccess: (job) => {
      toast.success(`Đã ghi nhận gửi debit job ${job?.job_code || ''}`.trim());
      invalidate(); setDetailJobId(null);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi ghi nhận'),
  });
  const paymentMut = useMutation({
    mutationFn: ({ id, recvAt })   => accountingPaymentReceived(id, recvAt),
    onSuccess: (job) => {
      toast.success(`Đã ghi nhận thu cho job ${job?.job_code || ''}`.trim());
      invalidate(); setDetailJobId(null);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi ghi nhận thu'),
  });
  const returnLogMut = useMutation({
    mutationFn: ({ id, reason })   => accountingReturnToLog(id, reason),
    onSuccess: (job) => {
      toast.success(`Đã trả về LOG: job ${job?.job_code || ''}`.trim());
      invalidate(); setDetailJobId(null);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi trả về LOG'),
  });
  const returnSalesMut = useMutation({
    mutationFn: ({ id, reason })   => accountingReturnToSales(id, reason),
    onSuccess: (job) => {
      toast.success(`Đã trả về Sales: job ${job?.job_code || ''}`.trim());
      invalidate(); setDetailJobId(null);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi trả về Sales'),
  });

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
    queryKey: [
      'accounting', 'jobs', activeTab,
      activeTab === 'debit_sent' ? showOnlyOverdue : null,
      activeTab === 'paid'       ? paidDateRange  : null,
    ],
    queryFn: () => getAccountingJobs({
      tab: activeTab,
      ...(activeTab === 'debit_sent' && showOnlyOverdue ? { overdue: 'true' } : {}),
      ...(activeTab === 'paid' ? paidDateRange : {}),
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

          {/* Date range — only on the paid sub-tab (Sub-tab 4). */}
          {activeTab === 'paid' && (
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
              <DateRangeFilter onChange={setPaidDateRange} defaultPreset="30d" />
            </div>
          )}

          {/* Tầng 3 content area — table per sub-tab. */}
          <div style={{ overflowX: 'auto' }}>
            {tabQ.isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}>
                <span className="spinner" />
              </div>
            ) : (
              <Sub3Table
                activeTab={activeTab}
                data={tabData}
                onOpen={setDetailJobId}
              />
            )}
          </div>
        </div>

      </div>

      {/* JobDetailModal — opened from any sub-tab's Số job cell.
          For ke_toan role, JobDetailModal renders read-only (canEditJob
          excludes ke_toan per KT4 PART B). KT5 will add KT action buttons. */}
      {detailJobId && (
        <JobDetailModal
          jobId={detailJobId}
          onClose={() => setDetailJobId(null)}
          onAccountingCheck={(id)        => checkMut.mutateAsync(id)}
          onDebitSent={(id, sentAt)      => debitMut.mutateAsync({ id, sentAt })}
          onPaymentReceived={(id, recvAt)=> paymentMut.mutateAsync({ id, recvAt })}
          onReturnToLog={(id, reason)    => returnLogMut.mutateAsync({ id, reason })}
          onReturnToSales={(id, reason)  => returnSalesMut.mutateAsync({ id, reason })}
        />
      )}
    </div>
  );
}

// ─── Sub3Table — picks the right column set + renderRow per sub-tab ───────
// Factored out so the conditional rendering inside AccountingDashboard's
// return stays readable. Inside this component the shared cell() switch
// handles every column key declared on the 4 column arrays above.
function Sub3Table({ activeTab, data, onOpen }) {
  // tdStyle is the per-cell padding base — concatenated with key-specific
  // styles inside the switch.
  const tdStyle = { padding: '8px 8px' };

  function cell(key, j, i) {
    switch (key) {
      case 'stt':
        return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)' }}>{i + 1}</td>;

      case 'job_code': {
        // Sub-tab 1 prefixes 🟠 when returned_to is set. Other sub-tabs
        // never see returned_to because accounting-check clears it.
        const codeColor = activeTab === 'paid' ? 'var(--primary)' : 'var(--info)';
        return (
          <td key={key} style={{
            ...tdStyle, whiteSpace: 'nowrap',
            fontWeight: 600, color: codeColor,
            cursor: 'pointer', textDecoration: 'underline dotted',
          }} onClick={e => { e.stopPropagation(); onOpen(j.id); }}>
            {j.returned_to && (
              <span style={{ marginRight: 4 }}
                title={`KT trả về ${j.returned_to.toUpperCase()}: ${j.returned_reason || ''}`}>
                🟠
              </span>
            )}
            {j.job_code || `#${j.id}`}
          </td>
        );
      }

      case 'si_number':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
          {j.si_number || '—'}
        </td>;

      case 'import_export': {
        const imp = j.import_export === 'import';
        return <td key={key} style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
          <span style={{
            background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
            color: imp ? '#d97706' : '#16a34a',
            borderRadius: 6, padding: '2px 8px',
            fontSize: 11, fontWeight: 600,
          }}>{imp ? 'Nhập' : 'Xuất'}</span>
        </td>;
      }

      case 'customer_name':
        return <td key={key} style={{ ...tdStyle, maxWidth: 160, fontWeight: 500, fontSize: 13 }}>
          {j.customer_name}
        </td>;

      case 'service':
        return <td key={key} style={tdStyle}>
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {SVC_LABEL[j.service_type] || j.service_type}
          </span>
        </td>;

      case 'cargo':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtCargo(j)}
        </td>;

      case 'completed_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(j.completed_at)}
        </td>;

      case 'revenue_entered_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(j.revenue_entered_at)}
        </td>;

      case 'sales_name':
        return <td key={key} style={{ ...tdStyle, fontSize: 12 }}>
          {j.sales_name || <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>;

      case 'returned_badge':
        return <td key={key} style={tdStyle}>
          {j.returned_to ? (
            <span style={{
              background: '#fff7ed', color: '#ea580c',
              borderRadius: 6, padding: '2px 8px',
              fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
            }} title={j.returned_reason || ''}>
              🟠 {j.returned_to.toUpperCase()}
            </span>
          ) : (
            <span style={{ color: 'var(--text-3)' }}>—</span>
          )}
        </td>;

      case 'accounting_checked_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(j.accounting_checked_at)}
        </td>;

      case 'accounting_checked_by_name':
        return <td key={key} style={{ ...tdStyle, fontSize: 12 }}>
          {j.accounting_checked_by_name || <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>;

      case 'days_since_checked': {
        const d = daysSince(j.accounting_checked_at);
        if (d == null) return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)' }}>—</td>;
        const isLate = d > WAITING_DEBIT_WARN;
        return <td key={key} style={{
          ...tdStyle, fontSize: 12, whiteSpace: 'nowrap',
          color: isLate ? 'var(--danger)' : 'var(--text)',
          fontWeight: isLate ? 600 : 400,
        }}>{isLate && '🔴 '}{d} ngày</td>;
      }

      case 'debit_sent_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(j.debit_sent_at)}
        </td>;

      case 'days_since_debit_sent': {
        const d = daysSince(j.debit_sent_at);
        if (d == null) return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)' }}>—</td>;
        const isOverdue = d > OVERDUE_DAYS;
        return <td key={key} style={{
          ...tdStyle, fontSize: 12, whiteSpace: 'nowrap',
          color: isOverdue ? 'var(--danger)' : 'var(--text)',
          fontWeight: isOverdue ? 600 : 400,
        }}>{isOverdue && '🔴 '}{d} ngày{isOverdue && ' (quá hạn)'}</td>;
      }

      case 'debit_sent_by_name':
        return <td key={key} style={{ ...tdStyle, fontSize: 12 }}>
          {j.debit_sent_by_name || <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>;

      case 'payment_received_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {fmtDate(j.payment_received_at)}
        </td>;

      case 'payment_received_by_name':
        return <td key={key} style={{ ...tdStyle, fontSize: 12 }}>
          {j.payment_received_by_name || <span style={{ color: 'var(--text-3)' }}>—</span>}
        </td>;

      case 'days_debit_to_payment': {
        const d = daysBetween(j.debit_sent_at, j.payment_received_at);
        if (d == null) return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)' }}>—</td>;
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          {d} ngày
        </td>;
      }

      default: return null;
    }
  }

  // ─── Sub-tab 1: pending_check (11 cols) ──────────────────────────────────
  if (activeTab === 'pending_check') {
    return (
      <FilteredTable
        columns={COLS_PENDING_CHECK}
        data={data}
        emptyText="Không có job nào chờ xử lý 🎉"
        tableStyle={{ fontSize: 13 }}
        renderRow={(j, i) => (
          <tr key={j.id}
            style={{
              borderBottom: '1px solid var(--border)',
              background: j.returned_to ? 'rgba(249,115,22,0.10)' : '',
              cursor: 'pointer',
            }}
            onDoubleClick={() => onOpen(j.id)}>
            {COLS_PENDING_CHECK.map(c => cell(c.key, j, i))}
          </tr>
        )}
        renderMobileCard={(j) => (
          <AccountingCard
            job={j}
            onOpen={() => onOpen(j.id)}
            accent={!!j.returned_to}
            body={
              <>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-2)' }}>DV:</span>{' '}
                  <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
                </div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-2)' }}>Ngày Sales tick:</span> {fmtDate(j.revenue_entered_at)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  Sales: <strong style={{ color: 'var(--text)' }}>{j.sales_name || '—'}</strong>
                </div>
                {j.returned_to && j.returned_reason && (
                  <div style={{ fontSize: 12, marginTop: 6, padding: '6px 8px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6, color: '#9a3412' }}>
                    <strong>Lý do trả về:</strong> {j.returned_reason}
                  </div>
                )}
              </>
            }
          />
        )}
      />
    );
  }

  // ─── Sub-tab 2: checked (10 cols) ────────────────────────────────────────
  if (activeTab === 'checked') {
    return (
      <FilteredTable
        columns={COLS_CHECKED}
        data={data}
        emptyText="Không có job nào chờ gửi debit"
        tableStyle={{ fontSize: 13 }}
        renderRow={(j, i) => (
          <tr key={j.id}
            style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
            onDoubleClick={() => onOpen(j.id)}>
            {COLS_CHECKED.map(c => cell(c.key, j, i))}
          </tr>
        )}
        renderMobileCard={(j) => {
          const d = daysSince(j.accounting_checked_at);
          const isLate = d != null && d > WAITING_DEBIT_WARN;
          return (
            <AccountingCard job={j} onOpen={() => onOpen(j.id)}
              body={
                <>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-2)' }}>Ngày KT kiểm:</span> {fmtDate(j.accounting_checked_at)}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: isLate ? 'var(--danger)' : 'var(--text)',
                    fontWeight: isLate ? 600 : 400,
                  }}>
                    {isLate && '🔴 '}{d != null ? `${d} ngày chờ debit` : '—'}
                  </div>
                </>
              }
            />
          );
        }}
      />
    );
  }

  // ─── Sub-tab 3: debit_sent (9 cols) ──────────────────────────────────────
  if (activeTab === 'debit_sent') {
    return (
      <FilteredTable
        columns={COLS_DEBIT_SENT}
        data={data}
        emptyText="Không có công nợ nào đang chờ thu"
        tableStyle={{ fontSize: 13 }}
        renderRow={(j, i) => (
          <tr key={j.id}
            style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
            onDoubleClick={() => onOpen(j.id)}>
            {COLS_DEBIT_SENT.map(c => cell(c.key, j, i))}
          </tr>
        )}
        renderMobileCard={(j) => {
          const d = daysSince(j.debit_sent_at);
          const isOverdue = d != null && d > OVERDUE_DAYS;
          return (
            <AccountingCard job={j} onOpen={() => onOpen(j.id)}
              body={
                <>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'var(--text-2)' }}>Ngày gửi debit:</span> {fmtDate(j.debit_sent_at)}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: isOverdue ? 'var(--danger)' : 'var(--text)',
                    fontWeight: isOverdue ? 600 : 400,
                  }}>
                    {isOverdue && '🔴 '}{d != null ? `${d} ngày chờ thu` : '—'}{isOverdue && ' (quá hạn)'}
                  </div>
                </>
              }
            />
          );
        }}
      />
    );
  }

  // ─── Sub-tab 4: paid (10 cols) ───────────────────────────────────────────
  return (
    <FilteredTable
      columns={COLS_PAID}
      data={data}
      emptyText="Chưa có job nào đã thu trong khoảng thời gian này"
      tableStyle={{ fontSize: 13 }}
      renderRow={(j, i) => (
        <tr key={j.id}
          style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
          onDoubleClick={() => onOpen(j.id)}>
          {COLS_PAID.map(c => cell(c.key, j, i))}
        </tr>
      )}
      renderMobileCard={(j) => {
        const d = daysBetween(j.debit_sent_at, j.payment_received_at);
        return (
          <AccountingCard job={j} codeColor="var(--primary)" onOpen={() => onOpen(j.id)}
            body={
              <>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-2)' }}>Ngày thu:</span> {fmtDate(j.payment_received_at)}
                </div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-2)' }}>Người thu:</span>{' '}
                  {j.payment_received_by_name || <span style={{ color: 'var(--text-3)' }}>—</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  Mất: <strong style={{ color: 'var(--text)' }}>{d != null ? `${d} ngày` : '—'}</strong> từ gửi debit
                </div>
              </>
            }
          />
        );
      }}
    />
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
