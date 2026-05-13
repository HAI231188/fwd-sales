import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
// Phase 4.1: bookings table + BBBG-per-booking restored after Phase 4 removed inline edit.
import {
  getJob, updateJobTk, updateJob, deleteJob, requestJobDelete, getLogStaff,
  getTruckBookings, deleteTruckBooking,
} from '../api';
import TransportPicker from './TransportPicker';
import BookingModal from './BookingModal';
import BBBGModal from './BBBGModal';
import { useModalZIndex } from '../hooks/useModalZIndex';
import { useAuth } from '../App';
import { TRUCK_BOOKING_STATUS_LABELS, truckBookingPillStyle } from '../utils/truckBookingStatus';

const TK_FLOW_OPTIONS = [
  { value: 'xanh', label: 'Xanh', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
  { value: 'vang', label: 'Vàng', color: '#d97706', bg: 'rgba(217,119,6,0.15)' },
  { value: 'do',   label: 'Đỏ',   color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
];
const TK_FLOW_LABEL = { xanh: 'Xanh', vang: 'Vàng', do: 'Đỏ' };
const TK_FLOW_COLOR = { xanh: '#22c55e', vang: '#d97706', do: '#ef4444' };

const TK_STATUS_OPTIONS = [
  { value: 'chua_truyen', label: 'Chưa truyền' },
  { value: 'dang_lam',    label: 'Đang làm' },
  { value: 'thong_quan',  label: 'Thông quan' },
  { value: 'giai_phong',  label: 'Giải phóng' },
  { value: 'bao_quan',    label: 'Bảo quan' },
];
const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const SVC_LABEL = { tk: 'Tờ khai', truck: 'Vận chuyển', both: 'TK + Vận chuyển' };
const OTHER_SVC_KEYS = ['ktcl', 'kiem_dich', 'hun_trung', 'co', 'khac'];
const OTHER_SVC_LABEL = { ktcl: 'KTCL', kiem_dich: 'Kiểm dịch', hun_trung: 'Hun trùng', co: 'CO', khac: 'Khác' };
const CUS_CONFIRM_LABEL = {
  pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận',
  adjustment_requested: 'Yêu cầu điều chỉnh deadline',
};
const CUS_CONFIRM_COLOR = {
  pending: 'var(--text-2)', confirmed: 'var(--primary)', adjustment_requested: 'var(--warning)',
};
const CONT_TYPES = ['20DC', '40DC', '40HC', '45HC', '20RF', '40RF'];
const OPS_PARTNER_OPTIONS = ['OPS 1', 'OPS 2', 'TTN', 'CDK', 'CTX'];

function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}
function deadlineColor(dl) {
  if (!dl) return 'var(--text-2)';
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return 'var(--danger)';
  if (ms < 48 * 3600 * 1000) return 'var(--warning)';
  return 'var(--primary)';
}
function fmtDest(d) {
  if (d === 'hai_phong') return 'Hải Phòng';
  return d || '—';
}
function toDatetimeLocal(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseJson(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return {}; }
}
function tkFlowAccent(tk) {
  if (!tk) return undefined;
  if (tk.tk_flow === 'xanh') return 'rgba(34,197,94,0.06)';
  if (tk.tk_flow === 'vang') return 'rgba(217,119,6,0.06)';
  if (tk.tk_flow === 'do') return 'rgba(239,68,68,0.06)';
  if (tk.tk_status === 'chua_truyen') return 'rgba(239,68,68,0.04)';
  return undefined;
}

function Section({ title, children, accent }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ background: accent || 'var(--bg)', borderRadius: 8, padding: '4px 0' }}>{children}</div>
    </div>
  );
}

// Phase 4.1: BookingsSection — replaces the deprecated `job.truck` block. Lazily
// fetches /api/truck-bookings?job_id=X when the modal opens. Per-booking actions
// (Sửa / Xóa / BBBG) are gated on DD + TP. The "+ Tạo kế hoạch" button creates
// a new booking via BookingModal. BBBG opens BBBGModal pre-filled with that
// specific booking's transport + containers.
function BookingsSection({ jobId, jobCode, customerName, truckBookingStatus, canWrite }) {
  const qc = useQueryClient();
  const [bookingModalState, setBookingModalState] = useState(null); // {mode, booking?}
  const [bbbgBookingId, setBbbgBookingId] = useState(null);

  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['truckBookings', jobId],
    queryFn: () => getTruckBookings(jobId),
    enabled: !!jobId,
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ['truckBookings', jobId] });
    qc.invalidateQueries({ queryKey: ['job', String(jobId)] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['availableContainers', jobId] });
  }

  async function handleDelete(b) {
    if (!window.confirm(`Xóa kế hoạch ${b.transport_name}? Các cont sẽ trở lại trạng thái chưa đặt xe.`)) return;
    try {
      await deleteTruckBooking(b.id);
      toast.success('Đã xóa kế hoạch');
      refresh();
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi xóa');
    }
  }

  const td = { padding: '8px 10px', verticalAlign: 'top', fontSize: 12 };
  const th = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)',
                fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' };

  return (
    <Section title="Vận chuyển">
      {truckBookingStatus && bookings.length > 0 && (
        <div style={{ padding: '6px 10px 10px' }}>
          <span style={truckBookingPillStyle(truckBookingStatus)}>
            {TRUCK_BOOKING_STATUS_LABELS[truckBookingStatus] || truckBookingStatus}
          </span>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
          Đang tải kế hoạch...
        </div>
      ) : bookings.length === 0 ? (
        <div style={{ padding: '12px 10px', fontSize: 13 }}>
          <div style={{ color: 'var(--text-2)', marginBottom: canWrite ? 10 : 0 }}>
            Chưa có kế hoạch giao xe nào.
          </div>
          {canWrite && (
            <button className="btn btn-primary btn-sm"
              onClick={() => setBookingModalState({ mode: 'create' })}>
              + Tạo kế hoạch
            </button>
          )}
        </div>
      ) : (
        <div style={{ padding: '0 6px 10px' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#fff', borderBottom: '1px solid var(--border)' }}>
                  <th style={th}>Vận tải</th>
                  <th style={th}>Số xe</th>
                  <th style={th}>KH ngày giờ</th>
                  <th style={th}>Địa điểm giao</th>
                  <th style={th}>Cước</th>
                  <th style={th}>Ghi chú</th>
                  {canWrite && <th style={{ ...th, textAlign: 'right' }}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {bookings.map(b => {
                  const transportLive = b.transport_current_name || b.transport_name;
                  const conts = (b.containers || [])
                    .map(c => c.cont_number || `(${c.cont_type} chưa nhập)`)
                    .join(', ');
                  return (
                    <tr key={b.id} style={{ borderBottom: '1px solid var(--border)', background: '#fff' }}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{transportLive}</div>
                        {conts && (
                          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                            Cont: {conts}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        {b.vehicle_number
                          ? <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{b.vehicle_number}</span>
                          : <span style={{ color: 'var(--warning)' }}>⏳ Chờ số xe</span>}
                      </td>
                      <td style={td}>{fmtDt(b.planned_datetime)}</td>
                      <td style={td}>{b.delivery_location || '—'}</td>
                      <td style={td}>{b.cost ? Number(b.cost).toLocaleString('vi-VN') + ' đ' : '—'}</td>
                      <td style={{ ...td, maxWidth: 160 }}>{b.notes || '—'}</td>
                      {canWrite && (
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginRight: 4 }}
                            onClick={() => setBookingModalState({ mode: 'edit', booking: b })}>
                            ✏️ Sửa
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--danger)', marginRight: 4 }}
                            onClick={() => handleDelete(b)}>
                            🗑 Xóa
                          </button>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                            onClick={() => setBbbgBookingId(b.id)}>
                            📄 BBBG
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canWrite && (
            <div style={{ padding: '10px 6px 0' }}>
              <button className="btn btn-ghost btn-sm"
                onClick={() => setBookingModalState({ mode: 'create' })}>
                + Tạo kế hoạch
              </button>
            </div>
          )}
        </div>
      )}

      {bookingModalState && (
        <BookingModal
          mode={bookingModalState.mode}
          jobId={jobId}
          jobCode={jobCode}
          booking={bookingModalState.booking}
          onClose={() => setBookingModalState(null)}
          onSaved={() => refresh()}
        />
      )}
      {bbbgBookingId && (
        <BBBGModal
          jobId={jobId}
          jobCode={jobCode}
          bookingId={bbbgBookingId}
          onClose={() => setBbbgBookingId(null)}
        />
      )}
    </Section>
  );
}

function Row({ label, value, color }) {
  if (value == null || value === '') return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', fontSize: 13 }}>
      <span style={{ color: 'var(--text-2)', flexShrink: 0, marginRight: 8 }}>{label}</span>
      <span style={{ fontWeight: 500, color: color || 'var(--text)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function ERow({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 10px', fontSize: 13 }}>
      <span style={{ color: 'var(--text-2)', flexShrink: 0, marginRight: 8, fontSize: 12 }}>{label}</span>
      <span style={{ textAlign: 'right', flex: 1 }}>{children}</span>
    </div>
  );
}

function InlineInput({ value, onSave, type = 'text' }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || '');
  const ref = useRef();

  function start() { setVal(value || ''); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() { setEditing(false); if (val !== (value || '')) onSave(val || null); }

  if (!editing) return (
    <span onClick={start} title="Click để sửa"
      style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', minWidth: 40, display: 'inline-block', fontSize: 13 }}>
      {value || <span style={{ color: 'var(--text-3)' }}>—</span>}
    </span>
  );
  return (
    <input ref={ref} type={type} value={val}
      {...(type === 'datetime-local' ? { step: 1800 } : {})}
      onChange={e => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      style={{ width: '100%', maxWidth: 200, padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 13 }} />
  );
}

function InlineSelect({ value, options, onSave }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef();

  if (!editing) return (
    <span onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 0); }}
      style={{ cursor: 'pointer', color: TK_STATUS_COLOR[value] || 'var(--text)', fontWeight: 500,
        borderBottom: '1px dashed var(--border)', fontSize: 13 }}>
      {options.find(o => o.value === value)?.label || '—'}
    </span>
  );
  return (
    <select ref={ref} value={value || ''} autoFocus
      onChange={e => { onSave(e.target.value); setEditing(false); }}
      onBlur={() => setEditing(false)}
      style={{ padding: '2px 4px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 13 }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function InlineFlowSelect({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef();
  const opt = TK_FLOW_OPTIONS.find(o => o.value === value);

  if (!editing) return (
    <span onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 0); }}
      title="Click để chọn"
      style={{
        cursor: 'pointer', display: 'inline-block',
        background: opt?.bg || 'transparent',
        color: opt?.color || 'var(--text-3)',
        padding: '1px 8px', borderRadius: 10,
        fontSize: 12, fontWeight: opt ? 600 : 400,
        border: '1px dashed var(--border)',
      }}>
      {opt?.label || '—'}
    </span>
  );
  return (
    <select ref={ref} value={value || ''} autoFocus
      onChange={e => { onSave(e.target.value || null); setEditing(false); }}
      onBlur={() => setEditing(false)}
      style={{ padding: '2px 4px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 13 }}>
      <option value="">— Bỏ chọn —</option>
      {TK_FLOW_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function SvcChips({ services, label }) {
  const active = OTHER_SVC_KEYS.filter(k => services?.[k]);
  if (!active.length) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 10px', fontSize: 13 }}>
      <span style={{ color: 'var(--text-2)', flexShrink: 0, marginRight: 8 }}>{label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
        {active.map(k => (
          <span key={k} style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: 'var(--info-dim)', color: 'var(--info)' }}>
            {OTHER_SVC_LABEL[k]}
          </span>
        ))}
      </div>
    </div>
  );
}

function HistoryRow({ row }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{row.changed_by_name || 'Hệ thống'}</span>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{fmtDt(row.changed_at)}</span>
      </div>
      <div style={{ color: 'var(--text-2)' }}>
        <span style={{ fontWeight: 500, color: 'var(--text)' }}>{row.field_name}</span>
        {row.old_value && <span> · <span style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>{row.old_value}</span></span>}
        {row.new_value && <span> → <span style={{ color: 'var(--primary)' }}>{row.new_value}</span></span>}
      </div>
    </div>
  );
}

function buildDraft(job) {
  const otherSvc = parseJson(job.other_services);
  return {
    job_code: job.job_code || '',
    customer_name: job.customer_name || '',
    customer_address: job.customer_address || '',
    customer_tax_code: job.customer_tax_code || '',
    pol: job.pol || '',
    pod: job.pod || '',
    etd: job.etd ? job.etd.slice(0, 10) : '',
    eta: job.eta ? job.eta.slice(0, 10) : '',
    service_type: job.service_type || 'tk',
    cargo_type: job.cargo_type || 'fcl',
    cont_number: job.cont_number || '',
    cont_type: job.cont_type || '',
    seal_number: job.seal_number || '',
    tons: job.tons || '',
    cbm: job.cbm || '',
    so_kien: job.so_kien || '',
    kg: job.kg || '',
    destination: job.destination || '',
    han_lenh: toDatetimeLocal(job.han_lenh),
    si_number: job.si_number || '',
    mbl_no: job.mbl_no || '',
    hbl_no: job.hbl_no || '',
    ops_partner: job.ops_partner || '',
    sales_id: job.sales_id || '',
    deadline: toDatetimeLocal(job.deadline),
    status: job.status || 'pending',
    other_services: { ...otherSvc },
    containers: Array.isArray(job.containers) && job.containers.length > 0
      ? job.containers.map(c => ({ cont_type: c.cont_type || '', cont_number: c.cont_number || '', seal_number: c.seal_number || '' }))
      : [],
  };
}

const INP = { padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%', background: 'var(--bg-card)' };
const LBL = { fontSize: 12, color: 'var(--text-2)', marginBottom: 3, display: 'block' };

function FRow({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={LBL}>{label}</label>
      {children}
    </div>
  );
}

export default function JobDetailModal({ jobId, onClose }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const zIndex = useModalZIndex();

  const canEditTk = ['cus','cus1','cus2','cus3'].includes(user?.role);
  const canEditStatus = user?.role === 'ops';
  const canEditTruck = user?.role === 'dieu_do';
  const canEditJob = user?.role !== 'ops';
  const isTP = user?.role === 'truong_phong_log';

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState(null);
  const [editErr, setEditErr] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
  });

  const { data: staffList } = useQuery({
    queryKey: ['logStaff'],
    queryFn: getLogStaff,
    enabled: editMode,
  });

  const tkMut = useMutation({
    mutationFn: data => updateJobTk(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', jobId] }),
  });
  // Phase 4: truckMut removed (legacy section is read-only).
  const editMut = useMutation({
    mutationFn: data => updateJob(jobId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['job', jobId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      setEditMode(false);
      setDraft(null);
    },
    onError: err => setEditErr(err?.error || err?.message || 'Lỗi khi lưu'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteJob(jobId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); onClose(); },
    onError: err => setEditErr(err?.error || err?.message || 'Lỗi khi xóa'),
  });
  const deleteReqMut = useMutation({
    mutationFn: () => requestJobDelete(jobId, deleteReason),
    onSuccess: () => { setShowDeleteConfirm(false); setDeleteReason(''); alert('Đã gửi yêu cầu xóa job'); },
    onError: err => setEditErr(err?.error || err?.message || 'Lỗi khi gửi yêu cầu'),
  });

  function startEdit() {
    if (!job) return;
    setDraft(buildDraft(job));
    setEditErr('');
    setEditMode(true);
  }
  function setD(field, value) {
    setDraft(d => ({ ...d, [field]: value }));
  }
  function toggleOs(key) {
    setDraft(d => ({ ...d, other_services: { ...d.other_services, [key]: !d.other_services[key] } }));
  }
  function addCont() {
    setDraft(d => ({ ...d, containers: [...d.containers, { cont_type: '', cont_number: '', seal_number: '' }] }));
  }
  function removeCont(i) {
    setDraft(d => ({ ...d, containers: d.containers.filter((_, idx) => idx !== i) }));
  }
  function updateCont(i, field, value) {
    setDraft(d => {
      const conts = d.containers.map((c, idx) => idx === i ? { ...c, [field]: value } : c);
      return { ...d, containers: conts };
    });
  }
  function handleSave() {
    setEditErr('');
    // han_lenh / Cutoff guard — mirror POST + PUT backend rule. Reject blank
    // before any network call so the user sees the same conditional message
    // they'd get from the server. Label follows job.import_export (read from
    // the source-of-truth row; import_export is not editable via PUT anyway).
    if (!(draft.han_lenh || '').trim()) {
      setEditErr(job?.import_export === 'import'
        ? 'Vui lòng nhập Hạn lệnh'
        : 'Vui lòng nhập Cutoff time');
      return;
    }
    const payload = { ...draft };
    if (!isTP) delete payload.deadline;
    // Coerce empty strings to null for date/numeric columns; PostgreSQL rejects '' for INTEGER/DECIMAL/DATE/TIMESTAMPTZ
    const NULLABLE_WHEN_BLANK = ['etd','eta','han_lenh','deadline','sales_id','tons','cbm','so_kien','kg'];
    for (const f of NULLABLE_WHEN_BLANK) {
      if (payload[f] === '' || payload[f] === undefined) payload[f] = null;
    }
    editMut.mutate(payload);
  }
  function handleDelete() {
    if (isTP) {
      if (window.confirm('Xác nhận xóa job này?')) deleteMut.mutate();
    } else {
      setShowDeleteConfirm(true);
    }
  }

  if (!jobId) return null;

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-xl" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, background: 'var(--info-dim)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📦</div>
            <div>
              <h3 style={{ fontSize: 16 }}>{isLoading ? 'Đang tải...' : (job?.job_code || `Job #${jobId}`)}</h3>
              {job && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{job.customer_name}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {job && canEditJob && !editMode && (
              <>
                <button className="btn btn-ghost btn-sm" onClick={startEdit} title="Chỉnh sửa job">✏️ Chỉnh sửa</button>
                <button className="btn btn-danger btn-sm" onClick={handleDelete} title="Xóa job">🗑 Xóa</button>
              </>
            )}
            {editMode && (
              <>
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={editMut.isPending}>
                  {editMut.isPending ? 'Đang lưu...' : '💾 Lưu'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setEditMode(false); setDraft(null); setEditErr(''); }}>Hủy</button>
              </>
            )}
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>

        {editErr && (
          <div style={{ padding: '8px 20px', background: 'var(--danger-dim)', color: 'var(--danger)', fontSize: 13 }}>{editErr}</div>
        )}

        {showDeleteConfirm && (
          <div style={{ padding: '12px 20px', background: 'var(--warning-dim)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, marginBottom: 8, fontWeight: 600 }}>Gửi yêu cầu xóa job</div>
            <input value={deleteReason} onChange={e => setDeleteReason(e.target.value)}
              placeholder="Lý do xóa (bắt buộc)"
              style={{ ...INP, marginBottom: 8 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger btn-sm" onClick={() => deleteReqMut.mutate()} disabled={!deleteReason.trim() || deleteReqMut.isPending}>
                {deleteReqMut.isPending ? 'Đang gửi...' : 'Gửi yêu cầu'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowDeleteConfirm(false); setDeleteReason(''); }}>Hủy</button>
            </div>
          </div>
        )}

        <div className="modal-body" style={{ padding: 0, display: 'flex', overflow: 'hidden' }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', width: '100%' }}><span className="spinner" /></div>
          ) : job ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', overflow: 'hidden' }}>
              {/* Left: job info */}
              <div style={{ padding: '20px 24px', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>

                {editMode && draft ? (
                  <Section title="Chỉnh sửa job">
                    <div style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                        <FRow label="Mã job">
                          <input style={INP} value={draft.job_code} onChange={e => setD('job_code', e.target.value)} />
                        </FRow>
                        <FRow label="Khách hàng">
                          <input style={INP} value={draft.customer_name} onChange={e => setD('customer_name', e.target.value)} />
                        </FRow>
                        <FRow label="Địa chỉ KH">
                          <input style={INP} value={draft.customer_address} onChange={e => setD('customer_address', e.target.value)} />
                        </FRow>
                        <FRow label="MST">
                          <input style={INP} value={draft.customer_tax_code} onChange={e => setD('customer_tax_code', e.target.value)} />
                        </FRow>
                        <FRow label="POL">
                          <input style={INP} value={draft.pol} onChange={e => setD('pol', e.target.value)} />
                        </FRow>
                        <FRow label="POD">
                          <input style={INP} value={draft.pod} onChange={e => setD('pod', e.target.value)} />
                        </FRow>
                        <FRow label="ETD">
                          <input style={INP} type="date" value={draft.etd} onChange={e => setD('etd', e.target.value)} />
                        </FRow>
                        <FRow label="ETA">
                          <input style={INP} type="date" value={draft.eta} onChange={e => setD('eta', e.target.value)} />
                        </FRow>
                        <FRow label="Mã SI">
                          <input style={INP} value={draft.si_number} onChange={e => setD('si_number', e.target.value)} />
                        </FRow>
                        <FRow label="MBL No">
                          <input style={INP} value={draft.mbl_no} onChange={e => setD('mbl_no', e.target.value)} />
                        </FRow>
                        <FRow label="HBL No">
                          <input style={INP} value={draft.hbl_no} onChange={e => setD('hbl_no', e.target.value)} />
                        </FRow>
                        <FRow label={job.import_export === 'import' ? 'Hạn lệnh' : 'Cutoff time'}>
                          {job.import_export === 'import' ? (
                            <input style={INP} type="date"
                              value={(draft.han_lenh || '').slice(0, 10)}
                              onChange={e => setD('han_lenh', e.target.value)} />
                          ) : (
                            <input style={INP} type="datetime-local" step={1800}
                              value={draft.han_lenh}
                              onChange={e => setD('han_lenh', e.target.value)} />
                          )}
                        </FRow>
                        <FRow label="Điểm đến">
                          <select style={INP} value={draft.destination} onChange={e => setD('destination', e.target.value)}>
                            <option value="">—</option>
                            <option value="hai_phong">Hải Phòng</option>
                            <option value="khac">Khác</option>
                          </select>
                        </FRow>
                        <FRow label="Dịch vụ">
                          <select style={INP} value={draft.service_type} onChange={e => setD('service_type', e.target.value)}>
                            <option value="tk">Tờ khai</option>
                            <option value="truck">Vận chuyển</option>
                            <option value="both">TK + Vận chuyển</option>
                          </select>
                        </FRow>
                        <FRow label="Đối tác OPS">
                          <select style={INP} value={draft.ops_partner} onChange={e => setD('ops_partner', e.target.value)}>
                            <option value="">—</option>
                            {OPS_PARTNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                            {draft.ops_partner && !OPS_PARTNER_OPTIONS.includes(draft.ops_partner) && (
                              <option value={draft.ops_partner}>{draft.ops_partner}</option>
                            )}
                          </select>
                        </FRow>
                        {staffList && (
                          <FRow label="Sales">
                            <select style={INP} value={draft.sales_id} onChange={e => setD('sales_id', e.target.value)}>
                              <option value="">—</option>
                              {staffList.filter(s => ['sales','lead'].includes(s.role)).map(s => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </FRow>
                        )}
                        {isTP && (
                          <FRow label="Deadline">
                            <input style={INP} type="datetime-local" step={1800} value={draft.deadline} onChange={e => setD('deadline', e.target.value)} />
                          </FRow>
                        )}
                        <FRow label="Trạng thái">
                          <select style={INP} value={draft.status} onChange={e => setD('status', e.target.value)}>
                            <option value="pending">Đang xử lý</option>
                            <option value="completed">Hoàn thành</option>
                          </select>
                        </FRow>
                      </div>

                      <div style={{ marginBottom: 10 }}>
                        <label style={LBL}>Loại hàng</label>
                        <div style={{ display: 'flex', gap: 16 }}>
                          {['fcl','lcl'].map(v => (
                            <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                              <input type="radio" name="cargo_type" value={v} checked={draft.cargo_type === v} onChange={e => setD('cargo_type', e.target.value)} />
                              {v.toUpperCase()}
                            </label>
                          ))}
                        </div>
                      </div>

                      {draft.cargo_type === 'lcl' ? (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                          <FRow label="Số kiện"><input style={INP} type="number" value={draft.so_kien} onChange={e => setD('so_kien', e.target.value)} /></FRow>
                          <FRow label="Kg"><input style={INP} type="number" value={draft.kg} onChange={e => setD('kg', e.target.value)} /></FRow>
                          <FRow label="CBM"><input style={INP} type="number" value={draft.cbm} onChange={e => setD('cbm', e.target.value)} /></FRow>
                        </div>
                      ) : (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <label style={{ ...LBL, marginBottom: 0 }}>Containers</label>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={addCont} style={{ fontSize: 11 }}>+ Thêm cont</button>
                          </div>
                          {draft.containers.length === 0 ? (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 12px' }}>
                              <FRow label="Số cont"><input style={INP} value={draft.cont_number} onChange={e => setD('cont_number', e.target.value)} /></FRow>
                              <FRow label="Loại cont">
                                <select style={INP} value={draft.cont_type} onChange={e => setD('cont_type', e.target.value)}>
                                  <option value="">—</option>
                                  {CONT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </FRow>
                              <FRow label="Số seal"><input style={INP} value={draft.seal_number} onChange={e => setD('seal_number', e.target.value)} /></FRow>
                            </div>
                          ) : (
                            draft.containers.map((c, i) => (
                              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '0 8px', marginBottom: 8, alignItems: 'end' }}>
                                <FRow label={i === 0 ? 'Loại cont' : ''}>
                                  <select style={INP} value={c.cont_type} onChange={e => updateCont(i, 'cont_type', e.target.value)}>
                                    <option value="">—</option>
                                    {CONT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                  </select>
                                </FRow>
                                <FRow label={i === 0 ? 'Số cont' : ''}>
                                  <input style={INP} value={c.cont_number} onChange={e => updateCont(i, 'cont_number', e.target.value)} />
                                </FRow>
                                <FRow label={i === 0 ? 'Số seal' : ''}>
                                  <input style={INP} value={c.seal_number} onChange={e => updateCont(i, 'seal_number', e.target.value)} />
                                </FRow>
                                <button type="button" onClick={() => removeCont(i)} style={{ padding: '4px 8px', background: 'var(--danger-dim)', border: 'none', borderRadius: 4, cursor: 'pointer', color: 'var(--danger)', marginBottom: 10 }}>✕</button>
                              </div>
                            ))
                          )}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                            <FRow label="Tấn"><input style={INP} type="number" value={draft.tons} onChange={e => setD('tons', e.target.value)} /></FRow>
                            <FRow label="CBM"><input style={INP} type="number" value={draft.cbm} onChange={e => setD('cbm', e.target.value)} /></FRow>
                          </div>
                        </div>
                      )}

                      <div style={{ marginBottom: 10 }}>
                        <label style={LBL}>Dịch vụ khác</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                          {OTHER_SVC_KEYS.map(k => (
                            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                              <input type="checkbox" checked={!!draft.other_services[k]} onChange={() => toggleOs(k)} />
                              {OTHER_SVC_LABEL[k]}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Section>
                ) : (
                  <>
                    <Section title="Thông tin chung">
                      <Row label="Mã job" value={job.job_code || '—'} />
                      <Row label="Mã SI" value={job.si_number || '—'} />
                      <Row label="MBL No" value={job.mbl_no || '—'} />
                      <Row label="HBL No" value={job.hbl_no || '—'} />
                      <Row label="Ngày tạo" value={fmtDt(job.created_at)} />
                      <Row label="Người tạo" value={job.created_by_name || '—'} />
                      <Row label={job.import_export === 'import' ? 'Hạn lệnh' : 'Cutoff time'}
                           value={job.han_lenh
                             ? (job.import_export === 'import' ? fmtDate(job.han_lenh) : fmtDt(job.han_lenh))
                             : '—'}
                           color={deadlineColor(job.han_lenh)} />
                      <Row label="Điểm đến" value={fmtDest(job.destination)} />
                      <Row label="Loại lô" value={job.import_export === 'import' ? 'Hàng nhập' : 'Hàng xuất'}
                           color={job.import_export === 'import' ? '#d97706' : '#16a34a'} />
                      <Row label="Khách hàng" value={job.customer_name} />
                      <Row label="Địa chỉ" value={job.customer_address || '—'} />
                      <Row label="MST" value={job.customer_tax_code || '—'} />
                      <Row label="Sales" value={job.sales_name || '—'} />
                      <Row label="Dịch vụ" value={SVC_LABEL[job.service_type] || job.service_type} />
                      <SvcChips services={job.other_services} label="Dịch vụ khác" />
                      <Row label="Deadline" value={fmtDt(job.deadline)} color={deadlineColor(job.deadline)} />
                      <Row label="Trạng thái" value={job.status === 'completed' ? 'Hoàn thành' : 'Đang xử lý'}
                           color={job.status === 'completed' ? 'var(--primary)' : 'var(--text)'} />
                    </Section>

                    <Section title="Lô hàng">
                      <Row label="POL" value={job.pol || '—'} />
                      <Row label="POD" value={job.pod || '—'} />
                      <Row label="ETD" value={fmtDate(job.etd)} />
                      <Row label="ETA" value={fmtDate(job.eta)} />
                      {job.cargo_type === 'lcl' ? (
                        <>
                          <Row label="Loại hàng" value="LCL" />
                          <Row label="Số kiện" value={job.so_kien} />
                          <Row label="Kg" value={job.kg} />
                          <Row label="CBM" value={job.cbm} />
                        </>
                      ) : (
                        <>
                          {Array.isArray(job.containers) && job.containers.length > 0 ? (
                            <div style={{ padding: '4px 10px' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-2)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Loại</th>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-2)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Số cont</th>
                                    <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-2)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Số seal</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {job.containers.map((c, i) => (
                                    <tr key={i}>
                                      <td style={{ padding: '4px 6px', fontWeight: 500 }}>{c.cont_type}</td>
                                      <td style={{ padding: '4px 6px' }}>{c.cont_number || '—'}</td>
                                      <td style={{ padding: '4px 6px', color: 'var(--text-2)' }}>{c.seal_number || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <>
                              <Row label="Số cont" value={job.cont_number || '—'} />
                              <Row label="Loại cont" value={job.cont_type || '—'} />
                              <Row label="Số seal" value={job.seal_number || '—'} />
                            </>
                          )}
                          <Row label="Tấn" value={job.tons} />
                          <Row label="CBM" value={job.cbm} />
                        </>
                      )}
                    </Section>
                  </>
                )}

                <Section title="Phân công">
                  <Row label="Nhân viên CUS" value={job.cus_name || '—'} />
                  <Row label="Xác nhận CUS"
                       value={CUS_CONFIRM_LABEL[job.cus_confirm_status] || '—'}
                       color={CUS_CONFIRM_COLOR[job.cus_confirm_status]} />
                  {job.adjustment_deadline_proposed && (
                    <Row label="Đề xuất deadline mới" value={fmtDt(job.adjustment_deadline_proposed)} color="var(--warning)" />
                  )}
                  {job.adjustment_reason && (
                    <Row label="Lý do điều chỉnh" value={job.adjustment_reason} />
                  )}
                  <Row label="Nhân viên OPS" value={job.ops_name || '—'} />
                  <Row label="Đối tác OPS" value={job.ops_partner || '—'} />
                  {job.ops_done != null && (
                    <Row label="Xong việc OPS"
                      value={job.ops_done ? `Đã xong — ${fmtDt(job.ops_done_at)}` : 'Chưa xong'}
                      color={job.ops_done ? 'var(--primary)' : 'var(--warning)'} />
                  )}
                  {(job.service_type === 'truck' || job.service_type === 'both') && (
                    <Row label="Điều Độ" value={job.dieu_do_name || '—'} />
                  )}
                </Section>

                {job.tk && (() => {
                  const tk = job.tk;
                  const svc = parseJson(tk.services_completed);
                  const otherSvc = parseJson(job.other_services);
                  const activeSvcKeys = OTHER_SVC_KEYS.filter(k => otherSvc[k]);
                  return (
                    <Section title="Tờ khai" accent={tkFlowAccent(tk)}>
                      <Row label="CUS xử lý" value={tk.cus_name || '—'} />
                      {canEditTk ? (
                        <>
                          <ERow label="Ngày TK">
                            <InlineInput type="datetime-local" value={toDatetimeLocal(tk.tk_datetime)}
                              onSave={v => tkMut.mutate({ tk_datetime: v })} />
                          </ERow>
                          <ERow label="Số TK">
                            <InlineInput value={tk.tk_number} onSave={v => tkMut.mutate({ tk_number: v })} />
                          </ERow>
                          <ERow label="Luồng">
                            <InlineFlowSelect value={tk.tk_flow} onSave={v => tkMut.mutate({ tk_flow: v })} />
                          </ERow>
                          <ERow label="Trạng thái">
                            <InlineSelect value={tk.tk_status} options={TK_STATUS_OPTIONS}
                              onSave={v => tkMut.mutate({ tk_status: v })} />
                          </ERow>
                          <ERow label="Ngày TQ">
                            <InlineInput type="datetime-local" value={toDatetimeLocal(tk.tq_datetime)}
                              onSave={v => tkMut.mutate({ tq_datetime: v })} />
                          </ERow>
                          <ERow label="Ngày giao">
                            <InlineInput type="datetime-local" value={toDatetimeLocal(tk.delivery_datetime)}
                              onSave={v => tkMut.mutate({ delivery_datetime: v })} />
                          </ERow>
                          <ERow label="Địa điểm giao">
                            <InlineInput value={tk.delivery_location} onSave={v => tkMut.mutate({ delivery_location: v })} />
                          </ERow>
                          <ERow label="Đặt xe">
                            <input type="checkbox" checked={!!tk.truck_booked}
                              disabled={(!tk.delivery_datetime || !tk.delivery_location) && !tk.truck_booked}
                              title={(!tk.delivery_datetime || !tk.delivery_location) && !tk.truck_booked
                                ? 'Nhập thời gian và địa điểm giao trước khi đặt xe'
                                : 'Đặt xe'}
                              onChange={e => tkMut.mutate({ truck_booked: e.target.checked })} />
                          </ERow>
                          {activeSvcKeys.length > 0 && (
                            <ERow label="Dịch vụ HT">
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                                {activeSvcKeys.map(k => (
                                  <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                                    <input type="checkbox" checked={!!svc[k]}
                                      onChange={e => tkMut.mutate({ services_completed: { ...svc, [k]: e.target.checked } })} />
                                    {OTHER_SVC_LABEL[k]}
                                  </label>
                                ))}
                              </div>
                            </ERow>
                          )}
                          <ERow label="Ghi chú TK">
                            <InlineInput value={tk.notes} onSave={v => tkMut.mutate({ notes: v })} />
                          </ERow>
                        </>
                      ) : canEditStatus ? (
                        <>
                          <Row label="Ngày TK" value={fmtDt(tk.tk_datetime)} />
                          <Row label="Số TK" value={tk.tk_number || '—'} />
                          <Row label="Luồng" value={TK_FLOW_LABEL[tk.tk_flow] || '—'} color={TK_FLOW_COLOR[tk.tk_flow]} />
                          <ERow label="Trạng thái">
                            <InlineSelect value={tk.tk_status} options={TK_STATUS_OPTIONS}
                              onSave={v => tkMut.mutate({ tk_status: v })} />
                          </ERow>
                          <Row label="Ngày TQ" value={fmtDt(tk.tq_datetime)} />
                          <Row label="Ngày giao" value={fmtDt(tk.delivery_datetime)} />
                          <Row label="Địa điểm giao" value={tk.delivery_location || '—'} />
                          <Row label="Đặt xe" value={tk.truck_booked ? 'Có' : 'Không'} />
                          <Row label="Ghi chú TK" value={tk.notes || '—'} />
                        </>
                      ) : (
                        <>
                          <Row label="Ngày TK" value={fmtDt(tk.tk_datetime)} />
                          <Row label="Số TK" value={tk.tk_number || '—'} />
                          <Row label="Luồng" value={TK_FLOW_LABEL[tk.tk_flow] || '—'} color={TK_FLOW_COLOR[tk.tk_flow]} />
                          <Row label="Trạng thái" value={TK_STATUS_LABEL[tk.tk_status] || '—'}
                               color={TK_STATUS_COLOR[tk.tk_status]} />
                          <Row label="Ngày TQ" value={fmtDt(tk.tq_datetime)} />
                          <Row label="Ngày giao" value={fmtDt(tk.delivery_datetime)} />
                          <Row label="Địa điểm giao" value={tk.delivery_location || '—'} />
                          <Row label="Đặt xe" value={tk.truck_booked ? 'Có' : 'Không'} />
                          <Row label="Ghi chú TK" value={tk.notes || '—'} />
                        </>
                      )}
                      <Row label="Hoàn thành lúc" value={fmtDt(tk.completed_at)} color="var(--primary)" />
                    </Section>
                  );
                })()}

                {(job.service_type === 'truck' || job.service_type === 'both') && (
                  <BookingsSection
                    jobId={job.id}
                    jobCode={job.job_code}
                    customerName={job.customer_name}
                    truckBookingStatus={job.truck_booking_status}
                    canWrite={user?.role === 'dieu_do' || user?.role === 'truong_phong_log'}
                  />
                )}

                {job.ops_tasks?.length > 0 && (
                  <Section title="Công việc OPS">
                    {job.ops_tasks.map(t => (
                      <div key={t.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontWeight: 500 }}>{t.ops_name || '—'}</span>
                          <span style={{ color: t.completed ? 'var(--primary)' : 'var(--warning)', fontSize: 11 }}>
                            {t.completed ? '✓ Hoàn thành' : 'Chờ xử lý'}
                          </span>
                        </div>
                        {t.content && <div style={{ color: 'var(--text-2)', marginBottom: 2 }}>{t.content}</div>}
                        {t.port && <div style={{ color: 'var(--text-3)', fontSize: 11 }}>Cảng: {t.port}</div>}
                        {t.deadline && (
                          <div style={{ fontSize: 11, color: deadlineColor(t.deadline), marginTop: 2 }}>
                            Deadline: {fmtDt(t.deadline)}
                          </div>
                        )}
                        {t.completed_at && (
                          <div style={{ fontSize: 11, color: 'var(--primary)', marginTop: 2 }}>
                            Hoàn thành lúc: {fmtDt(t.completed_at)}
                          </div>
                        )}
                        {t.notes && (
                          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2, fontStyle: 'italic' }}>
                            Ghi chú: {t.notes}
                          </div>
                        )}
                      </div>
                    ))}
                  </Section>
                )}
              </div>

              {/* Right: history */}
              <div style={{ padding: '20px 24px', overflowY: 'auto', background: 'var(--bg)' }}>
                <div className="section-title" style={{ marginBottom: 12 }}>Lịch sử thay đổi</div>
                {!job.history?.length && (
                  <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Chưa có lịch sử</div>
                )}
                {job.history?.map(h => <HistoryRow key={h.id} row={h} />)}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  ), document.body);
}
