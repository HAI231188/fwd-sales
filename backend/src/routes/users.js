// /api/users — per-user settings beyond auth/password.
//
// Phase 5 Step 3 Part 2 CP2 — Gmail SMTP setup endpoints. CP3+ will use the
// decrypted app password from here to send mail via nodemailer.

const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const enc = require('../utils/encryption');

// @gmail.com or @googlemail.com (case-insensitive), with a basic local-part.
const GMAIL_RE = /^[^\s@]+@(gmail\.com|googlemail\.com)$/i;

function parseDisplayName(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, 200);
}
function parseEmail(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s === '' ? null : s;
}

// ─── GET /api/users/me/gmail-setup ─────────────────────────────────────────────
// Returns the user's Gmail setup state — never the actual password.
router.get('/me/gmail-setup', requireAuth, async (req, res) => {
  try {
    const { rows: [u] } = await db.query(
      `SELECT gmail_address, gmail_display_name,
              (gmail_app_password_encrypted IS NOT NULL) AS has_app_password
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!u) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json({
      gmail_address: u.gmail_address,
      gmail_display_name: u.gmail_display_name,
      has_app_password: !!u.has_app_password,
      encryption_available: enc.isAvailable(),
    });
  } catch (err) {
    console.error('GET /api/users/me/gmail-setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/users/me/gmail-setup ─────────────────────────────────────────────
// Body: { gmail_address?, gmail_display_name?, gmail_app_password? }
//
// gmail_app_password semantics (spec — be careful):
//   undefined / key missing → leave existing encrypted password untouched.
//   non-empty string        → encrypt + overwrite.
//   empty string ''         → DELETE the password (clear encrypted column).
router.put('/me/gmail-setup', requireAuth, async (req, res) => {
  const { gmail_address, gmail_display_name, gmail_app_password } = req.body || {};

  // Validate fields that are present.
  const addr = parseEmail(gmail_address);
  if (gmail_address !== undefined && addr && !GMAIL_RE.test(addr)) {
    return res.status(400).json({
      error: 'Email phải có đuôi @gmail.com hoặc @googlemail.com',
    });
  }
  const displayName = parseDisplayName(gmail_display_name);

  // Build the SET clause incrementally so omitted keys aren't touched.
  const sets = [];
  const params = [];
  let idx = 1;

  if (gmail_address !== undefined) {
    sets.push(`gmail_address = $${idx++}`); params.push(addr);
  }
  if (gmail_display_name !== undefined) {
    sets.push(`gmail_display_name = $${idx++}`); params.push(displayName);
  }

  if (gmail_app_password !== undefined) {
    if (gmail_app_password === '') {
      // Explicit clear.
      sets.push(`gmail_app_password_encrypted = NULL`);
    } else {
      // Encrypt + store. Strip whitespace because Google's "app password"
      // UI shows it as "xxxx yyyy zzzz wwww" but the actual value is the
      // 16 contiguous chars.
      const raw = String(gmail_app_password).replace(/\s+/g, '');
      if (raw.length < 8) {
        return res.status(400).json({
          error: 'App password quá ngắn (Gmail app password thường 16 ký tự)',
        });
      }
      if (!enc.isAvailable()) {
        return res.status(503).json({
          error: 'Server chưa cấu hình mã hóa email (GMAIL_ENCRYPTION_KEY). Liên hệ admin.',
        });
      }
      let cipher;
      try {
        cipher = enc.encryptString(raw);
      } catch (e) {
        console.error('encryptString failed:', e.message);
        return res.status(500).json({ error: 'Lỗi mã hóa: ' + e.message });
      }
      sets.push(`gmail_app_password_encrypted = $${idx++}`); params.push(cipher);
    }
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: 'Không có thay đổi để lưu' });
  }

  params.push(req.user.id);
  try {
    await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`,
      params
    );
    const { rows: [u] } = await db.query(
      `SELECT gmail_address, gmail_display_name,
              (gmail_app_password_encrypted IS NOT NULL) AS has_app_password
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({
      gmail_address: u.gmail_address,
      gmail_display_name: u.gmail_display_name,
      has_app_password: !!u.has_app_password,
      encryption_available: enc.isAvailable(),
    });
  } catch (err) {
    console.error('PUT /api/users/me/gmail-setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/users/me/gmail-setup ──────────────────────────────────────────
// Clear all three Gmail fields. For "Remove Gmail integration" action.
router.delete('/me/gmail-setup', requireAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE users
          SET gmail_address = NULL,
              gmail_display_name = NULL,
              gmail_app_password_encrypted = NULL
        WHERE id = $1`,
      [req.user.id]
    );
    res.json({
      gmail_address: null,
      gmail_display_name: null,
      has_app_password: false,
      encryption_available: enc.isAvailable(),
    });
  } catch (err) {
    console.error('DELETE /api/users/me/gmail-setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
