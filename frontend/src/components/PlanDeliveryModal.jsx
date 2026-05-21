import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getJob,
  getTruckBookings, getAvailableContainers, getPastDeliveryLocations,
  createTruckBookingsBatch, updateTruckBooking, deleteTruckBooking,
} from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';
import DateTimeInput24h from './DateTimeInput24h';

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

  // Job fetch — needed for cargo_type (FCL per-container vs LCL whole-lot)
  // and the LCL lot summary (so_kien / kg / cbm).
  const { data: job, isLoading: loadingJob } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
  });
  const isLcl = job?.cargo_type === 'lcl';
  const lotSummary = job
    ? `Cả lô — ${job.so_kien ?? '?'} kiện, ${job.kg ?? '?'} kg, ${job.cbm ?? '?'} CBM`
    : 'Cả lô';

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
  //
  // `enabled` defaults to TRUE for every row. User toggles off to skip that
  // container — letting them plan partially and come back later. For existing
  // bookings, toggling off and saving DELETES the booking (soft-delete on the
  // server). For new rows, toggling off just excludes them from the batch.
  const initialRows = useMemo(() => {
    // Until the job is loaded we don't know FCL vs LCL — return nothing so we
    // don't briefly render the wrong layout.
    if (!job) return [];

    // LCL whole-lot: one row per existing booking (no containers), plus a
    // single empty row to start with when nothing is planned yet. The user
    // adds more rows via "+ Thêm xe" (LCL is usually 1 truck, sometimes 2).
    if (isLcl) {
      const rows = bookings.map(b => ({
        container_id: null,
        cont_number: null,
        cont_type: null,
        booking_id: b.id,
        planned_datetime: toDatetimeLocal(b.planned_datetime),
        delivery_location: b.delivery_location || '',
        note: b.note || '',
        existing: true,
        enabled: true,
        dirty: false,
      }));
      if (rows.length === 0) {
        rows.push({
          container_id: null, cont_number: null, cont_type: null,
          booking_id: null, planned_datetime: '', delivery_location: '',
          note: '', existing: false, enabled: true, dirty: false,
        });
      }
      return rows;
    }

    // FCL: one row per container (existing booking rows + available).
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
          enabled: true,
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
        enabled: true,
        dirty: false,
      });
    }
    return rows;
  }, [job, isLcl, bookings, avail]);

  const [rows, setRows] = useState([]);

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  function updateRow(idx, field, value) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, [field]: value, dirty: true } : r));
  }

  function toggleRow(idx) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, enabled: !r.enabled } : r));
  }

  // LCL only — add another whole-lot truck row (the occasional 2nd truck).
  function addLclRow() {
    setRows(rs => [...rs, {
      container_id: null, cont_number: null, cont_type: null,
      booking_id: null, planned_datetime: '', delivery_location: '',
      note: '', existing: false, enabled: true, dirty: false,
    }]);
  }

  const enabledCount = rows.filter(r => r.enabled).length;

  async function submit() {
    setErr('');

    // Validate ONLY enabled rows. Unchecked rows are skipped — that's the
    // whole point of the checkbox: plan one container today, others later.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.enabled) continue;
      if (!r.planned_datetime) { setErr(`Dòng ${i + 1}: vui lòng nhập ngày giờ giao`); return; }
      if (!String(r.delivery_location || '').trim()) {
        setErr(`Dòng ${i + 1}: vui lòng nhập địa điểm giao`); return;
      }
    }

    if (enabledCount === 0) {
      setErr('Vui lòng chọn ít nhất 1 container để đặt kế hoạch'); return;
    }

    setSaving(true);
    try {
      // Three groups derived from (existing × enabled):
      //   enabled=T existing=F → batch CREATE (new planning row)
      //   enabled=T existing=T dirty=T → PATCH (user edited an existing plan)
      //   enabled=F existing=T → DELETE booking (user unchecked an existing plan)
      // (enabled=F existing=F → no-op, never had a booking)
      const newOnes = rows.filter(r => r.enabled && !r.existing);
      const dirtyExisting = rows.filter(r => r.enabled && r.existing && r.dirty);
      const toDelete = rows.filter(r => !r.enabled && r.existing && r.booking_id);

      if (newOnes.length > 0) {
        // FCL rows carry container_id; LCL whole-lot rows omit it entirely
        // (backend POST /batch accepts container-less bookings for LCL jobs).
        await createTruckBookingsBatch(newOnes.map(r => ({
          job_id: jobId,
          ...(r.container_id != null ? { container_id: r.container_id } : {}),
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

      for (const r of toDelete) {
        await deleteTruckBooking(r.booking_id);
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

  const loading = loadingJob || loadingBookings || loadingAvail;

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
            // Empty state only reachable for FCL (LCL always seeds ≥1 lot row).
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
              Job này chưa có container. Hãy thêm container trong &quot;Tạo job&quot; trước khi đặt kế hoạch xe.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {rows.map((r, idx) => (
                <PlanRow key={`${r.booking_id ?? 'new'}-${r.container_id ?? 'lot'}-${idx}`}
                  row={r} pastLocs={pastLocs}
                  isLcl={isLcl} lotSummary={lotSummary}
                  onChange={(f, v) => updateRow(idx, f, v)}
                  onToggle={() => toggleRow(idx)} />
              ))}
              {isLcl && (
                <button type="button" className="btn btn-ghost btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={addLclRow}>
                  + Thêm xe
                </button>
              )}
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
            disabled={saving || loading || rows.length === 0 || enabledCount === 0}>
            {saving ? 'Đang lưu...' : `Lưu kế hoạch${enabledCount > 0 && enabledCount < rows.length ? ` (${enabledCount}/${rows.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

function PlanRow({ row, pastLocs, isLcl, lotSummary, onChange, onToggle }) {
  const [showLocList, setShowLocList] = useState(false);
  const filteredLocs = useMemo(() => {
    const q = (row.delivery_location || '').trim().toLowerCase();
    if (!q) return pastLocs;
    return pastLocs.filter(s => s.toLowerCase().includes(q));
  }, [pastLocs, row.delivery_location]);

  const off = !row.enabled;
  const inp = {
    padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, width: '100%', minWidth: 0, boxSizing: 'border-box',
    background: off ? 'var(--bg)' : '#fff', color: off ? 'var(--text-3)' : 'var(--text)',
  };
  const lbl = { fontSize: 12, color: 'var(--text-2)', marginBottom: 4, display: 'block', fontWeight: 600 };

  return (
    <div style={{
      padding: 12, border: '1px solid var(--border)', borderRadius: 8,
      background: off ? 'rgba(156,163,175,0.06)' : (row.existing ? 'rgba(34,197,94,0.04)' : 'var(--bg)'),
      opacity: off ? 0.72 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
          fontSize: 12, color: 'var(--text-2)', fontWeight: 600,
        }}>
          <input type="checkbox" checked={row.enabled} onChange={onToggle}
            style={{ width: 16, height: 16, cursor: 'pointer' }} />
          {isLcl ? 'Đặt xe này' : 'Đặt cont này'}
        </label>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        {isLcl ? (
          <strong style={{ fontSize: 13 }}>{lotSummary}</strong>
        ) : (
          <>
            <strong style={{ fontSize: 13 }}>
              {row.cont_number || `(${row.cont_type} chưa nhập số)`}
            </strong>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>({row.cont_type})</span>
          </>
        )}
        {row.existing && row.enabled && (
          <span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--primary-dim)',
            color: 'var(--primary)', borderRadius: 4 }}>Đã có kế hoạch</span>
        )}
        {row.existing && !row.enabled && (
          <span style={{ fontSize: 11, padding: '2px 6px', background: 'rgba(239,68,68,0.10)',
            color: 'var(--danger)', borderRadius: 4 }}>Bỏ chọn → sẽ xóa</span>
        )}
      </div>
      <div className="form-grid-3">
        <div>
          <label style={lbl}>Ngày giờ giao *</label>
          <DateTimeInput24h disabled={off}
            value={row.planned_datetime}
            onChange={v => onChange('planned_datetime', v)} />
        </div>
        <div style={{ position: 'relative' }}>
          <label style={lbl}>Địa điểm giao *</label>
          <input style={inp} disabled={off}
            value={row.delivery_location}
            onChange={e => { onChange('delivery_location', e.target.value); setShowLocList(true); }}
            onFocus={() => setShowLocList(true)}
            onBlur={() => setTimeout(() => setShowLocList(false), 200)}
            placeholder="VD: Kho ABC, Hà Nội" />
          {!off && showLocList && filteredLocs.length > 0 && (
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
          <input style={inp} disabled={off}
            value={row.note || ''}
            onChange={e => onChange('note', e.target.value)}
            placeholder="(tuỳ chọn)" />
        </div>
      </div>
    </div>
  );
}
