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
const { sendPlanningEmail } = require('../services/email-sender');

const SEND_ROLES = ['dieu_do', 'truong_phong_log'];
const READ_ROLES = ['dieu_do', 'truong_phong_log', 'lead'];

// ─── POST /api/email/send-planning ─────────────────────────────────────────────
router.post('/send-planning', requireAuth, async (req, res) => {
  if (!SEND_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Không có quyền gửi mail' });
  }

  const { job_id, transport_company_id, booking_ids, mail_type } = req.body || {};

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

module.exports = router;
