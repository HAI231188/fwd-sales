import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getTruckBookings, getAvailableContainers, getPastDeliveryLocations,
  createTruckBookingsBatch, updateTruckBooking,
} from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

// Phase 5 Step 2 — "Đặt kế hoạch xe"
//
// One row per container of the job. Rows where the container already has a
// live booking are pre-filled and tracked separately (PATCH on save). Rows
// for available containers are empty and tracked for batch-create.
//
// Save splits into two paths:
//   • POST /api/truck-bookings/batch  for all new rows (one carrier-less
//     booking per container)
//   • PATCH /api/truck-bookings/:id   for each dirty existing row
//
// DD assigns the carrier later via the Quản lý đặt xe workspace (Step 3).

function toDatetimeLocal(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PlanDeliveryModal({ jobId, jobCode, onClose, onSaved }) {
  const zIndex = useModalZIndex();
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: bookings = [], isLoading: loadingBookings } = useQuery({
    queryKey: ['truck-bookings', jobId],
    queryFn: () => getTruckBookings(jobId),
    enabled: !!jobId,
  });

  const { data: avail = [], isLoading: loadingAvail } = useQuery({
    queryKey: ['available-containers', jobId],
    queryFn: () => getAvailableContainers(jobId),
    enabled: !!jobId,
  });

  const { data: pastLocs = [] } = useQuery({
    queryKey: ['past-delivery-locations', jobId],
    queryFn: () => getPastDeliveryLocations(jobId),
    enabled: !!jobId,
  });

  // Build rows: one per container. Booked containers pre-filled from existing
  // booking; available containers start empty.
  const initialRows = useMemo(() => {
    const rows = [];
    for (const b of bookings) {
      for (const c of (b.containers || [])) {
        rows.push({
          container_id: c.id,
          cont_number: c.cont_number,
          cont_type: c.cont_type,
          booking_id: b.id,
          planned_datetime: toDatetimeLocal(b.planned_datetime),
          delivery_location: b.delivery_location || '',
          note: b.note || '',
          existing: true,
          dirty: false,
        });
      }
    }
    for (const c of avail) {
      rows.push({
        container_id: c.id,
        cont_number: c.cont_number,
        cont_type: c.cont_type,
        booking_id: null,
        planned_datetime: '',
        delivery_location: '',
        note: '',
        existing: false,
        dirty: false,
      });
    }
    return rows;
  }, [bookings, avail]);

  const [rows, setRows] = useState([]);

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  function updateRow(idx, field, value) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, [field]: value, dirty: true } : r));
  }

  async function submit() {
    setErr('');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.planned_datetime) { setErr(`Dòng ${i + 1}: vui lòng nhập ngày giờ giao`); return; }
      if (!String(r.delivery_location || '').trim()) {
        setErr(`Dòng ${i + 1}: vui lòng nhập địa điểm giao`); return;
      }
    }

    setSaving(true);
    try {
      const newOnes = rows.filter(r => !r.existing);
      const dirtyExisting = rows.filter(r => r.existing && r.dirty);

      if (newOnes.length > 0) {
        await createTruckBookingsBatch(newOnes.map(r => ({
          job_id: jobId,
          container_id: r.container_id,
          planned_datetime: r.planned_datetime,
          delivery_location: r.delivery_location.trim(),
          note: r.note?.trim() || null,
        })));
      }

      for (const r of dirtyExisting) {
        await updateTruckBooking(r.booking_id, {
          planned_datetime: r.planned_datetime,
          delivery_location: r.delivery_location.trim(),
          note: r.note?.trim() || null,
        });
      }

      toast.success('Đã lưu kế hoạch');
      qc.invalidateQueries({ queryKey: ['truck-bookings', jobId] });
      qc.invalidateQueries({ queryKey: ['available-containers', jobId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
      onSaved?.();
      onClose?.();
    } catch (e) {
      setErr(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  const loading = loadingBookings || loadingAvail;

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>
            Đặt kế hoạch xe — Job {jobCode || `#${jobId}`}
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
              Đang tải...
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
              Job này chưa có container. Hãy thêm container trong &quot;Tạo job&quot; trước khi đặt kế hoạch xe.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {rows.map((r, idx) => (
                <PlanRow key={`${r.container_id}-${idx}`}
                  row={r} pastLocs={pastLocs}
                  onChange={(f, v) => updateRow(idx, f, v)} />
              ))}
            </div>
          )}

          {err && (
            <div style={{ marginTop: 12, padding: 10, background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
              color: 'var(--danger)', fontSize: 13 }}>{err}</div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={submit}
            disabled={saving || loading || rows.length === 0}>
            {saving ? 'Đang lưu...' : 'Lưu kế hoạch'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

function PlanRow({ row, pastLocs, onChange }) {
  const [showLocList, setShowLocList] = useState(false);
  const filteredLocs = useMemo(() => {
    const q = (row.delivery_location || '').trim().toLowerCase();
    if (!q) return pastLocs;
    return pastLocs.filter(s => s.toLowerCase().includes(q));
  }, [pastLocs, row.delivery_location]);

  const inp = { padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, width: '100%', minWidth: 0, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, color: 'var(--text-2)', marginBottom: 4, display: 'block', fontWeight: 600 };

  return (
    <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8,
      background: row.existing ? 'rgba(34,197,94,0.04)' : 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>
          {row.cont_number || `(${row.cont_type} chưa nhập số)`}
        </strong>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>({row.cont_type})</span>
        {row.existing && (
          <span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--primary-dim)',
            color: 'var(--primary)', borderRadius: 4 }}>Đã có kế hoạch</span>
        )}
      </div>
      <div className="form-grid-3">
        <div>
          <label style={lbl}>Ngày giờ giao *</label>
          <input type="datetime-local" style={inp}
            value={row.planned_datetime}
            onChange={e => onChange('planned_datetime', e.target.value)} />
        </div>
        <div style={{ position: 'relative' }}>
          <label style={lbl}>Địa điểm giao *</label>
          <input style={inp}
            value={row.delivery_location}
            onChange={e => { onChange('delivery_location', e.target.value); setShowLocList(true); }}
            onFocus={() => setShowLocList(true)}
            onBlur={() => setTimeout(() => setShowLocList(false), 200)}
            placeholder="VD: Kho ABC, Hà Nội" />
          {showLocList && filteredLocs.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
              background: '#fff', border: '1px solid var(--border)', borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 200, overflowY: 'auto' }}>
              {filteredLocs.map((loc, i) => (
                <div key={i}
                  onMouseDown={() => { onChange('delivery_location', loc); setShowLocList(false); }}
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--border)' }}>
                  {loc}
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <label style={lbl}>Ghi chú</label>
          <input style={inp}
            value={row.note || ''}
            onChange={e => onChange('note', e.target.value)}
            placeholder="(tuỳ chọn)" />
        </div>
      </div>
    </div>
  );
}
