import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getJob, updateJobTk, updateJobTruck } from '../api';
import { useAuth } from '../App';

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

export default function JobDetailModal({ jobId, onClose }) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const canEditTk = ['cus','cus1','cus2','cus3'].includes(user?.role);
  const canEditStatus = user?.role === 'ops';
  const canEditTruck = user?.role === 'dieu_do';

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
  });

  const tkMut = useMutation({
    mutationFn: data => updateJobTk(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', jobId] }),
  });
  const truckMut = useMutation({
    mutationFn: data => updateJobTruck(jobId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', jobId] }),
  });

  if (!jobId) return null;

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-xl" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, background: 'var(--info-dim)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📦</div>
            <div>
              <h3 style={{ fontSize: 16 }}>{isLoading ? 'Đang tải...' : (job?.job_code || `Job #${jobId}`)}</h3>
              {job && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{job.customer_name}</div>}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 0, display: 'flex', overflow: 'hidden' }}>
          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', width: '100%' }}><span className="spinner" /></div>
          ) : job ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', overflow: 'hidden' }}>
              {/* Left: job info */}
              <div style={{ padding: '20px 24px', borderRight: '1px solid var(--border)', overflowY: 'auto' }}>

                <Section title="Thông tin chung">
                  <Row label="Mã job" value={job.job_code || '—'} />
                  <Row label="Mã SI" value={job.si_number || '—'} />
                  <Row label="MBL No" value={job.mbl_no || '—'} />
                  <Row label="HBL No" value={job.hbl_no || '—'} />
                  <Row label="Ngày tạo" value={fmtDt(job.created_at)} />
                  <Row label="Người tạo" value={job.created_by_name || '—'} />
                  <Row label="Hạn lệnh" value={fmtDt(job.han_lenh)} color={deadlineColor(job.han_lenh)} />
                  <Row label="Điểm đến" value={fmtDest(job.destination)} />
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
                            <InlineInput value={tk.tk_flow} onSave={v => tkMut.mutate({ tk_flow: v })} />
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
                          <Row label="Luồng" value={tk.tk_flow || '—'} />
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
                          <Row label="Luồng" value={tk.tk_flow || '—'} />
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

                {job.truck && (() => {
                  const truck = job.truck;
                  return (
                    <Section title="Vận chuyển">
                      {canEditTruck ? (
                        <>
                          <ERow label="Vận tải">
                            <InlineInput value={truck.transport_name} onSave={v => truckMut.mutate({ transport_name: v })} />
                          </ERow>
                          <ERow label="Số xe">
                            <InlineInput value={truck.vehicle_number} onSave={v => truckMut.mutate({ vehicle_number: v })} />
                          </ERow>
                          <ERow label="KH ngày giờ">
                            <InlineInput type="datetime-local" value={toDatetimeLocal(truck.planned_datetime)}
                              onSave={v => truckMut.mutate({ planned_datetime: v })} />
                          </ERow>
                          <ERow label="TH ngày giờ">
                            <InlineInput type="datetime-local" value={toDatetimeLocal(truck.actual_datetime)}
                              onSave={v => truckMut.mutate({ actual_datetime: v })} />
                          </ERow>
                          <ERow label="Lấy hàng">
                            <InlineInput value={truck.pickup_location} onSave={v => truckMut.mutate({ pickup_location: v })} />
                          </ERow>
                          <ERow label="Giao hàng">
                            <InlineInput value={truck.delivery_location} onSave={v => truckMut.mutate({ delivery_location: v })} />
                          </ERow>
                          <ERow label="Cước">
                            <InlineInput type="number" value={truck.cost != null ? String(truck.cost) : ''}
                              onSave={v => truckMut.mutate({ cost: v ? Number(v) : null })} />
                          </ERow>
                          <ERow label="Ghi chú vận tải">
                            <InlineInput value={truck.notes} onSave={v => truckMut.mutate({ notes: v })} />
                          </ERow>
                        </>
                      ) : (
                        <>
                          <Row label="Vận tải" value={truck.transport_name || '—'} />
                          <Row label="Số xe" value={truck.vehicle_number || '—'} />
                          <Row label="KH ngày giờ" value={fmtDt(truck.planned_datetime)} />
                          <Row label="TH ngày giờ" value={fmtDt(truck.actual_datetime)} />
                          <Row label="Lấy hàng" value={truck.pickup_location || '—'} />
                          <Row label="Giao hàng" value={truck.delivery_location || '—'} />
                          <Row label="Cước" value={truck.cost ? Number(truck.cost).toLocaleString('vi-VN') + ' đ' : '—'} />
                          <Row label="Ghi chú vận tải" value={truck.notes || '—'} />
                        </>
                      )}
                      <Row label="Hoàn thành lúc" value={fmtDt(truck.completed_at)} color="var(--primary)" />
                    </Section>
                  );
                })()}

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
  );
}
