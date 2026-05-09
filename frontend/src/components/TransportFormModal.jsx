import { useState } from 'react';
import { createPortal } from 'react-dom';
import { createTransportCompany, updateTransportCompany } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

const EMPTY = {
  name: '', tax_code: '', address: '',
  email: '', phone: '', contact_person: '', notes: '',
};

// initialName: pre-fill the name field (used when opened from "+ Thêm vận tải mới")
// existing: full transport_company row when editing; null when creating
// onSaved(savedRecord): called after successful POST/PATCH so caller can auto-select
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function TransportFormModal({ initialName = '', existing = null, onClose, onSaved }) {
  const zIndex = useModalZIndex();
  const isEdit = !!existing;
  const [form, setForm] = useState(() => existing
    ? { ...EMPTY, ...existing }
    : { ...EMPTY, name: initialName });
  // L16 — email_cc rows. Allow empty strings while editing (so user can keep typing
  // before validation kicks in). On submit, filter empties + validate each.
  const [cc, setCc] = useState(() => Array.isArray(existing?.email_cc) ? [...existing.email_cc] : []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function setCcAt(i, v)   { setCc(arr => arr.map((x, idx) => idx === i ? v : x)); }
  function removeCcAt(i)   { setCc(arr => arr.filter((_, idx) => idx !== i)); }
  function addCcRow()      { setCc(arr => [...arr, '']); }

  async function submit() {
    setErr('');
    if (!form.name.trim()) { setErr('Tên vận tải là bắt buộc'); return; }
    if (form.email && !EMAIL_RE.test(form.email)) {
      setErr('Email không hợp lệ'); return;
    }
    // email_cc validation — drop empties, then check each
    const cleanedCc = cc.map(e => (e || '').trim()).filter(e => e.length > 0);
    for (const e of cleanedCc) {
      if (!EMAIL_RE.test(e)) { setErr(`Email không hợp lệ: ${e}`); return; }
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        tax_code: form.tax_code?.trim() || null,
        address:  form.address?.trim()  || null,
        email:    form.email?.trim()    || null,
        phone:    form.phone?.trim()    || null,
        contact_person: form.contact_person?.trim() || null,
        notes:    form.notes?.trim()    || null,
        email_cc: cleanedCc,
      };
      const saved = isEdit
        ? await updateTransportCompany(existing.id, payload)
        : await createTransportCompany(payload);
      if (onSaved) onSaved(saved);
      onClose();
    } catch (e) {
      setErr(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 540, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>{isEdit ? 'Sửa vận tải' : 'Thêm vận tải mới'}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16 }}>
          <div className="form-group">
            <label className="form-label">Tên vận tải *</label>
            <input className="form-input" autoFocus value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="grid-2" style={{ gap: 10 }}>
            <div className="form-group">
              <label className="form-label">MST</label>
              <input className="form-input" value={form.tax_code} onChange={e => set('tax_code', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Số điện thoại</label>
              <input className="form-input" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Người liên hệ</label>
            <input className="form-input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Địa chỉ</label>
            <input className="form-input" value={form.address} onChange={e => set('address', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Email CC</label>
            {cc.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 6 }}>Chưa có email CC nào.</div>
            )}
            {cc.map((value, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  className="form-input"
                  type="email"
                  placeholder={`email${i + 1}@example.com`}
                  value={value}
                  onChange={e => setCcAt(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  title="Xóa email này"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => removeCcAt(i)}
                  type="button"
                >🗑</button>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 12, marginTop: 2 }}
              onClick={addCcRow}
              type="button"
            >+ Thêm email CC</button>
          </div>
          <div className="form-group">
            <label className="form-label">Ghi chú</label>
            <textarea className="form-textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          {err && (
            <div style={{ padding: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: 'var(--danger)', fontSize: 13 }}>
              {err}
            </div>
          )}
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={saving || !form.name.trim()}>
            {saving ? 'Đang lưu...' : (isEdit ? 'Cập nhật' : 'Tạo mới')}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
