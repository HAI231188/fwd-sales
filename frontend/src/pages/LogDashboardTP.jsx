import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import AssignmentModal from '../components/AssignmentModal';
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

function StatCard({ label, value, color, onClick, badge }) {
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
  const [overrides, setOverrides] = useState({});
  const { requests = [], no_deadline = [], delete_requests = [] } = data || {};

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '88vh' }}>
        <div className="modal-header">
          <h3>Chờ xác nhận Deadline</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {requests.length > 0 && (
            <>
              <div className="section-title" style={{ marginBottom: 10 }}>Yêu cầu điều chỉnh từ CUS</div>
              {requests.map(r => (
                <div key={r.id} className="card" style={{ marginBottom: 12, padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>
                    Deadline hiện tại: <strong>{r.current_deadline ? fmtDt(r.current_deadline) : 'Chưa có'}</strong>
                    {' → '}Đề xuất: <strong style={{ color: 'var(--warning)' }}>{fmtDt(r.proposed_deadline)}</strong>
                  </div>
                  <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-2)' }}>Lý do: {r.reason}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="datetime-local"
                      value={overrides[r.id] !== undefined ? overrides[r.id] : toDatetimeLocal(r.proposed_deadline)}
                      onChange={e => setOverrides(p => ({ ...p, [r.id]: e.target.value }))}
                      style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }} />
                    <button className="btn btn-primary btn-sm"
                      onClick={() => onReview(r.id, 'approved', overrides[r.id] || r.proposed_deadline)}>
                      Duyệt
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => onReview(r.id, 'rejected', null)}>
                      Từ chối
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
          {no_deadline.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16, marginBottom: 10 }}>Job chưa có deadline</div>
              {no_deadline.map(j => (
                <div key={j.job_id} className="card" style={{ marginBottom: 8, padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <strong>{j.job_code || `#${j.job_id}`}</strong> — {j.customer_name}
                    <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>{fmtDate(j.created_at)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
              ))}
            </>
          )}
          {delete_requests.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 16, marginBottom: 10, color: 'var(--danger)' }}>
                Yêu cầu xóa job ({delete_requests.length})
              </div>
              {delete_requests.map(r => (
                <div key={r.id} className="card" style={{ marginBottom: 10, padding: 14, borderLeft: '3px solid var(--danger)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                  </div>
                  {r.reason && (
                    <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>Lý do: {r.reason}</div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-danger btn-sm"
                      onClick={() => onReviewDelete(r.id, 'approved')}>
                      Duyệt xóa
                    </button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => onReviewDelete(r.id, 'rejected')}>
                      Từ chối
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
          {!requests.length && !no_deadline.length && !delete_requests.length && (
            <div className="empty-state">
              <div className="icon">✅</div>
              <p>Không có yêu cầu pending</p>
            </div>
          )}
        </div>
      </div>
    </div>
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

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const pollInterval = isVisible ? 5000 : 30000;

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: pollInterval });
  const { data: settings } = useQuery({ queryKey: ['jobSettings'], queryFn: getJobSettings, refetchInterval: pollInterval });
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs', tab], queryFn: () => getJobs({ tab }), refetchInterval: pollInterval,
  });
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
  const cusStaff = (qc.getQueryData(['logStaff']) || []).filter(s => ['cus','cus1','cus2','cus3'].includes(s.role));
  const opsStaff = (qc.getQueryData(['logStaff']) || []).filter(s => s.role === 'ops');
  const allAssignees = [...cusStaff, ...opsStaff];
  const filteredJobs = filterAssignee
    ? jobs.filter(j => String(j.cus_id) === filterAssignee || String(j.ops_id) === filterAssignee)
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
          <StatCard label="Tổng job pending" value={stats?.total_pending} color="var(--info)" />
          <StatCard label="Chờ phân CUS" value={stats?.waiting_cus} color="var(--warning)"
            badge={modeLabel}
            onClick={() => setShowAssignment('cus')} />
          <StatCard label="Chờ phân OPS" value={stats?.waiting_ops} color="var(--purple)"
            badge={modeLabel}
            onClick={() => setShowAssignment('ops')} />
          <StatCard label="Chờ xác nhận deadline" value={stats?.deadline_pending} color="var(--warning)"
            badge={stats?.delete_requests > 0 ? `${stats.delete_requests} xóa` : null}
            onClick={() => setShowDeadline(true)} />
          <StatCard label="Quá deadline" value={stats?.overdue} color="var(--danger)" />
          <StatCard label="Sắp hạn (48h)" value={stats?.warn_soon} color="var(--warning)" />
          <StatCard label="Thiếu thông tin" value={stats?.missing_info} color="var(--text-2)" />
        </div>

        {/* Staff table */}
        {stats?.staff?.length > 0 && (
          <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>
              Hiệu suất nhân viên
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                  {['Nhân viên','Vai trò','Job pending','Quá hạn','Chờ xác nhận','Cảnh báo'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.staff.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div className="avatar avatar-sm" style={{ background: s.avatar_color || '#6b7280' }}>{s.code}</div>
                        <span style={{ fontWeight: 500 }}>{s.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-2)', fontSize: 12 }}>{s.role}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: s.pending > 0 ? 'var(--info)' : 'var(--text-3)' }}>{s.pending || 0}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: s.overdue > 0 ? 'var(--danger)' : 'var(--text-3)' }}>{s.overdue || 0}</td>
                    <td style={{ padding: '10px 12px', color: s.awaiting_confirm > 0 ? 'var(--warning)' : 'var(--text-3)' }}>{s.awaiting_confirm || 0}</td>
                    <td style={{ padding: '10px 12px', color: s.warning > 0 ? 'var(--warning)' : 'var(--text-3)' }}>{s.warning || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Jobs grid */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
                CV Pending
              </button>
              <button className={`tab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>
                CV Hoàn thành (3 ngày)
              </button>
            </div>
            {tab === 'pending' && (
              <select
                className="form-select"
                style={{ fontSize: 12, padding: '4px 8px', width: 'auto', minWidth: 140, marginRight: 8 }}
                value={filterAssignee}
                onChange={e => setFilterAssignee(e.target.value)}
              >
                <option value="">Tất cả nhân viên</option>
                {cusStaff.length > 0 && <option disabled>── CUS ──</option>}
                {cusStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                {opsStaff.length > 0 && <option disabled>── OPS ──</option>}
                {opsStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                    {['#','Ngày tạo','Khách hàng','POL → POD','Cont / Loại','DV',
                      'ETD / ETA','Deadline','Ngày TK','TT TK','CUS','OPS','Phân công',''].map((h, i) => (
                      <th key={i} style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.length === 0 && (
                    <tr><td colSpan={14} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>Không có job nào</td></tr>
                  )}
                  {filteredJobs.map((j, i) => {
                    const waitingAssign = (j.service_type === 'tk' || j.service_type === 'both') && !j.cus_id;
                    const rowBg = waitingAssign ? 'rgba(217,119,6,0.04)'
                      : j.deadline && new Date(j.deadline) < Date.now() ? 'rgba(239,68,68,0.04)' : '';

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        <td style={{ padding: '8px 8px', color: 'var(--text-3)' }}>{i + 1}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                        <td style={{ padding: '8px 8px', maxWidth: 150 }}>
                          <div style={{ fontWeight: 500, fontSize: 13 }}>{j.customer_name}</div>
                          {j.job_code && <div style={{ fontSize: 11, color: 'var(--info)' }}>{j.job_code}</div>}
                        </td>
                        <td style={{ padding: '8px 8px', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                          {j.pol || '—'} → {j.pod || '—'}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {fmtCargo(j)}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                          {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                        </td>
                        <td style={{ padding: '8px 8px', minWidth: 130 }}>
                          <InlineDeadline value={j.deadline}
                            onSave={v => setDlMut.mutate({ id: j.id, deadline: v })} />
                        </td>
                        <td style={{ padding: '8px 8px', fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>
                          {j.tk_datetime ? fmtDt(j.tk_datetime) : '—'}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          {j.tk_status
                            ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500, fontSize: 12 }}>{TK_STATUS_LABEL[j.tk_status]}</span>
                            : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          {j.cus_name
                            ? <span style={{ fontSize: 12 }}>{j.cus_name}</span>
                            : <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          {j.ops_name
                            ? <span style={{ fontSize: 12 }}>{j.ops_name}</span>
                            : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }}
                              onClick={() => setAssigningJob(j)}>
                              {waitingAssign ? '⚡ Phân công' : '✏️ Sửa'}
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap' }}>
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
                  })}
                </tbody>
              </table>
            )}
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
    </div>
  );
}
