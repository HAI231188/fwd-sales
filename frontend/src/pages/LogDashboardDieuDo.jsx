import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import { getJobStats, getJobs, updateJobTruck, completeJobTruck, requestJobDelete, createJob } from '../api';

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

function InlineInput({ value, onSave, type = 'text', placeholder }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value || '');
  const ref = useRef();

  function start() { setVal(value || ''); setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  function save() { setEditing(false); if (val !== (value || '')) onSave(val || null); }

  if (!editing) return (
    <span onClick={start} title="Click để sửa"
      style={{ cursor: 'pointer', borderBottom: '1px dashed var(--border)', minWidth: 40, display: 'inline-block', fontSize: 13 }}>
      {value || <span style={{ color: 'var(--text-3)' }}>{placeholder || '—'}</span>}
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

export default function LogDashboardDieuDo() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: 30000 });
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['jobs', tab],
    queryFn: () => getJobs({ tab }),
    refetchInterval: 30000,
  });

  const truckMut = useMutation({
    mutationFn: ({ jobId, data }) => updateJobTruck(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
  const completeMut = useMutation({
    mutationFn: id => completeJobTruck(id),
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

  function canComplete(j) {
    return !!(j.transport_name && j.vehicle_number && j.truck_delivery_location && j.cost);
  }

  const HEADERS = [
    'Ngày', 'Job', 'Mã SI', 'Khách hàng', 'Cont / Tons',
    'ETD / ETA', 'Hạn lệnh',
    'Tên vận tải', 'KH ngày giờ', 'TH ngày giờ',
    'Số xe', 'Địa điểm lấy', 'Địa điểm giao', 'Cước', 'HT', 'Ghi chú', '',
  ];

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard Điều Độ</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 24 }}>
          <StatCard label="Tổng job truck đang xử lý" value={stats?.total_active} color="var(--info)" />
          <StatCard label="Đã đặt xe" value={stats?.da_dat_xe} color="var(--primary)" />
          <StatCard label="Chưa đặt xe" value={stats?.chua_dat_xe} color="var(--warning)" />
          <StatCard label="Cảnh báo quá hạn" value={stats?.warn_overdue} color="var(--danger)" />
          <StatCard label="Chưa hoàn thành" value={stats?.chua_hoan_thanh} color="var(--text-2)" />
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>Đang làm</button>
              <button className={`tab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>Hoàn thành (3 ngày)</button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                    {HEADERS.map((h, i) => (
                      <th key={i} style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 && (
                    <tr><td colSpan={HEADERS.length} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>Không có job nào</td></tr>
                  )}
                  {jobs.map(j => {
                    const planned = j.planned_datetime;
                    const isPastDue = planned && new Date(planned) < Date.now() && !j.truck_completed_at;
                    const isWarnSoon = planned && !isPastDue && (new Date(planned) - Date.now()) < 24 * 3600 * 1000;
                    const rowBg = isPastDue ? 'rgba(239,68,68,0.04)' : isWarnSoon ? 'rgba(217,119,6,0.04)' : '';

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--info)' }}>
                          {j.job_code || `#${j.id}`}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>
                        <td style={{ padding: '8px 8px', maxWidth: 140 }}>{j.customer_name}</td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {fmtCargo(j)}
                          {j.tons && <div style={{ color: 'var(--text-3)' }}>{j.tons} tấn</div>}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                          {fmtDate(j.etd)}<br />{fmtDate(j.eta)}
                        </td>
                        <td style={{ padding: '8px 8px', whiteSpace: 'nowrap', ...deadlineStyle(j.deadline) }}>
                          {j.deadline
                            ? new Date(j.deadline).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                            : '—'}
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 130 }}>
                          <InlineInput value={j.transport_name} placeholder="Nhập vận tải..."
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { transport_name: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 155 }}>
                          <InlineInput type="datetime-local" value={toDatetimeLocal(j.planned_datetime)}
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { planned_datetime: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 155 }}>
                          <InlineInput type="datetime-local" value={toDatetimeLocal(j.actual_datetime)}
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { actual_datetime: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 80 }}>
                          <InlineInput value={j.vehicle_number} placeholder="Số xe..."
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { vehicle_number: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 130 }}>
                          <InlineInput value={j.pickup_location} placeholder="Địa điểm lấy..."
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { pickup_location: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 130 }}>
                          <InlineInput value={j.truck_delivery_location} placeholder="Địa điểm giao..."
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { delivery_location: v } })} />
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 90 }}>
                          <InlineInput value={j.cost ? String(j.cost) : ''} type="number" placeholder="Cước..."
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { cost: v ? Number(v) : null } })} />
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'center' }}>
                          {tab === 'pending' ? (
                            <button className="btn btn-primary btn-sm" style={{ padding: '3px 10px', fontSize: 11 }}
                              disabled={!canComplete(j)}
                              title={canComplete(j) ? 'Hoàn thành' : 'Cần: vận tải, số xe, địa điểm giao, cước'}
                              onClick={() => canComplete(j) && completeMut.mutate(j.id)}>
                              HT
                            </button>
                          ) : (
                            <span style={{ color: 'var(--primary)', fontSize: 16 }}>✓</span>
                          )}
                        </td>
                        <td style={{ padding: '8px 6px', minWidth: 120 }}>
                          <InlineInput value={j.truck_notes}
                            onSave={v => truckMut.mutate({ jobId: j.id, data: { notes: v } })} />
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
                  })}
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
