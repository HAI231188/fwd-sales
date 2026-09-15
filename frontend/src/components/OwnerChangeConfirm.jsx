// Confirm dialog for a job save that would move a customer to another sales
// user. Driven by the server's 409 OWNER_CHANGE_CONFIRM_REQUIRED body
// ({ customer_name, current_owners[], new_owner }), so it fires on every owner
// change — a search pick, a typed name, or a sales edit on an existing job.
export default function OwnerChangeConfirm({ info, zIndex, saving, onCancel, onConfirm }) {
  const owners = (info.current_owners || []).map(o => o.name || '—').join(', ') || 'sales khác';
  return (
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" style={{ maxWidth: 480, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Chuyển khách sang sales khác</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16, fontSize: 13, lineHeight: 1.5 }}>
          <p>
            Khách hàng <strong>{info.customer_name}</strong> hiện thuộc pipeline của <strong>{owners}</strong>.
          </p>
          <p style={{ marginTop: 10 }}>
            Lưu job này sẽ chuyển khách sang <strong>{info.new_owner?.name || 'sales mới'}</strong>.
            Lịch sử tương tác, báo giá và pipeline của khách được giữ nguyên và chuyển theo khách;
            các job cũ vẫn giữ sales đã làm.
          </p>
          <p style={{ marginTop: 10 }}>Xác nhận?</p>
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={onConfirm} disabled={saving}>
            {saving ? 'Đang lưu...' : 'Chuyển khách'}
          </button>
        </div>
      </div>
    </div>
  );
}
