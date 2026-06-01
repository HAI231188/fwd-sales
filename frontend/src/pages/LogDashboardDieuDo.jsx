import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import StaffSection, { DD_COLS as STAFF_DD_COLS } from '../components/StaffSection';
import BBBGModal from '../components/BBBGModal';
import BookingModal from '../components/BookingModal';
import PlanDeliveryModal from '../components/PlanDeliveryModal';
import TruckPlanningModal from '../components/TruckPlanningModal';
import TransportPicker from '../components/TransportPicker';
import DateTimeInput24h from '../components/DateTimeInput24h';
import toast from 'react-hot-toast';
// Phase 4.1: TransportPicker + InlineInput RE-introduced on DD main grid —
// inline edits target the FIRST booking via updateTruckBooking (vs Phase 4's
// updateJobTruck which is gone for good).
import { getJobStats, getJobs, updateJob, requestJobDelete, createJob,
         getTruckBookings, updateTruckBooking, deleteTruckBooking } from '../api';
import {
  TRUCK_BOOKING_STATUS_LABELS, TRUCK_BOOKING_STATUS_SORT_RANK,
  TRUCK_BOOKING_ACTIVE_STATUSES, truckBookingPillStyle, pillStyleByColor,
  // 2026-05-25: ddPillInfo/ddPillStyle extracted to the shared utils so TP can reuse.
  ddPillInfo, ddPillStyle,
} from '../utils/truckBookingStatus';
import { fmtDate } from '../utils/dateFmt';

// waitingStatus: returns the list of "Chờ ..." items for the new Chờ column.
//   - CUS thông quan blocker if job has TK + tk_status not terminal
//   - OPS đổi lệnh blocker if HP + doi_lenh task incomplete
// Reflects the owner's spec: DD's row should surface CUS + OPS state without detail.
const TK_TERMINAL_STATUSES = ['thong_quan', 'giai_phong', 'bao_quan'];
function waitingStatus(j) {
  const items = [];
  const hasTk = j.service_type === 'tk' || j.service_type === 'both';
  if (hasTk && !TK_TERMINAL_STATUSES.includes(j.tk_status)) {
    items.push('CUS thông quan');
  }
  if (j.destination === 'hai_phong') {
    const dl = (Array.isArray(j.ops_tasks) ? j.ops_tasks : []).find(t => t.task_type === 'doi_lenh');
    if (dl && !(dl.completed === true && !!dl.cost_entered_at)) {
      items.push('OPS đổi lệnh');
    }
  }
  return items;
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
  if (ms < 24 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}

// Phase 5 Step 1 add-on: per-day delivery bucket label for the
// "Kế hoạch trả hàng" card. Reads BROWSER local time (= Vietnam tz in
// practice). Format: "T3 13/05".
function formatDayLabel(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const weekday = ['CN','T2','T3','T4','T5','T6','T7'][d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${weekday} ${dd}/${mm}`;
}

function StatCard({ label, value, color, onClick }) {
  return (
    <div className="card" onClick={onClick}
      style={{ textAlign: 'center', padding: '16px 12px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>
        {value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Phase 4.1: InlineInput restored for the DD main grid. Single-click enters edit
// mode; blur or Enter saves; Escape cancels. datetime-local auto-formats the
// value on focus so users see the standard browser picker.
function toDtLocal(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function InlineInput({ value, onSave, type = 'text', placeholder }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const ref = useRef();
  function start() {
    setVal(type === 'datetime-local' ? toDtLocal(value) : (value == null ? '' : String(value)));
    setEditing(true);
    setTimeout(() => ref.current?.focus(), 0);
  }
  function save() {
    setEditing(false);
    const next = val === '' ? null : val;
    const prev = value == null || value === '' ? null : (type === 'datetime-local' ? toDtLocal(value) : String(value));
    if (next !== prev) onSave(next);
  }
  if (!editing) {
    let display;
    if (value == null || value === '') {
      display = <span style={{ color: 'var(--text-3)' }}>—</span>;
    } else if (type === 'datetime-local') {
      display = new Date(value).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    } else if (type === 'number') {
      display = Number(value).toLocaleString('vi-VN');
    } else {
      display = value;
    }
    return (
      <span onClick={start} title="Click để sửa"
        style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', fontSize: 12, display: 'inline-block', minWidth: 30, padding: '1px 0' }}>
        {display}
      </span>
    );
  }
  return (
    <input ref={ref} type={type === 'datetime-local' ? 'datetime-local' : type}
      value={val} onChange={e => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        if (e.key === 'Escape') { setEditing(false); }
      }}
      placeholder={placeholder}
      style={{ fontSize: 12, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4, width: '100%', boxSizing: 'border-box' }}
    />
  );
}

// Phase 4.1: DD main grid has inline edit on the FIRST booking again, plus
// a per-row BBBG button. Bookings management (multi-booking) is still in the
// Quản lý đặt xe section above and the bookings table in JobDetailModal.
// Click a row → expand inline editing; double-click → open JobDetailModal.
const DD_COLS = [
  { key: 'created_at',     label: 'Ngày' },
  { key: 'job_code',       label: 'Job',              filterType: 'text' },
  { key: 'si_number',      label: 'Mã SI',            filterType: 'text' },
  { key: 'import_export',  label: 'Loại' },
  { key: 'customer_name',  label: 'Khách hàng',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',          label: 'Cont / Tons' },
  { key: 'etd_eta',        label: 'ETD / ETA' },
  { key: 'han_lenh',       label: 'Hạn lệnh / Cutoff' },
  { key: 'booking_status', label: 'Trạng thái' },
  // 2026-05-24 DD-split: shows what DD is waiting on (CUS thông quan, OPS đổi lệnh).
  // 2026-05-25: moved to sit immediately after Trạng thái for visibility.
  { key: 'waiting_status', label: 'Chờ' },
  { key: 'cont_coverage',  label: 'Cont' },
  { key: 'booking_count',  label: 'KH' },
  // ─── Restored inline-edit columns (Phase 4.1 — first booking only) ───
  { key: 'transport',      label: 'Tên vận tải',      filterType: 'text', accessor: j => j.first_booking_transport || '' },
  { key: 'vehicle',        label: 'Số xe',            filterType: 'text', accessor: j => j.first_booking_vehicle || '' },
  { key: 'planned_dt',     label: 'KH ngày giờ' },
  { key: 'actual_dt',      label: 'TH ngày giờ' },
  { key: 'pickup_loc',     label: 'Địa điểm lấy' },
  { key: 'delivery_loc',   label: 'Địa điểm giao' },
  { key: 'cost',           label: 'Cước' },
  { key: 'notes',          label: 'Ghi chú' },
  { key: 'doi_lenh',       label: 'TT đổi lệnh' },
  { key: 'bbbg',           label: 'BBBG' },
];

export default function LogDashboardDieuDo() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});
  const [bbbgJob, setBbbgJob] = useState(null); // { id, code } — opens BBBGModal
  // Quản lý đặt xe (Phase 3) state
  const [expandedBookingJobId, setExpandedBookingJobId] = useState(null);
  const [bookingModalState, setBookingModalState] = useState(null); // {mode, jobId, jobCode, booking?}
  // Phase 5 Step 2 — "Đặt kế hoạch xe" target (main grid + CUS/TP rows).
  const [planModalJob, setPlanModalJob] = useState(null); // {jobId, jobCode}
  // Phase 5 Step 3 — "Quản lý đặt xe" target (BookingManagementSection row button).
  const [planningJob, setPlanningJob] = useState(null); // {jobId, jobCode}
  const [deletingBooking, setDeletingBooking] = useState(null);     // {id, transport_name}

  useEffect(() => {
    const onOpen = e => { if (e.detail?.jobId) setDetailJobId(e.detail.jobId); };
    window.addEventListener('open-job-detail', onOpen);
    return () => window.removeEventListener('open-job-detail', onOpen);
  }, []);

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: 30000 });
  const { data: pendingJobs = [], isLoading: isLoadingPending } = useQuery({
    queryKey: ['jobs', 'pending'],
    queryFn: () => getJobs({ tab: 'pending' }),
    refetchInterval: 30000,
  });
  const { data: completedJobs = [], isLoading: isLoadingCompleted } = useQuery({
    queryKey: ['jobs', 'completed', completedRange],
    queryFn: () => getJobs({ tab: 'completed', ...completedRange }),
    enabled: tab === 'completed',
    refetchInterval: 30000,
  });
  // 2026-05-24 DD-split: DD's view is restricted to truck/both jobs (TK-only
  // doesn't reach DD). Partition by dd_completed_at, NOT by jobs.status:
  //   "Đang làm"  = truck/both AND dd_completed_at IS NULL
  //   "Hoàn thành" = truck/both AND dd_completed_at IS NOT NULL
  //                 ∪ status='completed' truck/both (from the completed query)
  const isDdJob = (j) => j.service_type === 'truck' || j.service_type === 'both';
  const ddActivePending = pendingJobs.filter(j => isDdJob(j) && !j.dd_completed_at);
  const ddCompletedFromPending = pendingJobs.filter(j => isDdJob(j) && j.dd_completed_at);
  const ddCompletedFromDone = (completedJobs || []).filter(isDdJob);
  // Merge sources for the "Hoàn thành" view; de-dup by id (a job in completedJobs
  // would also satisfy the pendingJobs predicate if it briefly overlaps — guard).
  const ddCompletedById = new Map();
  for (const j of [...ddCompletedFromDone, ...ddCompletedFromPending]) {
    if (!ddCompletedById.has(j.id)) ddCompletedById.set(j.id, j);
  }
  const ddCompletedJobs = Array.from(ddCompletedById.values());
  // 2026-05-25: simplified to 2 tabs only — Đang làm / Hoàn thành. The legacy
  // sub-tabs "Đã có KH xe" / "Chưa có KH xe" were removed (booking_status pill
  // + the stat cards already surface that info; the sub-tabs duplicated it).
  const jobs = tab === 'completed' ? ddCompletedJobs : ddActivePending;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;

  // Phase 4.1: truckMut restored — PATCHes the FIRST booking via
  // updateTruckBooking(bookingId, data). The server still auto-completes the job
  // when every booking has a vehicle_number (per checkAndCompleteJob in PATCH
  // /api/truck-bookings). When a job has 2+ bookings the user must open
  // JobDetailModal to edit the others; this row only edits booking #1.
  const truckMut = useMutation({
    mutationFn: ({ bookingId, data }) => updateTruckBooking(bookingId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi khi cập nhật'),
  });

  // 2026-05-24 DD-split: "TH ngày giờ" now stamps jobs.dd_completed_at (DD's own
  // completion) — backend then calls checkAndCompleteJob which only flips
  // jobs.completed_at when CUS + DD + OPS are all done. Response carries
  // { dd_completed, job_completed } so we can pick the right toast.
  const completeJobMut = useMutation({
    mutationFn: ({ jobId, completed_at }) => updateJob(jobId, { completed_at }),
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
      if (!vars.completed_at) {
        toast.success('Đã hủy TH ngày giờ — DD quay lại Đang làm');
        return;
      }
      if (data?.job_completed) {
        toast.success('✅ Job hoàn thành (CUS + DD + OPS xong)');
      } else if (data?.dd_completed) {
        toast.success('✅ Đã chốt TH ngày giờ — chờ CUS/OPS xong');
      } else {
        toast.success('Đã cập nhật');
      }
    },
    onError: (err) => {
      const code = err?.code;
      // CP6.1 — 3 new completion-guard codes from the backend; surface each
      // with its precise Vietnamese message so DD knows exactly which ticks
      // are missing.
      const TICK_CODES = new Set([
        'MISSING_INVOICE_LIFTING',
        'MISSING_COST_ENTERED',
        'MISSING_BOTH_TICKS',
      ]);
      if (code === 'JOB_NOT_READY_TO_COMPLETE') {
        toast.error(err.error || 'Job chưa đủ thông tin để hoàn thành. Cần đặt KH/VT/Số xe trước.');
      } else if (TICK_CODES.has(code)) {
        toast.error(err.error, { duration: 6000 });
      } else {
        toast.error(err?.error || err?.message || 'Lỗi khi cập nhật');
      }
    },
  });
  const deleteReqMut = useMutation({
    mutationFn: ({ id, reason }) => requestJobDelete(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const createMut = useMutation({
    mutationFn: data => createJob(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });

  // Phase 4: getMissingFieldsTruck / htState / canComplete removed.
  // Status now derives entirely from get_truck_booking_status() on the backend;
  // the "Quản lý đặt xe" section drives all DD action.

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard Điều Độ</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        <div className="stat-grid" style={{ marginBottom: 24 }}>
          {/* Card 1: Tổng job đang xử lý — Phase 5 Step 1 redesign.
              Mixes job-level (top row) and container-level (rows 2 + 3) counts. */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Tổng job đang xử lý</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Job chưa hoàn thành', value: stats?.job_chua_hoan_thanh, color: 'var(--info)',    filter: 'truck_pending' },
                { label: 'Kế hoạch đã chốt',    value: stats?.ke_hoach_da_dat,     color: 'var(--primary)', filter: 'dd_kh_da_dat_chi_tiet' },
                { label: 'Kế hoạch chưa đặt',   value: stats?.ke_hoach_chua_dat,   color: 'var(--warning)', filter: 'dd_ke_hoach_chua_dat' },
              ].map(r => (
                <div key={r.label} onClick={() => setJobListFilter(r.filter)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: `${r.color}12`, border: `1px solid ${r.color}30`, cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, color: r.color, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: 20, fontWeight: 700, color: r.color, fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 2 "Đã đặt xe" REMOVED (Phase 5 Step 1) — was duplicating Card 1 data. */}

          {/* Card 2 (new): Kế hoạch trả hàng — 7 rows, per-day bucket. */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Kế hoạch trả hàng</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Quá hạn',                                  value: stats?.ke_hoach_qua_han, color: 'var(--danger)',  filter: 'dd_kh_qua_han' },
                { label: `Hôm nay (${formatDayLabel(0)})`,           value: stats?.ke_hoach_hom_nay, color: 'var(--info)',    filter: 'dd_kh_today' },
                { label: `Ngày mai (${formatDayLabel(1)})`,          value: stats?.ke_hoach_d1,      color: 'var(--text)',    filter: 'dd_kh_d1' },
                { label: formatDayLabel(2),                          value: stats?.ke_hoach_d2,      color: 'var(--text)',    filter: 'dd_kh_d2' },
                { label: formatDayLabel(3),                          value: stats?.ke_hoach_d3,      color: 'var(--text)',    filter: 'dd_kh_d3' },
                { label: formatDayLabel(4),                          value: stats?.ke_hoach_d4,      color: 'var(--text)',    filter: 'dd_kh_d4' },
                { label: formatDayLabel(5),                          value: stats?.ke_hoach_d5,      color: 'var(--text)',    filter: 'dd_kh_d5' },
              ].map(r => (
                <div key={r.label} onClick={() => setJobListFilter(r.filter)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: `${r.color}12`, border: `1px solid ${r.color}30`, cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, color: r.color, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: 18, fontWeight: 700, color: r.color, fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 3: Cảnh báo — 3 rows */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Cảnh báo</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Chưa vận tải (24h)', value: stats?.canh_bao_chua_van_tai, color: 'var(--warning)', filter: 'dd_canh_bao_chua_van_tai' },
                { label: 'Chưa đổi lệnh', value: stats?.canh_bao_chua_doi_lenh, color: 'var(--purple)', filter: 'dd_canh_bao_chua_doi_lenh' },
                { label: 'Chưa hoàn thành', value: stats?.canh_bao_chua_hoan_thanh, color: 'var(--danger)', filter: 'dd_canh_bao_chua_hoan_thanh' },
              ].map(r => (
                <div key={r.label} onClick={() => setJobListFilter(r.filter)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: `${r.color}12`, border: `1px solid ${r.color}30`, cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, color: r.color, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: 20, fontWeight: 700, color: r.color, fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 4: Sắp hạn */}
          <StatCard label="Sắp hạn (48h)" value={stats?.sap_han} color="var(--danger)" onClick={() => setJobListFilter('dd_sap_han')} />
        </div>

        {/* Staff section — 1 row for current user */}
        <StaffSection
          title="Tình hình Điều Độ"
          rows={stats?.dieu_do_stats || []}
          columns={STAFF_DD_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />

        {/* Quản lý đặt xe (Phase 3) — jobs needing DD action on truck bookings */}
        <BookingManagementSection
          jobs={pendingJobs}
          onOpenJob={(id) => setDetailJobId(id)}
          onOpenPlanning={(j) => setPlanningJob({ jobId: j.id, jobCode: j.job_code })}
          onOpenPlan={(j) => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}
          onEdit={(j, b) => setBookingModalState({ mode: 'edit', jobId: j.id, jobCode: j.job_code, booking: b })}
          onDelete={(b) => setDeletingBooking({ id: b.id, transport_name: b.transport_name })}
          expanded={expandedBookingJobId}
          onToggleExpand={(id) => setExpandedBookingJobId(prev => prev === id ? null : id)}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>Đang làm</button>
              <button className={`tab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>Hoàn thành</button>
            </div>
            {tab === 'completed' && (
              <div style={{ paddingBottom: 4 }}>
                <DateRangeFilter onChange={setCompletedRange} />
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : (
              <FilteredTable
                columns={DD_COLS}
                data={jobs}
                emptyText="Không có job nào"
                tableStyle={{ fontSize: 13 }}
                renderMobileCard={(j) => {
                  // Phase 2 pilot — mobile card view. Same filteredData feeds desktop table.
                  const total = Array.isArray(j.containers) ? j.containers.length : 0;
                  const booked = j.truck_booked_containers_count || 0;
                  const imp = j.import_export === 'import';
                  const isOpsRelevant = j.destination === 'hai_phong' &&
                    (j.service_type === 'truck' || j.service_type === 'both');
                  const hl = j.han_lenh
                    ? (imp
                        ? fmtDate(j.han_lenh)
                        : new Date(j.han_lenh).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))
                    : '—';
                  // KT5 — orange chip + left border when KT bounced job back to LOG.
                  const isReturned = j.returned_to === 'log';
                  return (
                    <div key={j.id} className="data-card" onClick={() => setDetailJobId(j.id)}
                      style={isReturned ? { borderLeft: '4px solid #ea580c' } : undefined}>
                      {isReturned && (
                        <div style={{
                          background: 'rgba(249,115,22,0.10)',
                          padding: '6px 8px', borderRadius: 4, marginBottom: 8,
                          fontSize: 11, color: '#9a3412', fontWeight: 500,
                        }}>
                          🟠 KT trả về — Lý do: {j.returned_reason || '(không có)'}
                        </div>
                      )}
                      {/* Header — job code + loại badge */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--info)', fontFamily: 'var(--font-display)' }}>
                          {j.job_code || `#${j.id}`}
                        </div>
                        <span style={{
                          background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
                          color: imp ? '#d97706' : '#16a34a',
                          borderRadius: 6, padding: '2px 10px',
                          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                        }}>
                          {imp ? 'Nhập' : 'Xuất'}
                        </span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
                        <span style={{ color: 'var(--text-2)', fontSize: 11 }}>Khách: </span>
                        <strong>{j.customer_name || '—'}</strong>
                      </div>
                      <div style={{ height: 1, background: 'var(--border)', margin: '6px 0 8px' }} />

                      {/* 2-col mini grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 8, fontSize: 12 }}>
                        <div><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</div>
                        <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
                        <div><span style={{ color: 'var(--text-2)' }}>ETD:</span> {fmtDate(j.etd)}</div>
                        <div><span style={{ color: 'var(--text-2)' }}>ETA:</span> {fmtDate(j.eta)}</div>
                      </div>

                      <div style={{ fontSize: 12, marginBottom: 6 }}>
                        <span style={{ color: 'var(--text-2)' }}>Hàng hóa:</span> {fmtCargo(j)}
                        {j.tons && <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>· {j.tons} tấn</span>}
                      </div>

                      <div style={{ fontSize: 12, marginBottom: 10 }}>
                        <span style={{ color: 'var(--text-2)' }}>Hạn lệnh / Cutoff:</span>{' '}
                        <span style={deadlineStyle(j.han_lenh)}>{hl}</span>
                      </div>

                      {/* Status pill + inline metrics. 2026-05-24: ddPillInfo splits
                          du_xe_cho_giao into tick sub-states. */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        {(() => {
                          const info = ddPillInfo(j);
                          return (
                            <span style={{ ...ddPillStyle(info, j.truck_booking_status), fontSize: 12, padding: '4px 10px' }} title={info.tooltip}>
                              {info.label}
                            </span>
                          );
                        })()}
                        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-2)' }}>
                          <span>Cont:{' '}
                            <strong style={{ color: total === 0 ? 'var(--text-3)' : booked < total ? 'var(--warning)' : 'var(--primary)' }}>
                              {booked}/{total}
                            </strong>
                          </span>
                          <span>Booking: <strong style={{ color: 'var(--text)' }}>{j.truck_bookings_count || 0}</strong></span>
                        </div>
                      </div>

                      {/* Phase 4.1: first-booking transport summary on mobile (read-only;
                          tap card → JobDetailModal → BookingsSection for edits) */}
                      {j.first_booking_id && (
                        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, fontSize: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
                            <span style={{ color: 'var(--text-2)' }}>Vận tải:</span>
                            <strong>{j.first_booking_transport || '—'}</strong>
                            {j.truck_bookings_count > 1 && (
                              <span style={{ background: 'rgba(124,58,237,0.12)', color: '#7c3aed', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>
                                +{j.truck_bookings_count - 1} KH khác
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <span><span style={{ color: 'var(--text-2)' }}>Số xe:</span>{' '}
                              {j.first_booking_vehicle
                                ? <strong style={{ color: 'var(--primary)' }}>{j.first_booking_vehicle}</strong>
                                : <span style={{ color: 'var(--warning)' }}>⏳ Chờ</span>}
                            </span>
                            <span><span style={{ color: 'var(--text-2)' }}>KH:</span>{' '}
                              {j.first_booking_planned
                                ? new Date(j.first_booking_planned).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                                : '—'}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* OPS đổi lệnh badge — reads per-task state (2026-05-23).
                          DD cares specifically about doi_lenh (unlocks truck side). */}
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        OPS đổi lệnh:{' '}
                        {isOpsRelevant ? (() => {
                          const dl = (Array.isArray(j.ops_tasks) ? j.ops_tasks : []).find(t => t.task_type === 'doi_lenh');
                          const done = !!dl && dl.completed === true && !!dl.cost_entered_at;
                          return done
                            ? <span style={{ background: 'rgba(34,197,94,0.15)', color: '#16a34a', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>✓ Đã đổi</span>
                            : <span style={{ background: 'rgba(217,119,6,0.12)', color: '#b45309', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>✗ Chưa đổi</span>;
                        })() : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </div>
                      {/* 2026-05-24 DD-split: Chờ sub-badge surfacing CUS/OPS blockers. */}
                      {(() => {
                        const w = waitingStatus(j);
                        if (!w.length) return null;
                        return (
                          <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4, fontWeight: 500 }}>
                            ⏳ Chờ {w.join(', ')}
                          </div>
                        );
                      })()}
                    </div>
                  );
                }}
                renderRow={(j) => {
                  // Phase 4.1: inline-editable on the FIRST booking. Multi-booking
                  // edits go via JobDetailModal → BookingsSection. Double-click
                  // anywhere on the row opens JobDetailModal; single-click on an
                  // input stays inside the cell (stopPropagation).
                  const cs = { padding: '8px 8px', verticalAlign: 'middle' };
                  const total = Array.isArray(j.containers) ? j.containers.length : 0;
                  const booked = j.truck_booked_containers_count || 0;
                  const imp = j.import_export === 'import';
                  const isOpsRelevant = j.destination === 'hai_phong' &&
                    (j.service_type === 'truck' || j.service_type === 'both');
                  const isTruckJob = j.service_type === 'truck' || j.service_type === 'both';
                  const hasBooking = !!j.first_booking_id;
                  const stop = (e) => e.stopPropagation();
                  const setField = (data) => {
                    if (hasBooking) truckMut.mutate({ bookingId: j.first_booking_id, data });
                  };
                  const dash = <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
                  // KT5 — orange row tint when KT bounced job back to LOG.
                  const ktReturnedBg = j.returned_to === 'log' ? 'rgba(249,115,22,0.10)' : '';
                  return (
                    <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: ktReturnedBg }}
                      onDoubleClick={() => setDetailJobId(j.id)}>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--info)' }}>
                        {j.returned_to === 'log' && (
                          <span style={{ marginRight: 4, cursor: 'help' }}
                            title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                        )}
                        {j.job_code || `#${j.id}`}
                      </td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>
                      <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                        <span style={{ background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
                          color: imp ? '#d97706' : '#16a34a', borderRadius: 6, padding: '2px 8px',
                          fontSize: 11, fontWeight: 600 }}>{imp ? 'Nhập' : 'Xuất'}</span>
                      </td>
                      <td style={{ ...cs, maxWidth: 160 }}>{j.customer_name}</td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>
                        {fmtCargo(j)}
                        {j.tons && <div style={{ color: 'var(--text-3)' }}>{j.tons} tấn</div>}
                      </td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                        {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                      </td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', ...deadlineStyle(j.han_lenh) }}>
                        {j.han_lenh
                          ? (imp
                              ? fmtDate(j.han_lenh)
                              : new Date(j.han_lenh).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))
                          : '—'}
                      </td>
                      <td style={cs}>
                        {(() => {
                          const info = ddPillInfo(j);
                          return (
                            <span style={ddPillStyle(info, j.truck_booking_status)} title={info.tooltip}>
                              {info.label}
                            </span>
                          );
                        })()}
                      </td>
                      {/* 2026-05-25: Chờ column moved next to Trạng thái for visibility. */}
                      <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                        {(() => {
                          const w = waitingStatus(j);
                          if (!w.length) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
                          return (
                            <span style={{ color: 'var(--warning)', fontSize: 11, fontWeight: 500 }}>
                              Chờ {w.join(', ')}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ ...cs, fontWeight: 600,
                        color: total === 0 ? 'var(--text-3)' : booked < total ? 'var(--warning)' : 'var(--primary)' }}>
                        {booked}/{total}
                      </td>
                      <td style={{ ...cs, fontWeight: 600 }}>{j.truck_bookings_count || 0}</td>

                      {/* ─── Restored inline-edit columns (first booking only) ─── */}
                      <td style={{ ...cs, minWidth: 180 }} onClick={stop}>
                        {hasBooking ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                            {j.first_booking_code && (
                              <span style={{ background: 'var(--primary-dim)', color: 'var(--primary)',
                                borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 600,
                                fontFamily: 'var(--font-display)', whiteSpace: 'nowrap' }}>
                                {j.first_booking_code}
                              </span>
                            )}
                            <div style={{ flex: 1, minWidth: 110 }}>
                              <TransportPicker
                                value={{ transport_company_id: j.first_booking_transport_company_id, transport_name: j.first_booking_transport }}
                                onChange={v => v.transport_company_id && setField({ transport_company_id: v.transport_company_id })}
                                placeholder="Chọn vận tải..."
                              />
                            </div>
                            {j.truck_bookings_count > 1 && (
                              <span title={`Còn ${j.truck_bookings_count - 1} kế hoạch khác — mở chi tiết job để xem hết`}
                                style={{ background: 'rgba(124,58,237,0.12)', color: '#7c3aed', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                +{j.truck_bookings_count - 1} KH khác
                              </span>
                            )}
                          </div>
                        ) : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 90 }} onClick={stop}>
                        {hasBooking
                          ? <InlineInput value={j.first_booking_vehicle} placeholder="VD: 29C-12345"
                              onSave={v => setField({ vehicle_number: v })} />
                          : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 180 }} onClick={stop}>
                        {hasBooking
                          ? <DateTimeInput24h value={j.first_booking_planned}
                              onChange={v => { if (v) setField({ planned_datetime: v }); }} />
                          : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 180 }} onClick={stop}>
                        {/* CP4.5.1 — TH ngày giờ now binds to jobs.completed_at
                            (per job). DateTimeInput24h emits the picked value or
                            null/empty to clear. Backend guard returns 400 if the
                            job isn't ready (status must be 'du_xe_cho_giao' or
                            'hoan_thanh') — toast surfaces the friendly error. */}
                        <DateTimeInput24h value={j.completed_at}
                          onChange={v => completeJobMut.mutate({ jobId: j.id, completed_at: v || null })} />
                      </td>
                      <td style={{ ...cs, minWidth: 100 }} onClick={stop}>
                        {hasBooking
                          ? <InlineInput value={j.first_booking_pickup}
                              onSave={v => setField({ pickup_location: v })} />
                          : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 110 }} onClick={stop}>
                        {hasBooking
                          ? <InlineInput value={j.first_booking_delivery}
                              onSave={v => setField({ delivery_location: v })} />
                          : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 80 }} onClick={stop}>
                        {hasBooking
                          ? <InlineInput value={j.first_booking_cost} type="number"
                              onSave={v => setField({ cost: v === null ? null : Number(v) })} />
                          : dash}
                      </td>
                      <td style={{ ...cs, minWidth: 100 }} onClick={stop}>
                        {hasBooking
                          ? <InlineInput value={j.first_booking_notes}
                              onSave={v => setField({ notes: v })} />
                          : dash}
                      </td>

                      <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                        {/* Per-task model (2026-05-23): reads doi_lenh task state. */}
                        {isOpsRelevant ? (() => {
                          const dl = (Array.isArray(j.ops_tasks) ? j.ops_tasks : []).find(t => t.task_type === 'doi_lenh');
                          const done = !!dl && dl.completed === true && !!dl.cost_entered_at;
                          return done
                            ? <span style={{ background: 'rgba(34,197,94,0.15)', color: '#16a34a', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Đã đổi</span>
                            : <span style={{ background: 'rgba(217,119,6,0.12)', color: '#b45309', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Chưa đổi</span>;
                        })() : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>


                      <td style={{ ...cs, whiteSpace: 'nowrap' }} onClick={stop}>
                        {isTruckJob ? (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <button className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '3px 8px' }}
                              onClick={() => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}
                              title="Đặt kế hoạch xe (chọn ngày giờ + địa điểm + ghi chú cho từng cont)">
                              📅 Đặt KH
                            </button>
                            {hasBooking && (
                              <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px' }}
                                onClick={() => setBbbgJob({ id: j.id, code: j.job_code, bookingId: j.first_booking_id })}>
                                📄 BBBG
                              </button>
                            )}
                          </div>
                        ) : dash}
                      </td>
                    </tr>
                  );
                }}
              />
            )}
          </div>
        </div>
      </div>

      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {bbbgJob && <BBBGModal jobId={bbbgJob.id} jobCode={bbbgJob.code} bookingId={bbbgJob.bookingId} onClose={() => setBbbgJob(null)} />}
      {showCreate && <CreateJobModal onClose={() => setShowCreate(false)} onCreated={data => createMut.mutateAsync(data)} />}
      {planModalJob && (
        <PlanDeliveryModal
          jobId={planModalJob.jobId} jobCode={planModalJob.jobCode}
          onClose={() => setPlanModalJob(null)} />
      )}
      {planningJob && (
        <TruckPlanningModal
          jobId={planningJob.jobId} jobCode={planningJob.jobCode}
          onClose={() => setPlanningJob(null)} />
      )}
      {jobListFilter && (
        <JobListModal
          filterType={typeof jobListFilter === 'string' ? jobListFilter : jobListFilter.filterType}
          staffId={typeof jobListFilter === 'string' ? null : jobListFilter.staffId}
          staffName={typeof jobListFilter === 'string' ? null : jobListFilter.staffName}
          onClose={() => setJobListFilter(null)}
        />
      )}
      {bookingModalState && (
        <BookingModal
          mode={bookingModalState.mode}
          jobId={bookingModalState.jobId}
          jobCode={bookingModalState.jobCode}
          booking={bookingModalState.booking}
          onClose={() => setBookingModalState(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['jobs'] });
            qc.invalidateQueries({ queryKey: ['truckBookings', bookingModalState.jobId] });
            qc.invalidateQueries({ queryKey: ['availableContainers', bookingModalState.jobId] });
          }}
        />
      )}
      {deletingBooking && (
        <BookingDeleteConfirm
          booking={deletingBooking}
          onClose={() => setDeletingBooking(null)}
          onDeleted={() => {
            qc.invalidateQueries({ queryKey: ['jobs'] });
            qc.invalidateQueries({ queryKey: ['truckBookings'] });
            qc.invalidateQueries({ queryKey: ['availableContainers'] });
          }}
        />
      )}
    </div>
  );
}

// ─── Quản lý đặt xe section ─────────────────────────────────────────────────────
// Lives under the "Tình hình Điều Độ" StaffSection. Lists jobs whose
// truck_booking_status needs DD action (chua_dat_xe / dat_xe_1_phan /
// da_dat_xe_du_cho_so_xe). Status comes from backend get_truck_booking_status()
// per L19/L20 — never recomputed client-side.
function BookingManagementSection({ jobs, onOpenJob, onOpenPlanning, onOpenPlan, onEdit, onDelete, expanded, onToggleExpand }) {
  const visible = (jobs || [])
    .filter(j => TRUCK_BOOKING_ACTIVE_STATUSES.includes(j.truck_booking_status))
    .sort((a, b) => {
      const ra = TRUCK_BOOKING_STATUS_SORT_RANK[a.truck_booking_status] || 99;
      const rb = TRUCK_BOOKING_STATUS_SORT_RANK[b.truck_booking_status] || 99;
      if (ra !== rb) return ra - rb;
      const da = a.han_lenh ? new Date(a.han_lenh).getTime() : Number.POSITIVE_INFINITY;
      const db = b.han_lenh ? new Date(b.han_lenh).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });

  return (
    <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>
          Quản lý đặt xe <span style={{ color: 'var(--text-2)', fontWeight: 400 }}>({visible.length})</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
          Các job chưa hoàn thành đặt xe — sắp xếp theo mức độ ưu tiên
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        {visible.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            Không có job nào cần đặt xe. ✨
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                {['Job', 'Khách hàng', 'Loại', 'Trạng thái', 'Cont', 'Booking', 'Hạn lệnh / Cutoff', '']
                  .map((h, i) => (
                    <th key={i} style={{ padding: '10px 12px', textAlign: i === 7 ? 'right' : 'left',
                      fontWeight: 600, color: 'var(--text-2)', fontSize: 11,
                      whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {h}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(j => {
                const isOpen = expanded === j.id;
                const total = Array.isArray(j.containers) ? j.containers.length : 0;
                const booked = j.truck_booked_containers_count || 0;
                const imp = j.import_export === 'import';
                const ieBg = imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)';
                const ieFg = imp ? '#d97706' : '#16a34a';
                return (
                  <BookingRow key={j.id} j={j} isOpen={isOpen} total={total} booked={booked}
                    ieBg={ieBg} ieFg={ieFg} imp={imp}
                    onOpenJob={onOpenJob} onOpenPlanning={onOpenPlanning} onOpenPlan={onOpenPlan}
                    onEdit={onEdit} onDelete={onDelete}
                    onToggleExpand={onToggleExpand} />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function BookingRow({ j, isOpen, total, booked, ieBg, ieFg, imp,
                     onOpenJob, onOpenPlanning, onOpenPlan, onEdit, onDelete, onToggleExpand }) {
  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['truckBookings', j.id],
    queryFn: () => getTruckBookings(j.id),
    enabled: isOpen, // lazy — only fetch when user expands the row
  });

  const hl = j.han_lenh
    ? (imp
        ? new Date(j.han_lenh).toLocaleDateString('vi-VN')
        : new Date(j.han_lenh).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))
    : '—';

  const td = { padding: '10px 12px', verticalAlign: 'middle' };

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
        onClick={() => onToggleExpand(j.id)}>
        <td style={{ ...td, fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
          <span style={{ marginRight: 6, display: 'inline-block', width: 12, color: 'var(--text-2)' }}>
            {isOpen ? '▼' : '▶'}
          </span>
          <span onClick={e => { e.stopPropagation(); onOpenJob(j.id); }}
            style={{ textDecoration: 'underline dotted' }}>
            {j.job_code || `#${j.id}`}
          </span>
        </td>
        <td style={td}>{j.customer_name}</td>
        <td style={td}>
          <span style={{ background: ieBg, color: ieFg, padding: '2px 8px', borderRadius: 6,
            fontSize: 11, fontWeight: 600 }}>{imp ? 'Nhập' : 'Xuất'}</span>
        </td>
        <td style={td}>
          {(() => {
            const info = ddPillInfo(j);
            return (
              <span style={ddPillStyle(info, j.truck_booking_status)} title={info.tooltip}>
                {info.label}
              </span>
            );
          })()}
        </td>
        <td style={{ ...td, fontWeight: 600, color: booked < total ? 'var(--warning)' : 'var(--primary)' }}>
          {booked}/{total}
        </td>
        <td style={{ ...td, fontWeight: 600 }}>{j.truck_bookings_count || 0}</td>
        <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12 }}>{hl}</td>
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={e => { e.stopPropagation(); onOpenPlan(j); }}
              title="Đặt kế hoạch xe (chọn ngày giờ + địa điểm + ghi chú cho từng cont)">
              📅 Đặt KH
            </button>
            <button className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={e => { e.stopPropagation(); onOpenPlanning(j); }}>
              Quản lý đặt xe
            </button>
          </div>
        </td>
      </tr>
      {isOpen && (
        <tr style={{ background: 'var(--bg)' }}>
          <td colSpan={8} style={{ padding: '8px 18px 14px' }}>
            {isLoading ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>Đang tải bookings...</div>
            ) : bookings.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
                Job này chưa có kế hoạch giao xe nào. Bấm "Quản lý đặt xe" để mở workspace,
                hoặc dùng "📅 Đặt kế hoạch xe" ở dashboard chính để tạo plan cho từng cont.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bookings.map(b => (
                  <div key={b.id} style={{ display: 'grid',
                    gridTemplateColumns: '1.4fr 1.4fr 1fr 1.4fr 0.6fr auto',
                    gap: 8, padding: '8px 10px', background: '#fff',
                    border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, alignItems: 'center' }}>
                    <div>
                      {b.booking_code && (
                        <span style={{ padding: '1px 6px', background: 'var(--primary-dim)',
                          color: 'var(--primary)', borderRadius: 4, fontWeight: 600,
                          fontFamily: 'var(--font-display)', fontSize: 10, marginRight: 6 }}>
                          {b.booking_code}
                        </span>
                      )}
                      <div style={{ fontWeight: 600 }}>{b.transport_current_name || b.transport_name || <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Chưa có vận tải</span>}</div>
                      {b.transport_current_name && b.transport_current_name !== b.transport_name && (
                        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                          snapshot: {b.transport_name}
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-2)' }}>KH:</div>
                      <div style={{ fontWeight: 500 }}>
                        {b.planned_datetime
                          ? new Date(b.planned_datetime).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-2)' }}>Số xe:</div>
                      <div style={{ fontWeight: 600,
                        color: b.vehicle_number ? 'var(--primary)' : 'var(--warning)' }}>
                        {b.vehicle_number || 'Chờ số xe'}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-2)' }}>Địa điểm:</div>
                      <div>{b.delivery_location || '—'}</div>
                    </div>
                    <div style={{ textAlign: 'center', color: 'var(--text-2)' }}>
                      <strong>{(b.containers || []).length}</strong> cont
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                        onClick={e => { e.stopPropagation(); onEdit(j, b); }}>✏️ Sửa</button>
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--danger)' }}
                        onClick={e => { e.stopPropagation(); onDelete(b); }}>🗑 Xóa</button>
                    </div>
                    {b.receiver_name && (
                      <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-2)',
                        paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                        👤 Người liên hệ: <strong style={{ color: 'var(--text)' }}>{b.receiver_name}</strong>
                        {b.receiver_phone ? ` — ${b.receiver_phone}` : ''}
                      </div>
                    )}
                    {/* CP6.1 — sign-off ticks display (read-only). */}
                    <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-2)',
                      paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                      📋 Nâng hạ: {b.invoice_lifting_ticked
                        ? <span style={{ color: 'var(--primary)' }}>✅ Đã</span>
                        : <span style={{ color: 'var(--warning)' }}>❌ Chưa</span>}
                      {' | '}
                      💵 Cost: {b.cost_entered_ticked
                        ? <span style={{ color: 'var(--primary)' }}>✅ Đã</span>
                        : <span style={{ color: 'var(--warning)' }}>❌ Chưa</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function BookingDeleteConfirm({ booking, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  async function go() {
    setDeleting(true);
    try {
      await deleteTruckBooking(booking.id);
      toast.success('Đã xóa kế hoạch');
      onDeleted?.();
      onClose?.();
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi xóa');
    } finally {
      setDeleting(false);
    }
  }
  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 460, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Xóa kế hoạch giao xe</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16, fontSize: 13 }}>
          <p>Xóa kế hoạch <strong>{booking.transport_name}</strong>? Các cont sẽ trở lại trạng thái chưa đặt xe.</p>
          <p style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 8 }}>
            Soft delete — booking row vẫn được giữ làm audit; cont links sẽ bị xóa cứng để cho phép đặt xe lại.
          </p>
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={deleting}>Hủy</button>
          <button className="btn btn-danger btn-sm" disabled={deleting} onClick={go}>
            {deleting ? 'Đang xóa...' : 'Xóa'}
          </button>
        </div>
      </div>
    </div>
  );
}
