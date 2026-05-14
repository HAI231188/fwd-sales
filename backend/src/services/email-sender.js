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

function fmtDt(val) {
  if (!val) return '—';
  const d = new Date(val);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtCost(c) {
  if (c == null || c === '') return '—';
  const n = Number(c);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('vi-VN') + 'đ';
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

function renderSubject({ mailType, jobCode, n, transportName }) {
  if (mailType === 'cancel') {
    return `[HỦY kế hoạch giao xe] Job ${jobCode} - ${transportName}`;
  }
  return `[Kế hoạch giao xe] Job ${jobCode} - ${n} kế hoạch - ${transportName}`;
}

function renderBody({ mailType, transportName, bookings, senderDisplay }) {
  const lines = [];
  lines.push(`Kính gửi Quý nhà xe ${transportName},`);
  lines.push('');

  if (mailType === 'cancel') {
    lines.push('Chúng tôi xin thông báo HỦY các kế hoạch giao xe sau đây:');
    lines.push('');
    bookings.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.booking_code}] Cont ${b.cont_number || '(chưa số)'} (${b.cont_type})`);
      lines.push(`   - Ngày giờ đã chốt: ${fmtDt(b.planned_datetime)}`);
      lines.push(`   - Địa điểm: ${b.delivery_location || '—'}`);
      lines.push('');
    });
    lines.push('Lý do: Có thay đổi kế hoạch. Vui lòng KHÔNG sắp xếp xe cho các kế hoạch trên.');
    lines.push('');
    lines.push('Một kế hoạch mới sẽ được gửi trong email tiếp theo (nếu có).');
    lines.push('');
    lines.push('Xin lỗi vì sự bất tiện này.');
  } else {
    lines.push('Vui lòng sắp xếp xe cho các kế hoạch sau:');
    lines.push('');
    bookings.forEach((b, i) => {
      lines.push(`${i + 1}. [${b.booking_code}] Cont ${b.cont_number || '(chưa số)'} (${b.cont_type})`);
      lines.push(`   - Ngày giờ giao: ${fmtDt(b.planned_datetime)}`);
      lines.push(`   - Địa điểm giao: ${b.delivery_location || '—'}`);
      lines.push(`   - Cước chốt: ${fmtCost(b.cost)}`);
      lines.push(`   - Ghi chú: ${b.notes || '—'}`);
      lines.push('');
    });
    lines.push('Vui lòng xác nhận và báo SỐ XE sớm nhất có thể.');
    lines.push('');
    lines.push('Đính kèm: Biên bản bàn giao (sẽ có ở phase tiếp theo)');
  }
  lines.push('');
  lines.push('Trân trọng,');
  lines.push(senderDisplay || 'Điều độ');
  return lines.join('\n');
}

async function sendPlanningEmail({
  senderUserId, jobId, transportCompanyId, bookingIds, mailType,
}) {
  if (!['new', 'cancel'].includes(mailType)) {
    throw new Error('mailType phải là "new" hoặc "cancel"');
  }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    throw new Error('bookingIds rỗng — không có booking nào để gửi');
  }

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
  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  // ─── 4. Bookings + container info ──────────────────────────────────────
  // string_agg of cont numbers per booking (a booking can hold several conts).
  const { rows: bookings } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.transport_company_id, tb.transport_name,
           tb.planned_datetime, tb.delivery_location, tb.cost, tb.notes,
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
           ), '—') AS cont_type
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
  const subject = renderSubject({
    mailType, jobCode: job.job_code,
    n: bookings.length, transportName: tc.name,
  });
  const body = renderBody({
    mailType, transportName: tc.name, bookings,
    senderDisplay: sender.gmail_display_name,
  });

  // ─── 6. JSONB snapshot for "có thay đổi sau gửi" diff (CP5) ─────────────
  const snapshot = {
    bookings: bookings.map(b => ({
      id: b.id,
      booking_code: b.booking_code,
      cont_number: b.cont_number,
      cont_type: b.cont_type,
      planned_datetime: b.planned_datetime,
      delivery_location: b.delivery_location,
      cost: b.cost,
      transport_company_id: b.transport_company_id,
      transport_name: b.transport_name,
      vehicle_number: b.vehicle_number,
    })),
  };

  // ─── 7. Send via nodemailer (Gmail SMTP) ───────────────────────────────
  const transporter = nodemailer.createTransport({
    service: 'gmail',
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

module.exports = { sendPlanningEmail };
