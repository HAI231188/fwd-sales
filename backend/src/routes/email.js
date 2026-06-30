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
const { generateMultiBookingBBBG } = require('../services/bbbg-pdf');
const { getMailStatusPerTransport } = require('../services/email-status');
const multer = require('multer');

const SEND_ROLES = ['dieu_do', 'truong_phong_log'];
const READ_ROLES = ['dieu_do', 'truong_phong_log', 'lead'];
const INVOICE_TYPES = ['customer', 'slb', 'custom'];

// ─── Manual attachment upload — send-planning ONLY ───────────────────────────
// DD can attach EXTRA files to the carrier mail at send time, ALONGSIDE the
// auto-generated BBBG PDFs. Files are held in memory (multer.memoryStorage),
// attached to nodemailer's attachments[] array, sent, then discarded when the
// request ends — NEVER written to disk, DB, or email_history content.
// Limits: ≤10 files, ≤15MB TOTAL. ANY file type (no mimetype whitelist).
const ATTACH_MAX_FILES = 10;
const ATTACH_MAX_TOTAL_BYTES = 15 * 1024 * 1024; // 15MB
const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  // fileSize is multer's PER-FILE ceiling; the cumulative ≤15MB cap is enforced
  // in the handler (multer has no native total-size limit). 15MB per file is
  // the natural upper bound since the total can't exceed it anyway.
  limits: { fileSize: ATTACH_MAX_TOTAL_BYTES, files: ATTACH_MAX_FILES },
}).array('attachments', ATTACH_MAX_FILES);

// Wrap multer so its errors surface as a clear Vietnamese 400 instead of
// bubbling to the generic error handler. multer is a no-op on non-multipart
// requests (it calls next() immediately), so existing JSON callers — including
// any direct API client from before this shipped — pass straight through.
function handleAttachmentUpload(req, res, next) {
  uploadAttachments(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Tổng dung lượng file đính kèm vượt 15MB' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Tối đa 10 file đính kèm' });
      }
      return res.status(400).json({ error: `Lỗi tải file đính kèm: ${err.message}` });
    }
    next();
  });
}

// ─── POST /api/email/send-planning ─────────────────────────────────────────────
router.post('/send-planning', requireAuth, handleAttachmentUpload, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền gửi mail' });
  }

  let {
    job_id, transport_company_id, booking_ids, mail_type,
    invoice_info, is_replacement,
    // CP4.3.1 — DD checkbox decision threaded from InvoiceRecipientModal.
    // Default true so older clients (and any direct API caller from before
    // this CP shipped) keep the auto-attach behavior.
    attach_bbbg,
  } = req.body || {};

  // Multipart (file-attached) requests deliver every field as a string, so the
  // client JSON.stringifies the structured ones. Parse them back when string;
  // plain-JSON callers (no files) already receive arrays/objects/booleans.
  if (typeof booking_ids === 'string') {
    try { booking_ids = JSON.parse(booking_ids); } catch { /* leave as-is → validation 400s below */ }
  }
  if (typeof invoice_info === 'string') {
    try { invoice_info = JSON.parse(invoice_info); } catch { invoice_info = null; }
  }
  // Booleans arrive as 'true'/'false' strings over multipart. is_replacement
  // is truthy only on an explicit true; attach_bbbg keeps its default-true
  // semantics (only an explicit false — bool or string — turns it off).
  const isReplacement = (is_replacement === true || is_replacement === 'true');
  const attachBbbg = !(attach_bbbg === false || attach_bbbg === 'false');

  // Manual attachments — buffers held in memory by multer, discarded when this
  // request ends. multer already capped count + per-file size; enforce the
  // cumulative ≤15MB cap here (multer has no native total-size limit).
  const extraAttachments = (req.files || []).map(f => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));
  if (extraAttachments.length > ATTACH_MAX_FILES) {
    return res.status(400).json({ error: 'Tối đa 10 file đính kèm' });
  }
  const totalAttachBytes = (req.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalAttachBytes > ATTACH_MAX_TOTAL_BYTES) {
    return res.status(400).json({ error: 'Tổng dung lượng file đính kèm vượt 15MB' });
  }

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
      isReplacement,
      invoiceInfo: {
        type: invoice_info.type,
        company: invCompany,
        tax: invTax,
        address: invAddress,
      },
      // CP4.3.1 — coerced above (handles multipart 'false' string too).
      attachBbbg,
      // Manual user-uploaded files (in-memory, never persisted). [] when none.
      extraAttachments,
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
          invoice_info, is_replacement,
          // CP4.3.1 — optional, defaults true. The "Xem mail" UI doesn't
          // pass this so the preview always shows the "Đính kèm" line.
          attach_bbbg,
        } = req.body || {};

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
      attachBbbg: attach_bbbg !== false,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/email/preview-planning error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/email/preview-bbbg ────────────────────────────────────────────
// CP4.2 — Render BBBG PDF for ALL bookings in a transport group at once.
// Same body shape as /preview-planning + /send-planning, but the response is
// binary application/pdf (inline disposition so window.open() in the browser
// loads it directly in the built-in PDF viewer).
//
// Same role gate as /send-planning (DD + TPL). invoice_info is REQUIRED here
// because the BBBG section "Thông tin xuất hóa đơn nâng hạ" needs all 3
// fields — the preview-bbbg flow always opens InvoiceRecipientModal first
// on the frontend, so a caller without it is a bug we want to fail loud on.
router.post('/preview-bbbg', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }

  const { job_id, transport_company_id, booking_ids, invoice_info } = req.body || {};

  const jobId = parseInt(job_id, 10);
  const tcId  = parseInt(transport_company_id, 10);
  if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'job_id không hợp lệ' });
  if (!Number.isFinite(tcId))  return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
  if (!Array.isArray(booking_ids) || booking_ids.length === 0) {
    return res.status(400).json({ error: 'booking_ids rỗng' });
  }
  const bookingIds = booking_ids.map(x => parseInt(x, 10)).filter(Number.isFinite);
  if (bookingIds.length !== booking_ids.length) {
    return res.status(400).json({ error: 'booking_ids có giá trị không hợp lệ' });
  }
  if (!invoice_info || typeof invoice_info !== 'object') {
    return res.status(400).json({ error: 'Thiếu thông tin xuất hóa đơn' });
  }
  if (!INVOICE_TYPES.includes(invoice_info.type)) {
    return res.status(400).json({
      error: `Loại bên xuất hóa đơn phải là ${INVOICE_TYPES.join(' / ')}`,
    });
  }
  const invCompany = String(invoice_info.company || '').trim();
  const invTax     = String(invoice_info.tax || '').trim();
  const invAddress = String(invoice_info.address || '').trim();
  if (!invCompany || !invTax || !invAddress) {
    return res.status(400).json({ error: 'Thiếu thông tin xuất hóa đơn (Tên / MST / Địa chỉ)' });
  }

  try {
    // Read job_code + transport short-name once for the filename. The PDF
    // service does its own job/tc reads — this duplicate read is cheap and
    // keeps the route in charge of HTTP headers.
    const { rows: [job] } = await db.query(
      `SELECT id, job_code FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [jobId]
    );
    if (!job) return res.status(404).json({ error: 'Không tìm thấy job' });
    const { rows: [tc] } = await db.query(
      `SELECT id, name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`, [tcId]
    );
    if (!tc) return res.status(404).json({ error: 'Không tìm thấy vận tải' });

    const pdfBuffer = await generateMultiBookingBBBG({
      jobId, transportCompanyId: tcId, bookingIds,
      invoiceInfo: {
        type: invoice_info.type, company: invCompany,
        tax: invTax, address: invAddress,
      },
      creatorName: req.user?.name || '',
    });

    const safeJobCode = (job.job_code || `${job.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeTcName  = (tc.name || `tc${tc.id}`)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
    const filename = `BBBG_${safeJobCode}_${safeTcName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('POST /api/email/preview-bbbg error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/email/send-cancel-planning ────────────────────────────────────
// CP5.1 — send a HỦY mail to one transport company on a job. Looks up the
// most recent successful 'new' mail to that (job, transport), pulls its
// bookings_snapshot, and replays it as a cancel mail. No PDF attachments.
//
// Body: { job_id, transport_company_id, last_sent_email_id?, reason? }
// last_sent_email_id is optional — when supplied, scope-validates that the
// row belongs to this (job, transport). Otherwise the route picks the
// latest 'sent new' row itself.
//
// Auth: same DD + TPL gate as send-planning.
router.post('/send-cancel-planning', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền gửi mail' });
  }

  const { job_id, transport_company_id, last_sent_email_id, reason } = req.body || {};
  const jobId = parseInt(job_id, 10);
  const tcId  = parseInt(transport_company_id, 10);
  if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'job_id không hợp lệ' });
  if (!Number.isFinite(tcId))  return res.status(400).json({ error: 'transport_company_id không hợp lệ' });
  const lastIdRaw = last_sent_email_id != null ? parseInt(last_sent_email_id, 10) : null;
  if (last_sent_email_id != null && !Number.isFinite(lastIdRaw)) {
    return res.status(400).json({ error: 'last_sent_email_id không hợp lệ' });
  }

  try {
    // Gmail pre-flight (mirrors /send-planning) so the user gets a 412 with
    // an actionable redirect instead of a generic 500.
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

    // Look up the source 'new' row. If the caller passed an explicit id we
    // scope-validate it; otherwise we pick the latest sent 'new' for this
    // (job, transport).
    const baseQuery = `
      SELECT id, last_sent_data, booking_ids
        FROM email_history
       WHERE job_id = $1
         AND recipient_transport_company_id = $2
         AND mail_type = 'new'
         AND status = 'sent'
         AND deleted_at IS NULL
    `;
    const { rows: [hist] } = lastIdRaw
      ? await db.query(`${baseQuery} AND id = $3 LIMIT 1`, [jobId, tcId, lastIdRaw])
      : await db.query(`${baseQuery} ORDER BY created_at DESC, id DESC LIMIT 1`, [jobId, tcId]);
    if (!hist) {
      return res.status(404).json({
        error: 'Không tìm thấy mail kế hoạch đã gửi để hủy. Cần gửi mail kế hoạch trước.',
        code: 'NO_PREVIOUS_NEW_MAIL',
      });
    }

    const snapshot = hist.last_sent_data || {};
    const bookingsSnapshot = Array.isArray(snapshot.bookings_snapshot)
      ? snapshot.bookings_snapshot
      // Backward-compat: older 'new' rows stored bookings under .bookings.
      : Array.isArray(snapshot.bookings) ? snapshot.bookings : [];
    if (bookingsSnapshot.length === 0) {
      return res.status(500).json({
        error: 'Snapshot trong email_history không có thông tin bookings — không render được mail hủy.',
      });
    }

    // bookingIds is required by sendPlanningEmail's body validation; supply
    // the canonical id list from the snapshot so the email_history row's
    // booking_ids[] column still references the canceled bookings.
    const bookingIds = bookingsSnapshot
      .map(b => Number(b.id))
      .filter(Number.isFinite);

    const result = await sendPlanningEmail({
      senderUserId: req.user.id,
      jobId, transportCompanyId: tcId,
      bookingIds,
      mailType: 'cancel',
      // BBBG never attached on cancel; "Đính kèm" line always omitted.
      attachBbbg: false,
      // Force the renderer to use the historical snapshot rather than
      // re-querying current truck_bookings (which may have moved/disappeared).
      bookingsOverride: bookingsSnapshot,
      reason: typeof reason === 'string' ? reason : null,
      // CP5.3 — link this cancel row to the source 'new' batch so the
      // email-status query can flip the batch's pill to 'da_huy'. The
      // source row's id IS the mail_group_id by construction.
      mailGroupId: hist.id,
      // SLB defaults for the invoice block — cancel template doesn't render
      // it but the service still validates the shape. Pass SLB info so the
      // validator passes; the value is moot since renderBody's cancel branch
      // never touches invoiceInfo.
      invoiceInfo: { type: 'slb', ...SLB_INVOICE_INFO },
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/email/send-cancel-planning error:', err.message);
    if (err.code === 'NO_GMAIL_SETUP') {
      return res.status(412).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NO_TRANSPORT_EMAIL') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({
      error: err.message,
      email_history_id: err.email_history_id,
    });
  }
});

// ─── GET /api/email/mail-status/:jobId ───────────────────────────────────────
// CP5.1 — derived per-(job, transport) mail status that drives Vùng 2 pills.
// DD + TPL gated (same as send-planning). Returns { groups, job_code }; see
// services/email-status.js for the status enum + diff semantics.
router.get('/mail-status/:jobId', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }
  const jobId = parseInt(req.params.jobId, 10);
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ error: 'jobId không hợp lệ' });
  }
  try {
    const result = await getMailStatusPerTransport(jobId);
    res.json(result);
  } catch (err) {
    console.error('GET /api/email/mail-status/:jobId error:', err.message);
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
