import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import { getJobStats, getJobs, requestJobDelete, markOpsDone, updateJobTk } from '../api';

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const TK_TERMINAL = ['thong_quan', 'giai_phong', 'bao_quan'];
const TK_STATUS_OPTS = [
  { value: 'chua_truyen', label: 'Chưa truyền' }, { value: 'dang_lam', label: 'Đang làm' },
  { value: 'thong_quan', label: 'Thông quan' }, { value: 'giai_phong', label: 'Giải phóng' },
  { value: 'bao_quan', label: 'Bảo quan' },
];

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

const TH = ({ children }) => (
  <th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
    {children}
  </th>
);
const TD = ({ children, style }) => (
  <td style={{ padding: '8px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, ...style }}>{children}</td>
);

const TQ_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'etd_eta',       label: 'ETD / ETA' },
  { key: 'deadline',      label: 'Hạn lệnh' },
  { key: 'tk_flow',       label: 'Luồng TK' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  { key: 'tq_datetime',   label: 'Ngày giờ TQ' },
  { key: 'notes',         label: 'Ghi chú' },
];

const DL_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'deadline',      label: 'Hạn lệnh' },
  { key: 'ops_task_info', label: 'Cảng / Loại công việc' },
];

const TODAY_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'deadline',      label: 'Hạn lệnh' },
  { key: 'planned_dt',    label: 'KH giao xe' },
];

const DONE_COLS = [
  { key: 'ops_done_at',   label: 'Ngày xong' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  { key: 'ops_task_info', label: 'Yêu cầu công việc' },
];

const HT_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont' },
  { key: 'etd_eta',       label: 'ETD / ETA' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  { key: 'tq_datetime',   label: 'Ngày TQ' },
];

export default function LogDashboardOps() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('tq_doi_lenh');
  const [detailJobId, setDetailJobId] = useState(null);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: 30000 });
  const { data: pendingJobs = [], isLoading } = useQuery({
    queryKey: ['jobs', 'pending'],
    queryFn: () => getJobs({ tab: 'pending' }),
    refetchInterval: 30000,
  });
  const { data: completedJobs = [] } = useQuery({
    queryKey: ['jobs', 'completed', completedRange],
    queryFn: () => getJobs({ tab: 'completed', ...completedRange }),
    enabled: tab === 'hoan_thanh',
  });

  const opsDoneMut = useMutation({
    mutationFn: id => markOpsDone(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const tkMut = useMutation({
    mutationFn: ({ id, data }) => updateJobTk(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const deleteReqMut = useMutation({
    mutationFn: ({ id, reason }) => requestJobDelete(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });

  const tomorrow = localDate(new Date(Date.now() + 86400000));
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);

  const tqJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    (j.service_type === 'tk' || j.service_type === 'both') &&
    !j.ops_done
  );
  const dlJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    (j.service_type === 'truck' || j.service_type === 'both') &&
    !j.ops_done
  );
  const todayJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    (j.service_type === 'truck' || j.service_type === 'both') &&
    j.planned_datetime &&
    localDate(new Date(j.planned_datetime)) === tomorrow
  );
  const doneJobs = pendingJobs.filter(j =>
    j.ops_done && j.ops_done_at && new Date(j.ops_done_at) >= threeDaysAgo
  );

  function rowBg(j) {
    if (j.tk_flow === 'xanh') return 'rgba(34,197,94,0.06)';
    if (j.tk_flow === 'vang') return 'rgba(217,119,6,0.06)';
    if (j.tk_flow === 'do') return 'rgba(239,68,68,0.06)';
    if (!j.deadline) return '';
    const ms = new Date(j.deadline) - Date.now();
    if (ms < 0) return 'rgba(239,68,68,0.04)';
    if (ms < 24 * 3600 * 1000) return 'rgba(217,119,6,0.04)';
    return '';
  }

  function opsDoneBtn(j) {
    const isTkJob = j.service_type === 'tk' || j.service_type === 'both';
    const canDone = !isTkJob || TK_TERMINAL.includes(j.tk_status);
    return (
      <button
        className="btn btn-primary btn-sm"
        style={{ padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap' }}
        disabled={!canDone || opsDoneMut.isPending}
        title={canDone ? 'Xong việc' : 'TK chưa thông quan / giải phóng / bảo quan'}
        onClick={e => { e.stopPropagation(); if (window.confirm('Xác nhận xong việc?')) opsDoneMut.mutate(j.id); }}
      >Xong việc</button>
    );
  }

  function opsTaskInfo(j) {
    const tasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
    if (!tasks.length) return <span style={{ color: 'var(--text-3)' }}>—</span>;
    return tasks.map(t => (
      <div key={t.id} style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
        {t.port && <span style={{ fontWeight: 600 }}>{t.port}</span>}
        {t.task_type && <span style={{ marginLeft: 4, color: 'var(--info)' }}>
          [{t.task_type === 'doi_lenh' ? 'Đổi lệnh' : t.task_type === 'thong_quan_doi_lenh' ? 'TQ đổi lệnh' : t.task_type}]
        </span>}
        {t.content && <span style={{ marginLeft: 4 }}>{t.content}</span>}
      </div>
    ));
  }

  function deleteBtn(j) {
    return (
      <button className="btn btn-ghost btn-sm btn-icon" title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
        onClick={e => { e.stopPropagation(); if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) deleteReqMut.mutate({ id: j.id, reason: null }); }}>🗑</button>
    );
  }

  function Badge({ n, color }) {
    if (!n) return null;
    return <span style={{ marginLeft: 4, background: color, color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{n}</span>;
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>Dashboard OPS</h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tổng job đang quản lý" value={stats?.total_managing} color="var(--info)" onClick={() => setJobListFilter('ops_total')} />
          <StatCard label="Chờ TQ đổi lệnh" value={stats?.cho_tq_doi_lenh} color="var(--purple)" onClick={() => setJobListFilter('ops_waiting_tq_doilenh')} />
          <StatCard label="Chờ đổi lệnh" value={stats?.cho_doi_lenh} color="var(--warning)" onClick={() => setJobListFilter('ops_waiting_doilenh')} />
          <StatCard label="Sắp hạn (24h)" value={stats?.sap_han} color="var(--warning)" onClick={() => setJobListFilter('ops_near_deadline')} />
          <StatCard label="Quá hạn" value={stats?.qua_han} color="var(--danger)" onClick={() => setJobListFilter('ops_overdue')} />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'tq_doi_lenh' ? 'active' : ''}`} onClick={() => setTab('tq_doi_lenh')}>
                Thông quan đổi lệnh<Badge n={tqJobs.length} color="var(--purple)" />
              </button>
              <button className={`tab ${tab === 'doi_lenh' ? 'active' : ''}`} onClick={() => setTab('doi_lenh')}>
                Đổi lệnh<Badge n={dlJobs.length} color="var(--warning)" />
              </button>
              <button className={`tab ${tab === 'phai_doi_lenh' ? 'active' : ''}`} onClick={() => setTab('phai_doi_lenh')}>
                Phải đổi lệnh hôm nay<Badge n={todayJobs.length} color="var(--danger)" />
              </button>
              <button className={`tab ${tab === 'xong_viec' ? 'active' : ''}`} onClick={() => setTab('xong_viec')}>Xong việc (3 ngày)</button>
              <button className={`tab ${tab === 'hoan_thanh' ? 'active' : ''}`} onClick={() => setTab('hoan_thanh')}>Hoàn thành</button>
            </div>
            {tab === 'hoan_thanh' && (
              <div style={{ paddingBottom: 4 }}>
                <DateRangeFilter onChange={setCompletedRange} />
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading && tab !== 'hoan_thanh' ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : tab === 'tq_doi_lenh' ? (
              <FilteredTable
                columns={TQ_COLS}
                data={tqJobs}
                emptyText="Không có job nào"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: rowBg(j), cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)}<br />{fmtDate(j.eta)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>{j.deadline ? fmtDt(j.deadline) : '—'}</TD>
                    <TD style={{ color: 'var(--text-2)' }}>{j.tk_flow || '—'}</TD>
                    <TD>
                      <select
                        value={j.tk_status || 'chua_truyen'}
                        style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border)', color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', background: 'transparent', cursor: 'pointer' }}
                        onClick={e => e.stopPropagation()}
                        onChange={e => tkMut.mutate({ id: j.id, data: { tk_status: e.target.value } })}
                      >
                        {TK_STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                    <TD style={{ color: 'var(--text-2)', maxWidth: 160, fontSize: 12 }}>{j.tk_notes || '—'}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      {opsDoneBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'doi_lenh' ? (
              <FilteredTable
                columns={DL_COLS}
                data={dlJobs}
                emptyText="Không có job nào"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: rowBg(j), cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>{j.deadline ? fmtDt(j.deadline) : '—'}</TD>
                    <TD>{opsTaskInfo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      {opsDoneBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'phai_doi_lenh' ? (
              <FilteredTable
                columns={TODAY_COLS}
                data={todayJobs}
                emptyText="Không có job nào cần đổi lệnh hôm nay"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: 'rgba(239,68,68,0.04)', cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>{j.deadline ? fmtDt(j.deadline) : '—'}</TD>
                    <TD style={{ whiteSpace: 'nowrap', color: 'var(--warning)', fontWeight: 600 }}>{fmtDt(j.planned_datetime)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'xong_viec' ? (
              <FilteredTable
                columns={DONE_COLS}
                data={doneJobs}
                emptyText="Không có job nào xong việc trong 3 ngày"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--primary)' }}>{fmtDt(j.ops_done_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>{j.job_code || `#${j.id}`}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD>
                      <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                        {TK_STATUS_LABEL[j.tk_status] || '—'}
                      </span>
                    </TD>
                    <TD>{opsTaskInfo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : (
              <FilteredTable
                columns={HT_COLS}
                data={completedJobs}
                emptyText="Không có job hoàn thành"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--primary)' }}>{j.job_code || `#${j.id}`}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <TD>{j.customer_name}</TD>
                    <TD style={{ fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)} / {fmtDate(j.eta)}</TD>
                    <TD>
                      <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                        {TK_STATUS_LABEL[j.tk_status] || '—'}
                      </span>
                    </TD>
                    <TD style={{ fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            )}
          </div>
        </div>
      </div>

      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {jobListFilter && <JobListModal filterType={jobListFilter} onClose={() => setJobListFilter(null)} />}
    </div>
  );
}
