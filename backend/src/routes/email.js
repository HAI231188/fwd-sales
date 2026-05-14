// /api/email — planning-email send + history.
//
// Phase 5 Step 3 Part 2 CP3:
//   POST /send-planning  — DD/TPL trigger a single send to one transport.
//   GET  /history?job_id — DD/TPL/lead read the per-job audit trail.
//
// Status logic ("Đã gửi" / "Có thay đổi sau gửi" / "Cần gửi HỦY") and the
// BBBG PDF attachment are explicitly deferred to CP4 + CP5.

const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  sendPlanningEmail, previewPlanningEmail, SLB_INVOICE_INFO,
} = require('../services/email-sender');

const SEND_ROLES = ['dieu_do', 'truong_phong_log'];
const READ_ROLES = ['dieu_do', 'truong_phong_log', 'lead'];
const INVOICE_TYPES = ['customer', 'slb', 'custom'];

// ─── POST /api/email/send-planning ─────────────────────────────────────────────
router.post('/send-planning', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền gửi mail' });
  }

  const {
    job_id, transport_company_id, booking_ids, mail_type,
    invoice_info, is_replacement,
  } = req.body || {};

  // Basic shape validation (the service does the heavier checks).
  const jobId = parseInt(job_id, 10);
  const tcId = parseInt(transport_company_id, 10);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'job_id không hợp lệ' });
  }
  if (!Number.isFinite(tcId)) {
    return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
  }
  if (!Array.isArray(booking_ids) || booking_ids.length === 0) {
    return res.status(400).json({ error: 'booking_ids rỗng' });
  }
  if (!['new', 'cancel'].includes(mail_type)) {
    return res.status(400).json({ error: 'mail_type phải là "new" hoặc "cancel"' });
  }
  const bookingIds = booking_ids
    .map(x => parseInt(x, 10))
    .filter(Number.isFinite);
  if (bookingIds.length !== booking_ids.length) {
    return res.status(400).json({ error: 'booking_ids có giá trị không hợp lệ' });
  }

  // ─── invoice_info validation (CP3.5b) ────────────────────────────────────
  if (!invoice_info || typeof invoice_info !== 'object') {
    return res.status(400).json({ error: 'Thiếu thông tin xuất hóa đơn' });
  }
  if (!INVOICE_TYPES.includes(invoice_info.type)) {
    return res.status(400).json({
      error: `Loại bên xuất hóa đơn phải là ${INVOICE_TYPES.join(' / ')}`,
    });
  }
  const invCompany = String(invoice_info.company || '').trim();
  const invTax = String(invoice_info.tax || '').trim();
  const invAddress = String(invoice_info.address || '').trim();
  if (!invCompany || !invTax || !invAddress) {
    return res.status(400).json({ error: 'Thiếu thông tin xuất hóa đơn (Tên / MST / Địa chỉ)' });
  }

  // Pre-flight: caller's Gmail setup must be complete. The service throws
  // NO_GMAIL_SETUP anyway, but doing this here gives a friendly 412 without
  // touching nodemailer or the transport row.
  try {
    const { rows: [u] } = await db.query(
      `SELECT (gmail_address IS NOT NULL
               AND gmail_app_password_encrypted IS NOT NULL) AS ready
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!u?.ready) {
      return res.status(412).json({
        error: 'Vui lòng setup Gmail trong /change-password',
        code: 'NO_GMAIL_SETUP',
      });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const result = await sendPlanningEmail({
      senderUserId: req.user.id,
      jobId, transportCompanyId: tcId,
      bookingIds, mailType: mail_type,
      isReplacement: !!is_replacement,
      invoiceInfo: {
        type: invoice_info.type,
        company: invCompany,
        tax: invTax,
        address: invAddress,
      },
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/email/send-planning error:', err.message);
    if (err.code === 'NO_GMAIL_SETUP') {
      return res.status(412).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NO_TRANSPORT_EMAIL') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({
      error: err.message,
      email_history_id: err.email_history_id,  // present when nodemailer failed (logged as failed)
    });
  }
});

// ─── GET /api/email/history?job_id=X ──────────────────────────────────────────
// Returns ordered DESC. `body` is intentionally omitted — drilldown UI uses
// the subject + status + timestamp; CP5 will add a "view full body" sheet
// that lazy-fetches the body for a single row.
router.get('/history', requireAuth, async (req, res) => {
  if (!READ_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền xem lịch sử' });
  }
  const jobId = parseInt(req.query.job_id, 10);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'job_id là bắt buộc' });
  }
  try {
    const { rows } = await db.query(`
      SELECT id, sender_user_id, sender_email, sender_display_name,
             recipient_transport_company_id, recipient_email, recipient_cc,
             job_id, booking_ids, mail_type,
             subject, status, error_message, bbbg_attached, created_at
        FROM email_history
       WHERE job_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
    `, [jobId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/email/history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/email/preview-planning ────────────────────────────────────────
// Renders subject + body using the same template as send-planning, but does
// NOT send via SMTP and does NOT write to email_history. invoice_info is
// OPTIONAL — when omitted, the body shows a "(Sẽ chọn khi gửi)" placeholder.
// Same auth as send (DD + TPL) so a CUS/lead preview wouldn't bypass the
// send-side role gate.
router.post('/preview-planning', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }

  const { job_id, transport_company_id, booking_ids, mail_type,
          invoice_info, is_replacement } = req.body || {};

  const jobId = parseInt(job_id, 10);
  const tcId = parseInt(transport_company_id, 10);
  if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'job_id không hợp lệ' });
  if (!Number.isFinite(tcId)) return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
  if (!Array.isArray(booking_ids) || booking_ids.length === 0) {
    return res.status(400).json({ error: 'booking_ids rỗng' });
  }
  if (!['new', 'cancel'].includes(mail_type)) {
    return res.status(400).json({ error: 'mail_type phải là "new" hoặc "cancel"' });
  }
  const bookingIds = booking_ids.map(x => parseInt(x, 10)).filter(Number.isFinite);
  if (bookingIds.length !== booking_ids.length) {
    return res.status(400).json({ error: 'booking_ids có giá trị không hợp lệ' });
  }

  // invoice_info validation is intentionally LIGHT here. If the caller
  // passes a partial / missing object, the service renders the placeholder.
  // If the caller passes invoice_info with the wrong shape, drop the fields
  // we can't trust and treat as missing.
  let normalizedInvoice = null;
  if (invoice_info && typeof invoice_info === 'object') {
    const c = String(invoice_info.company || '').trim();
    const t = String(invoice_info.tax || '').trim();
    const a = String(invoice_info.address || '').trim();
    if (c && t && a) normalizedInvoice = { type: invoice_info.type || 'custom', company: c, tax: t, address: a };
  }

  try {
    const result = await previewPlanningEmail({
      senderUserId: req.user.id,
      jobId, transportCompanyId: tcId,
      bookingIds, mailType: mail_type,
      isReplacement: !!is_replacement,
      invoiceInfo: normalizedInvoice,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/email/preview-planning error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/email/slb-invoice-info ──────────────────────────────────────────
// Exposes SLB's own legal info so the frontend invoice modal can offer
// "SLB Logistics" as a one-click pick without hardcoding the strings in JS.
// DD + TPL + lead can read.
router.get('/slb-invoice-info', requireAuth, (req, res) => {
  if (!READ_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  res.json({ ...SLB_INVOICE_INFO, type: 'slb' });
});

module.exports = router;
