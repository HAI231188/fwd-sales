import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import AssignmentModal from '../components/AssignmentModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import TP_OverviewSection from '../components/TP_OverviewSection';
import StaffSection, { CUS_COLS, DD_COLS, OPS_COLS } from '../components/StaffSection';
import {
  getJobStats, getJobs, getDeadlineRequests, getLogStaff,
  assignJob, setJobDeadline, reviewDeadlineRequest, createJob,
  deleteJob, reviewDeleteRequest, getJobSettings,
} from '../api';

const SVC_LABEL = { tk: 'TK', truck: 'Xe', both: 'TK+Xe' };
const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const CONT_TYPES = ['20DC','40DC','40HC','45HC','20RF','40RF'];
const OTHER_SVC_KEYS = ['ktcl','kiem_dich','hun_trung','co','khac'];
const OTHER_SVC_LABEL = { ktcl:'KTCL', kiem_dich:'Kiểm dịch', hun_trung:'Hun trùng', co:'CO', khac:'Khác' };

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('vi-VN'); }
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
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function toDatetimeLocal(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function deadlineStyle(dl) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 48 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return { color: 'var(--primary)' };
}

const ALL_COLS = [
  { key: 'stt',          label: '#' },
  { key: 'job_code',     label: 'Số job' },
  { key: 'si_number',    label: 'Mã SI' },
  { key: 'created_at',   label: 'Ngày tạo' },
  { key: 'customer',     label: 'Tên khách' },
  { key: 'han_lenh',     label: 'Hạn lệnh' },
  { key: 'deadline',     label: 'Deadline' },
  { key: 'tk_flow',      label: 'Luồng TK' },
  { key: 'tk_number',    label: 'Số TK' },
  { key: 'tk_datetime',  label: 'Ngày TK' },
  { key: 'tk_status',    label: 'TT TK' },
  { key: 'tq_datetime',  label: 'Ngày TQ' },
  { key: 'delivery',     label: 'Ngày giao' },
  { key: 'phan_cong',    label: 'Phân công' },
  { key: 'delivery_loc', label: 'Địa điểm giao' },
  { key: 'cargo',        label: 'Cont-Loại' },
  { key: 'service',      label: 'DV' },
  { key: 'etd_eta',      label: 'ETD-ETA' },
  { key: 'cus',          label: 'CUS' },
  { key: 'ops',          label: 'OPS' },
  { key: 'notes',        label: 'Ghi chú' },
];
const FILTER_CONFIG = {
  job_code:  { filterType: 'text' },
  si_number: { filterType: 'text' },
  customer:  { filterType: 'text', accessor: j => j.customer_name || '' },
  service:   { filterType: 'select', options: [
    { value: 'tk', label: 'TK' }, { value: 'truck', label: 'Xe' }, { value: 'both', label: 'TK+Xe' },
  ]},
  tk_status: { filterType: 'select', options: [
    { value: 'chua_truyen', label: 'Chưa truyền' }, { value: 'dang_lam', label: 'Đang làm' },
    { value: 'thong_quan', label: 'Thông quan' }, { value: 'giai_phong', label: 'Giải phóng' },
    { value: 'bao_quan', label: 'Bảo quan' },
  ]},
  cus: { filterType: 'text', accessor: j => j.cus_name || '' },
  ops: { filterType: 'text', accessor: j => j.ops_name || '' },
};

const LS_COL_KEY = 'tp_grid_columns';
function loadVisibleCols() {
  const allKeys = ALL_COLS.map(c => c.key);
  try {
    const s = localStorage.getItem(LS_COL_KEY);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) {
        const valid = a.filter(k => allKeys.includes(k));
        if (valid.length) return valid;
      }
    }
  } catch {}
  localStorage.removeItem(LS_COL_KEY);
  return allKeys;
}

function StatCard({ label, value, color, onClick, badge, rows }) {
  if (rows) {
    return (
      <div className="card" onClick={onClick}
        style={{ cursor: onClick ? 'pointer' : 'default', padding: '14px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.label}</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: r.color || 'var(--text)', fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="card" onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', padding: '14px 16px', position: 'relative' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>
        {value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
      {badge && (
        <span style={{ position: 'absolute', top: 10, right: 10, background: color || 'var(--info)', color: '#fff', borderRadius: 20, fontSize: 10, padding: '2px 7px', fontWeight: 600 }}>
          {badge}
        </span>
      )}
    </div>
  );
}

function InlineDeadline({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const ref = useRef();

  function start() { setVal(toDatetimeLocal(value) || ''); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() { setEditing(false); if (val) onSave(val); }

  if (!editing) return (
    <div>
      <div style={deadlineStyle(value)}>{value ? fmtDt(value) : <span style={{ color: 'var(--text-3)' }}>Chưa có</span>}</div>
      <span onClick={start} style={{ fontSize: 11, color: 'var(--info)', cursor: 'pointer', borderBottom: '1px dashed var(--info)' }}>
        {value ? 'Sửa' : 'Đặt deadline'}
      </span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input ref={ref} type="datetime-local" value={val} onChange={e => setVal(e.target.value)}
        onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 12 }} />
    </div>
  );
}

// ─── Assign Modal ─────────────────────────────────────────────────────────────
function AssignModal({ job, staff, onClose, onSave }) {
  const cusStaff = staff.filter(s => ['cus','cus1','cus2','cus3'].includes(s.role));
  const opsStaff = staff.filter(s => s.role === 'ops');
  const [cusId, setCusId] = useState(String(job.cus_id || ''));
  const [opsId, setOpsId] = useState(String(job.ops_id || ''));

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3>Phân công — {job.job_code || `#${job.id}`}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16 }}>{job.customer_name}</div>
          {(job.service_type === 'tk' || job.service_type === 'both') && (
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Phân CUS (tờ khai)</label>
              <select className="form-select" value={cusId} onChange={e => setCusId(e.target.value)}>
                <option value="">-- Chọn CUS --</option>
                {cusStaff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
              </select>
            </div>
          )}
          {(job.service_type === 'tk' || job.service_type === 'both') && (
            <div className="form-group">
              <label className="form-label">Phân OPS (tuỳ chọn)</label>
              <select className="form-select" value={opsId} onChange={e => setOpsId(e.target.value)}>
                <option value="">-- Chọn OPS --</option>
                {opsStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm"
            onClick={() => onSave({ cus_id: cusId ? Number(cusId) : undefined, ops_id: opsId ? Number(opsId) : undefined })}>
            Xác nhận phân công
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Deadline Modal ───────────────────────────────────────────────────────────
function DeadlineModal({ data, onClose, onReview, onSetDeadline, onReviewDelete }) {
  const [activeTab, setActiveTab] = useState('cus_confirm');
  const [overrides, setOverrides] = useState({});
  const [detailJobId, setDetailJobId] = useState(null);
  const { pending_confirmations = [], requests = [], no_deadline = [], delete_requests = [] } = data || {};

  const tabs = [
    { key: 'cus_confirm', label: 'CUS chưa nhận', count: pending_confirmations.length, color: 'var(--warning)' },
    { key: 'deadline_adj', label: 'Điều chỉnh deadline', count: requests.length + delete_requests.length, color: 'var(--danger)' },
    { key: 'no_deadline', label: 'Chưa có deadline', count: no_deadline.length, color: 'var(--text-2)' },
  ];

  const rowStyle = { cursor: 'pointer' };
  function onRowHover(e, enter) { e.currentTarget.style.background = enter ? 'var(--bg)' : ''; }

  return (
    <>
      <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal modal-lg" style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
          <div className="modal-header">
            <h3>Chờ xác nhận</h3>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>

          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              {tabs.map(t => (
                <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {t.label}
                  <span style={{
                    background: t.count > 0 ? t.color : 'var(--border)',
                    color: t.count > 0 ? '#fff' : 'var(--text-3)',
                    borderRadius: 10, fontSize: 10, padding: '1px 6px', fontWeight: 600,
                  }}>{t.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>

            {/* Tab 1: CUS chưa nhận */}
            {activeTab === 'cus_confirm' && (
              pending_confirmations.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Tất cả CUS đã xác nhận</p></div>
                : pending_confirmations.map(j => (
                  <div key={j.job_id} className="card" style={{ marginBottom: 10, padding: 14, ...rowStyle }}
                    onClick={() => setDetailJobId(j.job_id)}
                    onMouseEnter={e => onRowHover(e, true)}
                    onMouseLeave={e => onRowHover(e, false)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, color: 'var(--info)' }}>{j.job_code || `#${j.job_id}`}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtDate(j.created_at)}</span>
                    </div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>{j.customer_name}</div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
                      <span>CUS: <strong style={{ color: 'var(--warning)' }}>
                        {j.cus_name ? `${j.cus_name}${j.ai_reason ? ` (AI: ${j.ai_reason})` : ''}` : '—'}
                      </strong></span>
                      {j.ops_name && <span>OPS: <strong>{j.ops_name}</strong></span>}
                      <span>Deadline: <strong style={{ color: j.deadline ? 'var(--text)' : 'var(--text-3)' }}>{j.deadline ? fmtDt(j.deadline) : 'Chưa có'}</strong></span>
                    </div>
                  </div>
                ))
            )}

            {/* Tab 2: Điều chỉnh deadline */}
            {activeTab === 'deadline_adj' && (
              requests.length === 0 && delete_requests.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Không có yêu cầu pending</p></div>
                : <>
                  {requests.map(r => (
                    <div key={r.id} className="card" style={{ marginBottom: 12, padding: 14, ...rowStyle }}
                      onClick={() => setDetailJobId(r.job_id)}
                      onMouseEnter={e => onRowHover(e, true)}
                      onMouseLeave={e => onRowHover(e, false)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>
                        Deadline hiện tại: <strong>{r.current_deadline ? fmtDt(r.current_deadline) : 'Chưa có'}</strong>
                        {' → '}Đề xuất: <strong style={{ color: 'var(--warning)' }}>{fmtDt(r.proposed_deadline)}</strong>
                      </div>
                      <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-2)' }}>Lý do: {r.reason}</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                        onClick={e => e.stopPropagation()}>
                        <input type="datetime-local"
                          value={overrides[r.id] !== undefined ? overrides[r.id] : toDatetimeLocal(r.proposed_deadline)}
                          onChange={e => setOverrides(p => ({ ...p, [r.id]: e.target.value }))}
                          style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }} />
                        <button className="btn btn-primary btn-sm"
                          onClick={() => onReview(r.id, 'approved', overrides[r.id] || r.proposed_deadline)}>Duyệt</button>
                        <button className="btn btn-danger btn-sm"
                          onClick={() => onReview(r.id, 'rejected', null)}>Từ chối</button>
                      </div>
                    </div>
                  ))}
                  {delete_requests.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', marginTop: 16, marginBottom: 8 }}>
                        Yêu cầu xóa job ({delete_requests.length})
                      </div>
                      {delete_requests.map(r => (
                        <div key={r.id} className="card" style={{ marginBottom: 10, padding: 14, borderLeft: '3px solid var(--danger)', ...rowStyle }}
                          onClick={() => setDetailJobId(r.job_id)}
                          onMouseEnter={e => onRowHover(e, true)}
                          onMouseLeave={e => onRowHover(e, false)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                          </div>
                          {r.reason && <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>Lý do: {r.reason}</div>}
                          <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                            <button className="btn btn-danger btn-sm" onClick={() => onReviewDelete(r.id, 'approved')}>Duyệt xóa</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => onReviewDelete(r.id, 'rejected')}>Từ chối</button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </>
            )}

            {/* Tab 3: Chưa có deadline */}
            {activeTab === 'no_deadline' && (
              no_deadline.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Tất cả job đã có deadline</p></div>
                : no_deadline.map(j => (
                  <div key={j.job_id} className="card" style={{ marginBottom: 8, padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', ...rowStyle }}
                    onClick={() => setDetailJobId(j.job_id)}
                    onMouseEnter={e => onRowHover(e, true)}
                    onMouseLeave={e => onRowHover(e, false)}>
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <strong>{j.job_code || `#${j.job_id}`}</strong> — {j.customer_name}
                      <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>{fmtDate(j.created_at)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                      <input type="datetime-local"
                        value={overrides[`n_${j.job_id}`] || ''}
                        onChange={e => setOverrides(p => ({ ...p, [`n_${j.job_id}`]: e.target.value }))}
                        style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }} />
                      <button className="btn btn-primary btn-sm"
                        disabled={!overrides[`n_${j.job_id}`]}
                        onClick={() => onSetDeadline(j.job_id, overrides[`n_${j.job_id}`])}>
                        Đặt deadline
                      </button>
                    </div>
                  </div>
                ))
            )}

          </div>
        </div>
      </div>

      {detailJobId && (
        <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
      )}
    </>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function LogDashboardTP() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showDeadline, setShowDeadline] = useState(false);
  const [assigningJob, setAssigningJob] = useState(null);
  const [showAssignment, setShowAssignment] = useState(null); // 'cus' | 'ops' | null
  const [filterAssignee, setFilterAssignee] = useState('');
  const [isVisible, setIsVisible] = useState(!document.hidden);
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols);
  const [showColMenu, setShowColMenu] = useState(false);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

  function toggleCol(key) {
    setVisibleCols(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem(LS_COL_KEY, JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  useEffect(() => { setFilterAssignee(''); }, [tab]);

  const pollInterval = isVisible ? 5000 : 30000;

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: pollInterval });
  const { data: settings } = useQuery({ queryKey: ['jobSettings'], queryFn: getJobSettings, refetchInterval: pollInterval });
  const { data: pendingJobs = [], isLoading: isLoadingPending } = useQuery({
    queryKey: ['jobs', 'pending'], queryFn: () => getJobs({ tab: 'pending' }), refetchInterval: pollInterval,
  });
  const { data: completedJobs = [], isLoading: isLoadingCompleted } = useQuery({
    queryKey: ['jobs', 'completed', completedRange],
    queryFn: () => getJobs({ tab: 'completed', ...completedRange }),
    enabled: tab === 'completed',
    refetchInterval: pollInterval,
  });
  const jobs = tab === 'completed' ? completedJobs : pendingJobs;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;
  const { data: dlData } = useQuery({
    queryKey: ['deadlineRequests'], queryFn: getDeadlineRequests,
    enabled: showDeadline,
  });
  const { data: staff = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });

  const createMut = useMutation({
    mutationFn: data => createJob(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'jobStats'] }),
  });
  const assignMut = useMutation({
    mutationFn: ({ id, data }) => assignJob(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setAssigningJob(null); },
  });
  const setDlMut = useMutation({
    mutationFn: ({ id, deadline }) => setJobDeadline(id, deadline),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'deadlineRequests', 'jobStats'] }),
  });
  const reviewMut = useMutation({
    mutationFn: ({ rid, action, dl }) => reviewDeadlineRequest(rid, action, dl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'deadlineRequests', 'jobStats'] }),
  });
  const deleteMut = useMutation({
    mutationFn: id => deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'jobStats'] }),
  });
  const reviewDeleteMut = useMutation({
    mutationFn: ({ rid, action }) => reviewDeleteRequest(rid, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'deadlineRequests', 'jobStats'] }),
  });

  const modeLabel = settings?.assignment_mode === 'manual' ? 'Bán tự động' : 'Tự động';
  const logStaff = qc.getQueryData(['logStaff']) || [];
  const cusStaff = logStaff.filter(s => ['cus','cus1','cus2','cus3'].includes(s.role));
  const opsStaff = logStaff.filter(s => s.role === 'ops');
  const dieuDoStaff = logStaff.filter(s => s.role === 'dieu_do');
  const filteredJobs = filterAssignee
    ? jobs.filter(j =>
        String(j.cus_id) === filterAssignee ||
        String(j.ops_id) === filterAssignee ||
        String(j.dieu_do_id) === filterAssignee
      )
    : jobs;

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard Trưởng Phòng LOG</h2>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tổng job pending" color="var(--info)"
            rows={[
              { label: 'Tổng pending',   value: stats?.total_pending, color: 'var(--info)',    onClick: () => setJobListFilter('pending') },
              { label: 'TK pending',     value: stats?.tk_pending,    color: 'var(--warning)', onClick: () => setJobListFilter('tp_tk_pending') },
              { label: 'Đặt xe pending', value: stats?.truck_pending, color: '#7c3aed',        onClick: () => setJobListFilter('tp_truck_pending') },
            ]} />
          <StatCard label="Chờ phân CUS" value={stats?.waiting_cus} color="var(--warning)"
            badge={modeLabel}
            onClick={() => setShowAssignment('cus')} />
          <StatCard label="Chờ phân OPS" value={stats?.waiting_ops} color="var(--purple)"
            badge={modeLabel}
            onClick={() => setShowAssignment('ops')} />
          <StatCard label="Chờ xác nhận"
            badge={stats?.delete_requests > 0 ? `${stats.delete_requests} xóa` : null}
            onClick={() => setShowDeadline(true)}
            rows={[
              { label: 'CUS chưa nhận', value: stats?.cus_confirm_pending, color: 'var(--warning)' },
              { label: 'Điều chỉnh deadline', value: stats?.deadline_adj_requests, color: 'var(--danger)' },
              { label: 'Chưa có deadline', value: stats?.no_deadline, color: 'var(--text-2)' },
            ]} />
          <StatCard label="Quá deadline" value={stats?.overdue} color="var(--danger)"
            onClick={() => setJobListFilter('overdue')} />
          <StatCard label="Sắp hạn (48h)" value={stats?.warn_soon} color="var(--warning)"
            onClick={() => setJobListFilter('warning')} />
          <StatCard label="Thiếu thông tin" value={stats?.missing_info} color="var(--text-2)"
            onClick={() => setJobListFilter('missing')} />
        </div>

        {/* Staff sections — 3 cards by role */}
        <StaffSection
          title="Tình hình CUS"
          rows={stats?.cus_stats || []}
          columns={CUS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />
        <StaffSection
          title="Tình hình Điều Độ"
          rows={stats?.dieu_do_stats || []}
          columns={DD_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />
        <StaffSection
          title="Tình hình OPS"
          rows={stats?.ops_stats || []}
          columns={OPS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />

        <TP_OverviewSection />

        {/* Jobs grid */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="tabs" style={{ marginBottom: 0 }}>
                <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
                  CV Pending
                </button>
                <button className={`tab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>
                  CV Hoàn thành
                </button>
              </div>
              {tab === 'completed' && (
                <div style={{ paddingBottom: 4 }}>
                  <DateRangeFilter onChange={setCompletedRange} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 4 }}>
              {tab === 'pending' && (
                <select
                  className="form-select"
                  style={{ fontSize: 12, padding: '4px 8px', width: 'auto', minWidth: 140 }}
                  value={filterAssignee}
                  onChange={e => setFilterAssignee(e.target.value)}
                >
                  <option value="">Tất cả nhân viên</option>
                  {cusStaff.length > 0 && <option disabled>── CUS ──</option>}
                  {cusStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {opsStaff.length > 0 && <option disabled>── OPS ──</option>}
                  {opsStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {dieuDoStaff.length > 0 && <option disabled>── Điều Độ ──</option>}
                  {dieuDoStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              <div style={{ position: 'relative' }}>
                <button className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => setShowColMenu(v => !v)}>
                  ⚙️ Cột
                </button>
                {showColMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, zIndex: 300,
                    background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 8,
                    minWidth: 170, display: 'flex', flexDirection: 'column', gap: 2,
                  }}>
                    {ALL_COLS.map(c => (
                      <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', padding: '3px 4px', borderRadius: 4 }}>
                        <input type="checkbox" checked={visibleCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : (() => {
              const ftColumns = ALL_COLS
                .filter(c => visibleCols.includes(c.key))
                .map(c => ({ ...c, ...(FILTER_CONFIG[c.key] || {}) }));
              return (
                <FilteredTable
                  columns={ftColumns}
                  data={filteredJobs}
                  emptyText="Không có job nào"
                  extraHeaderCells={<th style={{ padding: '10px 8px' }} />}
                  tableStyle={{ fontSize: 13 }}
                  renderRow={(j, i) => {
                    const waitingAssign = (j.service_type === 'tk' || j.service_type === 'both') && !j.cus_id;
                    const tkBg = j.tk_flow === 'xanh' ? 'rgba(34,197,94,0.06)' :
                                 j.tk_flow === 'vang' ? 'rgba(217,119,6,0.06)' :
                                 j.tk_flow === 'do'   ? 'rgba(239,68,68,0.06)' :
                                 j.tk_status === 'chua_truyen' ? 'rgba(239,68,68,0.04)' : '';
                    const rowBg = tkBg || (waitingAssign ? 'rgba(217,119,6,0.04)'
                      : j.deadline && new Date(j.deadline) < Date.now() ? 'rgba(239,68,68,0.04)' : '');
                    const cs = { padding: '8px 8px' };

                    const cell = (key) => {
                      switch (key) {
                        case 'stt':         return <td key={key} style={{ ...cs, color: 'var(--text-3)' }}>{i + 1}</td>;
                        case 'job_code':    return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12, color: 'var(--info)' }}>{j.job_code || '—'}</td>;
                        case 'si_number':   return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>;
                        case 'created_at':  return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>;
                        case 'customer':    return <td key={key} style={{ ...cs, maxWidth: 150 }}><div style={{ fontWeight: 500, fontSize: 13 }}>{j.customer_name}</div></td>;
                        case 'han_lenh':    return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{j.han_lenh ? <span style={deadlineStyle(j.han_lenh)}>{fmtDt(j.han_lenh)}</span> : <span style={{ color: 'var(--text-3)' }}>—</span>}</td>;
                        case 'deadline':    return <td key={key} style={{ ...cs, minWidth: 130 }}><InlineDeadline value={j.deadline} onSave={v => setDlMut.mutate({ id: j.id, deadline: v })} /></td>;
                        case 'tk_flow':     return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)' }}>{j.tk_flow || '—'}</td>;
                        case 'tk_number':   return <td key={key} style={{ ...cs, fontSize: 12 }}>{j.tk_number || '—'}</td>;
                        case 'tk_datetime': return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.tk_datetime ? fmtDt(j.tk_datetime) : '—'}</td>;
                        case 'tk_status':   return <td key={key} style={cs}>{j.tk_status ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500, fontSize: 12 }}>{TK_STATUS_LABEL[j.tk_status]}</span> : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}</td>;
                        case 'tq_datetime': return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.tq_datetime ? fmtDt(j.tq_datetime) : '—'}</td>;
                        case 'delivery':    return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.delivery_datetime ? fmtDate(j.delivery_datetime) : '—'}</td>;
                        case 'phan_cong':   return <td key={key} style={cs}>{tab === 'pending' && <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => setAssigningJob(j)}>{waitingAssign ? '⚡ Phân công' : '✏️ Sửa'}</button>}</td>;
                        case 'delivery_loc':return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)', maxWidth: 120 }}>{j.delivery_location || '—'}</td>;
                        case 'cargo':       return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</td>;
                        case 'service':     return <td key={key} style={cs}><span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span></td>;
                        case 'etd_eta':     return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)}<br />{fmtDate(j.eta)}</td>;
                        case 'cus':         return <td key={key} style={cs}>{j.cus_name ? <span style={{ fontSize: 12 }}>{j.cus_name}</span> : <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>}</td>;
                        case 'ops':         return <td key={key} style={cs}>{j.ops_name ? <span style={{ fontSize: 12 }}>{j.ops_name}</span> : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}</td>;
                        case 'notes':       return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)', maxWidth: 140 }}>{j.tk_notes || '—'}</td>;
                        default: return null;
                      }
                    };

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        {ftColumns.map(c => cell(c.key))}
                        <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm btn-icon"
                              title="Xóa job" style={{ color: 'var(--danger)' }}
                              onClick={() => {
                                if (window.confirm(`Xóa job ${j.job_code || '#' + j.id}?`)) {
                                  deleteMut.mutate(j.id);
                                }
                              }}>🗑</button>
                          )}
                          <button className="btn btn-ghost btn-sm btn-icon" title="Chi tiết"
                            onClick={() => setDetailJobId(j.id)}>🔍</button>
                        </td>
                      </tr>
                    );
                  }}
                />
              );
            })()}
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateJobModal onClose={() => setShowCreate(false)}
          onCreated={data => createMut.mutateAsync(data)} />
      )}
      {showDeadline && (
        <DeadlineModal
          data={dlData}
          onClose={() => setShowDeadline(false)}
          onReview={(rid, action, dl) => reviewMut.mutate({ rid, action, dl })}
          onSetDeadline={(id, deadline) => setDlMut.mutate({ id, deadline })}
          onReviewDelete={(rid, action) => reviewDeleteMut.mutate({ rid, action })}
        />
      )}
      {assigningJob && (
        <AssignModal job={assigningJob} staff={staff}
          onClose={() => setAssigningJob(null)}
          onSave={data => assignMut.mutate({ id: assigningJob.id, data })} />
      )}
      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {showAssignment && (
        <AssignmentModal
          initialTab={showAssignment}
          onClose={() => setShowAssignment(null)}
        />
      )}
      {jobListFilter && (
        <JobListModal
          filterType={typeof jobListFilter === 'string' ? jobListFilter : jobListFilter.filterType}
          staffId={typeof jobListFilter === 'string' ? null : jobListFilter.staffId}
          staffName={typeof jobListFilter === 'string' ? null : jobListFilter.staffName}
          onClose={() => setJobListFilter(null)}
        />
      )}
    </div>
  );
}
