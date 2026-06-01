import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getLogStaff, updateCustomerPipeline } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';
import { fmtDateTimeYear as fmtDt } from '../utils/dateFmt';

// Edit modal for one customer_pipeline row (Data khách hàng).
// Editable fields: company_name, company_full_name, tax_code, invoice_address, sales_id.
// Read-only: stage, created_at, updated_at, job_count.
// If sales_id changes the L14 transfer confirm modal appears before save.

const STAGE_LABEL = {
  new: 'Mới', following: 'Đang follow', dormant: 'Dormant', booked: 'Booked',
};
const STAGE_COLOR = {
  new: 'var(--info)', following: 'var(--primary)',
  dormant: 'var(--text-2)', booked: 'var(--purple)',
};


export default function CustomerEditModal({ pipeline, onClose, onSaved }) {
  const zIndex = useModalZIndex();
  const { data: staff = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });
  const salesStaff = staff.filter(s => s.role === 'sales' || s.role === 'lead');

  const [form, setForm] = useState({
    company_name:      pipeline?.company_name      || '',
    company_full_name: pipeline?.company_full_name || '',
    tax_code:          pipeline?.tax_code          || '',
    invoice_address:   pipeline?.invoice_address   || '',
    sales_id:          pipeline?.sales_id ? String(pipeline.sales_id) : '',
  });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);

  // Keep local state in sync if the parent passes a different pipeline row in.
  useEffect(() => {
    if (!pipeline) return;
    setForm({
      company_name:      pipeline.company_name      || '',
      company_full_name: pipeline.company_full_name || '',
      tax_code:          pipeline.tax_code          || '',
      invoice_address:   pipeline.invoice_address   || '',
      sales_id:          pipeline.sales_id ? String(pipeline.sales_id) : '',
    });
  }, [pipeline?.id]);

  if (!pipeline) return null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isSalesChange = Number(form.sales_id) !== Number(pipeline.sales_id);

  async function submit({ confirmedTransfer = false } = {}) {
    setErr('');
    const missing = !form.company_name.trim() || !form.company_full_name.trim()
                 || !form.tax_code.trim()     || !form.invoice_address.trim()
                 || !form.sales_id;
    if (missing) {
      setErr('Vui lòng nhập đủ thông tin (Tên, Tên công ty, MST, Địa chỉ HĐ, Sales)');
      return;
    }
    if (isSalesChange && !confirmedTransfer) {
      setShowTransferConfirm(true);
      return;
    }

    setSaving(true);
    try {
      const body = {
        company_name:      form.company_name.trim(),
        company_full_name: form.company_full_name.trim(),
        tax_code:          form.tax_code.trim(),
        invoice_address:   form.invoice_address.trim(),
      };
      if (isSalesChange) body.sales_id = Number(form.sales_id);

      const res = await updateCustomerPipeline(pipeline.id, body);
      toast.success(res?.transferred ? 'Đã chuyển khách sang sales mới' : 'Đã cập nhật');
      onSaved?.(res);
      onClose?.();
    } catch (e) {
      setErr(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  const labelStyle = { fontSize: 12, color: 'var(--text-2)', fontWeight: 600 };

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Sửa khách hàng</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16 }}>
          {/* Read-only metadata */}
          <div className="card" style={{ padding: 10, marginBottom: 14, background: 'var(--bg)', display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <div style={labelStyle}>Stage</div>
              <div style={{ marginTop: 2 }}>
                <span style={{ background: 'rgba(0,0,0,0.04)', color: STAGE_COLOR[pipeline.stage] || 'var(--text)',
                  borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600 }}>
                  {STAGE_LABEL[pipeline.stage] || pipeline.stage}
                </span>
                <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
                  Stage tự động cập nhật theo workflow
                </span>
              </div>
            </div>
            <div>
              <div style={labelStyle}>Tạo lúc</div>
              <div style={{ marginTop: 2, fontSize: 12 }}>{fmtDt(pipeline.created_at)}</div>
            </div>
            <div>
              <div style={labelStyle}>Cập nhật</div>
              <div style={{ marginTop: 2, fontSize: 12 }}>{fmtDt(pipeline.updated_at)}</div>
            </div>
            {typeof pipeline.job_count === 'number' && (
              <div>
                <div style={labelStyle}>Số job đã chạy</div>
                <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600,
                  color: pipeline.job_count > 0 ? 'var(--info)' : 'var(--text-3)' }}>
                  {pipeline.job_count}
                </div>
              </div>
            )}
          </div>

          {/* Editable fields */}
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Tên khách hàng (nội bộ) *</label>
            <input className="form-input" value={form.company_name}
              onChange={e => set('company_name', e.target.value)}
              placeholder="Tên ngắn gọn dùng trong hệ thống" />
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Tên công ty (xuất HĐ) *</label>
            <input className="form-input" value={form.company_full_name}
              onChange={e => set('company_full_name', e.target.value)}
              placeholder="VD: CÔNG TY CỔ PHẦN ABC VIỆT NAM" />
          </div>
          <div className="grid-2" style={{ gap: 12, marginBottom: 10 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">MST *</label>
              <input className="form-input" value={form.tax_code}
                onChange={e => set('tax_code', e.target.value)} placeholder="0301234567" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Sales phụ trách *</label>
              <select className="form-select" value={form.sales_id}
                onChange={e => set('sales_id', e.target.value)}>
                <option value="">— Chọn —</option>
                {salesStaff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.role === 'lead' ? ' (Lead)' : ''}
                  </option>
                ))}
              </select>
              {isSalesChange && (
                <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4 }}>
                  ⚠ Đổi sales sẽ kích hoạt L14 transfer
                </div>
              )}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Địa chỉ xuất HĐ *</label>
            <input className="form-input" value={form.invoice_address}
              onChange={e => set('invoice_address', e.target.value)}
              placeholder="Địa chỉ ghi trên hóa đơn..." />
          </div>

          {err && (
            <div style={{ marginTop: 12, padding: 10, background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
              color: 'var(--danger)', fontSize: 13 }}>
              {err}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={() => submit()} disabled={saving}>
            {saving ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </div>

      {/* L14 sales-transfer confirmation */}
      {showTransferConfirm && (
        <div className="modal-overlay" style={{ zIndex: zIndex + 1 }}
          onClick={e => { if (e.target === e.currentTarget) setShowTransferConfirm(false); }}>
          <div className="modal" style={{ maxWidth: 480, width: '95%' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: 16 }}>Chuyển khách sang sales khác</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setShowTransferConfirm(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 16, fontSize: 13, lineHeight: 1.5 }}>
              <p>
                Khách <strong>{form.company_name}</strong> hiện thuộc pipeline của{' '}
                <strong>{pipeline.sales_name || 'sales hiện tại'}</strong>.
              </p>
              <p style={{ color: 'var(--danger)', marginTop: 10 }}>
                Đổi sales sẽ chuyển khách sang pipeline của{' '}
                <strong>{salesStaff.find(s => Number(s.id) === Number(form.sales_id))?.name || 'sales mới'}</strong>{' '}
                và <strong>xóa lịch sử pipeline hiện tại</strong> (bao gồm các tương tác đã ghi nhận). Hành động này không thể hoàn tác.
              </p>
              <p style={{ marginTop: 10 }}>Xác nhận?</p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTransferConfirm(false)} disabled={saving}>Hủy</button>
              <button className="btn btn-danger btn-sm"
                disabled={saving}
                onClick={() => { setShowTransferConfirm(false); submit({ confirmedTransfer: true }); }}>
                {saving ? 'Đang lưu...' : 'Chuyển khách'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ), document.body);
}
