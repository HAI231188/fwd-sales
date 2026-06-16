import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getPastReceivers } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

// Phase 5 Step 3 Part 2 CP4.1 — "Người liên hệ tại kho + Ghi chú BBBG".
//
// Small per-booking modal. Captures the warehouse contact (name + phone) the
// driver should reach on arrival, plus a driver-only note that prints in BBBG
// but does NOT bleed into the planning email body (which carries the existing
// `note` field). Fields are all optional — the user can save with any subset.
//
// "Remembered contacts" autocomplete (modeled on the delivery-location
// autocomplete in PlanDeliveryModal): on open we fetch the FULL list of
// receivers previously used for the SAME customer (GET /jobs/:id/past-receivers).
// A customer can have several receivers at different warehouses, so each
// suggestion row shows the contact WITH its delivery_location so they can be
// told apart. Picking a row fills receiver_name + receiver_phone together; it
// never touches delivery_location (that field has its own autocomplete).
// Additive + graceful degrade — if the fetch fails the fields stay plain inputs.
//
// Props:
//   isOpen    — bool
//   onClose   — () => void
//   jobId     — number | undefined  (powers the receiver autocomplete)
//   booking   — { id, booking_code, receiver_name, receiver_phone, bbbg_note }
//   onSave    — (data) => void  with data = { receiver_name, receiver_phone, bbbg_note }
//
// The parent owns the PATCH call + query invalidation. We just return the
// trimmed form payload and let onSave decide what to do with it.

export default function ReceiverInfoModal({ isOpen, onClose, jobId, booking, onSave }) {
  const zIndex = useModalZIndex();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Which contact field is focused → controls the shared suggestion dropdown.
  const [focusedField, setFocusedField] = useState(null); // 'name' | 'phone' | null

  // Sync inputs whenever the modal opens against a (possibly different) booking.
  useEffect(() => {
    if (!isOpen) return;
    setName(booking?.receiver_name || '');
    setPhone(booking?.receiver_phone || '');
    setNote(booking?.bbbg_note || '');
  }, [isOpen, booking?.id, booking?.receiver_name, booking?.receiver_phone, booking?.bbbg_note]);

  // Remembered receivers for this customer (full list, each with its location).
  // Graceful degrade: on error `data` stays [] and the fields are plain inputs.
  const { data: pastReceivers = [] } = useQuery({
    queryKey: ['past-receivers', jobId],
    queryFn: () => getPastReceivers(jobId),
    enabled: !!jobId && isOpen,
  });

  // Filter-as-you-type against the FOCUSED field's value (mirror the location
  // field). Match name OR phone OR location so typing any part narrows the list.
  const filtered = useMemo(() => {
    const q = (focusedField === 'phone' ? phone : name).trim().toLowerCase();
    const list = Array.isArray(pastReceivers) ? pastReceivers : [];
    if (!q) return list;
    return list.filter(r =>
      `${r.receiver_name || ''} ${r.receiver_phone || ''} ${r.delivery_location || ''}`
        .toLowerCase().includes(q)
    );
  }, [pastReceivers, focusedField, name, phone]);

  function pickReceiver(r) {
    // Fill BOTH contact fields together; never touch delivery_location.
    setName(r.receiver_name || '');
    setPhone(r.receiver_phone || '');
    setFocusedField(null);
  }

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
  // Mirror the PlanDeliveryModal location-autocomplete dropdown styling.
  const dropdownStyle = {
    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
    background: '#fff', border: '1px solid var(--border)', borderRadius: 6,
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 200, overflowY: 'auto',
  };
  const rowStyle = {
    padding: '8px 12px', cursor: 'pointer', fontSize: 13,
    borderBottom: '1px solid var(--border)',
  };

  const showSuggest = !!focusedField && filtered.length > 0;
  // Shared renderer — same list under whichever field is focused.
  const suggestionList = showSuggest ? (
    <div style={dropdownStyle}>
      {filtered.map((r, i) => (
        <div key={i}
          onMouseDown={() => pickReceiver(r)}
          style={rowStyle}>
          <span style={{ fontWeight: 600 }}>{r.receiver_name || '(chưa có tên)'}</span>
          {r.receiver_phone ? <span style={{ color: 'var(--text-2)' }}> — {r.receiver_phone}</span> : null}
          {r.delivery_location
            ? <span style={{ color: 'var(--text-3)' }}> — {r.delivery_location}</span>
            : null}
        </div>
      ))}
    </div>
  ) : null;

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
          <div style={{ marginBottom: 14, position: 'relative' }}>
            <label style={labelStyle}>Tên người liên hệ tại kho</label>
            <input type="text" style={inputStyle}
              placeholder="VD: Mr Hùng"
              value={name}
              onChange={e => { setName(e.target.value); setFocusedField('name'); }}
              onFocus={() => setFocusedField('name')}
              onBlur={() => setTimeout(() => setFocusedField(f => f === 'name' ? null : f), 200)} />
            {focusedField === 'name' && suggestionList}
          </div>

          <div style={{ marginBottom: 14, position: 'relative' }}>
            <label style={labelStyle}>SĐT người liên hệ</label>
            <input type="tel" style={inputStyle}
              placeholder="VD: 0901234567"
              value={phone}
              onChange={e => { setPhone(e.target.value); setFocusedField('phone'); }}
              onFocus={() => setFocusedField('phone')}
              onBlur={() => setTimeout(() => setFocusedField(f => f === 'phone' ? null : f), 200)} />
            {focusedField === 'phone' && suggestionList}
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
