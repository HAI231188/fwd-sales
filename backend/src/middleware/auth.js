const db = require('../db');

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Token không hợp lệ' });
    req.user = rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Token không hợp lệ' });
  }
}

function requireLead(req, res, next) {
  if (req.user?.role !== 'lead') {
    return res.status(403).json({ error: 'Chỉ trưởng phòng mới có quyền xem' });
  }
  next();
}

module.exports = { requireAuth, requireLead };
