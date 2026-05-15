import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getJob, getTruckBookings, updateTruckBooking,
  sendPlanningEmail, previewPlanningEmail,
} from '../api';
import TransportPicker from './TransportPicker';
import InvoiceRecipientModal from './InvoiceRecipientModal';
import ReceiverInfoModal from './ReceiverInfoModal';
import { useModalZIndex } from '../hooks/useModalZIndex';
import { useAuth } from '../App';

// Phase 5 Step 3 — Quản lý đặt xe workspace.
//
// Vùng 1 (table): one row per container in the job. For containers WITH an
// existing booking, DD can edit transport_company_id, cost, vehicle_number.
// Other fields (booking_code, cont, delivery_location, planned_datetime,
// han_lenh) are read-only. For containers WITHOUT a booking, the editable
// inputs are disabled with a hint pointing users to PlanDeliveryModal first.
//
// Vùng 2 (cards): rows grouped by transport_company_id, live-derived from
// Vùng 1's edit state via useMemo. Each card lists Mã KH + cont info and
// has [Gửi mail kế hoạch] + [Xem preview] buttons. Email sending is a
// mock for this part — toast says feature is under development. The
// preview modal renders the mock email template (Phase 5 Step 3 spec).
//
// Save: per-row PATCH /api/truck-bookings/:id for each dirty row. The
// backend re-snapshots transport_name on transport_company_id change (L13).

function fmtPlanned(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
function fmtHanLenh(val, impExp) {
  if (!val) return '—';
  if (impExp === 'import') {
    return new Date(val).toLocaleDateString('vi-VN');
  }
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function TruckPlanningModal({ jobId, jobCode, onClose }) {
  const zIndex = useModalZIndex();
  const qc = useQueryClient();
  const { user } = useAuth() || {};
  const [saving, setSaving] = useState(false);
  const [previewGroup, setPreviewGroup] = useState(null);
  const [sendingGroupKey, setSendingGroupKey] = useState(null); // transport_company_id of the in-flight send
  // CP4.1 — which booking's receiver-info modal is open (null = closed).
  const [receiverModalBookingId, setReceiverModalBookingId] = useState(null);
  // CP3.5b — invoice picker gates the send. pendingMailContext holds the
  // group + send args while the modal is open; on confirm we fire the
  // mutation with the chosen invoice_info.
  const [pendingMailContext, setPendingMailContext] = useState(null);

  const sendMut = useMutation({
    mutationFn: (body) => sendPlanningEmail(body),
  });

  async function fireSend(invoiceInfo) {
    if (!pendingMailContext) return;
    const ctx = pendingMailContext;
    setPendingMailContext(null);
    setSendingGroupKey(ctx.group.transport_company_id);
    try {
      const result = await sendMut.mutateAsync({
        job_id: jobId,
        transport_company_id: ctx.group.transport_company_id,
        booking_ids: ctx.group.rows.map(r => r.booking_id).filter(Boolean),
        mail_type: ctx.mailType,
        is_replacement: !!ctx.isReplacement,
        invoice_info: invoiceInfo,
      });
      toast.success(`✅ Đã gửi mail cho ${ctx.group.transport_name} (${result.recipient_email})`);
      qc.invalidateQueries({ queryKey: ['email-history', jobId] });
    } catch (err) {
      const status = err?.response?.status ?? err?.status;
      const code = err?.code;
      const msg = err?.error || err?.message || 'Lỗi không xác định';
      if (code === 'NO_GMAIL_SETUP' || status === 412) {
        if (window.confirm(`${msg}\n\nMở /change-password ngay?`)) {
          window.location.href = '/change-password';
        }
      } else if (code === 'NO_TRANSPORT_EMAIL') {
        if (window.confirm(`${msg}\n\nMở /transport-companies ngay?`)) {
          window.location.href = '/transport-companies';
        }
      } else {
        toast.error(`Lỗi gửi mail: ${msg}`);
      }
    } finally {
      setSendingGroupKey(null);
    }
  }

  const { data: job, isLoading: jobL } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
  });
  const { data: bookings = [], isLoading: bookingL, refetch: refetchBookings } = useQuery({
    queryKey: ['truck-bookings', jobId],
    queryFn: () => getTruckBookings(jobId),
    enabled: !!jobId,
  });

  // Per-container rows. Match each container to its booking (if any).
  const containers = job?.containers || [];
  const initialRows = useMemo(() => {
    return containers.map(c => {
      const b = bookings.find(b => (b.containers || []).some(bc => bc.id === c.id));
      return {
        container_id: c.id,
        cont_number: c.cont_number,
        cont_type: c.cont_type,
        booking_id: b?.id || null,
        booking_code: b?.booking_code || null,
        delivery_location: b?.delivery_location || '',
        planned_datetime: b?.planned_datetime || '',
        transport_company_id: b?.transport_company_id ?? null,
        transport_name: b?.transport_current_name || b?.transport_name || '',
        cost: b?.cost != null ? String(b.cost) : '',
        vehicle_number: b?.vehicle_number || '',
        // CP4.1 — local edit state for receiver info. ReceiverInfoModal merges
        // changes here (marking the row dirty); the batch "Lưu thay đổi" footer
        // PATCHes alongside cost/vehicle_number, matching how every other
        // Vùng 1 column works.
        receiver_name:  b?.receiver_name  || '',
        receiver_phone: b?.receiver_phone || '',
        bbbg_note:      b?.bbbg_note      || '',
        dirty: false,
      };
    });
  }, [containers, bookings]);

  const [rows, setRows] = useState([]);
  useEffect(() => { setRows(initialRows); }, [initialRows]);

  function updateRow(idx, patch) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, ...patch, dirty: true } : r));
  }

  async function save() {
    const dirty = rows.filter(r => r.dirty && r.booking_id);
    if (dirty.length === 0) {
      toast('Không có thay đổi để lưu', { icon: 'ℹ️' });
      return;
    }
    setSaving(true);
    try {
      for (const r of dirty) {
        await updateTruckBooking(r.booking_id, {
          transport_company_id: r.transport_company_id,
          cost: r.cost === '' ? null : Number(r.cost),
          vehicle_number: r.vehicle_number,
          // CP4.1 — included in the batch PATCH so receiver edits from the
          // small modal flow through the same save path as cost/vehicle.
          receiver_name:  r.receiver_name  || null,
          receiver_phone: r.receiver_phone || null,
          bbbg_note:      r.bbbg_note      || null,
        });
      }
      toast.success(`Đã lưu ${dirty.length} kế hoạch`);
      refetchBookings();
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  // Vùng 2 grouping: live-derived from current rows. Only rows with a
  // booking AND a chosen transport_company_id appear.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      if (!r.booking_id || !r.transport_company_id) continue;
      const key = r.transport_company_id;
      if (!map.has(key)) {
        map.set(key, {
          transport_company_id: key,
          transport_name: r.transport_name || '(chưa snapshot)',
          rows: [],
        });
      }
      map.get(key).rows.push(r);
    }
    return Array.from(map.values());
  }, [rows]);

  const loading = jobL || bookingL;

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-xl" style={{ maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>
            Quản lý đặt xe — Job {jobCode || `#${jobId}`}
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
              Đang tải...
            </div>
          ) : (
            <>
              <SectionTitle>Vùng 1: Bảng kế hoạch theo container</SectionTitle>
              <Vung1Table rows={rows} job={job} onUpdateRow={updateRow}
                onOpenReceiver={(bookingId) => setReceiverModalBookingId(bookingId)} />

              <div style={{ height: 16 }} />
              <SectionTitle>Vùng 2: Mail gửi vận tải (theo nhóm)</SectionTitle>
              {groups.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)',
                  fontSize: 13, background: 'var(--bg)', borderRadius: 8 }}>
                  Chưa có vận tải nào được chốt. Vui lòng chọn vận tải ở bảng trên.
                </div>
              ) : (
                <div style={{ display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                  {groups.map(g => (
                    <TransportCard key={g.transport_company_id} group={g}
                      sending={sendingGroupKey === g.transport_company_id}
                      onPreview={() => setPreviewGroup(g)}
                      onSend={() => {
                        // Open invoice picker first; actual mutation fires
                        // from fireSend() on InvoiceRecipientModal confirm.
                        setPendingMailContext({
                          group: g, mailType: 'new', isReplacement: false,
                        });
                      }} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>Đóng</button>
          <button className="btn btn-primary btn-sm" onClick={save}
            disabled={saving || loading || rows.every(r => !r.dirty)}>
            {saving ? 'Đang lưu...' : 'Lưu thay đổi'}
          </button>
        </div>
      </div>

      {previewGroup && (
        <EmailPreviewModal group={previewGroup} job={job}
          onClose={() => setPreviewGroup(null)} />
      )}

      <InvoiceRecipientModal
        isOpen={!!pendingMailContext}
        customer={job ? {
          name: job.customer_name,
          invoice_company: job.invoice_company_name,
          invoice_tax: job.invoice_tax_code,
          invoice_address: job.invoice_address,
        } : null}
        onClose={() => setPendingMailContext(null)}
        onConfirm={(invoiceInfo) => fireSend(invoiceInfo)} />

      {/* CP4.1 — Receiver info per booking. Find the row matching the open
          booking id; pass through booking shape ReceiverInfoModal expects. */}
      <ReceiverInfoModal
        isOpen={receiverModalBookingId != null}
        booking={(() => {
          if (receiverModalBookingId == null) return null;
          const r = rows.find(x => x.booking_id === receiverModalBookingId);
          return r ? {
            id: r.booking_id, booking_code: r.booking_code,
            receiver_name: r.receiver_name, receiver_phone: r.receiver_phone,
            bbbg_note: r.bbbg_note,
          } : null;
        })()}
        onClose={() => setReceiverModalBookingId(null)}
        onSave={(data) => {
          // Option B (CP4.1 bug fix) — merge into local row state + mark dirty.
          // No PATCH here. The footer "Lưu thay đổi" batch-PATCHes alongside
          // cost / số xe / vận tải. Avoids the invalidate→refetch→initialRows
          // reset that was wiping in-progress edits on sibling rows.
          setRows(rs => rs.map(r =>
            r.booking_id === receiverModalBookingId
              ? { ...r,
                  receiver_name:  data.receiver_name  || '',
                  receiver_phone: data.receiver_phone || '',
                  bbbg_note:      data.bbbg_note      || '',
                  dirty: true }
              : r
          ));
          setReceiverModalBookingId(null);
        }} />
    </div>
  ), document.body);
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)',
      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
      {children}
    </div>
  );
}

function Vung1Table({ rows, job, onUpdateRow, onOpenReceiver }) {
  const impExp = job?.import_export;
  const inp = { padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4,
    fontSize: 12, width: '100%', minWidth: 0, boxSizing: 'border-box' };
  const td = { padding: '8px 8px', verticalAlign: 'middle', fontSize: 12, borderBottom: '1px solid var(--border)' };
  const th = { padding: '10px 8px', textAlign: 'left', fontWeight: 600,
    color: 'var(--text-2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em',
    background: 'var(--bg)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' };

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Mã KH</th>
            <th style={th}>Cont</th>
            <th style={th}>Loại</th>
            <th style={th}>Địa điểm giao</th>
            <th style={th}>Ngày giờ giao</th>
            <th style={th}>Hạn lệnh</th>
            <th style={{ ...th, minWidth: 180 }}>Vận tải</th>
            <th style={th}>👤 Người liên hệ</th>
            <th style={th}>Cước</th>
            <th style={th}>Số xe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const noBooking = !r.booking_id;
            const hint = noBooking
              ? 'Cần đặt kế hoạch trước (nút Đặt kế hoạch xe)'
              : '';
            return (
              <tr key={r.container_id} style={{ background: noBooking ? 'rgba(156,163,175,0.04)' : '#fff' }}>
                <td style={{ ...td, color: 'var(--text-2)', fontFamily: 'var(--font-display)',
                  fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {r.booking_code || '—'}
                </td>
                <td style={{ ...td, fontWeight: 600 }}>{r.cont_number || '—'}</td>
                <td style={td}>{r.cont_type}</td>
                <td style={td}>{noBooking ? '—' : (r.delivery_location || '—')}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {noBooking ? '—' : fmtPlanned(r.planned_datetime)}
                </td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {fmtHanLenh(job?.han_lenh, impExp)}
                </td>
                <td style={td} title={hint}>
                  {noBooking ? (
                    <span style={{ color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' }}>
                      Cần đặt kế hoạch trước
                    </span>
                  ) : (
                    <TransportPicker
                      value={{
                        transport_company_id: r.transport_company_id,
                        transport_name: r.transport_name,
                      }}
                      onChange={v => onUpdateRow(idx, {
                        transport_company_id: v.transport_company_id ?? null,
                        transport_name: v.transport_name ?? '',
                      })} />
                  )}
                </td>
                <td style={td}>
                  {noBooking ? (
                    <span style={{ color: 'var(--text-3)' }}>—</span>
                  ) : r.receiver_name ? (
                    <button type="button"
                      onClick={() => onOpenReceiver(r.booking_id)}
                      title={r.receiver_phone
                        ? `${r.receiver_name} — ${r.receiver_phone}`
                        : r.receiver_name}
                      style={{
                        padding: '2px 8px', background: 'var(--info-dim)',
                        color: 'var(--info)', border: '1px solid transparent',
                        borderRadius: 999, fontSize: 11, fontWeight: 600,
                        cursor: 'pointer', whiteSpace: 'nowrap', maxWidth: 140,
                        overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                      👤 {r.receiver_name}
                    </button>
                  ) : (
                    <button type="button"
                      onClick={() => onOpenReceiver(r.booking_id)}
                      style={{
                        padding: '2px 8px', background: 'transparent',
                        color: 'var(--text-2)', border: '1px dashed var(--border)',
                        borderRadius: 6, fontSize: 11, fontWeight: 500,
                        cursor: 'pointer', whiteSpace: 'nowrap',
                      }}>
                      👤 + Thêm
                    </button>
                  )}
                </td>
                <td style={td}>
                  <input type="number" style={inp} disabled={noBooking}
                    title={hint}
                    value={r.cost}
                    onChange={e => onUpdateRow(idx, { cost: e.target.value })} />
                </td>
                <td style={td}>
                  <input type="text" style={inp} disabled={noBooking}
                    title={hint}
                    placeholder="VD: 29C-12345"
                    value={r.vehicle_number}
                    onChange={e => onUpdateRow(idx, { vehicle_number: e.target.value })} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TransportCard({ group, sending, onPreview, onSend }) {
  // Status field is still MOCK "Chưa gửi" — real per-card status (Đã gửi /
  // Có thay đổi sau gửi / Cần gửi HỦY) lands in CP5 once email_history is
  // queried per (job, transport_company_id) and diffed against current state.
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>{group.transport_name}</span>
        <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500 }}>
          {group.rows.length} cont
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {group.rows.map(r => (
          <div key={r.container_id} style={{ fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ padding: '1px 6px', background: 'var(--primary-dim)',
              color: 'var(--primary)', borderRadius: 4, fontWeight: 600,
              fontFamily: 'var(--font-display)', fontSize: 11 }}>
              {r.booking_code || '—'}
            </span>
            <span style={{ color: 'var(--text)' }}>
              {r.cont_number || '(chưa số)'} ({r.cont_type})
              {r.planned_datetime ? ` — ${fmtPlanned(r.planned_datetime)}` : ''}
              {r.delivery_location ? `, ${r.delivery_location}` : ''}
              {r.cost ? `, ${Number(r.cost).toLocaleString('vi-VN')}đ` : ''}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 10 }}>
        Trạng thái: <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Chưa gửi</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={onSend} disabled={sending}>
          {sending ? '⏳ Đang gửi...' : '📧 Gửi mail kế hoạch'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onPreview} disabled={sending}>
          👁 Xem preview
        </button>
      </div>
    </div>
  );
}

function EmailPreviewModal({ group, job, onClose }) {
  const zIndex = useModalZIndex();
  // CP3.5c — Real backend rendering. Server runs the same renderSubject +
  // renderBody pipeline as send-planning (no SMTP, no email_history insert).
  // invoice_info is intentionally omitted from the request so the body shows
  // the "(Sẽ chọn khi gửi)" placeholder for that section.
  const { data, isLoading, error } = useQuery({
    queryKey: ['email-preview', job?.id, group.transport_company_id, group.rows.map(r => r.booking_id).join(',')],
    queryFn: () => previewPlanningEmail({
      job_id: job?.id,
      transport_company_id: group.transport_company_id,
      booking_ids: group.rows.map(r => r.booking_id).filter(Boolean),
      mail_type: 'new',
      is_replacement: false,
    }),
    enabled: !!(job?.id && group.transport_company_id),
  });

  const toLine = (label, val) => `${label}: ${val ?? '—'}`;
  const composed = data && [
    toLine('To', data.recipient_email || '(chưa có)'),
    toLine('CC', data.cc?.length ? data.cc.join(', ') : '(không có)'),
    toLine('Subject', data.subject),
    '',
    data.body,
  ].join('\n');

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '90vh' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 15 }}>
            👁 Xem trước nội dung mail — {group.transport_name}
          </h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16, overflowY: 'auto' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 8,
            padding: '6px 10px', background: 'var(--info-dim)', borderRadius: 6 }}>
            ℹ️ Đây là preview mock — phần &quot;Thông tin xuất hóa đơn nâng hạ&quot; sẽ được chọn khi bấm <strong>Gửi mail kế hoạch</strong>.
          </div>
          {isLoading && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)' }}>
              Đang render preview...
            </div>
          )}
          {error && (
            <div style={{ padding: 12, color: 'var(--danger)', fontSize: 13,
              background: 'rgba(239,68,68,0.08)', borderRadius: 6 }}>
              Lỗi render preview: {error?.error || error?.message || 'unknown'}
            </div>
          )}
          {data && (
            <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7,
              padding: 14, background: 'var(--bg)', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
              {composed}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  ), document.body);
}
