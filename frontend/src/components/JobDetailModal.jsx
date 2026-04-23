import { useQuery } from '@tanstack/react-query';
import { getJob } from '../api';

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
  pending: 'Chờ xác nhận',
  confirmed: 'Đã xác nhận',
  adjustment_requested: 'Yêu cầu điều chỉnh deadline',
};
const CUS_CONFIRM_COLOR = {
  pending: 'var(--text-2)',
  confirmed: 'var(--primary)',
  adjustment_requested: 'var(--warning)',
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

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '4px 0' }}>{children}</div>
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

function SvcCompletedChips({ services }) {
  const done = OTHER_SVC_KEYS.filter(k => services?.[k]);
  if (!done.length) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 10px', fontSize: 13 }}>
      <span style={{ color: 'var(--text-2)', flexShrink: 0, marginRight: 8 }}>Dịch vụ hoàn thành</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
        {done.map(k => (
          <span key={k} style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: 'var(--primary-dim)', color: 'var(--primary)' }}>
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
  const { data: job, isLoading } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
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
                </Section>

                {job.tk && (
                  <Section title="Tờ khai">
                    <Row label="CUS xử lý" value={job.tk.cus_name || '—'} />
                    <Row label="Ngày TK" value={fmtDt(job.tk.tk_datetime)} />
                    <Row label="Số TK" value={job.tk.tk_number || '—'} />
                    <Row label="Luồng" value={job.tk.tk_flow || '—'} />
                    <Row label="Trạng thái" value={TK_STATUS_LABEL[job.tk.tk_status] || '—'}
                         color={TK_STATUS_COLOR[job.tk.tk_status]} />
                    <Row label="Ngày TQ" value={fmtDt(job.tk.tq_datetime)} />
                    <Row label="Ngày giao" value={fmtDt(job.tk.delivery_datetime)} />
                    <Row label="Địa điểm giao" value={job.tk.delivery_location || '—'} />
                    <Row label="Đã đặt xe" value={job.tk.truck_booked ? 'Có' : 'Không'} />
                    <SvcCompletedChips services={job.tk.services_completed} />
                    <Row label="Ghi chú TK" value={job.tk.notes || '—'} />
                    <Row label="Hoàn thành lúc" value={fmtDt(job.tk.completed_at)} color="var(--primary)" />
                  </Section>
                )}

                {job.truck && (
                  <Section title="Vận chuyển">
                    <Row label="Vận tải" value={job.truck.transport_name || '—'} />
                    <Row label="Số xe" value={job.truck.vehicle_number || '—'} />
                    <Row label="KH ngày giờ" value={fmtDt(job.truck.planned_datetime)} />
                    <Row label="TH ngày giờ" value={fmtDt(job.truck.actual_datetime)} />
                    <Row label="Lấy hàng" value={job.truck.pickup_location || '—'} />
                    <Row label="Giao hàng" value={job.truck.delivery_location || '—'} />
                    <Row label="Cước" value={job.truck.cost ? Number(job.truck.cost).toLocaleString('vi-VN') + ' đ' : '—'} />
                    <Row label="Ghi chú vận tải" value={job.truck.notes || '—'} />
                    <Row label="Hoàn thành lúc" value={fmtDt(job.truck.completed_at)} color="var(--primary)" />
                  </Section>
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
  );
}
