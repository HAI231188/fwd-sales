// Phase 5 Step 3 Part 2 CP3 — Email sender service.
//
// One public function: sendPlanningEmail. Routes call it after auth + role
// validation; this layer handles the per-row business logic:
//   1. Load sender + decrypt Gmail app password.
//   2. Load transport company + parse email_cc (L16 JSON-array TEXT pattern).
//   3. Load job + bookings (filtered to booking_ids, scoped to job_id).
//   4. Render subject + body (Vietnamese, plain-text — HTML deferred).
//   5. Send via nodemailer over Gmail SMTP.
//   6. Log to email_history with status sent/failed + a JSONB snapshot
//      of the bookings so CP5 can diff against fresh state for the
//      "có thay đổi sau gửi" detection.
//
// Errors carry a `.code` when the caller should surface a specific HTTP
// status (NO_GMAIL_SETUP → 412, NO_TRANSPORT_EMAIL → 400). All other
// errors are 500-level.

const nodemailer = require('nodemailer');
const db = require('../db');
const enc = require('../utils/encryption');
// CP4.3 fix — generateSingleBookingBBBG is intentionally lazy-required inside
// sendPlanningEmail (see the attachments loop). A top-level destructure here
// caused a circular-dep bug: bbbg-pdf.js requires this file for
// SLB_INVOICE_INFO_EN, so when bbbg-pdf loaded first (via routes/jobs.js →
// buildBbbgPdf), email-sender's destructure ran while bbbg-pdf's
// module.exports was still {}. The function ended up bound to undefined and
// every BBBG send failed with "generateSingleBookingBBBG is not a function".
// By call time both modules are fully loaded and cached.

// Phase 5 Step 3 Part 2 CP3.5b — SLB's own legal info, exposed via
// GET /api/email/slb-invoice-info so the frontend invoice modal can pick
// "SLB Logistics" as the bên xuất hóa đơn nâng hạ option without hard-
// coding the same strings in JS.
const SLB_INVOICE_INFO = Object.freeze({
  company: 'CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB',
  tax: '0201743661',
  address: 'Tầng 8 Tòa nhà Diamond, Số 7 Lô 8A Đường Lê Hồng Phong, Phường Gia Viên, Thành phố Hải Phòng, Việt Nam',
});

// CP4.2.2 — English variant for the BBBG PDF (which goes to the customer for
// signature, international document). Mail body continues to use the Vietnamese
// SLB_INVOICE_INFO. The split is by destination, not by user choice — when the
// user picks "SLB Logistics" in InvoiceRecipientModal, backend overrides values
// from this constant for PDF and from SLB_INVOICE_INFO for mail.
const SLB_INVOICE_INFO_EN = Object.freeze({
  company: 'SLB GLOBAL LOGISTICS COMPANY LIMITED',
  tax: '0201743661',
  address: '8th Floor, Diamond Building, No 7 Lot 8A Le Hong Phong, Ngo Quyen, Hai Phong, Viet Nam',
});

function fmtDt(val) {
  if (!val) return '—';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// L19 — han_lenh meaning depends on jobs.import_export. For 'import' the value
// is a calendar date (date-only on UI); for 'export' it's a precise cutoff
// datetime. Same column, different format.
function fmtHanLenh(val, impExp) {
  if (!val) return '—';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  if (impExp === 'import') {
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function shortDate(val) {
  if (!val) return '';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}`;
}
function firstWord(s) {
  if (!s) return '';
  return String(s).trim().split(/\s+/)[0];
}
function fmtCost(c) {
  if (c == null || c === '') return '—';
  const n = Number(c);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('vi-VN') + 'đ';
}
function fmtWeight(w) {
  if (w == null || w === '') return '';
  const n = Number(w);
  if (!Number.isFinite(n) || n === 0) return '';
  // Drop trailing .00 if integer-equivalent.
  const s = Number.isInteger(n) ? String(n) : n.toString();
  return ` - ${s} tấn`;
}
// CP4.1 — Per-booking warehouse contact line. Emitted only when name OR phone
// is set; bbbg_note is intentionally NOT rendered (driver-only, BBBG PDF).
function receiverLine(b) {
  const name  = (b.receiver_name  || '').trim();
  const phone = (b.receiver_phone || '').trim();
  if (!name && !phone) return null;
  const nameOut  = name || '—';
  const phoneOut = phone ? ` - ${phone}` : '';
  return `   - 👤 Người liên hệ tại kho: ${nameOut}${phoneOut}`;
}
function parseCcList(raw) {
  if (!raw) return [];
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(p)
      ? p.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim())
      : [];
  } catch { return []; }
}

function renderSubject({ mailType, jobCode, customerName, n, importExport, earliestPlanned }) {
  const customerShort = firstWord(customerName);
  const ieLabel = importExport === 'import' ? 'Nhập' : 'Xuất';
  const dateLabel = shortDate(earliestPlanned);
  const prefix = mailType === 'cancel' ? 'HỦY ĐẶT KẾ HOẠCH XE' : 'ĐẶT KẾ HOẠCH XE';
  return `${prefix} ${jobCode} - ${customerShort} - ${n} cont / ${ieLabel} / ${dateLabel}`;
}

function renderBody({
  mailType, isReplacement,
  jobCode, customerName, shippingLine, hanLenh, importExport,
  invoiceInfo, bookings,
  // CP4.3 — number of BBBG PDFs attached. The send path passes the actual
  // generated count; the preview path passes bookings.length so the user
  // sees the right line. mailType='cancel' ignores this (no attachments).
  attachmentCount,
  // CP4.3.1 — when false, the "Đính kèm: N file BBBG..." line is omitted
  // entirely (no mention of attachments). Default true preserves CP4.3
  // behavior for callers that don't pass it.
  includeBbbgLine = true,
  // CP5.1 — free-text cancellation reason. Rendered as "Lý do hủy: …"
  // when present on a cancel mail; ignored on 'new' mails.
  reason = null,
}) {
  const lines = [];
  lines.push('Kính gửi anh/chị,');
  lines.push('');

  if (mailType === 'cancel') {
    // CP5.1 — cancel template rewrite. Body uses bookings_snapshot from the
    // historical 'new' mail (passed by the caller as `bookings`), so even if
    // the original truck_bookings have since been moved/deleted the carrier
    // still sees what they were originally asked to schedule.
    lines.push('⚠️ THÔNG BÁO HỦY KẾ HOẠCH ⚠️');
    lines.push('');
    lines.push(`SLB Logistics xin thông báo HỦY kế hoạch giao hàng đã gửi trước đó cho job ${jobCode}:`);
    lines.push('');
    bookings.forEach(b => {
      lines.push(`📦 [${b.booking_code}] Cont ${b.cont_number || '(chưa số)'} (${b.cont_type || '—'})`);
      lines.push(`   - Ngày giao đã đặt: ${fmtDt(b.planned_datetime)}`);
      lines.push(`   - Địa điểm: ${b.delivery_location || '—'}`);
      lines.push('');
    });
    const cleanReason = (typeof reason === 'string' ? reason.trim() : '');
    if (cleanReason) {
      lines.push(`Lý do hủy: ${cleanReason}`);
      lines.push('');
    }
    lines.push('Vui lòng KHÔNG sắp xếp xe cho kế hoạch này.');
    lines.push('');
    lines.push('Một kế hoạch MỚI sẽ được gửi trong email tiếp theo (nếu có).');
    lines.push('');
    lines.push('Trân trọng,');
    lines.push('Điều vận - SLB Logistics');
    return lines.join('\n');
  }

  // mailType === 'new'
  if (isReplacement) {
    lines.push('🆕 KẾ HOẠCH MỚI (THAY THẾ KẾ HOẠCH ĐÃ HỦY) 🆕');
    lines.push('');
    lines.push(`SLB Logistics gửi kế hoạch giao hàng CẬP NHẬT cho job ${jobCode} như sau, nhờ anh/chị sắp xếp:`);
  } else {
    lines.push('SLB Logistics gửi kế hoạch giao hàng như sau, nhờ anh/chị sắp xếp:');
  }
  lines.push('');
  lines.push(`📦 Tổng cộng: ${bookings.length} cont`);
  lines.push(`🏢 Khách hàng: ${customerName || '—'}`);
  lines.push(`🚢 Hãng tàu: ${shippingLine || '—'}`);
  lines.push(`📅 Hạn lệnh / Cutoff: ${fmtHanLenh(hanLenh, importExport)}`);
  lines.push('');
  // CP4.2.2 — when the user picked "SLB Logistics", force the Vietnamese
  // values regardless of what the frontend POSTed (it now displays English
  // text on the SLB option so the BBBG PDF can render in English — but the
  // mail body must stay Vietnamese for the Vietnamese-speaking carrier).
  const invForBody = invoiceInfo?.type === 'slb'
    ? { ...invoiceInfo, ...SLB_INVOICE_INFO }
    : invoiceInfo;

  if (invForBody && invForBody.company && invForBody.tax && invForBody.address) {
    lines.push('📋 Thông tin xuất hóa đơn nâng hạ:');
    lines.push(`   - Tên: ${invForBody.company}`);
    lines.push(`   - MST: ${invForBody.tax}`);
    lines.push(`   - Địa chỉ: ${invForBody.address}`);
  } else {
    // Preview path — invoiceInfo not chosen yet. The real send path always
    // passes a validated object so this branch only fires for previews.
    lines.push('📋 Thông tin xuất hóa đơn nâng hạ: (Sẽ chọn khi gửi)');
  }
  lines.push('');
  lines.push('📝 Chi tiết kế hoạch:');
  lines.push('');
  bookings.forEach((b, i) => {
    lines.push(`${i + 1}. [${b.booking_code}] Cont ${b.cont_number || '(chưa số)'} (${b.cont_type})${fmtWeight(b.weight_tons)}`);
    lines.push(`   - Ngày giờ giao: ${fmtDt(b.planned_datetime)}`);
    lines.push(`   - Địa điểm giao: ${b.delivery_location || '—'}`);
    lines.push(`   - Cước chốt: ${fmtCost(b.cost)}`);
    lines.push(`   - Ghi chú: ${b.note || b.notes || '—'}`);
    const rl = receiverLine(b);
    if (rl) lines.push(rl);
    lines.push('');
  });
  lines.push('Vui lòng xác nhận và báo SỐ XE sớm nhất có thể.');
  lines.push('');
  // CP4.3 — BBBG PDFs are now auto-attached, one file per booking. The exact
  // count is passed by the caller (send path = generated count, preview =
  // bookings.length). Fall back to bookings.length so the line is never blank.
  // CP4.3.1 — entirely omit the line when includeBbbgLine === false (DD
  // chose not to attach BBBG this round — placeholder mail to lock the
  // carrier before BBBG details are finalized).
  if (includeBbbgLine) {
    const nAttach = (attachmentCount != null) ? attachmentCount : bookings.length;
    lines.push(`Đính kèm: ${nAttach} file Biên bản bàn giao (mỗi container 1 file PDF — vui lòng in và đưa từng tài xế)`);
    lines.push('');
  }
  lines.push('Trân trọng,');
  lines.push('Điều vận - SLB Logistics');
  return lines.join('\n');
}

function validateInvoiceInfo(info) {
  if (!info || typeof info !== 'object') {
    throw new Error('Thiếu thông tin xuất hóa đơn');
  }
  const company = String(info.company || '').trim();
  const tax = String(info.tax || '').trim();
  const address = String(info.address || '').trim();
  if (!company || !tax || !address) {
    throw new Error('Thiếu thông tin xuất hóa đơn (cần đủ Tên, MST, Địa chỉ)');
  }
  // type is informational — accept any value, default 'custom'.
  return { type: info.type || 'custom', company, tax, address };
}

async function sendPlanningEmail({
  senderUserId, jobId, transportCompanyId, bookingIds, mailType,
  isReplacement = false, invoiceInfo,
  // CP4.3.1 — DD toggle for "attach BBBG PDFs". Default true for backwards
  // compat: existing callers + scripts keep the auto-attach behavior they
  // expect; the InvoiceRecipientModal explicitly threads this through.
  attachBbbg = true,
  // CP5.1 — cancel-flow overrides. When the caller supplies bookingsOverride
  // (an array of snapshot rows from a previous 'new' mail), the loader is
  // bypassed and the snapshot is used verbatim. This lets HỦY mails render
  // the historical state even after the originating bookings were moved or
  // deleted. `reason` is the free-text cancellation reason threaded into
  // renderBody.
  bookingsOverride = null,
  reason = null,
}) {
  if (!['new', 'cancel'].includes(mailType)) {
    throw new Error('mailType phải là "new" hoặc "cancel"');
  }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    throw new Error('bookingIds rỗng — không có booking nào để gửi');
  }
  // invoiceInfo is required for 'new' (body section needs it). For 'cancel'
  // we still validate so the call shape stays uniform — but the cancel
  // body doesn't render the invoice block, so callers can pass SLB defaults.
  const invoice = validateInvoiceInfo(invoiceInfo);

  // ─── 1. Sender + decrypt ────────────────────────────────────────────────
  const { rows: [sender] } = await db.query(
    `SELECT id, gmail_address, gmail_display_name, gmail_app_password_encrypted
       FROM users WHERE id = $1`,
    [senderUserId]
  );
  if (!sender) throw new Error('Không tìm thấy người gửi');
  if (!sender.gmail_address || !sender.gmail_app_password_encrypted) {
    const e = new Error('DD chưa setup Gmail, vui lòng vào /change-password');
    e.code = 'NO_GMAIL_SETUP';
    throw e;
  }
  if (!enc.isAvailable()) {
    throw new Error('Server chưa cấu hình mã hóa email (GMAIL_ENCRYPTION_KEY)');
  }
  let appPassword;
  try {
    appPassword = enc.decryptString(sender.gmail_app_password_encrypted);
  } catch (e) {
    throw new Error(
      'Không giải mã được app password (encryption key có thể đã rotate). ' +
      'Vui lòng nhập lại ở /change-password'
    );
  }

  // ─── 2. Transport company ───────────────────────────────────────────────
  const { rows: [tc] } = await db.query(
    `SELECT id, name, email, email_cc
       FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
    [transportCompanyId]
  );
  if (!tc) throw new Error('Không tìm thấy vận tải');
  const recipientEmail = (tc.email || '').trim();
  if (!recipientEmail) {
    const e = new Error('Vận tải chưa có email, vui lòng thêm trong /transport-companies');
    e.code = 'NO_TRANSPORT_EMAIL';
    throw e;
  }
  const ccList = parseCcList(tc.email_cc);

  // ─── 3. Job ────────────────────────────────────────────────────────────
  // shipping_line column doesn't exist yet on `jobs` — CP3.5b template
  // shows it as '—' if NULL. A later schema change can add the column
  // without touching this query (the COALESCE here will pick it up).
  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name, han_lenh, import_export, NULL::text AS shipping_line
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  // ─── 4. Bookings + container info ──────────────────────────────────────
  // CP5.1 — cancel flow short-circuits the DB load: when bookingsOverride is
  // supplied (historical snapshot from a previous 'new' mail), render that
  // verbatim. The historical truck_bookings rows may have been moved or
  // deleted by now, but the carrier needs to see what they were originally
  // told to schedule. The shape matches what renderBody's cancel branch
  // reads: booking_code / cont_number / cont_type / planned_datetime /
  // delivery_location.
  let bookings;
  if (Array.isArray(bookingsOverride) && bookingsOverride.length > 0) {
    bookings = bookingsOverride;
  } else {
  const { rows: rowsLoaded } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.transport_company_id, tb.transport_name,
           tb.planned_datetime, tb.delivery_location, tb.cost, tb.notes, tb.note,
           tb.receiver_name, tb.receiver_phone,
           tb.vehicle_number,
           COALESCE((
             SELECT string_agg(COALESCE(jc.cont_number, '(chưa số)'), ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id
           ), '(chưa có cont)') AS cont_number,
           COALESCE((
             SELECT string_agg(jc.cont_type, ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id
           ), '—') AS cont_type,
           NULLIF((
             SELECT string_agg(jc.weight_tons::text, ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id AND jc.weight_tons IS NOT NULL
           ), '') AS weight_tons
      FROM truck_bookings tb
     WHERE tb.id = ANY($1::int[])
       AND tb.job_id = $2
       AND tb.deleted_at IS NULL
     ORDER BY tb.id ASC
  `, [bookingIds, jobId]);
  bookings = rowsLoaded;
  }

  if (bookings.length === 0) {
    throw new Error('Không tìm thấy booking nào khớp với booking_ids cho job này');
  }

  // ─── 4b. CP4.3 — Generate BBBG PDF per booking (mailType='new' only). ─────
  // Each booking gets its own one-page PDF so the carrier can hand each file
  // to the driver of that container. Per-booking errors are logged but do
  // NOT abort the send — the mail still goes out with whatever attachments
  // succeeded; the caller surfaces a warning via the bbbgErrors return field.
  // Cancel mails carry no attachments.
  const attachments = [];
  const bbbgErrors = [];
  // CP4.3.1 — gate the attachment loop on the DD's checkbox decision. When
  // the user unticks "Đính kèm BBBG PDF", we skip generation entirely (no
  // wasted CPU rendering PDFs that won't be sent) AND drop the body line.
  if (mailType === 'new' && attachBbbg) {
    // Lazy require — see note at the top of this file. Resolves to the fully
    // populated bbbg-pdf module at request time, dodging the circular-load
    // window that produced undefined at module-init time.
    const { generateSingleBookingBBBG } = require('./bbbg-pdf');
    for (const booking of bookings) {
      try {
        const pdfBuffer = await generateSingleBookingBBBG({
          jobId, transportCompanyId, bookingId: booking.id,
          invoiceInfo: invoice,
          creatorName: sender.gmail_display_name || '',
        });
        const bookingShort = (booking.booking_code || '').replace(/^KH-/, '')
          || `BK${booking.id}`;
        const contRaw = (booking.cont_number || 'NOCONT')
          .replace(/[^A-Za-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'NOCONT';
        const filename = `BBBG_${bookingShort}_${contRaw}.pdf`;
        attachments.push({
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        });
      } catch (err) {
        console.error(`[bbbg] gen failed booking #${booking.id}:`, err.message);
        bbbgErrors.push({
          booking_id: booking.id,
          booking_code: booking.booking_code,
          error: err.message,
        });
      }
    }
  }

  // ─── 5. Render ──────────────────────────────────────────────────────────
  // Earliest planned_datetime across the bookings → dd/MM subject suffix.
  const earliestPlanned = bookings
    .map(b => b.planned_datetime)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0];

  const subject = renderSubject({
    mailType,
    jobCode: job.job_code,
    customerName: job.customer_name,
    n: bookings.length,
    importExport: job.import_export,
    earliestPlanned,
  });
  const body = renderBody({
    mailType,
    isReplacement: !!isReplacement,
    jobCode: job.job_code,
    customerName: job.customer_name,
    shippingLine: job.shipping_line,
    hanLenh: job.han_lenh,
    importExport: job.import_export,
    invoiceInfo: invoice,
    bookings,
    // The body's "Đính kèm: N file..." line uses the ACTUAL generated count
    // — if a per-booking PDF failed, the body honestly reflects what made it
    // to the recipient. Cancel mails ignore this param.
    attachmentCount: attachments.length,
    // CP4.3.1 — track the DD's checkbox choice into the body. When the
    // attach loop was skipped (attachBbbg=false), this is false too, so the
    // body drops the "Đính kèm" line entirely.
    includeBbbgLine: attachBbbg,
    // CP5.1 — free-text reason on cancel mails. Ignored for mailType='new'.
    reason,
  });

  // ─── 6. JSONB snapshot for "có thay đổi sau gửi" diff + cancel render ───
  // CP5.1 — new shape. Top-level `booking_ids` is the canonical signal that
  // email-status.js's diff logic reads. `bookings_snapshot` keeps the per-
  // booking fields the cancel template needs to render the historical
  // bookings even after they've been moved/deleted in current state.
  const snapshot = {
    booking_ids: bookings.map(b => Number(b.id)).filter(Number.isFinite),
    transport_company_id: transportCompanyId,
    job_id: jobId,
    mailType,
    isReplacement: !!isReplacement,
    invoiceInfo: invoice,
    bookings_snapshot: bookings.map(b => ({
      id: b.id,
      booking_code: b.booking_code,
      cont_number: b.cont_number,
      cont_type: b.cont_type,
      planned_datetime: b.planned_datetime,
      delivery_location: b.delivery_location,
    })),
  };

  // ─── 7. Send via nodemailer (Gmail SMTP) ───────────────────────────────
  // Gmail SMTP over STARTTLS on 587 instead of implicit-TLS on 465. Railway's
  // egress blocks/times-out outbound 465 (we saw "Connection timeout" after
  // family:4 fixed the IPv6 hop); 587 is the more permissive port and goes
  // through cleanly. End-to-end TLS is the same — secure:false + requireTLS:
  // true means "connect plain, upgrade via STARTTLS, refuse to proceed if
  // the upgrade can't be negotiated".
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    family: 4,            // keep IPv4 force from the prior fix
    auth: { user: sender.gmail_address, pass: appPassword },
  });
  const fromAddress = sender.gmail_display_name
    ? `"${sender.gmail_display_name}" <${sender.gmail_address}>`
    : sender.gmail_address;

  let status = 'sent';
  let errorMessage = null;
  try {
    await transporter.sendMail({
      from: fromAddress,
      to: recipientEmail,
      cc: ccList.length ? ccList : undefined,
      subject,
      text: body,
      attachments,
    });
  } catch (e) {
    status = 'failed';
    errorMessage = e?.message || String(e);
  }

  // CP4.3 — when the send itself succeeded but some BBBG PDFs failed to
  // generate, surface that in error_message as a warning blob alongside any
  // SMTP error. Always serializable JSON; never overwrites a real SMTP error.
  if (status === 'sent' && bbbgErrors.length > 0) {
    errorMessage = JSON.stringify({ bbbg_partial_failure: bbbgErrors });
  }

  // ─── 8. Log to email_history (both sent + failed paths) ────────────────
  const { rows: [hist] } = await db.query(`
    INSERT INTO email_history (
      sender_user_id, sender_email, sender_display_name,
      recipient_transport_company_id, recipient_email, recipient_cc,
      job_id, booking_ids, mail_type,
      subject, body, bbbg_attached,
      status, error_message, last_sent_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id, created_at
  `, [
    sender.id, sender.gmail_address, sender.gmail_display_name,
    tc.id, recipientEmail, JSON.stringify(ccList),
    job.id, bookingIds, mailType,
    subject, body, attachments.length > 0,
    status, errorMessage, JSON.stringify(snapshot),
  ]);

  if (status === 'failed') {
    const e = new Error(errorMessage || 'Gửi mail thất bại');
    e.email_history_id = hist.id;
    throw e;
  }

  return {
    success: true,
    email_history_id: hist.id,
    sent_at: hist.created_at,
    recipient_email: recipientEmail,
    cc: ccList,
    subject,
    attachmentCount: attachments.length,
    bbbgErrors: bbbgErrors.length ? bbbgErrors : null,
  };
}

// ─── previewPlanningEmail ─────────────────────────────────────────────────────
// Mirrors sendPlanningEmail's data-load but skips Gmail decrypt, nodemailer
// send, and email_history insert. invoice_info is OPTIONAL — when missing,
// renderBody emits a "Sẽ chọn khi gửi" placeholder so the preview is useful
// before the user has picked the invoice recipient.
//
// Returns { subject, body, recipient_email, cc }.
async function previewPlanningEmail({
  senderUserId, jobId, transportCompanyId, bookingIds, mailType,
  isReplacement = false, invoiceInfo,
  // CP4.3.1 — preview defaults to attachBbbg=true so the user always sees
  // the "Đính kèm" line in the preview pane. Frontend "Xem mail" button
  // doesn't expose the toggle (decision: keep preview simple).
  attachBbbg = true,
}) {
  if (!['new', 'cancel'].includes(mailType)) {
    throw new Error('mailType phải là "new" hoặc "cancel"');
  }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    throw new Error('bookingIds rỗng — không có booking nào để preview');
  }

  // Sender — only the display_name is read from the row; we don't need to
  // validate the Gmail setup or decrypt for a preview render.
  const { rows: [sender] } = await db.query(
    `SELECT id, gmail_display_name FROM users WHERE id = $1`,
    [senderUserId]
  );
  if (!sender) throw new Error('Không tìm thấy người gửi');

  // Transport — load name + email + email_cc. Soft on email: render even
  // when no email is set (the preview row shows "(chưa có)").
  const { rows: [tc] } = await db.query(
    `SELECT id, name, email, email_cc
       FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
    [transportCompanyId]
  );
  if (!tc) throw new Error('Không tìm thấy vận tải');
  const recipientEmail = (tc.email || '').trim();
  const ccList = parseCcList(tc.email_cc);

  // Job + bookings — identical query to send path.
  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name, han_lenh, import_export, NULL::text AS shipping_line
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  const { rows: bookings } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.transport_company_id, tb.transport_name,
           tb.planned_datetime, tb.delivery_location, tb.cost, tb.notes, tb.note,
           tb.receiver_name, tb.receiver_phone,
           tb.vehicle_number,
           COALESCE((
             SELECT string_agg(COALESCE(jc.cont_number, '(chưa số)'), ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id
           ), '(chưa có cont)') AS cont_number,
           COALESCE((
             SELECT string_agg(jc.cont_type, ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id
           ), '—') AS cont_type,
           NULLIF((
             SELECT string_agg(jc.weight_tons::text, ', ' ORDER BY jc.id)
               FROM truck_booking_containers tbc
               JOIN job_containers jc ON jc.id = tbc.container_id
              WHERE tbc.booking_id = tb.id AND jc.weight_tons IS NOT NULL
           ), '') AS weight_tons
      FROM truck_bookings tb
     WHERE tb.id = ANY($1::int[])
       AND tb.job_id = $2
       AND tb.deleted_at IS NULL
     ORDER BY tb.id ASC
  `, [bookingIds, jobId]);

  if (bookings.length === 0) {
    throw new Error('Không tìm thấy booking nào khớp với booking_ids cho job này');
  }

  // Normalize invoiceInfo: pass an object only when all 3 fields are non-empty.
  // Otherwise pass null so renderBody emits the placeholder.
  let normalizedInvoice = null;
  if (invoiceInfo
      && String(invoiceInfo.company || '').trim()
      && String(invoiceInfo.tax || '').trim()
      && String(invoiceInfo.address || '').trim()) {
    normalizedInvoice = {
      type: invoiceInfo.type || 'custom',
      company: String(invoiceInfo.company).trim(),
      tax: String(invoiceInfo.tax).trim(),
      address: String(invoiceInfo.address).trim(),
    };
  }

  const earliestPlanned = bookings
    .map(b => b.planned_datetime)
    .filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0];

  const subject = renderSubject({
    mailType,
    jobCode: job.job_code,
    customerName: job.customer_name,
    n: bookings.length,
    importExport: job.import_export,
    earliestPlanned,
  });
  const body = renderBody({
    mailType,
    isReplacement: !!isReplacement,
    jobCode: job.job_code,
    customerName: job.customer_name,
    shippingLine: job.shipping_line,
    hanLenh: job.han_lenh,
    importExport: job.import_export,
    invoiceInfo: normalizedInvoice,
    bookings,
    // CP4.3 — preview mirrors the send-path body's "Đính kèm: N file..." line
    // by passing bookings.length here. Preview doesn't actually generate PDFs.
    attachmentCount: bookings.length,
    // CP4.3.1 — preview honors the attachBbbg flag, but the frontend
    // "Xem mail" path doesn't pass one, so it defaults to true and the
    // preview always shows the line.
    includeBbbgLine: attachBbbg,
  });

  return {
    subject,
    body,
    recipient_email: recipientEmail || null,
    cc: ccList,
    transport_name: tc.name,
    has_invoice_info: !!normalizedInvoice,
  };
}

module.exports = { sendPlanningEmail, previewPlanningEmail, SLB_INVOICE_INFO, SLB_INVOICE_INFO_EN };
