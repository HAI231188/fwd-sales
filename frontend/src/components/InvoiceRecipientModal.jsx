import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useModalZIndex } from '../hooks/useModalZIndex';

// Phase 5 Step 3 Part 2 CP3.5b — Invoice recipient picker.
//
// Opens before the actual send-mail call. Lets DD choose whether the
// "Thông tin xuất hóa đơn nâng hạ" block in the email body reflects:
//   1. The customer (default — pulled from customer_pipeline via job)
//   2. SLB Logistics (the forwarder issues the lift invoice itself)
//   3. A custom value (DD types Tên / MST / Địa chỉ manually)
//
// On confirm the parent (TruckPlanningModal) receives a fully-formed
// {type, company, tax, address} object matching the backend's
// INVOICE_TYPES whitelist and ships it via POST /api/email/send-planning.

// CP4.2.2 — English variant. The BBBG PDF is signed by the customer and is
// an international document; the mail body needs Vietnamese. Frontend ships
// these EN strings on the wire — backend overrides to VN when rendering the
// mail body (`type==='slb'` switch in email-sender.js renderBody). The PDF
// renderer overrides to EN too (defense in depth — values match either way).
const SLB = {
  type: 'slb',
  company: 'SLB GLOBAL LOGISTICS COMPANY LIMITED',
  tax: '0201743661',
  address: '8th Floor, Diamond Building, No 7 Lot 8A Le Hong Phong, Ngo Quyen, Hai Phong, Viet Nam',
};

// CP4.3.1 — when `bookings` is supplied (mail-send flow from
// TruckPlanningModal), the modal renders an "Đính kèm BBBG PDF" checkbox.
// Smart default: ON when every booking has receiver_name + receiver_phone +
// delivery_location + planned_datetime; OFF when any field is missing. The
// BBBG-preview flow doesn't pass bookings → checkbox hidden.
export default function InvoiceRecipientModal({ isOpen, customer, bookings, onClose, onConfirm }) {
  const zIndex = useModalZIndex();
  const [selected, setSelected] = useState('customer');
  const [customCompany, setCustomCompany] = useState('');
  const [customTax, setCustomTax] = useState('');
  const [customAddress, setCustomAddress] = useState('');
  // attachBbbg lives in state because the user can override the smart default.
  // userTouchedAttach tracks whether the user has clicked the checkbox; if
  // not, re-opening the modal recomputes the smart default. Once clicked,
  // the user's choice sticks for the rest of this modal session.
  const [attachBbbg, setAttachBbbg] = useState(true);
  const [userTouchedAttach, setUserTouchedAttach] = useState(false);

  const showAttachToggle = Array.isArray(bookings) && bookings.length > 0;
  const allComplete = useMemo(() => {
    if (!showAttachToggle) return true;
    return bookings.every(b =>
      b.receiver_name && b.receiver_phone && b.delivery_location && b.planned_datetime
    );
  }, [showAttachToggle, bookings]);

  // Reset attach decision when the modal opens (new send session).
  useEffect(() => {
    if (!isOpen) return;
    if (showAttachToggle) {
      setAttachBbbg(allComplete);
      setUserTouchedAttach(false);
    }
  }, [isOpen, showAttachToggle, allComplete]);

  // Customer info from job (post-LATERAL JOIN to customer_pipeline).
  const cust = customer || {};
  const custCompany = (cust.invoice_company || cust.name || '').trim();
  const custTax = (cust.invoice_tax || '').trim();
  const custAddress = (cust.invoice_address || '').trim();
  const customerHasInfo = !!(custCompany && custTax && custAddress);

  // Validation for the primary CTA. If 'Khác', all three fields must be
  // filled. If 'Khách hàng' but customer info incomplete, the button is
  // disabled and a warning row appears below the radio.
  const canConfirm = useMemo(() => {
    if (selected === 'customer') return customerHasInfo;
    if (selected === 'slb') return true;
    return !!(customCompany.trim() && customTax.trim() && customAddress.trim());
  }, [selected, customerHasInfo, customCompany, customTax, customAddress]);

  function handleConfirm() {
    let payload;
    if (selected === 'customer') {
      if (!customerHasInfo) return;
      payload = { type: 'customer', company: custCompany, tax: custTax, address: custAddress };
    } else if (selected === 'slb') {
      payload = { ...SLB };
    } else {
      payload = {
        type: 'custom',
        company: customCompany.trim(),
        tax: customTax.trim(),
        address: customAddress.trim(),
      };
    }
    // CP4.3.1 — onConfirm signature is (invoiceInfo, attachBbbg). Callers
    // that don't pass `bookings` get attachBbbg=true here (backwards compat
    // with the BBBG-preview flow, which ignores the second arg anyway).
    onConfirm?.(payload, attachBbbg);
  }

  if (!isOpen) return null;

  const lblStyle = { display: 'block', fontSize: 12, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 };
  const optStyle = (active) => ({
    padding: 12, border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
    borderRadius: 8, marginBottom: 8, cursor: 'pointer', display: 'block',
    background: active ? 'rgba(34,197,94,0.04)' : '#fff',
  });

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Thông tin xuất hóa đơn nâng hạ</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16, overflowY: 'auto' }}>
          {/* Option 1: Khách hàng */}
          <label style={optStyle(selected === 'customer')}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input type="radio" name="invrecip" value="customer"
                checked={selected === 'customer'}
                onChange={() => setSelected('customer')}
                style={{ marginTop: 3 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Khách hàng</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                  <div><strong>{custCompany || <em style={{ color: 'var(--text-3)' }}>—</em>}</strong></div>
                  <div>MST: {custTax || <em style={{ color: 'var(--text-3)' }}>—</em>}</div>
                  <div>Địa chỉ: {custAddress || <em style={{ color: 'var(--text-3)' }}>—</em>}</div>
                </div>
              </div>
            </div>
          </label>

          {selected === 'customer' && !customerHasInfo && (
            <div style={{ padding: 10, background: 'rgba(217,119,6,0.10)',
              border: '1px solid rgba(217,119,6,0.3)', borderRadius: 6,
              color: 'var(--warning)', fontSize: 12, marginBottom: 8 }}>
              ⚠️ Khách hàng chưa có thông tin xuất hóa đơn (Tên / MST / Địa chỉ).
              Vui lòng chọn <strong>SLB Logistics</strong> hoặc nhập thủ công bằng tay.
            </div>
          )}

          {/* Option 2: SLB */}
          <label style={optStyle(selected === 'slb')}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input type="radio" name="invrecip" value="slb"
                checked={selected === 'slb'}
                onChange={() => setSelected('slb')}
                style={{ marginTop: 3 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>SLB Logistics</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                  <div><strong>{SLB.company}</strong></div>
                  <div>MST: {SLB.tax}</div>
                  <div>Địa chỉ: {SLB.address}</div>
                </div>
              </div>
            </div>
          </label>

          {/* Option 3: Khác (manual) */}
          <label style={optStyle(selected === 'custom')}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <input type="radio" name="invrecip" value="custom"
                checked={selected === 'custom'}
                onChange={() => setSelected('custom')}
                style={{ marginTop: 3 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
                  Khác (nhập thủ công)
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={lblStyle}>Tên công ty</label>
                  <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    disabled={selected !== 'custom'}
                    value={customCompany}
                    onChange={e => setCustomCompany(e.target.value)}
                    placeholder="VD: Công ty TNHH ABC" />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <label style={lblStyle}>MST</label>
                  <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    disabled={selected !== 'custom'}
                    value={customTax}
                    onChange={e => setCustomTax(e.target.value)}
                    placeholder="VD: 0123456789" />
                </div>
                <div>
                  <label style={lblStyle}>Địa chỉ</label>
                  <input className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    disabled={selected !== 'custom'}
                    value={customAddress}
                    onChange={e => setCustomAddress(e.target.value)}
                    placeholder="VD: 123 Đường XYZ, Quận 1, TP. Hồ Chí Minh" />
                </div>
              </div>
            </div>
          </label>

          {/* CP4.3.1 — BBBG attach toggle. Rendered only when the parent
              passes a `bookings` array (mail-send flow). Smart default ON if
              every booking has receiver_name + receiver_phone + delivery_location
              + planned_datetime; OFF otherwise. User can override either way. */}
          {showAttachToggle && (
            <div style={{ marginTop: 16, padding: 12, background: '#f9fafb',
              border: '1px solid var(--border)', borderRadius: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', fontSize: 14, fontWeight: 500 }}>
                <input type="checkbox" checked={attachBbbg}
                  onChange={e => { setAttachBbbg(e.target.checked); setUserTouchedAttach(true); }} />
                <span>📎 Đính kèm BBBG PDF ({bookings.length} file, mỗi container 1 file)</span>
              </label>
              {!allComplete && !attachBbbg && !userTouchedAttach && (
                <div style={{ marginTop: 8, fontSize: 13, color: '#dc2626' }}>
                  ⚠️ Một số container thiếu thông tin (người liên hệ tại kho, địa điểm).
                  BBBG có thể không đầy đủ — đã tự động tắt đính kèm.
                </div>
              )}
              {!allComplete && attachBbbg && (
                <div style={{ marginTop: 8, fontSize: 13, color: '#ea580c' }}>
                  ℹ️ Một số container thiếu thông tin nhưng vẫn đính kèm BBBG theo lựa chọn của bạn.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={handleConfirm} disabled={!canConfirm}>
            Tiếp tục → Gửi mail
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
