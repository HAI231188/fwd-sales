import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  createTruckBooking, updateTruckBooking,
  getAvailableContainers, getPastDeliveryLocations,
} from '../api';
import TransportPicker from './TransportPicker';
import DateTimeInput24h from './DateTimeInput24h';
import { useModalZIndex } from '../hooks/useModalZIndex';

// Create / edit one truck_booking.
// Props:
//   mode:     'create' | 'edit'
//   jobId:    int (required for both modes)
//   jobCode:  string (display only)
//   booking:  full booking row when mode==='edit'
//   onClose:  () => void
//   onSaved:  (result) => void

function toDatetimeLocal(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function BookingModal({ mode, jobId, jobCode, booking, onClose, onSaved }) {
  const zIndex = useModalZIndex();
  const isEdit = mode === 'edit';

  const [transport, setTransport] = useState(
    isEdit
      ? { transport_company_id: booking?.transport_company_id, transport_name: booking?.transport_name }
      : { transport_company_id: null, transport_name: null }
  );
  const [plannedDt, setPlannedDt] = useState(
    isEdit ? toDatetimeLocal(booking?.planned_datetime) : ''
  );
  const [actualDt, setActualDt] = useState(
    isEdit ? toDatetimeLocal(booking?.actual_datetime) : ''
  );
  const [pickupLoc, setPickupLoc] = useState(isEdit ? (booking?.pickup_location || '') : '');
  const [deliveryLoc, setDeliveryLoc] = useState(isEdit ? (booking?.delivery_location || '') : '');
  const [cost, setCost] = useState(isEdit && booking?.cost != null ? String(booking.cost) : '');
  const [vehicleNumber, setVehicleNumber] = useState(isEdit ? (booking?.vehicle_number || '') : '');
  const [notes, setNotes] = useState(isEdit ? (booking?.notes || '') : '');
  const [containerIds, setContainerIds] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [showLocList, setShowLocList] = useState(false);

  // Available containers — create mode only (edit shows the booking's own containers read-only).
  const { data: avail = [], isLoading: loadingAvail } = useQuery({
    queryKey: ['availableContainers', jobId],
    queryFn: () => getAvailableContainers(jobId),
    enabled: !isEdit && !!jobId,
  });

  // Past delivery locations for autocomplete (create mode only).
  const { data: pastLocs = [] } = useQuery({
    queryKey: ['pastDeliveryLocations', jobId],
    queryFn: () => getPastDeliveryLocations(jobId),
    enabled: !isEdit && !!jobId,
  });

  const filteredLocs = useMemo(() => {
    const q = deliveryLoc.trim().toLowerCase();
    if (!q) return pastLocs;
    return pastLocs.filter(s => s.toLowerCase().includes(q));
  }, [pastLocs, deliveryLoc]);

  function toggleContainer(id) {
    setContainerIds(cs => cs.includes(id) ? cs.filter(x => x !== id) : [...cs, id]);
  }

  async function submit() {
    setErr('');
    if (!transport.transport_company_id) { setErr('Vui lòng chọn vận tải'); return; }
    if (!plannedDt) { setErr('Vui lòng nhập ngày giờ giao'); return; }
    if (!deliveryLoc.trim()) { setErr('Vui lòng nhập địa điểm giao'); return; }
    if (!isEdit && containerIds.length === 0) { setErr('Vui lòng chọn ít nhất 1 cont'); return; }

    setSaving(true);
    try {
      if (isEdit) {
        const body = {
          transport_company_id: transport.transport_company_id,
          planned_datetime: plannedDt,
          actual_datetime: actualDt === '' ? null : actualDt,
          pickup_location: pickupLoc.trim() === '' ? null : pickupLoc.trim(),
          delivery_location: deliveryLoc.trim(),
          cost: cost === '' ? null : Number(cost),
          vehicle_number: vehicleNumber.trim() === '' ? null : vehicleNumber.trim(),
          notes: notes.trim() === '' ? null : notes.trim(),
        };
        const res = await updateTruckBooking(booking.id, body);
        toast.success('Đã cập nhật kế hoạch');
        onSaved?.(res);
        onClose?.();
      } else {
        const body = {
          job_id: jobId,
          transport_company_id: transport.transport_company_id,
          planned_datetime: plannedDt,
          actual_datetime: actualDt === '' ? null : actualDt,
          pickup_location: pickupLoc.trim() === '' ? null : pickupLoc.trim(),
          delivery_location: deliveryLoc.trim(),
          cost: cost === '' ? null : Number(cost),
          container_ids: containerIds,
          notes: notes.trim() === '' ? null : notes.trim(),
        };
        const res = await createTruckBooking(body);
        toast.success('Đã tạo kế hoạch');
        onSaved?.(res);
        onClose?.();
      }
    } catch (e) {
      setErr(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  const inp = { padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%', boxSizing: 'border-box' };
  const lbl = { fontSize: 12, color: 'var(--text-2)', marginBottom: 4, display: 'block', fontWeight: 600 };

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>
            {isEdit
              ? `Sửa kế hoạch — ${booking?.transport_name || ''}`
              : `Tạo kế hoạch giao xe — Job ${jobCode || `#${jobId}`}`}
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16, overflowY: 'auto' }}>
          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Vận tải *</label>
            <TransportPicker
              value={{ transport_company_id: transport.transport_company_id, transport_name: transport.transport_name }}
              onChange={v => setTransport({
                transport_company_id: v.transport_company_id,
                transport_name: v.transport_name,
              })}
              placeholder="Chọn vận tải..."
            />
          </div>

          <div className="form-grid-2" style={{ marginBottom: 12 }}>
            <div>
              <label style={lbl}>KH ngày giờ giao *</label>
              <DateTimeInput24h value={plannedDt} onChange={setPlannedDt} required />
            </div>
            <div>
              <label style={lbl}>TH ngày giờ giao (tuỳ chọn)</label>
              <DateTimeInput24h value={actualDt} onChange={setActualDt} />
            </div>
          </div>

          <div className="form-grid-2" style={{ marginBottom: 12 }}>
            <div>
              <label style={lbl}>Địa điểm lấy (tuỳ chọn)</label>
              <input style={inp} value={pickupLoc}
                onChange={e => setPickupLoc(e.target.value)}
                placeholder="VD: Cảng Cát Lái" />
            </div>
            <div>
              <label style={lbl}>Cước (tuỳ chọn)</label>
              <input type="number" style={inp}
                value={cost} onChange={e => setCost(e.target.value)} placeholder="Cước vận chuyển" />
            </div>
          </div>

          <div style={{ marginBottom: 12, position: 'relative' }}>
            <label style={lbl}>Địa điểm giao *</label>
            <input style={inp} value={deliveryLoc}
              onChange={e => { setDeliveryLoc(e.target.value); setShowLocList(true); }}
              onFocus={() => setShowLocList(true)}
              onBlur={() => setTimeout(() => setShowLocList(false), 200)}
              placeholder="VD: Kho ABC, Hà Nội" />
            {!isEdit && showLocList && filteredLocs.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                background: '#fff', border: '1px solid var(--border)', borderRadius: 6,
                boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 200, overflowY: 'auto' }}>
                {filteredLocs.map((loc, i) => (
                  <div key={i}
                    onMouseDown={() => { setDeliveryLoc(loc); setShowLocList(false); }}
                    style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
                    {loc}
                  </div>
                ))}
              </div>
            )}
          </div>

          {isEdit && (
            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Số xe (Vehicle number)</label>
              <input style={inp} value={vehicleNumber}
                onChange={e => setVehicleNumber(e.target.value)}
                placeholder="VD: 29C-12345" />
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                Khi nhập số xe lần đầu, hệ thống tự đánh dấu hoàn thành booking.
              </div>
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Ghi chú</label>
            <textarea rows={2} style={inp} value={notes}
              onChange={e => setNotes(e.target.value)} placeholder="Ghi chú nội bộ..." />
          </div>

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
            <label style={lbl}>
              {isEdit ? 'Containers (chỉ xem — xóa booking để gán lại)' : 'Chọn cont cho kế hoạch này *'}
            </label>
            {isEdit ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(booking?.containers || []).map(c => (
                  <div key={c.id} style={{ padding: '6px 10px', fontSize: 13, background: 'var(--bg)', borderRadius: 6 }}>
                    <strong>{c.cont_number || `(${c.cont_type} chưa nhập số)`}</strong>
                    {' '}<span style={{ color: 'var(--text-2)' }}>({c.cont_type}{c.seal_number ? `, seal ${c.seal_number}` : ''})</span>
                  </div>
                ))}
                {(!booking?.containers || booking.containers.length === 0) && (
                  <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Booking này chưa có cont.</div>
                )}
              </div>
            ) : loadingAvail ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>Đang tải containers...</div>
            ) : avail.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>
                Không có container nào còn rảnh để gán. Tất cả container của job đã được đặt xe.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                {avail.map(c => {
                  const checked = containerIds.includes(c.id);
                  return (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                      cursor: 'pointer', fontSize: 13, borderRadius: 4,
                      background: checked ? 'rgba(34,197,94,0.08)' : 'transparent' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleContainer(c.id)} />
                      <span style={{ fontWeight: 600 }}>{c.cont_number || `(${c.cont_type} chưa nhập số)`}</span>
                      <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
                        {c.cont_type}{c.seal_number ? ` · seal ${c.seal_number}` : ''}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {!isEdit && (
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
                Đã chọn: <strong>{containerIds.length}</strong> / {avail.length} container
              </div>
            )}
          </div>

          {err && (
            <div style={{ marginTop: 12, padding: 10, background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
              color: 'var(--danger)', fontSize: 13 }}>{err}</div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={saving}>
            {saving ? 'Đang lưu...' : (isEdit ? 'Lưu' : 'Tạo kế hoạch')}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
