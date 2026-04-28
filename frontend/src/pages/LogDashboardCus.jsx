import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import StaffSection, { CUS_COLS } from '../components/StaffSection';
import {
  getJobStats, getJobs, updateJobTk, updateJob, confirmJob, requestDeadline, completeJob,
  requestJobDelete, createJob,
} from '../api';

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

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
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
  if (ms < 24 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
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
  const [val, setVal] = useState(value || '');
  const ref = useRef();

  function start() { setVal(value || ''); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() {
    setEditing(false);
    if (val !== (value || '')) onSave(val || null);
  }

  if (!editing) return (
    <span onClick={start} title="Click để sửa"
      style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', minWidth: 40, display: 'inline-block', fontSize: 13 }}>
      {value || <span style={{ color: 'var(--text-3)' }}>—</span>}
    </span>
  );
  return (
    <input ref={ref} type={type} value={val}
      onChange={e => setVal(e.target.value)}
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

const CUS_FILTER_COLS = [
  { key: 'stt',              label: 'STT' },
  { key: 'created_at',       label: 'Ngày' },
  { key: 'job_code',         label: 'Job',            filterType: 'text' },
  { key: 'si_number',        label: 'Mã SI',          filterType: 'text' },
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
  { key: 'other_svc',        label: 'Dịch vụ khác' },
  { key: 'delivery_dt',      label: 'Ngày giao hàng' },
  { key: 'delivery_loc',     label: 'Địa điểm giao' },
  { key: 'truck_booked',     label: 'Đặt xe' },
  { key: 'ht',               label: 'HT' },
  { key: 'notes',            label: 'Ghi chú' },
];

function DeadlineRequestModal({ job, onClose, onSubmit }) {
  const [proposed, setProposed] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
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
  );
}

export default function LogDashboardCus() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  const [deadlineReqJob, setDeadlineReqJob] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

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
  const jobs = tab === 'completed' ? completedJobs : pendingJobs;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;

  const tkMut = useMutation({
    mutationFn: ({ jobId, data }) => updateJobTk(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const confirmMut = useMutation({
    mutationFn: id => confirmJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'jobStats'] }),
  });
  const deadlineMut = useMutation({
    mutationFn: ({ id, proposed, reason }) => requestDeadline(id, { proposed_deadline: proposed, reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setDeadlineReqJob(null); },
  });
  const completeMut = useMutation({
    mutationFn: id => completeJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'jobStats'] }),
  });
  const deleteReqMut = useMutation({
    mutationFn: ({ id, reason }) => requestJobDelete(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const createMut = useMutation({
    mutationFn: data => createJob(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs', 'jobStats'] }),
  });
  const opsMut = useMutation({
    mutationFn: ({ id, data }) => updateJob(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  function canComplete(j) {
    const terminal = ['thong_quan', 'giai_phong', 'bao_quan'];
    if (!terminal.includes(j.tk_status)) return false;
    if (j.service_type === 'both' && (!j.delivery_datetime || !j.delivery_location)) return false;
    return true;
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard CUS</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tổng job đang làm" value={stats?.total_active} color="var(--info)" onClick={() => setJobListFilter('cus_active')} />
          <StatCard label="Chờ xác nhận" value={stats?.cho_xac_nhan} color="var(--warning)" onClick={() => setJobListFilter('cus_waiting_confirm')} />
          <StatCard label="Sắp hạn (24h)" value={stats?.sap_han} color="var(--warning)" onClick={() => setJobListFilter('cus_near_deadline')} />
          <StatCard label="Quá hạn" value={stats?.qua_han} color="var(--danger)" onClick={() => setJobListFilter('cus_overdue')} />
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
                emptyText="Không có job nào"
                tableStyle={{ fontSize: 13 }}
                renderRow={(j, i) => {
                    const svc = parseJson(j.services_completed);
                    const os = parseJson(j.other_services);
                    const isTk = j.service_type === 'tk' || j.service_type === 'both';
                    const isConfirmPending = j.cus_confirm_status === 'pending';
                    const rowBg = tkFlowRowBg(j) ||
                      (j.deadline && new Date(j.deadline) < Date.now() ? 'rgba(239,68,68,0.04)' :
                      j.deadline && (new Date(j.deadline) - Date.now()) < 24*3600*1000 ? 'rgba(217,119,6,0.04)' : '');

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        <td style={{ padding: '8px 8px', color: 'var(--text-3)' }}>{i + 1}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--info)' }}>
                          {j.job_code || `#${j.id}`}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>
                        <td style={{ padding: '8px 8px', maxWidth: 140 }}>{j.customer_name}</td>
                        <td style={{ padding: '8px 6px', minWidth: 80 }}>
                          <OpsPartnerCell job={j} onSave={v => opsMut.mutate({ id: j.id, data: { ops_partner: v } })} />
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                          {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>
                          {j.deadline
                            ? new Date(j.deadline).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : '—'}
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
                            <td style={{ padding: '8px 6px', minWidth: 150 }}>
                              <InlineInput type="datetime-local" value={toDatetimeLocal(j.tk_datetime)}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_datetime: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 80 }}>
                              <InlineInput value={j.tk_number}
                                onSave={v => tkMut.mutate({ jobId: j.id, data: { tk_number: v } })} />
                            </td>
                            <td style={{ padding: '8px 6px', minWidth: 70 }}>
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
                        <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                          <input type="checkbox" checked={!!j.truck_booked}
                            onChange={e => tkMut.mutate({ jobId: j.id, data: { truck_booked: e.target.checked } })} />
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                          {tab === 'pending' ? (
                            <button className="btn btn-primary btn-sm" style={{ padding: '3px 10px', fontSize: 11 }}
                              disabled={!canComplete(j)}
                              title={canComplete(j) ? 'Đánh dấu hoàn thành' : 'Chưa đủ điều kiện (cần TK đạt TQ/GP/BQ)'}
                              onClick={() => canComplete(j) && completeMut.mutate(j.id)}>
                              HT
                            </button>
                          ) : (
                            <span style={{ color: 'var(--primary)', fontSize: 16 }}>✓</span>
                          )}
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
