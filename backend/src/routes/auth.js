const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// List all users (for login screen)
router.get('/users', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, code, role, avatar_color FROM users ORDER BY role DESC, name ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login (select user - no password for prototype)
router.post('/login', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Vui lòng chọn người dùng' });

  try {
    const { rows } = await db.query(
      'SELECT id, name, code, role, avatar_color FROM users WHERE id = $1',
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Người dùng không tồn tại' });

    const user = rows[0];
    const token = Buffer.from(
      JSON.stringify({ userId: user.id, timestamp: Date.now() })
    ).toString('base64');

    res.json({ user, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user
router.get('/me', requireAuth, (req, res) => {
  const { id, name, code, role, avatar_color } = req.user;
  res.json({ id, name, code, role, avatar_color });
});

module.exports = router;
