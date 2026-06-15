import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getJob, getTruckBookings, updateTruckBooking,
  sendPlanningEmail, previewPlanningEmail, previewBBBGPdf,
  getMailStatus, sendCancelPlanningEmail,
} from '../api';
import TransportPicker from './TransportPicker';
import InvoiceRecipientModal from './InvoiceRecipientModal';
import ReceiverInfoModal from './ReceiverInfoModal';
import CancelMailConfirmModal from './CancelMailConfirmModal';
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
  // CP4.2 — BBBG preview pipeline. `pendingBbbgContext` mirrors
  // pendingMailContext: opens the same InvoiceRecipientModal but on confirm
  // fires firePreviewBbbg() instead of fireSend(). bbbgLoadingGroupKey tracks
  // the in-flight transport_company_id for per-card loading text.
  const [pendingBbbgContext, setPendingBbbgContext] = useState(null);
  const [bbbgLoadingGroupKey, setBbbgLoadingGroupKey] = useState(null);
  // CP3.5b — invoice picker gates the send. pendingMailContext holds the
  // group + send args while the modal is open; on confirm we fire the
  // mutation with the chosen invoice_info.
  const [pendingMailContext, setPendingMailContext] = useState(null);

  const sendMut = useMutation({
    mutationFn: (body) => sendPlanningEmail(body),
  });

  // CP4.2 — Build the PDF on the backend, hand the resulting blob to the
  // native browser PDF viewer in a new tab. We deliberately do NOT pre-check
  // dirty state here — the dirty guard runs before the invoice modal opens
  // (in the per-card onPreviewBbbg handler) so the user can't lose unsaved
  // edits to a refetch triggered by anything else.
  async function firePreviewBbbg(invoiceInfo) {
    if (!pendingBbbgContext) return;
    const ctx = pendingBbbgContext;
    setPendingBbbgContext(null);
    setBbbgLoadingGroupKey(ctx.group.key || ctx.group.transport_company_id);
    try {
      const blob = await previewBBBGPdf({
        job_id: jobId,
        transport_company_id: ctx.group.transport_company_id,
        booking_ids: ctx.group.rows.map(r => r.booking_id).filter(Boolean),
        invoice_info: invoiceInfo,
      });
      // Browsers sometimes hand us an axios-mangled blob with the wrong MIME.
      // Force application/pdf so the new tab uses the PDF viewer plugin.
      const pdfBlob = blob instanceof Blob
        ? new Blob([blob], { type: 'application/pdf' })
        : new Blob([blob], { type: 'application/pdf' });
      const url = URL.createObjectURL(pdfBlob);
      const win = window.open(url, '_blank');
      if (!win) {
        toast.error('Trình duyệt chặn popup — hãy cho phép popup và thử lại');
      }
      // Don't immediately revokeObjectURL — the new tab still needs the URL.
      // Browsers garbage-collect blob URLs when the document holding them
      // closes; this is the standard pattern.
    } catch (err) {
      // Blob errors arrive as the Blob itself; convert to text to surface
      // the JSON error from the backend.
      let msg = err?.error || err?.message || 'Lỗi tạo BBBG';
      if (err?.response?.data instanceof Blob) {
        try { msg = JSON.parse(await err.response.data.text()).error || msg; }
        catch { /* keep msg */ }
      }
      toast.error(`Lỗi tạo BBBG: ${msg}`);
    } finally {
      setBbbgLoadingGroupKey(null);
    }
  }

  async function fireSend(invoiceInfo, attachBbbg = true) {
    if (!pendingMailContext) return;
    const ctx = pendingMailContext;
    setPendingMailContext(null);
    setSendingGroupKey(ctx.group.key || ctx.group.transport_company_id);
    try {
      const result = await sendMut.mutateAsync({
        job_id: jobId,
        transport_company_id: ctx.group.transport_company_id,
        booking_ids: ctx.group.rows.map(r => r.booking_id).filter(Boolean),
        mail_type: ctx.mailType,
        is_replacement: !!ctx.isReplacement,
        invoice_info: invoiceInfo,
        // CP4.3.1 — DD checkbox decision from InvoiceRecipientModal. When
        // false, backend skips PDF generation entirely and drops the
        // "Đính kèm" line from the mail body.
        attach_bbbg: attachBbbg,
      });
      // CP4.3 — surface BBBG attachment count + partial-failure warnings.
      // CP4.3.1 — third variant when DD explicitly unticked the attach
      // checkbox: confirm the no-BBBG send explicitly so they know the mail
      // went out without PDFs (placeholder/lock-the-carrier flow).
      const tn = ctx.group.transport_name;
      const ac = Number(result?.attachmentCount) || 0;
      if (!attachBbbg) {
        toast.success(`✅ Đã gửi mail cho ${tn} (không kèm BBBG)`);
      } else if (ac > 0) {
        toast.success(`✅ Đã gửi mail cho ${tn} — Đính kèm ${ac} file BBBG`);
      } else {
        toast.success(`✅ Đã gửi mail cho ${tn} (${result.recipient_email})`);
      }
      if (Array.isArray(result?.bbbgErrors) && result.bbbgErrors.length > 0) {
        toast(`⚠️ Mail đã gửi nhưng ${result.bbbgErrors.length} file BBBG bị lỗi — vui lòng gửi BBBG riêng cho ${tn}`,
          { icon: '⚠️', duration: 8000 });
      }
      qc.invalidateQueries({ queryKey: ['email-history', jobId] });
      // CP5.2 — flip the transport's pill from chua_gui / co_thay_doi → da_gui.
      qc.invalidateQueries({ queryKey: ['mail-status', jobId] });
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

  // CP5.2 — per-transport mail status (Vùng 2 pills + buttons). Returns
  // groups for every transport involved in the job (currently OR historically),
  // each with status enum + diff + last-sent snapshot.
  const { data: mailStatusData } = useQuery({
    queryKey: ['mail-status', jobId],
    queryFn: () => getMailStatus(jobId),
    enabled: !!jobId,
  });
  // CP5.3 — composite key: a single transport can have multiple batch cards
  // (one per mail_group_id, plus one for the forming batch with key=NULL).
  function statusKey(transportCompanyId, mailGroupId) {
    return `${transportCompanyId}-${mailGroupId == null ? 'new' : mailGroupId}`;
  }
  const mailStatusMap = useMemo(() => {
    const map = new Map();
    const groups = mailStatusData?.groups || [];
    for (const g of groups) {
      map.set(statusKey(g.transport_company_id, g.mail_group_id), g);
    }
    return map;
  }, [mailStatusData]);

  // FCL vs LCL. LCL jobs have zero job_containers (aggregate so_kien/kg/cbm);
  // their bookings are whole-lot (no truck_booking_containers link). The
  // container-driven row builder below would yield 0 rows for LCL — so LCL
  // branches to map over `bookings` directly. Mirrors PlanDeliveryModal (82737e6).
  const containers = job?.containers || [];
  const isLcl = job?.cargo_type === 'lcl';
  const lotSummary = job
    ? `Cả lô — ${job.so_kien ?? '?'} kiện, ${job.kg ?? '?'} kg${job.cbm != null ? `, ${job.cbm} CBM` : ''}`
    : 'Cả lô';

  // Shared row shape for both branches. For FCL, container fields come from the
  // job_containers row; for LCL they are null (whole-lot booking).
  function bookingRow(b, contFields) {
    return {
      container_id: contFields.container_id,
      cont_number: contFields.cont_number,
      cont_type: contFields.cont_type,
      booking_id: b?.id || null,
      booking_code: b?.booking_code || null,
      delivery_location: b?.delivery_location || '',
      planned_datetime: b?.planned_datetime || '',
      transport_company_id: b?.transport_company_id ?? null,
      transport_name: b?.transport_current_name || b?.transport_name || '',
      // CP5.3 — null = forming batch, number = already-mailed batch id.
      mail_group_id: b?.mail_group_id ?? null,
      cost: b?.cost != null ? String(b.cost) : '',
      vehicle_number: b?.vehicle_number || '',
      // CP4.1 — local edit state for receiver info. ReceiverInfoModal merges
      // changes here (marking the row dirty); the batch "Lưu thay đổi" footer
      // PATCHes alongside cost/vehicle_number, matching how every other
      // Vùng 1 column works.
      receiver_name:  b?.receiver_name  || '',
      receiver_phone: b?.receiver_phone || '',
      bbbg_note:      b?.bbbg_note      || '',
      // CP6.1 — sign-off ticks. Default false. Editable only when this row
      // already has a carrier + vehicle (the gating logic lives in the
      // Vùng1Table cell renderer).
      invoice_lifting_ticked: !!b?.invoice_lifting_ticked,
      cost_entered_ticked:    !!b?.cost_entered_ticked,
      dirty: false,
    };
  }
  const initialRows = useMemo(() => {
    // LCL: one row per whole-lot booking (no containers to iterate).
    if (isLcl) {
      return bookings.map(b => bookingRow(b, {
        container_id: null, cont_number: null, cont_type: null,
      }));
    }
    // FCL: one row per container, matched to its booking (if any).
    return containers.map(c => {
      const b = bookings.find(b => (b.containers || []).some(bc => bc.id === c.id));
      return bookingRow(b, {
        container_id: c.id, cont_number: c.cont_number, cont_type: c.cont_type,
      });
    });
  }, [isLcl, containers, bookings]);

  const [rows, setRows] = useState([]);
  // B1 / L3 / Golden Rule 7 — don't clobber in-progress edits when the bookings
  // query refetches (refetchOnWindowFocus or the post-save refetch). Seed on
  // first load and refresh only while nothing is dirty; once any row is being
  // edited, keep the local rows so a background refetch can't wipe in-progress
  // cost/vehicle/receiver edits. save() clears the dirty flags after a
  // successful PATCH so the post-save refetch re-seeds from fresh server data.
  useEffect(() => {
    setRows(prev => (prev.length === 0 || !prev.some(r => r.dirty)) ? initialRows : prev);
  }, [initialRows]);

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
          // CP6.1 — sign-off ticks ride the same batch save.
          invoice_lifting_ticked: !!r.invoice_lifting_ticked,
          cost_entered_ticked:    !!r.cost_entered_ticked,
        });
      }
      // B1 — mark the just-saved rows clean so the freeze-if-dirty guard lets
      // the post-save refetch re-seed from fresh server data (otherwise the grid
      // would stay frozen on the local copy after saving).
      setRows(rs => rs.map(r => r.dirty ? { ...r, dirty: false } : r));
      toast.success(`Đã lưu ${dirty.length} kế hoạch`);
      refetchBookings();
      // CP5.2 — re-evaluate the per-transport status pills after any save;
      // a transport change on a booking can flip a 'da_gui' card to
      // 'co_thay_doi' or move it to 'can_huy'.
      qc.invalidateQueries({ queryKey: ['mail-status', jobId] });
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  // Vùng 2 grouping: CP5.3 composite key (transport_company_id, mail_group_id).
  // Each booking row carries its own mail_group_id (null = forming batch),
  // so the same transport can produce multiple cards: one per sent batch
  // plus one for any new bookings still in the forming batch.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      if (!r.booking_id || !r.transport_company_id) continue;
      const key = statusKey(r.transport_company_id, r.mail_group_id);
      if (!map.has(key)) {
        map.set(key, {
          key,
          transport_company_id: r.transport_company_id,
          transport_name: r.transport_name || '(chưa snapshot)',
          mail_group_id: r.mail_group_id ?? null,
          rows: [],
        });
      }
      map.get(key).rows.push(r);
    }
    return Array.from(map.values());
  }, [rows]);

  // CP5.2 — "ghost" cards for sent batches with zero current alive bookings
  // (status can_huy / da_huy). DD still needs to see them to send HỦY.
  // CP5.3 — keyed by composite, so a transport can have BOTH a live forming
  // batch AND a ghost prior batch surface side by side.
  const ghostGroups = useMemo(() => {
    if (!mailStatusData?.groups) return [];
    const liveKeys = new Set(groups.map(g => g.key));
    return mailStatusData.groups
      .filter(s => !liveKeys.has(statusKey(s.transport_company_id, s.mail_group_id)))
      .filter(s => s.status === 'can_huy' || s.status === 'da_huy')
      .map(s => ({
        key: statusKey(s.transport_company_id, s.mail_group_id),
        transport_company_id: s.transport_company_id,
        transport_name: s.transport_name || '(không xác định)',
        mail_group_id: s.mail_group_id,
        rows: [],
        isGhost: true,
      }));
  }, [mailStatusData, groups]);
  // CP5.3 — sort: transports alphabetically; within a transport, batches by
  // mail_group_id ASC (earliest mailed first), forming batch (null) at the
  // bottom so DD's next action gravitates to the live work.
  const allGroups = useMemo(() => {
    return [...groups, ...ghostGroups].sort((a, b) => {
      const na = (a.transport_name || '').toLowerCase();
      const nb = (b.transport_name || '').toLowerCase();
      if (na !== nb) return na < nb ? -1 : 1;
      const ga = a.mail_group_id ?? Number.POSITIVE_INFINITY;
      const gb = b.mail_group_id ?? Number.POSITIVE_INFINITY;
      return ga - gb;
    });
  }, [groups, ghostGroups]);

  // CP5.2 — Confirm modal target for HỦY send. Holds the (group, statusInfo)
  // pair so the modal can render the bookings_snapshot from email_history.
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelingGroupKey, setCancelingGroupKey] = useState(null);

  async function fireSendCancel({ group, statusInfo, reason }) {
    setCancelingGroupKey(group.key || group.transport_company_id);
    try {
      await sendCancelPlanningEmail({
        job_id: jobId,
        transport_company_id: group.transport_company_id,
        last_sent_email_id: statusInfo?.last_sent_email_id || undefined,
        reason: reason || undefined,
      });
      toast.success(`✅ Đã gửi mail HỦY cho ${group.transport_name}`);
      setCancelTarget(null);
      qc.invalidateQueries({ queryKey: ['mail-status', jobId] });
      qc.invalidateQueries({ queryKey: ['email-history', jobId] });
      qc.invalidateQueries({ queryKey: ['truck-bookings', jobId] });
    } catch (err) {
      const code = err?.code;
      const msg = err?.error || err?.message || 'Lỗi gửi mail HỦY';
      if (code === 'NO_GMAIL_SETUP') {
        if (window.confirm(`${msg}\n\nMở /change-password ngay?`)) {
          window.location.href = '/change-password';
        }
      } else if (code === 'NO_PREVIOUS_NEW_MAIL') {
        toast.error('Không có mail kế hoạch trước đó để hủy.');
      } else {
        toast.error(`Lỗi gửi HỦY: ${msg}`);
      }
    } finally {
      setCancelingGroupKey(null);
    }
  }

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
                isLcl={isLcl} lotSummary={lotSummary}
                onOpenReceiver={(bookingId) => setReceiverModalBookingId(bookingId)}
                canEditTicks={user?.role === 'dieu_do'} />

              <div style={{ height: 16 }} />
              <SectionTitle>Vùng 2: Mail gửi vận tải (theo nhóm)</SectionTitle>
              {allGroups.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)',
                  fontSize: 13, background: 'var(--bg)', borderRadius: 8 }}>
                  Chưa có vận tải nào được chốt. Vui lòng chọn vận tải ở bảng trên.
                </div>
              ) : (
                <div style={{ display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                  {allGroups.map(g => {
                    const statusInfo = mailStatusMap.get(g.key) || null;
                    return (
                      <TransportCard key={g.key} group={g}
                        statusInfo={statusInfo}
                        lotSummary={isLcl ? lotSummary : null}
                        sending={sendingGroupKey === g.key}
                        canceling={cancelingGroupKey === g.key}
                        loadingBbbg={bbbgLoadingGroupKey === g.key}
                        onPreview={() => setPreviewGroup(g)}
                        onSend={() => {
                          // Open invoice picker first; actual mutation fires
                          // from fireSend() on InvoiceRecipientModal confirm.
                          setPendingMailContext({
                            group: g, mailType: 'new', isReplacement: false,
                          });
                        }}
                        onPreviewBbbg={() => {
                          // CP4.2 — dirty guard runs HERE so we don't open the
                          // invoice modal when the user still has unsaved edits
                          // (which would render with stale DB state).
                          if (rows.some(r => r.dirty)) {
                            window.alert('Bạn có thay đổi chưa lưu. Vui lòng Lưu trước khi xem BBBG.');
                            return;
                          }
                          setPendingBbbgContext({ group: g });
                        }}
                        onCancelMail={() => {
                          if (!statusInfo || !statusInfo.last_sent_email_id) {
                            toast.error('Không có mail kế hoạch trước đó để hủy.');
                            return;
                          }
                          setCancelTarget({ group: g, statusInfo });
                        }}
                        onShowHistory={() => {
                          if (!statusInfo?.last_sent_at) {
                            toast('Chưa có lịch sử gửi mail cho vận tải này.', { icon: 'ℹ️' });
                            return;
                          }
                          const when = new Date(statusInfo.last_sent_at)
                            .toLocaleString('vi-VN', { hour12: false });
                          const kind = statusInfo.status === 'da_huy' ? 'HỦY' : 'MỚI';
                          toast(`📜 Lần gửi cuối: ${when} — Gửi ${kind} (mail #${statusInfo.last_sent_email_id})`,
                            { icon: '📜', duration: 6000 });
                        }} />
                    );
                  })}
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
        // CP4.3.1 — surface the group's per-cont rows so InvoiceRecipientModal
        // can compute the smart default for the BBBG attach checkbox. The
        // BBBG-preview instance below intentionally doesn't pass `bookings`
        // → checkbox hidden, attachBbbg stays at default true (irrelevant
        // for that flow anyway since it's just rendering a preview PDF).
        bookings={pendingMailContext?.group?.rows || null}
        onClose={() => setPendingMailContext(null)}
        onConfirm={(invoiceInfo, attachBbbg) => fireSend(invoiceInfo, attachBbbg)} />

      {/* CP4.2 — Separate modal mount for the "Xem BBBG" flow. Same modal
          component, different pending-context state + different onConfirm. */}
      <InvoiceRecipientModal
        isOpen={!!pendingBbbgContext}
        customer={job ? {
          name: job.customer_name,
          invoice_company: job.invoice_company_name,
          invoice_tax: job.invoice_tax_code,
          invoice_address: job.invoice_address,
        } : null}
        onClose={() => setPendingBbbgContext(null)}
        onConfirm={(invoiceInfo) => firePreviewBbbg(invoiceInfo)} />

      {/* CP5.2 — HỦY mail confirm. Renders the snapshot from email_history
          so DD sees what's about to be cancelled before firing the POST. */}
      <CancelMailConfirmModal
        isOpen={!!cancelTarget}
        transport={cancelTarget?.group ? {
          name: cancelTarget.group.transport_name,
          transport_company_id: cancelTarget.group.transport_company_id,
        } : null}
        bookings={cancelTarget?.statusInfo?.last_sent_snapshot || []}
        onClose={() => setCancelTarget(null)}
        onConfirm={({ reason }) => fireSendCancel({
          group: cancelTarget.group,
          statusInfo: cancelTarget.statusInfo,
          reason,
        })} />

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

function Vung1Table({ rows, job, isLcl, lotSummary, onUpdateRow, onOpenReceiver, canEditTicks }) {
  const impExp = job?.import_export;
  const inp = { padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4,
    fontSize: 12, width: '100%', minWidth: 0, boxSizing: 'border-box' };
  const td = { padding: '8px 8px', verticalAlign: 'middle', fontSize: 12, borderBottom: '1px solid var(--border)' };
  const th = { padding: '10px 8px', textAlign: 'left', fontWeight: 600,
    color: 'var(--text-2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em',
    background: 'var(--bg)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' };

  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 13,
        border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
        Chưa có kế hoạch xe — vào &quot;Đặt kế hoạch xe&quot; để tạo trước.
      </div>
    );
  }

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
            <th style={th} title="DD tick khi đã làm hóa đơn nâng hạ cho cont này">☑ Nâng hạ</th>
            <th style={th} title="DD tick khi đã nhập cost thực tế vào hệ thống nội bộ">☑ Cost HT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const noBooking = !r.booking_id;
            const hint = noBooking
              ? 'Cần đặt kế hoạch trước (nút Đặt kế hoạch xe)'
              : '';
            return (
              <tr key={r.booking_id ?? r.container_id} style={{ background: noBooking ? 'rgba(156,163,175,0.04)' : '#fff' }}>
                <td style={{ ...td, color: 'var(--text-2)', fontFamily: 'var(--font-display)',
                  fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {r.booking_code || '—'}
                </td>
                <td style={{ ...td, fontWeight: 600 }}>{isLcl ? lotSummary : (r.cont_number || '—')}</td>
                <td style={td}>{isLcl ? '—' : r.cont_type}</td>
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
                {/* CP6.1 — sign-off ticks. Gated on transport + vehicle present
                    AND user is DD. Otherwise show disabled checkbox with a
                    tooltip explaining why. */}
                {(() => {
                  const hasTransport = !!r.transport_company_id;
                  const hasVehicle = !!(r.vehicle_number && r.vehicle_number.trim());
                  const tickEnabled = !noBooking && hasTransport && hasVehicle && canEditTicks;
                  const tipMissing = !canEditTicks
                    ? 'Chỉ DD mới được tick'
                    : (!hasTransport || !hasVehicle)
                      ? 'Cần chốt vận tải và số xe trước'
                      : '';
                  return (
                    <>
                      <td style={{ ...td, textAlign: 'center' }} title={tipMissing}>
                        <input type="checkbox"
                          checked={!!r.invoice_lifting_ticked}
                          disabled={!tickEnabled}
                          style={{ cursor: tickEnabled ? 'pointer' : 'not-allowed' }}
                          onChange={e => onUpdateRow(idx, { invoice_lifting_ticked: e.target.checked })} />
                      </td>
                      <td style={{ ...td, textAlign: 'center' }} title={tipMissing}>
                        <input type="checkbox"
                          checked={!!r.cost_entered_ticked}
                          disabled={!tickEnabled}
                          style={{ cursor: tickEnabled ? 'pointer' : 'not-allowed' }}
                          onChange={e => onUpdateRow(idx, { cost_entered_ticked: e.target.checked })} />
                      </td>
                    </>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// CP5.2 — Status pill styles per spec.
const STATUS_PILL = {
  chua_gui:    { bg: 'rgba(107,114,128,0.12)', fg: '#6b7280', label: 'Chưa gửi' },
  da_gui:      { bg: 'rgba(34,197,94,0.12)',   fg: '#16a34a', label: '✅ Đã gửi' },
  co_thay_doi: { bg: 'rgba(217,119,6,0.14)',   fg: '#d97706', label: '⚠️ Có thay đổi sau gửi' },
  can_huy:     { bg: 'rgba(239,68,68,0.12)',   fg: '#ef4444', label: '🚫 Cần gửi mail HỦY' },
  da_huy:      { bg: 'rgba(75,85,99,0.16)',    fg: '#374151', label: '🚫 Đã hủy' },
};
function fmtSentTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit' });
}

function TransportCard({
  group, statusInfo, lotSummary,
  sending, canceling, loadingBbbg,
  onPreview, onSend, onPreviewBbbg, onCancelMail, onShowHistory,
}) {
  const status = statusInfo?.status || 'chua_gui';
  const pill = STATUS_PILL[status] || STATUS_PILL.chua_gui;
  const sentTime = fmtSentTime(statusInfo?.last_sent_at);
  // Diff summary for the co_thay_doi pill: "+1 cont, -2 cont"
  const diff = statusInfo?.diff;
  const diffSummary = diff
    ? [diff.added?.length ? `+${diff.added.length} cont` : null,
       diff.removed?.length ? `-${diff.removed.length} cont` : null]
        .filter(Boolean).join(', ')
    : '';

  const busy = sending || canceling || loadingBbbg;
  const isGhost = !!group.isGhost;
  // Snapshot rows for ghost cards (no current bookings) — show what the
  // carrier was originally promised so DD knows WHAT they're cancelling.
  const ghostList = isGhost ? (statusInfo?.last_sent_snapshot || []) : [];
  // CP5.3 — Đợt label. Forming batch (no mail_group_id) → "Đợt mới".
  // Sent batches use the backend-computed batch_number (1, 2, …).
  const isFormingBatch = group.mail_group_id == null;
  const batchLabel = isFormingBatch
    ? 'Đợt mới'
    : `Đợt ${statusInfo?.batch_number ?? '?'}`;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span>
          {group.transport_name}
          <span style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12,
            marginLeft: 6 }}>
            — {batchLabel}
          </span>
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 500 }}>
          {isGhost
            ? `${ghostList.length} cont (đã chuyển)`
            : `${group.rows.length} cont`}
        </span>
      </div>

      {/* Current rows (live transports) — empty for ghost cards. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {isGhost && ghostList.length > 0 ? (
          ghostList.map(b => (
            <div key={b.id} style={{ fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap',
              color: 'var(--text-3)', textDecoration: 'line-through' }}>
              <span style={{ padding: '1px 6px', background: 'rgba(107,114,128,0.14)',
                color: 'var(--text-2)', borderRadius: 4, fontWeight: 600,
                fontFamily: 'var(--font-display)', fontSize: 11 }}>
                {b.booking_code || '—'}
              </span>
              <span>
                {b.cont_type ? `${b.cont_number || '(chưa số)'} (${b.cont_type})` : (lotSummary || 'Cả lô')}
                {b.planned_datetime ? ` — ${fmtPlanned(b.planned_datetime)}` : ''}
                {b.delivery_location ? `, ${b.delivery_location}` : ''}
              </span>
            </div>
          ))
        ) : group.rows.map(r => (
          <div key={r.booking_id ?? r.container_id} style={{ fontSize: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ padding: '1px 6px', background: 'var(--primary-dim)',
              color: 'var(--primary)', borderRadius: 4, fontWeight: 600,
              fontFamily: 'var(--font-display)', fontSize: 11 }}>
              {r.booking_code || '—'}
            </span>
            <span style={{ color: 'var(--text)' }}>
              {r.cont_type ? `${r.cont_number || '(chưa số)'} (${r.cont_type})` : (lotSummary || 'Cả lô')}
              {r.planned_datetime ? ` — ${fmtPlanned(r.planned_datetime)}` : ''}
              {r.delivery_location ? `, ${r.delivery_location}` : ''}
              {r.cost ? `, ${Number(r.cost).toLocaleString('vi-VN')}đ` : ''}
            </span>
          </div>
        ))}
      </div>

      {/* CP5.2 — real status pill. */}
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 10,
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>Trạng thái:</span>
        <span style={{ background: pill.bg, color: pill.fg,
          padding: '2px 8px', borderRadius: 6, fontWeight: 600, fontSize: 11 }}>
          {pill.label}
          {status === 'da_gui' && sentTime ? ` (${sentTime})` : ''}
          {status === 'co_thay_doi' && diffSummary ? ` (${diffSummary})` : ''}
          {status === 'da_huy' && sentTime ? ` (${sentTime})` : ''}
        </span>
      </div>

      {/* CP5.2 — buttons per status. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {status === 'chua_gui' && (
          <>
            <button className="btn btn-primary btn-sm" onClick={onSend} disabled={busy}>
              {sending ? '⏳ Đang gửi...' : '📧 Gửi mail kế hoạch'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onPreview} disabled={busy}>
              👁 Xem mail
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onPreviewBbbg} disabled={busy}>
              {loadingBbbg ? '⏳ Đang tạo...' : '👁 Xem BBBG'}
            </button>
          </>
        )}

        {status === 'da_gui' && (
          <>
            <button className="btn btn-ghost btn-sm" onClick={onPreview} disabled={busy}>
              👁 Xem mail đã gửi
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onShowHistory} disabled={busy}>
              📜 Lịch sử
            </button>
          </>
        )}

        {status === 'co_thay_doi' && (
          <>
            <button className="btn btn-sm" onClick={onCancelMail} disabled={busy}
              style={{ background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}>
              {canceling ? '⏳ Đang gửi HỦY...' : '🚫 Gửi HỦY'}
            </button>
            <button className="btn btn-primary btn-sm" onClick={onSend} disabled={busy}>
              {sending ? '⏳ Đang gửi...' : '📧 Gửi MỚI'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onPreview} disabled={busy}>
              👁 Xem mail
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onPreviewBbbg} disabled={busy}>
              {loadingBbbg ? '⏳ Đang tạo...' : '👁 Xem BBBG'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onShowHistory} disabled={busy}>
              📜 Lịch sử
            </button>
          </>
        )}

        {status === 'can_huy' && (
          <>
            <button className="btn btn-sm" onClick={onCancelMail} disabled={busy}
              style={{ background: '#ef4444', color: '#fff', borderColor: '#ef4444' }}>
              {canceling ? '⏳ Đang gửi HỦY...' : '🚫 Gửi mail HỦY'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onShowHistory} disabled={busy}>
              📜 Lịch sử
            </button>
          </>
        )}

        {status === 'da_huy' && (
          <button className="btn btn-ghost btn-sm" onClick={onShowHistory} disabled={busy}>
            📜 Lịch sử
          </button>
        )}
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
