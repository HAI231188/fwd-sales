const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// List customers
router.get('/', requireAuth, async (req, res) => {
  const { userId, interactionType, startDate, endDate, search, excludeSaved, limit } = req.query;

  let conditions = [];
  let params = [];
  let idx = 1;

  if (req.user.role === 'sales') {
    conditions.push(`c.user_id = $${idx++}`);
    params.push(req.user.id);
  } else if (userId) {
    conditions.push(`c.user_id = $${idx++}`);
    params.push(userId);
  }

  if (interactionType) {
    conditions.push(`c.interaction_type = $${idx++}`);
    params.push(interactionType);
  }
  if (startDate) {
    conditions.push(`r.report_date >= $${idx++}`);
    params.push(startDate);
  }
  if (endDate) {
    conditions.push(`r.report_date <= $${idx++}`);
    params.push(endDate);
  }
  if (search) {
    conditions.push(`(c.company_name ILIKE $${idx++} OR c.contact_person ILIKE $${idx - 1})`);
    params.push(`%${search}%`);
  }
  // Exclude 'saved' customers when searching or explicitly requested
  if (search || excludeSaved === 'true') {
    conditions.push(`c.interaction_type IN ('contacted', 'quoted')`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const limitClause = limit ? `LIMIT ${Math.min(parseInt(limit) || 10, 50)}` : '';

  try {
    const { rows } = await db.query(`
      SELECT
        c.*,
        u.name AS user_name, u.code AS user_code, u.avatar_color,
        r.report_date,
        COUNT(q.id) AS quote_count,
        BOOL_OR(q.closing_soon) AS has_closing_soon,
        STRING_AGG(DISTINCT q.status, ',') AS quote_statuses
      FROM customers c
      JOIN users u ON u.id = c.user_id
      JOIN reports r ON r.id = c.report_id
      LEFT JOIN quotes q ON q.customer_id = c.id
      ${where}
      GROUP BY c.id, u.name, u.code, u.avatar_color, r.report_date
      ORDER BY r.report_date DESC, c.created_at DESC
      ${limitClause}
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single customer with quotes
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, u.name AS user_name, u.code AS user_code, r.report_date
       FROM customers c
       JOIN users u ON u.id = c.user_id
       JOIN reports r ON r.id = c.report_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    if (req.user.role === 'sales' && rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Không có quyền' });
    }

    const { rows: quotes } = await db.query(
      'SELECT * FROM quotes WHERE customer_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({ ...rows[0], quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add customer to existing report
router.post('/', requireAuth, async (req, res) => {
  const {
    report_id, company_name, contact_person, phone, source, industry,
    interaction_type, needs, notes, next_action, follow_up_date,
  } = req.body;

  try {
    // Verify the report belongs to this user
    const { rows: reportCheck } = await db.query(
      'SELECT id FROM reports WHERE id=$1 AND user_id=$2',
      [report_id, req.user.id]
    );
    if (!reportCheck[0]) return res.status(403).json({ error: 'Không có quyền' });

    const { rows } = await db.query(`
      INSERT INTO customers
        (report_id, user_id, company_name, contact_person, phone, source, industry,
         interaction_type, needs, notes, next_action, follow_up_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      report_id, req.user.id, company_name, contact_person, phone,
      source, industry, interaction_type, needs, notes, next_action,
      follow_up_date || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update customer
router.put('/:id', requireAuth, async (req, res) => {
  const {
    company_name, contact_person, phone, source, industry,
    interaction_type, needs, notes, next_action, follow_up_date,
  } = req.body;

  try {
    const { rows } = await db.query(`
      UPDATE customers SET
        company_name=$1, contact_person=$2, phone=$3, source=$4, industry=$5,
        interaction_type=$6, needs=$7, notes=$8, next_action=$9, follow_up_date=$10,
        updated_at=NOW()
      WHERE id=$11 AND user_id=$12
      RETURNING *
    `, [
      company_name, contact_person, phone, source, industry,
      interaction_type, needs, notes, next_action, follow_up_date || null,
      req.params.id, req.user.id,
    ]);

    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete customer
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM customers WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ message: 'Đã xóa' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
