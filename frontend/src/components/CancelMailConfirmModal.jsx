import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useModalZIndex } from '../hooks/useModalZIndex';

// CP5.2 — Confirms a HỦY-mail send for one (job, transport). DD must see what
// the carrier will be asked to drop before firing the destructive action.
//
// Props:
//   isOpen        — bool
//   onClose       — () => void
//   transport     — { name, transport_company_id }
//   bookings      — bookings_snapshot from email_history.last_sent_data
//                   (array of { booking_code, cont_number, cont_type,
//                   planned_datetime, delivery_location })
//   onConfirm     — async ({ reason }) => void — parent fires the POST and
//                   handles success/error toasts + query invalidation.

function fmtDt(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CancelMailConfirmModal({ isOpen, onClose, transport, bookings, onConfirm }) {
  const zIndex = useModalZIndex();
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setSending(false);
  }, [isOpen, transport?.transport_company_id]);

  async function handleConfirm() {
    if (sending) return;
    setSending(true);
    try {
      await onConfirm?.({ reason: reason.trim() || null });
    } finally {
      setSending(false);
    }
  }

  if (!isOpen) return null;

  const tName = transport?.name || '—';
  const list = Array.isArray(bookings) ? bookings : [];

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={{ maxWidth: 560, maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Xác nhận gửi mail HỦY</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} disabled={sending}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16, overflowY: 'auto' }}>
          <div style={{ padding: 10, background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
            color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
            ⚠️ Hành động này sẽ gửi mail HỦY cho <strong>{tName}</strong> về các cont sau:
          </div>

          <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
            {list.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13, fontStyle: 'italic' }}>
                (Không tìm thấy snapshot bookings — mail HỦY vẫn gửi được, nội dung sẽ ít chi tiết)
              </div>
            ) : list.map((b, i) => (
              <div key={b.id || i} style={{
                padding: '8px 10px', fontSize: 12,
                borderBottom: i < list.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ background: 'var(--primary-dim)', color: 'var(--primary)',
                    padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                    fontFamily: 'var(--font-display)', fontSize: 10 }}>
                    {b.booking_code || '—'}
                  </span>
                  <strong style={{ fontSize: 12 }}>{b.cont_number || '(chưa số)'}</strong>
                  <span style={{ color: 'var(--text-2)' }}>({b.cont_type || '—'})</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                  {fmtDt(b.planned_datetime)} — {b.delivery_location || '—'}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
              color: 'var(--text-2)', marginBottom: 4 }}>
              Lý do hủy (tùy chọn)
            </label>
            <textarea
              style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
                borderRadius: 6, fontSize: 13, boxSizing: 'border-box',
                minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="VD: Khách yêu cầu dời ngày giao, hoặc kế hoạch thay đổi…"
              value={reason}
              onChange={e => setReason(e.target.value)}
              disabled={sending}
            />
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-2)',
            padding: '8px 10px', background: 'var(--bg)', borderRadius: 6,
            border: '1px solid var(--border)' }}>
            ℹ️ Sau khi gửi HỦY, bạn có thể gửi mail kế hoạch MỚI (nếu có) bằng nút "📧 Gửi MỚI" trên thẻ vận tải.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={sending}>
            Hủy bỏ
          </button>
          <button className="btn btn-sm" onClick={handleConfirm} disabled={sending}
            style={{ background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}>
            {sending ? '⏳ Đang gửi...' : '🚫 Xác nhận gửi HỦY'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
