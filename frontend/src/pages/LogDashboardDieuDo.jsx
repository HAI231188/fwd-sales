import { useState, useEffect } from 'react';
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
import toast from 'react-hot-toast';
// Phase 4: TransportPicker no longer needed on DD main grid — bookings hold
// carrier info via BookingModal. updateJobTruck + completeJobTruck removed.
import { getJobStats, getJobs, requestJobDelete, createJob,
         getTruckBookings, deleteTruckBooking } from '../api';
import {
  TRUCK_BOOKING_STATUS_LABELS, TRUCK_BOOKING_STATUS_SORT_RANK,
  TRUCK_BOOKING_ACTIVE_STATUSES, truckBookingPillStyle,
} from '../utils/truckBookingStatus';

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
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

// Phase 4: InlineInput removed — DD main grid is read-only; booking edits live
// in the Quản lý đặt xe section via BookingModal.

// Phase 4: DD main grid is a read-only summary view. Booking edits happen in
// the "Quản lý đặt xe" section above (one job → N bookings, can't fit inline).
// Click a row → JobDetailModal opens for full audit.
const DD_COLS = [
  { key: 'created_at',     label: 'Ngày' },
  { key: 'job_code',       label: 'Job',              filterType: 'text' },
  { key: 'si_number',      label: 'Mã SI',            filterType: 'text' },
  { key: 'import_export',  label: 'Loại' },
  { key: 'customer_name',  label: 'Khách hàng',       filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',          label: 'Cont / Tons' },
  { key: 'etd_eta',        label: 'ETD / ETA' },
  { key: 'han_lenh',       label: 'Hạn lệnh / Cutoff' },
  { key: 'booking_status', label: 'Trạng thái đặt xe' },
  { key: 'cont_coverage',  label: 'Cont' },
  { key: 'booking_count',  label: 'Booking' },
  { key: 'doi_lenh',       label: 'TT đổi lệnh' },
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
  // Phase 4: tab filters use truck_booking_status. "Đã có KH xe" = at least one
  // booking exists (any non-final live status); "Chưa có KH xe" = no bookings.
  const coKhXeJobs = pendingJobs.filter(j =>
    j.truck_booking_status === 'dat_xe_1_phan' ||
    j.truck_booking_status === 'da_dat_xe_du_cho_so_xe');
  const chuaKhXeJobs = pendingJobs.filter(j => j.truck_booking_status === 'chua_dat_xe');
  const jobs = tab === 'completed' ? completedJobs
    : tab === 'co_kh_xe' ? coKhXeJobs
    : tab === 'chua_kh_xe' ? chuaKhXeJobs
    : pendingJobs;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;

  // Phase 4: truckMut + completeMut removed. Booking edits go through BookingModal
  // → updateTruckBooking / createTruckBooking. Job auto-completes when every
  // booking has a vehicle_number (server-side trigger in PATCH /api/truck-bookings).
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          {/* Card 1: Tổng job — 3 rows with per-row click */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Tổng job truck đang xử lý</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Tổng', value: stats?.tong_job, color: 'var(--info)', filter: 'truck_total' },
                { label: 'Đã có KH xe', value: stats?.tong_co_kh_xe, color: 'var(--primary)', filter: 'dd_co_kh_xe' },
                { label: 'Chưa có KH xe', value: stats?.tong_chua_kh_xe, color: 'var(--warning)', filter: 'dd_chua_kh_xe' },
              ].map(r => (
                <div key={r.label} onClick={() => setJobListFilter(r.filter)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: `${r.color}12`, border: `1px solid ${r.color}30`, cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, color: r.color, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: 20, fontWeight: 700, color: r.color, fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 2: Đã đặt xe — 2 rows */}
          <div className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Đã đặt xe</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Có KH xe', value: stats?.da_dat_xe_co_kh, color: 'var(--primary)', filter: 'dd_co_kh_xe' },
                { label: 'Có vận tải', value: stats?.da_dat_xe_da_dat, color: 'var(--info)', filter: 'truck_booked' },
              ].map(r => (
                <div key={r.label} onClick={() => setJobListFilter(r.filter)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', borderRadius: 8, background: `${r.color}12`, border: `1px solid ${r.color}30`, cursor: 'pointer' }}>
                  <span style={{ fontSize: 11, color: r.color, fontWeight: 600 }}>{r.label}</span>
                  <span style={{ fontSize: 20, fontWeight: 700, color: r.color, fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
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
          onCreate={(j) => setBookingModalState({ mode: 'create', jobId: j.id, jobCode: j.job_code })}
          onEdit={(j, b) => setBookingModalState({ mode: 'edit', jobId: j.id, jobCode: j.job_code, booking: b })}
          onDelete={(b) => setDeletingBooking({ id: b.id, transport_name: b.transport_name })}
          expanded={expandedBookingJobId}
          onToggleExpand={(id) => setExpandedBookingJobId(prev => prev === id ? null : id)}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>Đang làm</button>
              <button className={`tab ${tab === 'co_kh_xe' ? 'active' : ''}`} onClick={() => setTab('co_kh_xe')}>Đã có KH xe</button>
              <button className={`tab ${tab === 'chua_kh_xe' ? 'active' : ''}`} onClick={() => setTab('chua_kh_xe')}>Chưa có KH xe</button>
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
                renderRow={(j) => {
                  // Phase 4: read-only summary. Booking-level edits live in the
                  // Quản lý đặt xe section above. Click row → JobDetailModal.
                  const cs = { padding: '8px 8px', verticalAlign: 'middle' };
                  const total = Array.isArray(j.containers) ? j.containers.length : 0;
                  const booked = j.truck_booked_containers_count || 0;
                  const imp = j.import_export === 'import';
                  return (
                    <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => setDetailJobId(j.id)}>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                      <td style={{ ...cs, whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--info)' }}>{j.job_code || `#${j.id}`}</td>
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
                        <span style={truckBookingPillStyle(j.truck_booking_status)}>
                          {TRUCK_BOOKING_STATUS_LABELS[j.truck_booking_status] || j.truck_booking_status || '—'}
                        </span>
                      </td>
                      <td style={{ ...cs, fontWeight: 600,
                        color: total === 0 ? 'var(--text-3)' : booked < total ? 'var(--warning)' : 'var(--primary)' }}>
                        {booked}/{total}
                      </td>
                      <td style={{ ...cs, fontWeight: 600 }}>{j.truck_bookings_count || 0}</td>
                      <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                        {(j.destination === 'hai_phong' && (j.service_type === 'truck' || j.service_type === 'both'))
                          ? j.ops_done
                            ? <span style={{ background: 'rgba(34,197,94,0.15)', color: '#16a34a', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Đã đổi</span>
                            : <span style={{ background: 'rgba(217,119,6,0.12)', color: '#b45309', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Chưa đổi</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
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
      {bbbgJob && <BBBGModal jobId={bbbgJob.id} jobCode={bbbgJob.code} onClose={() => setBbbgJob(null)} />}
      {showCreate && <CreateJobModal onClose={() => setShowCreate(false)} onCreated={data => createMut.mutateAsync(data)} />}
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
function BookingManagementSection({ jobs, onOpenJob, onCreate, onEdit, onDelete, expanded, onToggleExpand }) {
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
                    onOpenJob={onOpenJob} onCreate={onCreate} onEdit={onEdit} onDelete={onDelete}
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
                     onOpenJob, onCreate, onEdit, onDelete, onToggleExpand }) {
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
          <span style={truckBookingPillStyle(j.truck_booking_status)}>
            {TRUCK_BOOKING_STATUS_LABELS[j.truck_booking_status] || j.truck_booking_status}
          </span>
        </td>
        <td style={{ ...td, fontWeight: 600, color: booked < total ? 'var(--warning)' : 'var(--primary)' }}>
          {booked}/{total}
        </td>
        <td style={{ ...td, fontWeight: 600 }}>{j.truck_bookings_count || 0}</td>
        <td style={{ ...td, whiteSpace: 'nowrap', fontSize: 12 }}>{hl}</td>
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={e => { e.stopPropagation(); onCreate(j); }}>
            + Tạo kế hoạch
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr style={{ background: 'var(--bg)' }}>
          <td colSpan={8} style={{ padding: '8px 18px 14px' }}>
            {isLoading ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>Đang tải bookings...</div>
            ) : bookings.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
                Job này chưa có kế hoạch giao xe nào. Bấm "+ Tạo kế hoạch" để bắt đầu.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {bookings.map(b => (
                  <div key={b.id} style={{ display: 'grid',
                    gridTemplateColumns: '1.4fr 1.4fr 1fr 1.4fr 0.6fr auto',
                    gap: 8, padding: '8px 10px', background: '#fff',
                    border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{b.transport_current_name || b.transport_name}</div>
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
