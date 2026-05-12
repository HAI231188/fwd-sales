import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getBbbgData, generateBbbgPdf } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

function fmtToday() {
  return new Date().toLocaleDateString('vi-VN');
}
function todayHHmm() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
    {children}
  </div>
);

const Field = ({ label, en, children, span = 1 }) => (
  <div className="form-group" style={{ gridColumn: `span ${span}`, margin: 0 }}>
    <label className="form-label" style={{ marginBottom: 2 }}>
      {label} {en && <span style={{ color: 'var(--text-3)', fontStyle: 'italic', fontWeight: 400 }}>({en})</span>}
    </label>
    {children}
  </div>
);

export default function BBBGModal({ jobId, jobCode, bookingId, onClose }) {
  const zIndex = useModalZIndex();
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // bookingId is part of the cache key so switching between per-booking BBBG views
  // for the same job does not reuse stale container/transport data.
  const { data, isLoading, error } = useQuery({
    queryKey: ['bbbgData', jobId, bookingId || null],
    queryFn: () => getBbbgData(jobId, bookingId),
    enabled: !!jobId,
  });

  const [form, setForm] = useState(null);

  useEffect(() => {
    if (data && !form) {
      setForm({
        job_code: data.job_code || '',
        today_date: fmtToday(),
        consignee: data.consignee || '',
        shipper: '',
        vessel: '',
        voy: '',
        from_: '',
        terminal: '',
        hbl_no: data.hbl_no || '',
        mbl_no: data.mbl_no || '',
        description: 'AS PER BILL',
        containers: (data.containers || []).map(c => ({
          cont_number: c.cont_number || '',
          cont_type:   c.cont_type   || '',
          seal_number: c.seal_number || '',
        })),
        weight_value: data.weight_value ?? '',
        weight_unit:  data.weight_unit  || 'TONS',
        so_kien:      data.so_kien ?? '',
        delivery_company: data.consignee || '',
        delivery_address: data.suggested_delivery_location || data.delivery_address || '',
        recipient_name:   '',
        delivery_time:    todayHHmm(),
        delivery_date:    fmtToday(),
        remarks: '',
        // Invoice info (L15) — pre-fill from customer_pipeline snapshot via bbbg-data.
        invoice_company_name: data.invoice_company_name || '',
        invoice_tax_code:     data.invoice_tax_code     || '',
        invoice_address:      data.invoice_address      || '',
        save_as_default:      false,
      });
    }
  }, [data, form]);

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  function updateContainer(i, key, value) {
    setForm(f => ({ ...f, containers: f.containers.map((c, idx) => idx === i ? { ...c, [key]: value } : c) }));
  }
  function removeContainer(i) {
    setForm(f => ({ ...f, containers: f.containers.filter((_, idx) => idx !== i) }));
  }
  function addContainer() {
    setForm(f => ({ ...f, containers: [...f.containers, { cont_number: '', cont_type: '', seal_number: '' }] }));
  }

  async function handleExport() {
    if (!form) return;
    setSubmitErr('');
    setSubmitting(true);
    try {
      const payload = {
        ...form,
        weight_value: form.weight_value === '' ? null : Number(form.weight_value),
        so_kien:      form.so_kien      === '' ? null : Number(form.so_kien),
        save_as_default: !!form.save_as_default,
      };
      const blob = await generateBbbgPdf(jobId, payload);
      const safeCode = String(form.job_code || jobCode || jobId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const datePart = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `BBBG_${safeCode}_${datePart}.pdf`);
    } catch (err) {
      setSubmitErr(err?.error || err?.message || 'Không xuất được PDF. Thử lại.');
    } finally {
      setSubmitting(false);
    }
  }

  const past = data?.past_delivery_locations || [];

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Tạo BBBG — {jobCode || `#${jobId}`}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          {isLoading && <div style={{ padding: 24, textAlign: 'center' }}><span className="spinner" /></div>}
          {error && <div style={{ padding: 16, color: 'var(--danger)' }}>Lỗi tải dữ liệu: {error?.error || error?.message || 'Unknown'}</div>}

          {form && (
            <>
              <Section title="Thông tin chung">
                <div className="form-grid-2">
                  <Field label="Số lô hàng" en="Job ID">
                    <input className="form-input" value={form.job_code} onChange={e => set('job_code', e.target.value)} />
                  </Field>
                  <Field label="Ngày phát hành" en="Date">
                    <input className="form-input" value={form.today_date} onChange={e => set('today_date', e.target.value)} />
                  </Field>
                  <Field label="Người gửi" en="Shipper">
                    <input className="form-input" value={form.shipper} onChange={e => set('shipper', e.target.value)} />
                  </Field>
                  <Field label="Người nhận" en="Consignee">
                    <input className="form-input" value={form.consignee} onChange={e => set('consignee', e.target.value)} />
                  </Field>
                  <Field label="Tàu" en="Vessel">
                    <input className="form-input" value={form.vessel} onChange={e => set('vessel', e.target.value)} />
                  </Field>
                  <Field label="Chuyến" en="Voy.">
                    <input className="form-input" value={form.voy} onChange={e => set('voy', e.target.value)} />
                  </Field>
                  <Field label="Từ" en="From">
                    <input className="form-input" value={form.from_} onChange={e => set('from_', e.target.value)} />
                  </Field>
                  <Field label="Đến cảng" en="Terminal">
                    <input className="form-input" value={form.terminal} onChange={e => set('terminal', e.target.value)} />
                  </Field>
                  <Field label="Vận đơn phụ" en="H-B/L">
                    <input className="form-input" value={form.hbl_no} onChange={e => set('hbl_no', e.target.value)} />
                  </Field>
                  <Field label="Vận đơn chính" en="M-B/L">
                    <input className="form-input" value={form.mbl_no} onChange={e => set('mbl_no', e.target.value)} />
                  </Field>
                </div>
              </Section>

              <Section title="Container">
                {form.containers.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>Chưa có container.</div>
                )}
                {form.containers.map((c, i) => (
                  <div key={i} className="form-grid-4" style={{ gap: 6, marginBottom: 6 }}>
                    <input className="form-input" placeholder="Số container" value={c.cont_number} onChange={e => updateContainer(i, 'cont_number', e.target.value)} />
                    <input className="form-input" placeholder="Loại"          value={c.cont_type}   onChange={e => updateContainer(i, 'cont_type',   e.target.value)} />
                    <input className="form-input" placeholder="Seal"          value={c.seal_number} onChange={e => updateContainer(i, 'seal_number', e.target.value)} />
                    <button className="btn btn-ghost btn-sm btn-icon" title="Xóa cont này" style={{ color: 'var(--danger)' }} onClick={() => removeContainer(i)}>🗑</button>
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} onClick={addContainer}>+ Thêm cont</button>
              </Section>

              <Section title="Hàng hóa">
                <div className="form-grid-4">
                  <Field label="Tên hàng hóa" en="Description">
                    <input className="form-input" value={form.description} onChange={e => set('description', e.target.value)} />
                  </Field>
                  <Field label="Trọng lượng" en="Weight">
                    <input className="form-input" type="number" step="any" value={form.weight_value} onChange={e => set('weight_value', e.target.value)} />
                  </Field>
                  <Field label="Đơn vị" en="Unit">
                    <select className="form-select" value={form.weight_unit} onChange={e => set('weight_unit', e.target.value)}>
                      <option value="TONS">TONS</option>
                      <option value="KGS">KGS</option>
                    </select>
                  </Field>
                  <Field label="Số kiện" en="Pieces (LCL)">
                    <input className="form-input" type="number" value={form.so_kien} onChange={e => set('so_kien', e.target.value)} />
                  </Field>
                </div>
              </Section>

              <Section title="Thông tin xuất hóa đơn">
                <div className="form-grid-2">
                  <Field label="Tên công ty (xuất HĐ)" en="Company name" span={2}>
                    <input className="form-input" value={form.invoice_company_name}
                      placeholder="VD: CÔNG TY CỔ PHẦN ABC VIỆT NAM"
                      onChange={e => set('invoice_company_name', e.target.value)} />
                  </Field>
                  <Field label="MST" en="Tax code">
                    <input className="form-input" value={form.invoice_tax_code}
                      placeholder="0301234567"
                      onChange={e => set('invoice_tax_code', e.target.value)} />
                  </Field>
                  <Field label="Địa chỉ xuất HĐ" en="Invoice address">
                    <input className="form-input" value={form.invoice_address}
                      placeholder="Địa chỉ trên hóa đơn..."
                      onChange={e => set('invoice_address', e.target.value)} />
                  </Field>
                  <div style={{ gridColumn: 'span 2', marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer' }}
                      title="Tick để cập nhật thông tin xuất HĐ mặc định cho khách. Bỏ tick nếu chỉ override 1 lần cho lô này.">
                      <input type="checkbox" checked={!!form.save_as_default}
                        onChange={e => set('save_as_default', e.target.checked)}
                        style={{ marginTop: 2, flexShrink: 0 }} />
                      <span>Lưu làm thông tin xuất hóa đơn mặc định cho khách hàng này (lần sau tự động fill)</span>
                    </label>
                  </div>
                </div>
              </Section>

              <Section title="Giao hàng">
                <div className="form-grid-2">
                  <Field label="Công ty nhận" en="Company" span={2}>
                    <input className="form-input" value={form.delivery_company} onChange={e => set('delivery_company', e.target.value)} />
                  </Field>
                  <Field label="Địa chỉ trả hàng" en="Delivery Address" span={2}>
                    <div style={{ position: 'relative' }}>
                      <input
                        className="form-input"
                        value={form.delivery_address}
                        onChange={e => { set('delivery_address', e.target.value); setShowSuggestions(true); }}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                      />
                      {showSuggestions && past.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid var(--border)', borderRadius: 6, zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 180, overflowY: 'auto', marginTop: 2 }}>
                          <div style={{ padding: '6px 10px', fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>Lịch sử</div>
                          {past.map((loc, i) => (
                            <div key={i}
                              onMouseDown={() => { set('delivery_address', loc); setShowSuggestions(false); }}
                              style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, borderBottom: i === past.length - 1 ? 'none' : '1px solid var(--border)' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                              onMouseLeave={e => e.currentTarget.style.background = ''}>
                              {loc}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Field>
                  <Field label="Tên người nhận + SĐT" en="Recipient + Phone" span={2}>
                    <input className="form-input" placeholder="VD: 08h. SDT NHUNG" value={form.recipient_name} onChange={e => set('recipient_name', e.target.value)} />
                  </Field>
                  <Field label="Giờ trả hàng" en="Time">
                    <input className="form-input" type="time" value={form.delivery_time} onChange={e => set('delivery_time', e.target.value)} />
                  </Field>
                  <Field label="Ngày giao" en="Date">
                    <input className="form-input" value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
                  </Field>
                  <Field label="Ghi chú" en="Remarks" span={2}>
                    <textarea className="form-textarea" rows={2} value={form.remarks} onChange={e => set('remarks', e.target.value)} />
                  </Field>
                </div>
              </Section>

              {submitErr && <div style={{ padding: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{submitErr}</div>}
            </>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={handleExport} disabled={submitting || !form}>
            {submitting ? 'Đang xuất...' : 'Xuất PDF'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
