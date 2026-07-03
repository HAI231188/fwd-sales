import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import JobListModal from '../components/JobListModal';
import PlanDeliveryModal from '../components/PlanDeliveryModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import StaffSection, { CUS_COLS } from '../components/StaffSection';
import { useModalZIndex } from '../hooks/useModalZIndex';
import {
  getJobStats, getJobs, updateJobTk, updateJob, confirmJob, requestDeadline, completeJob,
  requestJobDelete, createJob,
  tickJobTkCost, untickJobTkCost,
} from '../api';
import { fmtDate, fmtDateTime as fmtDt, toDatetimeLocal, vnLocalToIso } from '../utils/dateFmt';

const TK_STATUS_OPTIONS = [
  { value: 'chua_truyen', label: 'Chưa truyền' },
  { value: 'dang_lam',    label: 'Đang làm' },
  { value: 'thong_quan',  label: 'Thông quan' },
  { value: 'giai_phong',  label: 'Giải phóng' },
  { value: 'bao_quan',    label: 'Bảo quan' },
];
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const OTHER_SVC_KEYS = ['kiem_dich', 'hun_trung', 'co', 'dkktcl', 'khac'];
const OTHER_SVC_LABEL = {
  kiem_dich: 'Kiểm dịch', hun_trung: 'Hun trùng', co: 'CO', dkktcl: 'DKKTCL', khac: 'Khác',
};
// Mirror of LogDashboardTP.jsx:22 — copied locally per the project convention
// (frontend/src/CLAUDE.md: "Canonical maps live at the top of each file ... don't
// import them from a shared module — copy the map into the file that needs it").
const SVC_LABEL = { tk: 'TK', truck: 'Xe', both: 'TK+Xe', ops_hp: 'OPS HP' };

function deadlineStyle(dl) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 24 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}
// CUS-overdue coloring gate (2026-07): the amber/red deadline warning only
// applies while TK is not yet done (tk_datetime NULL). Once tk_datetime is set
// the deadline is satisfied → no tint. If TK was completed AFTER the deadline,
// that's a "Trễ" fact shown via LateBadge (not a tint). Keeps deadlineStyle (L30)
// untouched — gating happens here at the call site.
function cusDeadlineTint(j) {
  if (j.tk_datetime) return {};
  return deadlineStyle(j.deadline);
}
function cusIsLate(j) {
  return !!(j.tk_datetime && j.deadline && new Date(j.tk_datetime) > new Date(j.deadline));
}
function LateBadge({ j }) {
  if (!cusIsLate(j)) return null;
  return (
    <span title="TK hoàn thành sau deadline" style={{
      marginLeft: 6, background: '#b91c1c', color: '#fff',
      borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
    }}>Trễ</span>
  );
}
function parseJson(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return {}; }
}

function StatCard({ label, value, color, onClick }) {
  return (
    <div className="card" onClick={onClick}
      style={{ textAlign: 'center', padding: '16px 12px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>{value ?? '—'}</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

function InlineInput({ value, onSave, type = 'text' }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef();

  function start() { setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() {
    setEditing(false);
    // UNCONTROLLED input: read the live DOM value at save time. datetime-local's
    // onChange is unreliable and a controlled value could be reset by a mid-edit
    // refetch, so we never trust React state here. (FIX 2)
    const raw = ref.current?.value ?? '';
    if (type === 'datetime-local') {
      // Always emit on a real save for datetime; vnLocalToIso anchors the picked
      // wall-clock to Vietnam time (+07:00) so storage is unambiguous. (FIX 3)
      onSave(vnLocalToIso(raw));
      return;
    }
    if (raw !== (value || '')) onSave(raw || null);
  }

  if (!editing) return (
    <span onClick={start} title="Click để sửa"
      style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', minWidth: 40, display: 'inline-block', fontSize: 13 }}>
      {value || <span style={{ color: 'var(--text-3)' }}>—</span>}
    </span>
  );
  return (
    <input ref={ref} type={type} defaultValue={value || ''}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
      style={{ width: '100%', padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 13 }} />
  );
}

function InlineSelect({ value, options, onSave }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef();

  if (!editing) return (
    <span onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 0); }}
      style={{ cursor: 'pointer', color: TK_STATUS_COLOR[value] || 'var(--text)', fontWeight: 500, borderBottom: '1px dashed var(--border)', fontSize: 13 }}>
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

const TK_FLOW_OPTIONS = [
  { value: 'xanh', label: 'Xanh', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
  { value: 'vang', label: 'Vàng', color: '#d97706', bg: 'rgba(217,119,6,0.15)' },
  { value: 'do',   label: 'Đỏ',   color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
];

const OPS_PARTNER_OPTIONS = ['OPS 1', 'OPS 2', 'TTN', 'CDK', 'CTX'];

function tkFlowRowBg(j) {
  if (j.tk_flow === 'xanh') return 'rgba(34,197,94,0.06)';
  if (j.tk_flow === 'vang') return 'rgba(217,119,6,0.06)';
  if (j.tk_flow === 'do') return 'rgba(239,68,68,0.06)';
  if (j.tk_status === 'chua_truyen') return 'rgba(239,68,68,0.04)';
  return '';
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

function OpsPartnerCell({ job, onSave }) {
  const [mode, setMode] = useState('view');
  const [custom, setCustom] = useState('');
  const inputRef = useRef();

  if (job.ops_id) {
    return <span style={{ fontSize: 12 }}>{job.ops_name || '—'}</span>;
  }
  if (mode === 'input') {
    return (
      <input ref={inputRef} autoFocus value={custom}
        onChange={e => setCustom(e.target.value)}
        onBlur={() => { onSave(custom || null); setMode('view'); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { onSave(custom || null); setMode('view'); }
          if (e.key === 'Escape') setMode('view');
        }}
        style={{ width: 80, padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 12 }} />
    );
  }
  if (mode === 'select') {
    return (
      <select autoFocus value=""
        onChange={e => {
          if (e.target.value === '__custom__') { setCustom(job.ops_partner || ''); setMode('input'); }
          else { onSave(e.target.value || null); setMode('view'); }
        }}
        onBlur={() => setMode('view')}
        style={{ padding: '2px 4px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 12 }}>
        <option value="">— Bỏ chọn —</option>
        {OPS_PARTNER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        <option value="__custom__">Tự điền...</option>
      </select>
    );
  }
  return (
    <span onClick={() => setMode('select')} title="Click để chọn"
      style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', fontSize: 12,
        color: job.ops_partner ? 'var(--text)' : 'var(--text-3)', display: 'inline-block', minWidth: 30 }}>
      {job.ops_partner || '—'}
    </span>
  );
}

// 2026-05-25 CUS status helpers.
// cusStatusInfo: CUS's own done-state (TK + cost). Returns null for truck-only.
//   - !tk_completed_at                    → "Chưa làm tờ khai"        (orange)
//   - tk_completed_at && !cost_entered_at → "Đã làm TK — chưa nhập cost" (warning)
//   - tk_completed_at && cost_entered_at  → "Xong"                    (green)
function cusStatusInfo(j) {
  if (j.service_type === 'truck') return null;
  if (!j.tk_completed_at) {
    return { label: 'Chưa làm tờ khai', bg: 'rgba(217,119,6,0.12)', fg: '#d97706' };
  }
  if (!j.cost_entered_at) {
    return { label: 'Đã làm TK — chưa nhập cost', bg: 'rgba(217,119,6,0.12)', fg: '#b45309' };
  }
  return { label: 'Xong', bg: 'rgba(34,197,94,0.15)', fg: '#16a34a' };
}
// cusWaitingStatus: who CUS is waiting on (per spec — just done/not-done, no detail).
//   - tk job HP: OPS doi_lenh not done → "OPS đổi lệnh"
//   - both job:  truck_booking_status not at DD-done/job-done → "DD đủ xe"
function cusWaitingStatus(j) {
  const items = [];
  if (j.service_type === 'tk' && j.destination === 'hai_phong') {
    const dl = (Array.isArray(j.ops_tasks) ? j.ops_tasks : []).find(t => t.task_type === 'doi_lenh');
    if (dl && !(dl.completed === true && !!dl.cost_entered_at)) {
      items.push('OPS đổi lệnh');
    }
  }
  if (j.service_type === 'both') {
    const ddDoneStates = ['du_xe_cho_giao', 'dd_da_xong', 'hoan_thanh'];
    if (!ddDoneStates.includes(j.truck_booking_status)) {
      items.push('DD đủ xe');
    }
  }
  return items;
}
// cusIsDone: CUS's tab partition predicate.
function cusIsDone(j) {
  return cusStatusInfo(j)?.label === 'Xong' && cusWaitingStatus(j).length === 0;
}

const CUS_FILTER_COLS = [
  { key: 'stt',              label: 'STT' },
  { key: 'created_at',       label: 'Ngày' },
  { key: 'job_code',         label: 'Job',            filterType: 'text' },
  { key: 'si_number',        label: 'Mã SI',          filterType: 'text' },
  { key: 'service_type',     label: 'Dịch vụ' },
  { key: 'customer_name',    label: 'Khách hàng',     filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'ops_col',          label: 'Tên OPS',        filterType: 'text', accessor: j => j.ops_name || j.ops_partner || '' },
  { key: 'etd_eta',          label: 'ETD / ETA' },
  { key: 'deadline',         label: 'Deadline' },
  { key: 'tk_datetime',      label: 'Ngày giờ TK' },
  { key: 'tk_number',        label: 'Số TK',          filterType: 'text' },
  { key: 'tk_flow',          label: 'Luồng TK',       filterType: 'select', options: [
    { value: 'xanh', label: 'Xanh' }, { value: 'vang', label: 'Vàng' }, { value: 'do', label: 'Đỏ' },
  ]},
  { key: 'tk_status',        label: 'Trạng thái TK',  filterType: 'select', options: [
    { value: 'chua_truyen', label: 'Chưa truyền' }, { value: 'dang_lam', label: 'Đang làm' },
    { value: 'thong_quan', label: 'Thông quan' }, { value: 'giai_phong', label: 'Giải phóng' },
    { value: 'bao_quan', label: 'Bảo quan' },
  ]},
  { key: 'tq_datetime',      label: 'Ngày giờ TQ' },
  // 2026-05-25: CUS dept-level status columns.
  { key: 'cus_status',       label: 'Trạng thái' },
  { key: 'cus_waiting',      label: 'Chờ' },
  { key: 'other_svc',        label: 'Dịch vụ khác' },
  { key: 'delivery_dt',      label: 'Ngày giao hàng' },
  { key: 'delivery_loc',     label: 'Địa điểm giao' },
  { key: 'cost_entered_at',  label: 'Nhập cost' },
  { key: 'ht',               label: 'HT' },
  { key: 'notes',            label: 'Ghi chú' },
];

// Phase 6 Phase B2 — Mobile card shell. Mirrors OpsCard (LogDashboardOps:L97).
// Header (job_code + Loại badge) + Khách line + dashed divider + per-tab `body`
// + optional action footer with click-propagation stopped. The CUS dashboard
// only has one FilteredTable (Đang làm / Hoàn thành share it), so this shell
// is consumed once and the body branches on `tab` / `isConfirmPending` / `isTk`
// the same way the desktop renderRow does.
function CusCard({ job: j, body, actions, onOpen, codeColor }) {
  // KT5 — orange chip + left border when KT bounced job back to LOG.
  const isReturned = j.returned_to === 'log';
  return (
    <div className="data-card" onClick={onOpen}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: codeColor || 'var(--info)', fontFamily: 'var(--font-display)' }}>
          {j.job_code || `#${j.id}`}
        </div>
        <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
        <span style={{ color: 'var(--text-2)', fontSize: 11 }}>Khách: </span>
        <strong>{j.customer_name || '—'}</strong>
      </div>
      <div style={{ height: 1, background: 'var(--border)', margin: '6px 0 8px' }} />
      {body}
      {actions && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border)', alignItems: 'center' }}
             onClick={e => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

function DeadlineRequestModal({ job, onClose, onSubmit }) {
  const zIndex = useModalZIndex();
  const [proposed, setProposed] = useState('');
  const [reason, setReason] = useState('');
  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h3>Yêu cầu điều chỉnh deadline</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-2)' }}>
            Job: <strong>{job.job_code || `#${job.id}`}</strong> — {job.customer_name}
          </div>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Deadline đề xuất</label>
            <input type="datetime-local" className="form-input" value={proposed} onChange={e => setProposed(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Lý do</label>
            <textarea className="form-textarea" value={reason} onChange={e => setReason(e.target.value)} placeholder="Nhập lý do..." />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm" disabled={!proposed || !reason}
            onClick={() => onSubmit(proposed, reason)}>Gửi yêu cầu</button>
        </div>
      </div>
    </div>
  ), document.body);
}

export default function LogDashboardCus() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  const [deadlineReqJob, setDeadlineReqJob] = useState(null);
  // Phase 5 Step 2 — "Đặt kế hoạch xe" target. Button lives next to 🔍 on each row.
  const [planModalJob, setPlanModalJob] = useState(null); // {jobId, jobCode}
  const [showCreate, setShowCreate] = useState(false);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

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
  // 2026-05-25 CUS-split: restrict to tk/both jobs only (truck-only never appears
  // in CUS view). Partition by cusIsDone (CUS work + waiting list both clear),
  // NOT by jobs.status. "Hoàn thành" merges both sources to cover the race
  // window between CUS's last tick and checkAndCompleteJob's auto-flip.
  const isCusJob = (j) => j.service_type === 'tk' || j.service_type === 'both';
  const pendingView   = pendingJobs.filter(j => isCusJob(j) && !cusIsDone(j));
  const cusDoneInPending = pendingJobs.filter(j => isCusJob(j) && cusIsDone(j));
  const completedAll  = (completedJobs || []).filter(isCusJob);
  const completedById = new Map();
  for (const j of [...cusDoneInPending, ...completedAll]) {
    if (!completedById.has(j.id)) completedById.set(j.id, j);
  }
  const completedView = Array.from(completedById.values());
  const jobs = tab === 'completed' ? completedView : pendingView;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;

  const tkMut = useMutation({
    mutationFn: ({ jobId, data }) => updateJobTk(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (err) => toast.error(err?.response?.data?.error || err?.error || err?.message || 'Không lưu được số tờ khai'),
  });
  // 2026-05-21 — Cost tick mutations mirror M4 revenue tick (SalesDashboard:240-255).
  // PATCH stamps + triggers checkAndCompleteJob on the backend; DELETE clears
  // (no auto-uncomplete). Both invalidate ['jobs'] so the tab counts + dashboard
  // refetch atomically.
  const tickCostMut = useMutation({
    mutationFn: (jobId) => tickJobTkCost(jobId),
    onSuccess: (resp) => {
      toast.success(resp?.job_completed
        ? 'Đã nhập cost — job hoàn thành'
        : 'Đã nhập cost');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Không tick được cost'),
  });
  const untickCostMut = useMutation({
    mutationFn: (jobId) => untickJobTkCost(jobId),
    onSuccess: () => {
      toast.success('Đã bỏ tick cost');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Không bỏ tick được'),
  });
  function onTickCostClick(j) {
    const msg = `Xác nhận đã nhập cost job ${j.job_code || '#' + j.id}?\n\n`
              + 'Sau khi tick, phần cost TK của bạn coi như xong. '
              + 'Bạn có thể bỏ tick sau nếu sai sót.';
    if (window.confirm(msg)) tickCostMut.mutate(j.id);
  }
  function onUntickCostClick(j) {
    const msg = `Bỏ tick cost job ${j.job_code || '#' + j.id}?\n\n`
              + 'Nếu job đã hoàn thành, bỏ tick KHÔNG đưa job về pending — '
              + 'job vẫn ở trạng thái hoàn thành.';
    if (window.confirm(msg)) untickCostMut.mutate(j.id);
  }
  const confirmMut = useMutation({
    mutationFn: id => confirmJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const deadlineMut = useMutation({
    mutationFn: ({ id, proposed, reason }) => requestDeadline(id, { proposed_deadline: proposed, reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setDeadlineReqJob(null); },
  });
  const completeMut = useMutation({
    mutationFn: id => completeJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
    onError: (err) => {
      const msg = err?.error || err?.message || 'Không thể hoàn thành. Thử lại sau.';
      alert(msg);
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
  const opsMut = useMutation({
    mutationFn: ({ id, data }) => updateJob(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  function getMissingFields(j) {
    const missing = [];
    if (!j.han_lenh)    missing.push(j.import_export === 'import' ? 'Hạn lệnh' : 'Cutoff time');
    if (!j.tk_flow)     missing.push('Luồng TK');
    if (!j.tk_number)   missing.push('Số TK');
    if (!j.tk_datetime) missing.push('Ngày TK');
    if (!j.ops_id && !j.ops_partner) missing.push('OPS');
    return missing;
  }

  function canComplete(j) {
    const terminal = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (!terminal.includes(j.tk_status)) return false;
    if (getMissingFields(j).length > 0) return false;
    return true;
  }

  function htTooltip(j) {
    const terminal = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (!terminal.includes(j.tk_status)) return 'Chưa đủ điều kiện (cần TK đạt TQ/GP/BQ)';
    const m = getMissingFields(j);
    if (m.length) return `Vui lòng nhập đủ thông tin: ${m.join(', ')}`;
    return 'Hoàn thành phần CUS';
  }

  function canBookTruck(j) {
    return !!(j.delivery_datetime && j.delivery_location);
  }
  const missingInputStyle = { boxShadow: 'inset 0 0 0 1px var(--danger)', borderRadius: 4 };

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard CUS</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        {/* Stat cards */}
        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <StatCard label="Tổng job đang làm" value={stats?.total_active} color="var(--info)" onClick={() => setJobListFilter('cus_active')} />
          <StatCard label="Chờ xác nhận" value={stats?.cho_xac_nhan} color="var(--warning)" onClick={() => setJobListFilter('cus_waiting_confirm')} />
          <StatCard label="Sắp hạn (24h)" value={stats?.sap_han} color="var(--warning)" onClick={() => setJobListFilter('cus_near_deadline')} />
          <StatCard label="Chưa TQ, quá hạn" value={stats?.qua_han} color="var(--danger)" onClick={() => setJobListFilter('cus_overdue')} />
          <StatCard label="Quá hạn thật" value={stats?.qua_han_that} color="#b91c1c" onClick={() => setJobListFilter('cus_true_overdue')} />
        </div>

        {/* Staff section — 1 row for current user */}
        <StaffSection
          title="Tình hình CUS"
          rows={stats?.cus_stats || []}
          columns={CUS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />

        {/* Job grid */}
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
                columns={CUS_FILTER_COLS}
                data={jobs}
                renderMobileCard={(j) => {
                  const isTk = j.service_type === 'tk' || j.service_type === 'both';
                  const isConfirmPending = j.cus_confirm_status === 'pending';
                  const missing = getMissingFields(j);
                  const flow = TK_FLOW_OPTIONS.find(o => o.value === j.tk_flow);
                  return (
                    <CusCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)}
                      codeColor={tab === 'completed' ? 'var(--primary)' : 'var(--info)'}
                      body={
                        <>
                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            <span style={{ color: 'var(--text-2)' }}>OPS:</span>{' '}
                            <strong>{j.ops_name || j.ops_partner || <span style={{ color: 'var(--text-3)' }}>—</span>}</strong>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                            <div><span style={{ color: 'var(--text-2)' }}>ETD:</span> {fmtDate(j.etd)}</div>
                            <div><span style={{ color: 'var(--text-2)' }}>ETA:</span> {fmtDate(j.eta)}</div>
                          </div>

                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            <span style={{ color: 'var(--text-2)' }}>Deadline:</span>{' '}
                            <span style={cusDeadlineTint(j)}>{fmtDt(j.deadline)}</span>
                            <LateBadge j={j} />
                          </div>

                          {isConfirmPending && tab === 'pending' && (
                            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                              <button className="btn btn-primary btn-sm"
                                onClick={() => confirmMut.mutate(j.id)}>Xác nhận</button>
                              <button className="btn btn-ghost btn-sm"
                                onClick={() => setDeadlineReqJob(j)}>Điều chỉnh deadline</button>
                            </div>
                          )}

                          {/* 2026-05-25: CUS Trạng thái + Chờ badges on mobile. */}
                          {(() => {
                            const info = cusStatusInfo(j);
                            const w = cusWaitingStatus(j);
                            if (!info && !w.length) return null;
                            return (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, fontSize: 12 }}>
                                {info && (
                                  <span style={{ background: info.bg, color: info.fg,
                                    borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                                    {info.label}
                                  </span>
                                )}
                                {w.length > 0 && (
                                  <span style={{ color: 'var(--warning)', fontSize: 11, fontWeight: 500 }}>
                                    ⏳ Chờ {w.join(', ')}
                                  </span>
                                )}
                              </div>
                            );
                          })()}

                          {isTk && (
                            <div style={{ padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, marginBottom: 8 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, marginBottom: 6 }}>Tờ khai</div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px', fontSize: 12, marginBottom: 6 }}>
                                <div><span style={{ color: 'var(--text-2)' }}>Số TK:</span> {j.tk_number || '—'}</div>
                                <div>
                                  <span style={{ color: 'var(--text-2)' }}>Luồng:</span>{' '}
                                  {flow
                                    ? <span style={{ background: flow.bg, color: flow.color, padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{flow.label}</span>
                                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                                </div>
                              </div>
                              <div onClick={e => e.stopPropagation()}>
                                <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Trạng thái TK</label>
                                <select value={j.tk_status || 'chua_truyen'}
                                  style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', background: 'transparent', width: '100%' }}
                                  onChange={e => tkMut.mutate({ jobId: j.id, data: { tk_status: e.target.value } })}>
                                  {TK_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>
                              {(j.tk_datetime || j.tq_datetime) && (
                                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-2)' }}>
                                  {j.tk_datetime && <>Ngày TK: {fmtDt(j.tk_datetime)}</>}
                                  {j.tk_datetime && j.tq_datetime && <span style={{ margin: '0 6px' }}>·</span>}
                                  {j.tq_datetime && <>TQ: {fmtDt(j.tq_datetime)}</>}
                                </div>
                              )}
                            </div>
                          )}

                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            <div><span style={{ color: 'var(--text-2)' }}>Giao hàng:</span> {fmtDt(j.delivery_datetime)}</div>
                            <div><span style={{ color: 'var(--text-2)' }}>Địa điểm:</span> {j.delivery_location || '—'}</div>
                          </div>

                          {tab === 'pending' && missing.length > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--danger)', padding: '6px 8px', background: 'rgba(239,68,68,0.08)', borderRadius: 6, marginBottom: 8 }}>
                              ⚠️ Thiếu: {missing.join(', ')}
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                            <span onClick={e => e.stopPropagation()}>
                              {(() => {
                                const ticked = !!j.cost_entered_at;
                                const inFlight = (tickCostMut.isPending && tickCostMut.variables === j.id)
                                              || (untickCostMut.isPending && untickCostMut.variables === j.id);
                                if (ticked) {
                                  return (
                                    <button className="btn btn-ghost btn-sm"
                                      style={{ fontSize: 11, color: 'var(--primary)', padding: '2px 8px' }}
                                      disabled={inFlight}
                                      onClick={() => onUntickCostClick(j)}>
                                      {inFlight ? '...' : '✓ Cost đã nhập'}
                                    </button>
                                  );
                                }
                                return (
                                  <button className="btn btn-primary btn-sm"
                                    style={{ fontSize: 11, padding: '2px 8px' }}
                                    disabled={inFlight}
                                    onClick={() => onTickCostClick(j)}>
                                    {inFlight ? '...' : '✅ Nhập cost'}
                                  </button>
                                );
                              })()}
                            </span>
                            <span>
                              <span style={{ color: 'var(--text-2)' }}>HT:</span>{' '}
                              {tab === 'completed'
                                ? <span style={{ color: 'var(--primary)', fontWeight: 600 }}>✓</span>
                                : j.tk_completed_at
                                  ? <span style={{ color: 'var(--primary)', fontWeight: 600, background: 'rgba(34,197,94,0.12)', padding: '2px 6px', borderRadius: 6 }}>✓ TK xong</span>
                                  : <span style={{ color: 'var(--text-3)' }}>—</span>}
                            </span>
                          </div>

                          {tab === 'pending' && !j.tk_completed_at && (() => {
                            const ok = canComplete(j);
                            return (
                              <div style={{ marginTop: 10 }} onClick={e => e.stopPropagation()}>
                                <button
                                  className={`btn btn-sm ${ok ? 'btn-primary' : 'btn-ghost'}`}
                                  style={{ width: '100%', ...(ok ? {} : { color: 'var(--danger)', borderColor: 'var(--danger)' }) }}
                                  disabled={!ok}
                                  title={htTooltip(j)}
                                  onClick={() => completeMut.mutate(j.id)}>
                                  {ok
                                    ? '✓ Hoàn thành phần CUS'
                                    : (missing.length
                                        ? `Thiếu: ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? '…' : ''}`
                                        : 'Chưa đủ điều kiện')}
                                </button>
                              </div>
                            );
                          })()}

                          {j.tk_notes && (
                            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 8, padding: '6px 8px', background: 'var(--bg)', borderRadius: 6 }}>
                              {j.tk_notes}
                            </div>
                          )}
                        </>
                      }
                      actions={<>
                        {tab === 'pending' && (
                          <button className="btn btn-ghost btn-sm btn-icon" title="Yêu cầu xóa job"
                            style={{ color: 'var(--danger)' }}
                            onClick={() => {
                              if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) {
                                deleteReqMut.mutate({ id: j.id, reason: null });
                              }
                            }}>🗑</button>
                        )}
                        <button className="btn btn-ghost btn-sm btn-icon" title="Đặt kế hoạch xe"
                          onClick={() => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}>📅</button>
                        <button className="btn btn-ghost btn-sm btn-icon" title="Chi tiết"
                          onClick={() => setDetailJobId(j.id)}>🔍</button>
                      </>}
                    />
                  );
                }}
                emptyText="Không có job nào"
                tableStyle={{ fontSize: 13 }}
                renderRow={(j, i) => {
                    const svc = parseJson(j.services_completed);
                    const os = parseJson(j.other_services);
                    const isTk = j.service_type === 'tk' || j.service_type === 'both';
                    const isConfirmPending = j.cus_confirm_status === 'pending';
                    // KT5 — KT-returned-to-log paints orange on top of any other tint.
                    const ktReturnedBg = j.returned_to === 'log' ? 'rgba(249,115,22,0.10)' : '';
                    // Deadline tint only while TK not done (tk_datetime NULL) — a
                    // TQ-done job is no longer overdue (late-cleared shows a "Trễ" badge).
                    const rowBg = ktReturnedBg || tkFlowRowBg(j) ||
                      (!j.tk_datetime && j.deadline && new Date(j.deadline) < Date.now() ? 'rgba(239,68,68,0.04)' :
                      !j.tk_datetime && j.deadline && (new Date(j.deadline) - Date.now()) < 24*3600*1000 ? 'rgba(217,119,6,0.04)' : '');

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        <td style={{ padding: '8px 8px', color: 'var(--text-3)' }}>{i + 1}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--info)' }}>
                          {j.returned_to === 'log' && (
                            <span style={{ marginRight: 4, cursor: 'help' }}
                              title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                          )}
                          {j.job_code || `#${j.id}`}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap' }}>
                          <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
                        </td>
                        <td style={{ padding: '8px 8px', maxWidth: 140 }}>{j.customer_name}</td>
                        <td style={{ padding: '8px 6px', minWidth: 80, ...(!j.ops_id && !j.ops_partner ? missingInputStyle : {}) }}>
                          <OpsPartnerCell job={j} onSave={v => opsMut.mutate({ id: j.id, data: { ops_partner: v } })} />
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                          {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', ...cusDeadlineTint(j) }}>
                          {j.deadline
                            ? new Date(j.deadline).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : '—'}
                          <LateBadge j={j} />
                          {isConfirmPending && tab === 'pending' && (
                            <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                              <button className="btn btn-primary btn-sm" style={{ padding: '2px 8px', fontSize: 11 }}
                                onClick={e => { e.stopPropagation(); confirmMut.mutate(j.id); }}>
                                Xác nhận
                              </button>
                              <button className="btn btn-ghost btn-sm" style={{ padding: '2px 8px', fontSize: 11 }}
                                onClick={e => { e.stopPropagation(); setDeadlineReqJob(j); }}>
                                Điều chỉnh
                              </button>
                            </div>
                          )}
                        </td>

                        {isTk ? (
                          <>
                            <td style={{ padding: '8px 6px', minWidth: 150, ...(!j.tk_datetime ? missingInputStyle : {}) }}
                              title={!j.tk_datetime ? 'Thiếu Ngày TK' : undefined}>
                              <InlineInput type="datetime-local" value={toDatetimeLocal(j.tk_datetime)}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_datetime: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 80, ...(!j.tk_number ? missingInputStyle : {}) }}
                              title={!j.tk_number ? 'Thiếu Số TK' : undefined}>
                              <InlineInput value={j.tk_number}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_number: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 70, ...(!j.tk_flow ? missingInputStyle : {}) }}
                              title={!j.tk_flow ? 'Thiếu Luồng TK' : undefined}>
                              <InlineFlowSelect value={j.tk_flow}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_flow: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 110 }}>
                              <InlineSelect value={j.tk_status} options={TK_STATUS_OPTIONS}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_status: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 150 }}>
                              <InlineInput type="datetime-local" value={toDatetimeLocal(j.tq_datetime)}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tq_datetime: v } })} />
                            </td>
                          </>
                        ) : (
                          <td colSpan={5} style={{ padding: '8px 8px', color: 'var(--text-3)', fontSize: 11, textAlign: 'center' }}>
                            Truck only
                          </td>
                        )}

                        {/* 2026-05-25: CUS Trạng thái + Chờ — always rendered (independent of isTk block). */}
                        <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                          {(() => {
                            const info = cusStatusInfo(j);
                            if (!info) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
                            return (
                              <span style={{ background: info.bg, color: info.fg,
                                borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                                {info.label}
                              </span>
                            );
                          })()}
                        </td>
                        <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
                          {(() => {
                            const w = cusWaitingStatus(j);
                            if (!w.length) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
                            return (
                              <span style={{ color: 'var(--warning)', fontSize: 11, fontWeight: 500 }}>
                                Chờ {w.join(', ')}
                              </span>
                            );
                          })()}
                        </td>

                        {/* Other services checkboxes */}
                        <td style={{ padding: '8px 6px', minWidth: 100 }}>
                          {OTHER_SVC_KEYS.filter(k => os[k]).length > 0
                            ? OTHER_SVC_KEYS.filter(k => os[k]).map(k => (
                              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: 2 }}>
                                <input type="checkbox" checked={!!svc[k]}
                                  onChange={e => tkMut.mutate({ jobId: j.id, data: { services_completed: { ...svc, [k]: e.target.checked } } })} />
                                {OTHER_SVC_LABEL[k]}
                              </label>
                            ))
                            : <span style={{ color: 'var(--text-3)' }}>—</span>
                          }
                        </td>

                        <td style={{ padding: '8px 6px', minWidth: 150 }}>
                          <InlineInput type="datetime-local" value={toDatetimeLocal(j.delivery_datetime)}
                            onSave={v => tkMut.mutate({ jobId: j.id, data: { delivery_datetime: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 120 }}>
                          <InlineInput value={j.delivery_location}
                            onSave={v => tkMut.mutate({ jobId: j.id, data: { delivery_location: v } })} />
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                          {(() => {
                            const ticked = !!j.cost_entered_at;
                            const inFlight = (tickCostMut.isPending && tickCostMut.variables === j.id)
                                          || (untickCostMut.isPending && untickCostMut.variables === j.id);
                            if (ticked) {
                              return (
                                <button className="btn btn-ghost btn-sm"
                                  style={{ fontSize: 11, color: 'var(--primary)' }}
                                  disabled={inFlight}
                                  title="Click để bỏ tick"
                                  onClick={(e) => { e.stopPropagation(); onUntickCostClick(j); }}>
                                  {inFlight ? '...' : '✓ Đã nhập'}
                                </button>
                              );
                            }
                            return (
                              <button className="btn btn-primary btn-sm"
                                style={{ fontSize: 11 }}
                                disabled={inFlight}
                                onClick={(e) => { e.stopPropagation(); onTickCostClick(j); }}>
                                {inFlight ? '...' : '✅ Nhập cost'}
                              </button>
                            );
                          })()}
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                          {tab === 'completed' ? (
                            <span style={{ color: 'var(--primary)', fontSize: 16 }}>✓</span>
                          ) : j.tk_completed_at ? (
                            <span title="Phần CUS đã hoàn thành — chờ vận chuyển/OPS"
                              style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600,
                                       background: 'rgba(34,197,94,0.12)', padding: '3px 6px', borderRadius: 6, whiteSpace: 'nowrap' }}>
                              ✓ TK xong
                            </span>
                          ) : (() => {
                            const ok = canComplete(j);
                            const missing = getMissingFields(j);
                            return (
                              <button
                                className={`btn btn-sm ${ok ? 'btn-primary' : 'btn-ghost'}`}
                                style={{ padding: '3px 10px', fontSize: 11,
                                         ...(ok ? {} : { color: 'var(--danger)', borderColor: 'var(--danger)' }) }}
                                disabled={!ok}
                                title={htTooltip(j)}
                                onClick={() => ok && completeMut.mutate(j.id)}>
                                {ok ? 'HT' : (missing.length ? `Thiếu: ${missing[0]}${missing.length>1?'…':''}` : 'HT')}
                              </button>
                            );
                          })()}
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 120 }}>
                          <InlineInput value={j.tk_notes}
                            onSave={v => tkMut.mutate({ jobId: j.id, data: { notes: v } })} />
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap' }}>
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm btn-icon"
                              title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
                              onClick={() => {
                                if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) {
                                  deleteReqMut.mutate({ id: j.id, reason: null });
                                }
                              }}>🗑</button>
                          )}
                          <button className="btn btn-ghost btn-sm btn-icon" title="Đặt kế hoạch xe"
                            onClick={() => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}>📅</button>
                          <button className="btn btn-ghost btn-sm btn-icon" title="Chi tiết"
                            onClick={() => setDetailJobId(j.id)}>🔍</button>
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
      {planModalJob && (
        <PlanDeliveryModal
          jobId={planModalJob.jobId} jobCode={planModalJob.jobCode}
          onClose={() => setPlanModalJob(null)} />
      )}
      {showCreate && <CreateJobModal onClose={() => setShowCreate(false)} onCreated={data => createMut.mutateAsync(data)} />}
      {jobListFilter && (
        <JobListModal
          filterType={typeof jobListFilter === 'string' ? jobListFilter : jobListFilter.filterType}
          staffId={typeof jobListFilter === 'string' ? null : jobListFilter.staffId}
          staffName={typeof jobListFilter === 'string' ? null : jobListFilter.staffName}
          onClose={() => setJobListFilter(null)}
        />
      )}
      {deadlineReqJob && (
        <DeadlineRequestModal
          job={deadlineReqJob}
          onClose={() => setDeadlineReqJob(null)}
          onSubmit={(proposed, reason) => deadlineMut.mutate({ id: deadlineReqJob.id, proposed, reason })}
        />
      )}
    </div>
  );
}
