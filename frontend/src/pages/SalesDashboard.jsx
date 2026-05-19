import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import StatCard from '../components/StatCard';
import DateFilter, { useDateFilter } from '../components/DateFilter';
import DateRangeFilter from '../components/DateRangeFilter';
import DrilldownModal from '../components/DrilldownModal';
import PipelineView from '../components/PipelineView';
import FilteredTable from '../components/FilteredTable';
import JobDetailModal from '../components/JobDetailModal';
import { getStats, getReports, getJobs, tickJobRevenue, untickJobRevenue } from '../api';
import { useAuth } from '../App';

const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

// ─── M4 — formatting + column helpers for "Quản lý công việc" tab ───────────
// Cloned from LogDashboardTP / LogDashboardCus conventions. Kept local rather
// than extracted to a shared module (matches the existing 4-dashboard pattern;
// a future cleanup can extract if/when a 5th caller appears).
const SVC_LABEL      = { tk: 'TK', truck: 'Xe', both: 'TK+Xe' };
const TK_FLOW_LABEL  = { xanh: 'Xanh', vang: 'Vàng', do: 'Đỏ' };
const TK_FLOW_COLOR  = { xanh: '#22c55e', vang: '#d97706', do: '#ef4444' };
const TK_FLOW_BG     = { xanh: 'rgba(34,197,94,0.15)', vang: 'rgba(217,119,6,0.15)', do: 'rgba(239,68,68,0.15)' };

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('vi-VN'); }
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
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
function deadlineStyle(dl) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 48 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return { color: 'var(--primary)' };
}
function daysSinceCompleted(j) {
  if (!j.completed_at) return 0;
  return Math.floor((Date.now() - new Date(j.completed_at).getTime()) / 86400000);
}
function pendingRowBg(j) {
  if (j.tk_flow === 'xanh') return 'rgba(34,197,94,0.06)';
  if (j.tk_flow === 'vang') return 'rgba(217,119,6,0.06)';
  if (j.tk_flow === 'do')   return 'rgba(239,68,68,0.06)';
  if (j.deadline && new Date(j.deadline) < Date.now()) return 'rgba(239,68,68,0.04)';
  return '';
}

// 12 columns for Sub-tab 1 (Job pending).
const PENDING_COLS = [
  { key: 'stt',           label: '#' },
  { key: 'job_code',      label: 'Số job',     filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',      filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'created_at',    label: 'Ngày tạo' },
  { key: 'customer_name', label: 'Tên khách',  filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'han_lenh',      label: 'Hạn lệnh' },
  { key: 'deadline',      label: 'Deadline' },
  { key: 'tk_flow',       label: 'Luồng TK',   filterType: 'select', options: [
    { value: 'xanh', label: 'Xanh' }, { value: 'vang', label: 'Vàng' }, { value: 'do', label: 'Đỏ' },
  ]},
  { key: 'delivery_dt',   label: 'Ngày giao' },
  { key: 'cargo',         label: 'Cont-Loại' },
  { key: 'notes',         label: 'Ghi chú' },
];

// 9 columns for Sub-tab 2 (Yêu cầu nhập thu) — last col is the tick action.
const REVENUE_PENDING_COLS = [
  { key: 'stt',           label: '#' },
  { key: 'job_code',      label: 'Số job',          filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Tên khách',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',       label: 'DV' },
  { key: 'completed_at',  label: 'Ngày hoàn thành' },
  { key: 'days_waiting',  label: 'Số ngày chờ' },
  { key: 'notes',         label: 'Ghi chú' },
];

// 9 columns for Sub-tab 3 (Đã nhập thu) — last col is the un-tick action.
const REVENUE_ENTERED_COLS = [
  { key: 'stt',                label: '#' },
  { key: 'job_code',           label: 'Số job',          filterType: 'text' },
  { key: 'import_export',      label: 'Loại' },
  { key: 'customer_name',      label: 'Tên khách',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'service',            label: 'DV' },
  { key: 'completed_at',       label: 'Ngày hoàn thành' },
  { key: 'revenue_entered_at', label: 'Tick lúc' },
  { key: 'revenue_entered_by', label: 'Người tick' },
];

// Shared mobile card frame (matches TPCard / CusCard / OpsCard from Phase
// B1-B3): job_code (left) + Loại badge (right) + Khách line + divider +
// per-sub-tab body + optional full-width action button.
// KT5 — two optional decoration props for the Sub-tab 2 returned-to-Sales
// indicator. `wrapperStyle` merges into the root data-card div style;
// `beforeHeader` renders a single ReactNode before the job_code/Loại header
// row. Both default to undefined so Sub-tab 1/3 callers stay unchanged.
function SalesCard({ job: j, codeColor, onOpen, body, action, wrapperStyle, beforeHeader }) {
  const imp = j.import_export === 'import';
  return (
    <div key={j.id} className="data-card" onClick={onOpen} style={wrapperStyle}>
      {beforeHeader}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{
          fontWeight: 700, fontSize: 15,
          color: codeColor || 'var(--info)',
          fontFamily: 'var(--font-display)',
          cursor: onOpen ? 'pointer' : 'default',
        }}>
          {j.job_code || `#${j.id}`}
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
      {action && (
        <div style={{ marginTop: 10 }} onClick={e => e.stopPropagation()}>
          {action}
        </div>
      )}
    </div>
  );
}

export default function SalesDashboard() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [drilldown, setDrilldown] = useState(null);
  const dateFilter = useDateFilter();
  const dateRange = dateFilter.getRange();

  const statsQ = useQuery({
    queryKey: ['stats', 'my', dateRange],
    queryFn: () => getStats(dateRange),
  });

  const reportsQ = useQuery({
    queryKey: ['reports', 'my', dateRange],
    queryFn: () => getReports({ ...dateRange, limit: 50 }),
    enabled: activeTab === 'overview',
  });

  // M3 — "Quản lý công việc" tab state + lazy-loaded sub-tab queries.
  // Default sub-tab is 'pending' to mirror the LOG dashboards' convention.
  const [subTab, setSubTab] = useState('pending');
  const [revenueEnteredRange, setRevenueEnteredRange] = useState({});

  // Visibility-aware polling — 5s when tab is visible, 30s when hidden.
  // Mirrors LogDashboardTP:471-475.
  const [isVisible, setIsVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);
  const pollInterval = isVisible ? 5000 : 30000;

  // M3 — three lazy-loaded queries, one per sub-tab. Each fires only when
  // the user is actually on that sub-tab to avoid unnecessary traffic on the
  // default ("Báo cáo của tôi") landing.
  // The 'sales_view' discriminator on the pending query's key prevents cache
  // collision with LogDashboardTP's ['jobs','pending'] key — the two views
  // hit the same endpoint but the backend role-scopes the result differently
  // (sales sees only own jobs; TP sees everything).
  const pendingJobsQ = useQuery({
    queryKey: ['jobs', 'pending', 'sales_view'],
    queryFn: () => getJobs({ tab: 'pending' }),
    enabled: activeTab === 'job_management' && subTab === 'pending',
    refetchInterval: pollInterval,
  });

  const revenuePendingQ = useQuery({
    queryKey: ['jobs', 'revenue_pending'],
    queryFn: () => getJobs({ tab: 'revenue_pending' }),
    enabled: activeTab === 'job_management' && subTab === 'revenue_pending',
    refetchInterval: pollInterval,
  });

  const revenueEnteredQ = useQuery({
    queryKey: ['jobs', 'revenue_entered', revenueEnteredRange],
    queryFn: () => getJobs({ tab: 'revenue_entered', ...revenueEnteredRange }),
    enabled: activeTab === 'job_management' && subTab === 'revenue_entered',
    // No refetchInterval — data is stable, refetches on date-range change
    // or on user-triggered tick/un-tick (mutations invalidate ['jobs']).
  });

  // M5 — header stat card #7: always-on count of awaiting-revenue jobs so
  // Sales sees a pile-up the moment they open the dashboard (without having
  // to click into Tab 3 / Sub-tab 2). 30s polling is calm for a header signal.
  // Separate cache key ('count_only' discriminator) from revenuePendingQ so
  // each can keep its own refetch cadence — accepted minor double-fetch on
  // Sub-tab 2 view in exchange for clear separation of concerns.
  const revenuePendingCountQ = useQuery({
    queryKey: ['jobs', 'revenue_pending', 'count_only'],
    queryFn: () => getJobs({ tab: 'revenue_pending' }),
    refetchInterval: 30000,
    enabled: user?.role === 'sales',
  });
  const revenuePendingCount = revenuePendingCountQ.data?.length ?? 0;

  // M4 — JobDetailModal trigger from any sub-tab.
  const [detailJobId, setDetailJobId] = useState(null);

  // M4 — tick / un-tick mutations. Both invalidate every ['jobs', ...] query
  // so all 3 sub-tab counts + tables refresh atomically (a tick moves the row
  // from Sub-tab 2 → Sub-tab 3; un-tick is the reverse).
  const qc = useQueryClient();
  const tickMut = useMutation({
    mutationFn: (jobId) => tickJobRevenue(jobId),
    onSuccess: (job) => {
      toast.success(`Đã nhập thu job ${job.job_code || '#' + job.id}`);
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Không nhập thu được'),
  });
  const untickMut = useMutation({
    mutationFn: (jobId) => untickJobRevenue(jobId),
    onSuccess: (job) => {
      toast.success(`Đã bỏ tick job ${job.job_code || '#' + job.id}`);
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Không bỏ tick được'),
  });

  function onTickClick(j) {
    const msg = `Xác nhận đã nhập thu job ${j.job_code || '#' + j.id}?\n\n`
              + '⚠️ Sau khi nhập thu, kế toán sẽ xử lý debit note.\n'
              + 'Bạn có thể bỏ tick sau nếu sai sót.';
    if (window.confirm(msg)) tickMut.mutate(j.id);
  }
  function onUntickClick(j) {
    const msg = `Bỏ tick nhập thu job ${j.job_code || '#' + j.id}?\n\n`
              + `Job sẽ quay lại danh sách 'Yêu cầu nhập thu'.`;
    if (window.confirm(msg)) untickMut.mutate(j.id);
  }

  // Shared cell renderer for the 3 sub-tab tables. Each sub-tab passes its
  // own column array; cell() only handles the keys it knows. Unknown keys
  // return null (caller's responsibility to use the right column set).
  // KT5 — 4th arg `showReturnedSales` toggles the 🟠 prefix on the job_code
  // cell. Sub-tab 2 (revenue_pending) passes true so jobs KT returned to
  // Sales are visible at a glance; Sub-tab 1/3 leave it false per spec.
  const tdStyle = { padding: '8px 8px' };
  function cell(key, j, i, showReturnedSales = false) {
    switch (key) {
      case 'stt':
        return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)' }}>{i + 1}</td>;
      case 'job_code':
        return <td key={key} style={{
          ...tdStyle, whiteSpace: 'nowrap',
          fontWeight: 600, color: 'var(--info)',
          cursor: 'pointer', textDecoration: 'underline dotted',
        }} onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>
          {showReturnedSales && j.returned_to === 'sales' && (
            <span style={{ marginRight: 4, cursor: 'help' }}
              title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
          )}
          {j.job_code || `#${j.id}`}
        </td>;
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
      case 'created_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(j.created_at)}</td>;
      case 'customer_name':
        return <td key={key} style={{ ...tdStyle, maxWidth: 150, fontWeight: 500, fontSize: 13 }}>{j.customer_name}</td>;
      case 'han_lenh': {
        if (!j.han_lenh) return <td key={key} style={{ ...tdStyle, fontSize: 12, color: 'var(--text-3)' }}>—</td>;
        const isImport = j.import_export === 'import';
        return <td key={key} style={{ ...tdStyle, whiteSpace: 'nowrap', fontSize: 12 }}>
          <span style={deadlineStyle(j.han_lenh)}>{isImport ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)}</span>
        </td>;
      }
      case 'deadline':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>
          <span style={deadlineStyle(j.deadline)}>{j.deadline ? fmtDt(j.deadline) : '—'}</span>
        </td>;
      case 'tk_flow': {
        const f = j.tk_flow;
        if (!f) return <td key={key} style={{ ...tdStyle, color: 'var(--text-3)', fontSize: 12 }}>—</td>;
        return <td key={key} style={tdStyle}>
          <span style={{
            background: TK_FLOW_BG[f], color: TK_FLOW_COLOR[f],
            padding: '1px 8px', borderRadius: 10,
            fontSize: 11, fontWeight: 600,
          }}>{TK_FLOW_LABEL[f]}</span>
        </td>;
      }
      case 'delivery_dt':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
          {fmtDate(j.delivery_datetime)}
        </td>;
      case 'cargo':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtCargo(j)}</td>;
      case 'service':
        return <td key={key} style={tdStyle}>
          <span className="badge badge-info" style={{ fontSize: 10 }}>
            {SVC_LABEL[j.service_type] || j.service_type}
          </span>
        </td>;
      case 'completed_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(j.completed_at)}</td>;
      case 'days_waiting': {
        const d = daysSinceCompleted(j);
        const isLate = d > 3;
        return <td key={key} style={{
          ...tdStyle, fontSize: 12, whiteSpace: 'nowrap',
          color: isLate ? 'var(--danger)' : 'var(--text)',
          fontWeight: isLate ? 600 : 400,
        }}>{isLate && '🔴 '}{d} ngày</td>;
      }
      case 'revenue_entered_at':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDt(j.revenue_entered_at)}</td>;
      case 'revenue_entered_by':
        return <td key={key} style={{ ...tdStyle, fontSize: 12 }}>
          {j.revenue_entered_by_name
            || (j.revenue_entered_by ? `#${j.revenue_entered_by}` : '—')}
        </td>;
      case 'notes':
        return <td key={key} style={{ ...tdStyle, fontSize: 12, color: 'var(--text-2)', maxWidth: 140 }}>
          {j.tk_notes || '—'}
        </td>;
      default:
        return null;
    }
  }

  const stats = statsQ.data || {};
  const reports = reportsQ.data?.reports || [];

  return (
    <div className="page">
      <Navbar />

      <main style={{ padding: '24px 0 60px' }}>
        <div className="container">
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 4 }}>
              Xin chào, {user?.name.split(' ').pop()} 👋
            </h1>
            <p style={{ color: 'var(--text-2)', fontSize: 14 }}>
              Báo cáo kinh doanh cá nhân · {format(new Date(), 'EEEE, dd/MM/yyyy')}
            </p>
          </div>

          {/* Date filter */}
          <DateFilter {...dateFilter} />

          {/* Stats — M5: switched grid-6 → stat-grid so the 7th card flows
              cleanly on every screen width (auto-fit, minmax(180px, 1fr)).
              Mobile collapse rule on .stat-grid matches what .grid-6 used to
              do (1 column at ≤768px per Phase 1 L21), so no regression. */}
          <div className="stat-grid" style={{ marginBottom: 32 }}>
            <StatCard label="Đã Booking" value={stats.booked} icon="✅" color="var(--primary)" loading={statsQ.isLoading} onClick={() => setDrilldown('booked')} />
            <StatCard label="Báo giá follow" value={stats.follow_up} icon="🔄" color="var(--warning)" loading={statsQ.isLoading} onClick={() => setDrilldown('follow_up')} />
            <StatCard label="Sắp Chốt" value={stats.closing_soon} icon="⚡" color="#ff6b35" loading={statsQ.isLoading} onClick={() => setDrilldown('closing_soon')} />
            <StatCard label="Tiếp Cận" value={stats.total_contacts} icon="👥" color="var(--info)" loading={statsQ.isLoading} onClick={() => setDrilldown('contacts')} />
            <StatCard label="Báo Giá" value={stats.total_quotes} icon="📋" color="var(--purple)" loading={statsQ.isLoading} onClick={() => setDrilldown('total_quotes')} />
            <StatCard
              label="Chờ Follow"
              icon="⏰" color="var(--danger)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('waiting_follow_up')}
              rows={[
                { label: 'Hôm nay',  value: stats.follow_today,    color: '#d97706' },
                { label: '7 ngày tới',  value: stats.follow_upcoming, color: '#3b82f6' },
                { label: 'Quá hạn',  value: stats.overdue,         color: '#ef4444' },
              ]}
            />
            {/* M5 — Sales revenue-tick header card. Urgency cue follows the
                existing "Chờ Follow > Quá hạn" pattern: muted at 0, amber at
                1-5, danger red at >5. Click jumps directly into Tab 3 /
                Sub-tab 2 so Sales can clear the pile-up without navigation. */}
            <StatCard
              label="Yêu cầu nhập thu"
              value={revenuePendingCount}
              icon="💰"
              color={
                revenuePendingCount === 0
                  ? 'var(--text-3)'
                  : revenuePendingCount > 5
                    ? 'var(--danger)'
                    : 'var(--warning)'
              }
              loading={revenuePendingCountQ.isLoading}
              onClick={() => { setActiveTab('job_management'); setSubTab('revenue_pending'); }}
            />
          </div>

          {/* Tabs */}
          <div className="tabs">
            {[
              { key: 'overview',        label: '📋 Báo cáo của tôi' },
              { key: 'pipeline',        label: '📊 Danh sách hoạt động' },
              { key: 'job_management',  label: '🚛 Quản lý công việc' },
            ].map(t => (
              <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* My Reports */}
          {activeTab === 'overview' && (
            <div>
              {reportsQ.isLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : reports.length === 0 ? (
                <div className="empty-state">
                  <div className="icon">📭</div>
                  <p style={{ marginBottom: 16 }}>Chưa có báo cáo nào. Thêm khách hàng để bắt đầu!</p>
                  <button className="btn btn-primary" onClick={() => setActiveTab('pipeline')}>
                    📊 Mở Danh sách hoạt động
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {reports.map(r => (
                    <Link key={r.id} to={`/reports/${r.id}`} style={{ textDecoration: 'none' }}>
                      <div
                        className="card"
                        style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', transition: 'all 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.transform = 'translateX(2px)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.transform = ''; }}
                      >
                        <div style={{
                          width: 48, height: 48, borderRadius: 12,
                          background: 'var(--primary-dim)', border: '1px solid var(--border)',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--primary)', lineHeight: 1 }}>
                            {new Date(r.report_date).getDate()}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-2)' }}>
                            Th{new Date(r.report_date).getMonth() + 1}
                          </div>
                        </div>

                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                            Báo cáo {format(new Date(r.report_date), 'dd/MM/yyyy')}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <span>👥 {r.total_contacts} lượt tiếp cận</span>
                            <span>🆕 {r.new_customers} KH mới</span>
                            <span>📋 {r.customer_count} KH · {r.quote_count} báo giá</span>
                          </div>
                          {r.issues && (
                            <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4 }}>
                              ⚠️ {r.issues.substring(0, 100)}{r.issues.length > 100 ? '...' : ''}
                            </div>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                          {r.issues && <span className="badge badge-warning">Cần hỗ trợ</span>}
                          <span style={{ color: 'var(--text-3)', fontSize: 18 }}>→</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pipeline */}
          {activeTab === 'pipeline' && <PipelineView />}

          {/* M3 — Quản lý công việc (Sales-side job management) */}
          {activeTab === 'job_management' && (() => {
            const SUB_TABS = [
              { key: 'pending',         label: '🔵 Job pending',     color: 'var(--info)',     bg: '#eff6ff', border: '#bfdbfe', q: pendingJobsQ },
              { key: 'revenue_pending', label: '🟡 Yêu cầu nhập thu', color: 'var(--warning)', bg: '#fffbeb', border: '#fde68a', q: revenuePendingQ },
              { key: 'revenue_entered', label: '🟢 Đã nhập thu',      color: 'var(--primary)', bg: '#f0fdf4', border: '#bbf7d0', q: revenueEnteredQ },
            ];
            const activeQ = SUB_TABS.find(s => s.key === subTab)?.q;
            const activeData = activeQ?.data || [];
            return (
              <div>
                {/* Sub-tab navigation — clickable pill cards with live count badges */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                  {SUB_TABS.map(s => {
                    const isActive = subTab === s.key;
                    const count = s.q.data?.length;
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => setSubTab(s.key)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '10px 16px',
                          background: isActive ? s.bg : 'var(--bg-card)',
                          border: `1.5px solid ${isActive ? s.color : 'var(--border)'}`,
                          borderRadius: 'var(--radius)',
                          color: isActive ? s.color : 'var(--text-2)',
                          fontFamily: 'var(--font)',
                          fontSize: 14, fontWeight: isActive ? 600 : 500,
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                        }}
                      >
                        <span>{s.label}</span>
                        <span style={{ fontSize: 13, opacity: 0.8 }}>
                          ({s.q.isLoading ? '…' : count ?? 0})
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Date range — only on Đã nhập thu sub-tab */}
                {subTab === 'revenue_entered' && (
                  <div style={{ marginBottom: 12 }}>
                    <DateRangeFilter
                      onChange={setRevenueEnteredRange}
                      defaultPreset="7d"
                    />
                  </div>
                )}

                {/* Table per sub-tab — wrapped in overflowX:auto for desktop;
                    FilteredTable handles the mobile card swap at ≤768px via
                    renderMobileCard (Phase B3 pattern). */}
                <div style={{ overflowX: 'auto' }}>
                  {activeQ?.isLoading ? (
                    <div style={{ padding: 40, textAlign: 'center' }}>
                      <span className="spinner" />
                    </div>
                  ) : subTab === 'pending' ? (
                    <FilteredTable
                      columns={PENDING_COLS}
                      data={activeData}
                      emptyText="Không có job nào"
                      tableStyle={{ fontSize: 13 }}
                      renderRow={(j, i) => (
                        <tr key={j.id}
                          style={{ borderBottom: '1px solid var(--border)',
                                   background: pendingRowBg(j), cursor: 'pointer' }}
                          onDoubleClick={() => setDetailJobId(j.id)}>
                          {PENDING_COLS.map(c => cell(c.key, j, i))}
                        </tr>
                      )}
                      renderMobileCard={(j) => (
                        <SalesCard job={j} onOpen={() => setDetailJobId(j.id)}
                          body={
                            <>
                              <div style={{ fontSize: 12, marginBottom: 6 }}>
                                <span style={{ color: 'var(--text-2)' }}>Hạn lệnh:</span>{' '}
                                {j.han_lenh
                                  ? <span style={deadlineStyle(j.han_lenh)}>
                                      {j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)}
                                    </span>
                                  : <span style={{ color: 'var(--text-3)' }}>—</span>}
                              </div>
                              <div style={{ fontSize: 12, marginBottom: 6 }}>
                                <span style={{ color: 'var(--text-2)' }}>Deadline:</span>{' '}
                                <span style={deadlineStyle(j.deadline)}>{j.deadline ? fmtDt(j.deadline) : '—'}</span>
                              </div>
                              <div style={{ fontSize: 12 }}>
                                <span style={{ color: 'var(--text-2)' }}>Luồng TK:</span>{' '}
                                {j.tk_flow
                                  ? <span style={{
                                      background: TK_FLOW_BG[j.tk_flow], color: TK_FLOW_COLOR[j.tk_flow],
                                      padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                    }}>{TK_FLOW_LABEL[j.tk_flow]}</span>
                                  : <span style={{ color: 'var(--text-3)' }}>—</span>}
                              </div>
                            </>
                          }
                        />
                      )}
                    />
                  ) : subTab === 'revenue_pending' ? (
                    <FilteredTable
                      columns={REVENUE_PENDING_COLS}
                      data={activeData}
                      emptyText="Không có job nào chờ nhập thu"
                      extraHeaderCells={<th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>Hành động</th>}
                      tableStyle={{ fontSize: 13 }}
                      renderRow={(j, i) => {
                        const inFlight = tickMut.isPending && tickMut.variables === j.id;
                        // KT5 — orange row when KT returned this job to Sales.
                        const ktReturnedBg = j.returned_to === 'sales' ? 'rgba(249,115,22,0.10)' : '';
                        return (
                          <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: ktReturnedBg }}>
                            {REVENUE_PENDING_COLS.map(c => cell(c.key, j, i, true))}
                            <td style={{ padding: '8px 8px', whiteSpace: 'nowrap' }}>
                              <button className="btn btn-primary btn-sm"
                                disabled={tickMut.isPending}
                                onClick={() => onTickClick(j)}>
                                {inFlight ? '...' : '✅ Đã nhập thu'}
                              </button>
                            </td>
                          </tr>
                        );
                      }}
                      renderMobileCard={(j) => {
                        const d = daysSinceCompleted(j);
                        const isLate = d > 3;
                        const inFlight = tickMut.isPending && tickMut.variables === j.id;
                        // KT5 — KT returned this job to Sales: chip + left border.
                        const isReturned = j.returned_to === 'sales';
                        return (
                          <SalesCard job={j} onOpen={() => setDetailJobId(j.id)}
                            wrapperStyle={isReturned ? { borderLeft: '4px solid #ea580c' } : undefined}
                            beforeHeader={isReturned && (
                              <div style={{
                                background: 'rgba(249,115,22,0.10)',
                                padding: '6px 8px', borderRadius: 4, marginBottom: 8,
                                fontSize: 11, color: '#9a3412', fontWeight: 500,
                              }}>
                                🟠 KT trả về — Lý do: {j.returned_reason || '(không có)'}
                              </div>
                            )}
                            body={
                              <>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>
                                  <span style={{ color: 'var(--text-2)' }}>DV:</span>{' '}
                                  <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
                                </div>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Ngày HT:</span> {fmtDate(j.completed_at)}
                                </div>
                                <div style={{
                                  fontSize: 12,
                                  color: isLate ? 'var(--danger)' : 'var(--text)',
                                  fontWeight: isLate ? 600 : 400,
                                }}>
                                  {isLate && '🔴 '}{d} ngày chờ
                                </div>
                                {j.tk_notes && (
                                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, padding: '6px 8px', background: 'var(--bg)', borderRadius: 6 }}>
                                    {j.tk_notes}
                                  </div>
                                )}
                              </>
                            }
                            action={
                              <button className="btn btn-primary btn-sm"
                                style={{ width: '100%' }}
                                disabled={tickMut.isPending}
                                onClick={() => onTickClick(j)}>
                                {inFlight ? '...' : '✅ Đã nhập thu'}
                              </button>
                            }
                          />
                        );
                      }}
                    />
                  ) : (
                    <FilteredTable
                      columns={REVENUE_ENTERED_COLS}
                      data={activeData}
                      emptyText="Không có job nào trong khoảng thời gian này"
                      extraHeaderCells={<th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>Hành động</th>}
                      tableStyle={{ fontSize: 13 }}
                      renderRow={(j, i) => {
                        const inFlight = untickMut.isPending && untickMut.variables === j.id;
                        return (
                          <tr key={j.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            {REVENUE_ENTERED_COLS.map(c => cell(c.key, j, i))}
                            <td style={{ padding: '8px 8px', whiteSpace: 'nowrap' }}>
                              <button className="btn btn-ghost btn-sm"
                                disabled={untickMut.isPending}
                                onClick={() => onUntickClick(j)}>
                                {inFlight ? '...' : '↩️ Bỏ tick'}
                              </button>
                            </td>
                          </tr>
                        );
                      }}
                      renderMobileCard={(j) => {
                        const inFlight = untickMut.isPending && untickMut.variables === j.id;
                        return (
                          <SalesCard job={j} codeColor="var(--primary)"
                            onOpen={() => setDetailJobId(j.id)}
                            body={
                              <>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Ngày HT:</span> {fmtDate(j.completed_at)}
                                </div>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Tick lúc:</span> {fmtDt(j.revenue_entered_at)}
                                </div>
                                <div style={{ fontSize: 12 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Người tick:</span>{' '}
                                  {j.revenue_entered_by_name
                                    || (j.revenue_entered_by ? `#${j.revenue_entered_by}` : '—')}
                                </div>
                              </>
                            }
                            action={
                              <button className="btn btn-ghost btn-sm"
                                style={{ width: '100%' }}
                                disabled={untickMut.isPending}
                                onClick={() => onUntickClick(j)}>
                                {inFlight ? '...' : '↩️ Bỏ tick'}
                              </button>
                            }
                          />
                        );
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })()}

          {/* JobDetailModal — opened from Sub-tab 1 row double-click, or
              from "Số job" cell click on any sub-tab. Reused as-is (read-only
              for Sales since Sales can't trigger LOG-side actions). */}
          {detailJobId && (
            <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
          )}

        </div>
      </main>

      {drilldown && (
        <DrilldownModal
          type={drilldown}
          dateParams={dateRange}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}
