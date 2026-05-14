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

// Phase 5 Step 3 Part 2 CP3.5b — SLB's own legal info, exposed via
// GET /api/email/slb-invoice-info so the frontend invoice modal can pick
// "SLB Logistics" as the bên xuất hóa đơn nâng hạ option without hard-
// coding the same strings in JS.
const SLB_INVOICE_INFO = Object.freeze({
  company: 'CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB',
  tax: '0201743661',
  address: 'Tầng 8 Tòa nhà Diamond, Số 7 Lô 8A Đường Lê Hồng Phong, Phường Gia Viên, Thành phố Hải Phòng, Việt Nam',
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
}) {
  const lines = [];
  lines.push('Kính gửi anh/chị,');
  lines.push('');

  if (mailType === 'cancel') {
    lines.push('⚠️ THÔNG BÁO HỦY KẾ HOẠCH ⚠️');
    lines.push('');
    lines.push(`SLB Logistics xin HỦY các kế hoạch giao xe sau đây cho job ${jobCode}:`);
    lines.push('');
    bookings.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.booking_code}] Cont ${b.cont_number || '(chưa số)'} (${b.cont_type})`);
      lines.push(`   - Ngày giờ đã chốt: ${fmtDt(b.planned_datetime)}`);
      lines.push(`   - Địa điểm: ${b.delivery_location || '—'}`);
      lines.push('');
    });
    lines.push('Lý do: Có thay đổi kế hoạch.');
    lines.push('');
    lines.push('Vui lòng KHÔNG sắp xếp xe theo các kế hoạch trên.');
    lines.push('');
    lines.push('Nếu có kế hoạch mới thay thế, sẽ được gửi trong email tiếp theo.');
    lines.push('');
    lines.push('Xin lỗi vì sự bất tiện này.');
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
  if (invoiceInfo && invoiceInfo.company && invoiceInfo.tax && invoiceInfo.address) {
    lines.push('📋 Thông tin xuất hóa đơn nâng hạ:');
    lines.push(`   - Tên: ${invoiceInfo.company}`);
    lines.push(`   - MST: ${invoiceInfo.tax}`);
    lines.push(`   - Địa chỉ: ${invoiceInfo.address}`);
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
    lines.push('');
  });
  lines.push('Vui lòng xác nhận và báo SỐ XE sớm nhất có thể.');
  lines.push('');
  lines.push('Đính kèm: Biên bản bàn giao (đang phát triển)');
  lines.push('');
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
  // string_agg of cont numbers / types / weights per booking. Multi-cont
  // bookings show all three as comma-separated lists; single-cont bookings
  // (the common Phase 5 Step 2 batch pattern) render as a single value
  // each. weight_tons is aggregated only when at least one container has a
  // non-null weight — fmtWeight() drops the suffix when the joined string
  // is empty.
  const { rows: bookings } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.transport_company_id, tb.transport_name,
           tb.planned_datetime, tb.delivery_location, tb.cost, tb.notes, tb.note,
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
  });

  // ─── 6. JSONB snapshot for "có thay đổi sau gửi" diff (CP5) ─────────────
  const snapshot = {
    bookings: bookings.map(b => ({
      id: b.id,
      booking_code: b.booking_code,
      cont_number: b.cont_number,
      cont_type: b.cont_type,
      weight_tons: b.weight_tons,
      planned_datetime: b.planned_datetime,
      delivery_location: b.delivery_location,
      cost: b.cost,
      transport_company_id: b.transport_company_id,
      transport_name: b.transport_name,
      vehicle_number: b.vehicle_number,
    })),
    invoiceInfo: invoice,
    isReplacement: !!isReplacement,
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
    });
  } catch (e) {
    status = 'failed';
    errorMessage = e?.message || String(e);
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
    subject, body, false,
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

module.exports = { sendPlanningEmail, previewPlanningEmail, SLB_INVOICE_INFO };
