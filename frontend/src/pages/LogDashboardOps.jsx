import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import { getJobStats, getJobs, completeOpsTask, completeJob, requestJobDelete, createJob } from '../api';

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function deadlineStyle(dl) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 24 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}

function StatCard({ label, value, color }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>
        {value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

const TH = ({ children }) => (
  <th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
    {children}
  </th>
);
const TD = ({ children, style }) => (
  <td style={{ padding: '8px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, ...style }}>{children}</td>
);

export default function LogDashboardOps() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('follow_tq');
  const [detailJobId, setDetailJobId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: 30000 });
  const { data: pendingJobs = [], isLoading } = useQuery({
    queryKey: ['jobs', 'pending'],
    queryFn: () => getJobs({ tab: 'pending' }),
    refetchInterval: 30000,
  });
  const { data: completedJobs = [] } = useQuery({
    queryKey: ['jobs', 'completed'],
    queryFn: () => getJobs({ tab: 'completed' }),
    enabled: tab === 'hoan_thanh',
  });

  const completeTaskMut = useMutation({
    mutationFn: ({ tid, notes }) => completeOpsTask(tid, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const completeJobMut = useMutation({
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

  const displayJobs = tab === 'hoan_thanh' ? completedJobs : pendingJobs;

  function rowBg(j) {
    if (!j.deadline) return '';
    const ms = new Date(j.deadline) - Date.now();
    if (ms < 0) return 'rgba(239,68,68,0.04)';
    if (ms < 24 * 3600 * 1000) return 'rgba(217,119,6,0.04)';
    return '';
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>Dashboard OPS</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tổng job đang quản lý" value={stats?.total_managing} color="var(--info)" />
          <StatCard label="Chờ xử lý đổi lệnh" value={stats?.cho_doi_lenh} color="var(--warning)" />
          <StatCard label="Chờ thông quan" value={stats?.cho_thong_quan} color="var(--purple)" />
          <StatCard label="Sắp hạn (24h)" value={stats?.sap_han} color="var(--warning)" />
          <StatCard label="Quá hạn" value={stats?.qua_han} color="var(--danger)" />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'follow_tq' ? 'active' : ''}`} onClick={() => setTab('follow_tq')}>Follow thông quan</button>
              <button className={`tab ${tab === 'doi_lenh' ? 'active' : ''}`} onClick={() => setTab('doi_lenh')}>Đổi lệnh & việc khác</button>
              <button className={`tab ${tab === 'hoan_thanh' ? 'active' : ''}`} onClick={() => setTab('hoan_thanh')}>Hoàn thành (3 ngày)</button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading && tab !== 'hoan_thanh' ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : tab === 'follow_tq' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH>Ngày</TH><TH>Job</TH><TH>Khách hàng</TH>
                    <TH>Số cont / Loại cont</TH><TH>ETD / ETA</TH>
                    <TH>Hạn lệnh</TH><TH>Luồng TK</TH><TH>Trạng thái TK</TH>
                    <TH>Ngày giờ TQ</TH><TH>Ghi chú</TH><TH></TH>
                  </tr>
                </thead>
                <tbody>
                  {displayJobs.length === 0 && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>Không có job nào</td></tr>
                  )}
                  {displayJobs.map(j => (
                    <tr key={j.id} style={{ background: rowBg(j) }} onDoubleClick={() => setDetailJobId(j.id)}>
                      <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                      <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                      <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                      <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                        {j.cont_number || '—'}{j.cont_type ? ` / ${j.cont_type}` : ''}
                      </TD>
                      <TD style={{ whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                        {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                      </TD>
                      <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>
                        {j.deadline ? fmtDt(j.deadline) : '—'}
                      </TD>
                      <TD style={{ color: 'var(--text-2)' }}>{j.tk_flow || '—'}</TD>
                      <TD>
                        <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                          {TK_STATUS_LABEL[j.tk_status] || '—'}
                        </span>
                      </TD>
                      <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                      <TD style={{ color: 'var(--text-2)', maxWidth: 160, fontSize: 12 }}>{j.tk_notes || '—'}</TD>
                      <TD style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm btn-icon"
                          title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
                          onClick={() => {
                            if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) {
                              deleteReqMut.mutate({ id: j.id, reason: null });
                            }
                          }}>🗑</button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setDetailJobId(j.id)}>🔍</button>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : tab === 'doi_lenh' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH>Ngày</TH><TH>Job</TH><TH>Khách hàng</TH>
                    <TH>Số cont / Loại cont</TH><TH>Hạn lệnh</TH>
                    <TH>Cảng đổi lệnh</TH><TH>Nội dung CV</TH>
                    <TH>Deadline task</TH><TH>Hoàn thành</TH><TH>Ghi chú</TH><TH></TH>
                  </tr>
                </thead>
                <tbody>
                  {displayJobs.length === 0 && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>Không có job nào</td></tr>
                  )}
                  {displayJobs.map(j => (
                    <tr key={j.id} style={{ background: rowBg(j) }} onDoubleClick={() => setDetailJobId(j.id)}>
                      <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                      <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                      <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                      <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                        {j.cont_number || '—'}{j.cont_type ? ` / ${j.cont_type}` : ''}
                      </TD>
                      <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>
                        {j.deadline ? fmtDt(j.deadline) : '—'}
                      </TD>
                      <TD colSpan={5} style={{ color: 'var(--text-3)', fontSize: 12 }}>
                        Mở chi tiết để xem &amp; hoàn thành công việc OPS
                      </TD>
                      <TD style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm btn-icon"
                          title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
                          onClick={() => {
                            if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) {
                              deleteReqMut.mutate({ id: j.id, reason: null });
                            }
                          }}>🗑</button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setDetailJobId(j.id)}>🔍</button>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <TH>Ngày</TH><TH>Job</TH><TH>Khách hàng</TH>
                    <TH>Số cont</TH><TH>ETD / ETA</TH>
                    <TH>Trạng thái TK</TH><TH>Ngày TQ</TH><TH></TH>
                  </tr>
                </thead>
                <tbody>
                  {completedJobs.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>Không có job hoàn thành trong 3 ngày qua</td></tr>
                  )}
                  {completedJobs.map(j => (
                    <tr key={j.id} style={{ borderBottom: '1px solid var(--border)' }} onDoubleClick={() => setDetailJobId(j.id)}>
                      <TD style={{ fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                      <TD style={{ fontWeight: 600, color: 'var(--primary)' }}>{j.job_code || `#${j.id}`}</TD>
                      <TD>{j.customer_name}</TD>
                      <TD style={{ fontSize: 12 }}>{j.cont_number || '—'}</TD>
                      <TD style={{ color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)} / {fmtDate(j.eta)}</TD>
                      <TD>
                        <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                          {TK_STATUS_LABEL[j.tk_status] || '—'}
                        </span>
                      </TD>
                      <TD style={{ fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                      <TD style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm btn-icon"
                          title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
                          onClick={() => {
                            if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) {
                              deleteReqMut.mutate({ id: j.id, reason: null });
                            }
                          }}>🗑</button>
                        <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setDetailJobId(j.id)}>🔍</button>
                      </TD>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {showCreate && <CreateJobModal onClose={() => setShowCreate(false)} onCreated={data => createMut.mutateAsync(data)} />}
    </div>
  );
}
