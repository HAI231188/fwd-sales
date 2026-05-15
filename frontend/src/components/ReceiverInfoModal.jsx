import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useModalZIndex } from '../hooks/useModalZIndex';

// Phase 5 Step 3 Part 2 CP4.1 — "Người liên hệ tại kho + Ghi chú BBBG".
//
// Small per-booking modal. Captures the warehouse contact (name + phone) the
// driver should reach on arrival, plus a driver-only note that prints in BBBG
// but does NOT bleed into the planning email body (which carries the existing
// `note` field). Fields are all optional — the user can save with any subset.
//
// Props:
//   isOpen    — bool
//   onClose   — () => void
//   booking   — { id, booking_code, receiver_name, receiver_phone, bbbg_note }
//   onSave    — (data) => void  with data = { receiver_name, receiver_phone, bbbg_note }
//
// The parent owns the PATCH call + query invalidation. We just return the
// trimmed form payload and let onSave decide what to do with it.

export default function ReceiverInfoModal({ isOpen, onClose, booking, onSave }) {
  const zIndex = useModalZIndex();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync inputs whenever the modal opens against a (possibly different) booking.
  useEffect(() => {
    if (!isOpen) return;
    setName(booking?.receiver_name || '');
    setPhone(booking?.receiver_phone || '');
    setNote(booking?.bbbg_note || '');
  }, [isOpen, booking?.id, booking?.receiver_name, booking?.receiver_phone, booking?.bbbg_note]);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    try {
      await onSave?.({
        receiver_name:  name.trim()  || null,
        receiver_phone: phone.trim() || null,
        bbbg_note:      note.trim()  || null,
      });
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  const code = booking?.booking_code || (booking?.id ? `#${booking.id}` : '');
  const inputStyle = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
    borderRadius: 6, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
  };
  const labelStyle = {
    display: 'block', fontSize: 12, color: 'var(--text-2)',
    marginBottom: 4, fontWeight: 600,
  };

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={{ maxWidth: 520, maxHeight: '90vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>
            Người liên hệ tại kho + Ghi chú BBBG{code ? ` — ${code}` : ''}
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Tên người liên hệ tại kho</label>
            <input type="text" style={inputStyle}
              placeholder="VD: Mr Hùng"
              value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>SĐT người liên hệ</label>
            <input type="tel" style={inputStyle}
              placeholder="VD: 0901234567"
              value={phone} onChange={e => setPhone(e.target.value)} />
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Ghi chú cho tài xế (in trong BBBG)</label>
            <textarea style={{ ...inputStyle, minHeight: 84, resize: 'vertical' }}
              placeholder="VD: Gọi trước 30 phút, vào cổng B"
              value={note} onChange={e => setNote(e.target.value)} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-2)',
            padding: '8px 10px', background: 'var(--bg)', borderRadius: 6,
            border: '1px solid var(--border)' }}>
            ℹ️ Ghi chú này chỉ in trong BBBG, KHÔNG gửi qua mail cho vận tải.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            Hủy
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Đang lưu...' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
