const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications  — last 20 notifications for current user + unread count
router.get('/', requireAuth, async (req, res) => {
  try {
    const [list, unread] = await Promise.all([
      db.query(
        `SELECT id, type, title, message, job_id, read_at, created_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [req.user.id]
      ),
      db.query(
        `SELECT COUNT(*) AS v FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
        [req.user.id]
      ),
    ]);
    res.json({
      notifications: list.rows,
      unread_count: parseInt(unread.rows[0].v, 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/unread-count  — light endpoint for fast polling
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS v FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ count: parseInt(rows[0].v, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/mark-read  — body { ids?: number[], all?: true }
router.post('/mark-read', requireAuth, async (req, res) => {
  const { ids, all } = req.body || {};
  try {
    if (all) {
      await db.query(
        `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
        [req.user.id]
      );
    } else if (Array.isArray(ids) && ids.length > 0) {
      const cleanIds = ids.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n));
      if (cleanIds.length === 0) return res.json({ ok: true, updated: 0 });
      const { rowCount } = await db.query(
        `UPDATE notifications SET read_at = NOW()
         WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2)`,
        [req.user.id, cleanIds]
      );
      return res.json({ ok: true, updated: rowCount });
    } else {
      return res.status(400).json({ error: 'Provide ids[] or all:true' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
