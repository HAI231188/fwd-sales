const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail fast at startup. A missing secret would silently fall back to a
  // hardcoded default and let any attacker forge tokens.
  throw new Error('JWT_SECRET environment variable is required');
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, name, username, code, role, avatar_color, disabled_at FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Token không hợp lệ' });
    // Account lock — a disabled user must be rejected on EVERY request, not just
    // at login, because their 7-day JWT stays otherwise-valid after being locked.
    if (rows[0].disabled_at) {
      return res.status(403).json({ error: 'Tài khoản đã bị khóa. Liên hệ quản trị viên.' });
    }
    const { disabled_at, ...safeUser } = rows[0];
    req.user = safeUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}

function requireLead(req, res, next) {
  if (req.user?.role !== 'lead') {
    return res.status(403).json({ error: 'Chỉ trưởng phòng mới có quyền xem' });
  }
  next();
}

// App-wide administrator gate (mirrors requireKeToan in routes/accounting.js).
// requireAuth must run first so req.user is populated.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ quản trị viên mới có quyền' });
  }
  next();
}

module.exports = { requireAuth, requireLead, requireAdmin, JWT_SECRET };
