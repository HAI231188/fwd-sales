const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'fwd-sales-secret-change-in-production';

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, name, username, code, role, avatar_color FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Token không hợp lệ' });
    req.user = rows[0];
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

module.exports = { requireAuth, requireLead, JWT_SECRET };
