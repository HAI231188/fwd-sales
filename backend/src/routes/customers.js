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
  // Exclude 'saved' customers only when explicitly requested
  if (excludeSaved === 'true') {
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

// Update customer
router.put('/:id', requireAuth, async (req, res) => {
  const {
    company_name, contact_person, phone, source, industry,
    interaction_type, needs, notes, next_action, follow_up_date,
    potential_level, decision_maker, preferred_contact, estimated_value, competitor,
    address, tax_code,
  } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Sales can only edit their own customers; lead can edit any
    const ownerClause = req.user.role === 'sales' ? 'AND user_id = $19' : '';
    const queryParams = [
      company_name, contact_person, phone, source, industry,
      interaction_type || 'contacted', needs, notes, next_action, follow_up_date || null,
      potential_level || null, decision_maker || false, preferred_contact || null,
      estimated_value || null, competitor || null,
      address || null, tax_code || null,
      req.params.id,
      ...(req.user.role === 'sales' ? [req.user.id] : []),
    ];

    const { rows } = await client.query(`
      UPDATE customers SET
        company_name=$1, contact_person=$2, phone=$3, source=$4, industry=$5,
        interaction_type=$6, needs=$7, notes=$8, next_action=$9, follow_up_date=$10,
        potential_level=$11, decision_maker=$12, preferred_contact=$13,
        estimated_value=$14, competitor=$15,
        address=$16, tax_code=$17,
        updated_at=NOW()
      WHERE id=$18 ${ownerClause}
      RETURNING *
    `, queryParams);

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy' });
    }

    // Sync basic info back to customer_pipeline if this customer belongs to one
    if (rows[0].pipeline_id) {
      await client.query(`
        UPDATE customer_pipeline SET
          company_name   = $1,
          contact_person = $2,
          phone          = $3,
          industry       = $4,
          source         = $5,
          updated_at     = NOW()
        WHERE id = $6
      `, [
        company_name, contact_person || null, phone || null,
        industry || null, source || null, rows[0].pipeline_id,
      ]);
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
