const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Apply time-based stage transitions for a user (called lazily on GET)
async function applyAutoTransitions(client, salesId) {
  // 1. new/following → dormant: no activity for 7+ days
  const { rows: dormantCands } = await client.query(`
    SELECT id, stage FROM customer_pipeline
    WHERE sales_id = $1
      AND stage IN ('new', 'following')
      AND (last_activity_date IS NULL OR last_activity_date < CURRENT_DATE - INTERVAL '7 days')
  `, [salesId]);

  if (dormantCands.length > 0) {
    const ids = dormantCands.map(r => r.id);
    await client.query(
      `UPDATE customer_pipeline SET stage = 'dormant', updated_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
    for (const r of dormantCands) {
      await client.query(
        `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage) VALUES ($1, $2, 'dormant')`,
        [r.id, r.stage]
      );
    }
  }

  // 2. new → following: only if the latest interaction was contacted/quoted
  //    (saved customers stay 'new' until actually contacted)
  const { rows: followCands } = await client.query(`
    SELECT cp.id FROM customer_pipeline cp
    WHERE cp.sales_id = $1
      AND cp.stage = 'new'
      AND EXISTS (
        SELECT 1 FROM customers c
        WHERE c.pipeline_id = cp.id
          AND c.interaction_type IN ('contacted', 'quoted')
      )
  `, [salesId]);

  if (followCands.length > 0) {
    const ids = followCands.map(r => r.id);
    await client.query(
      `UPDATE customer_pipeline SET stage = 'following', updated_at = NOW() WHERE id = ANY($1)`,
      [ids]
    );
    for (const r of followCands) {
      await client.query(
        `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage) VALUES ($1, 'new', 'following')`,
        [r.id]
      );
    }
  }
}

// GET /api/pipeline/debug — temporary diagnostic (remove after use)
router.get('/debug', requireAuth, async (req, res) => {
  try {
    const [r1, r2, r3, r4, r5] = await Promise.all([
      db.query('SELECT COUNT(*) AS total FROM customer_pipeline WHERE sales_id=$1', [req.user.id]),
      db.query('SELECT COUNT(*) AS total FROM customer_pipeline'),
      db.query('SELECT COUNT(*) AS total FROM customers WHERE user_id=$1', [req.user.id]),
      db.query('SELECT COUNT(*) AS no_pipeline FROM customers WHERE user_id=$1 AND pipeline_id IS NULL', [req.user.id]),
      db.query('SELECT stage, COUNT(*) AS cnt FROM customer_pipeline WHERE sales_id=$1 GROUP BY stage', [req.user.id]),
    ]);
    res.json({
      user_id: req.user.id,
      pipeline_for_me: r1.rows[0].total,
      pipeline_total_all_users: r2.rows[0].total,
      customers_for_me: r3.rows[0].total,
      customers_no_pipeline_id: r4.rows[0].no_pipeline,
      stages: r5.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/search — lightweight search for "Khách hàng cũ" dropdown
// Returns all pipeline customers for the current salesperson (any stage),
// optionally filtered by company name. No auto-transitions applied.
router.get('/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  const trimmed = (q || '').trim();
  try {
    const params = [req.user.id];
    const searchClause = trimmed
      ? `AND (LOWER(cp.company_name) LIKE LOWER($2) OR LOWER(cp.contact_person) LIKE LOWER($2))`
      : '';
    if (trimmed) params.push(`%${trimmed}%`);

    // No LIMIT when searching — return every matching pipeline customer.
    // For the empty/default list, cap at 10 most recent to keep the dropdown tidy.
    const limitClause = trimmed ? '' : 'LIMIT 50';

    const { rows } = await db.query(`
      SELECT
        cp.id, cp.company_name, cp.contact_person, cp.phone,
        cp.industry, cp.source, cp.stage, cp.last_activity_date
      FROM customer_pipeline cp
      WHERE cp.sales_id = $1
        ${searchClause}
      ORDER BY cp.last_activity_date DESC NULLS LAST, cp.company_name
      ${limitClause}
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline — return current user's pipeline (with auto-transitions applied)
router.get('/', requireAuth, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await applyAutoTransitions(client, req.user.id);

    const { rows } = await client.query(`
      SELECT
        cp.*,
        COUNT(DISTINCT c.id)::int                                          AS total_interactions,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'booked')::int      AS booked_count,
        COUNT(DISTINCT q.id)::int                                          AS quote_count,
        BOOL_OR(q.closing_soon)                                            AS has_closing_soon,
        STRING_AGG(DISTINCT q.status, ',') FILTER (WHERE q.status IS NOT NULL) AS quote_statuses,
        MAX(r.report_date)                                                 AS last_report_date
      FROM customer_pipeline cp
      LEFT JOIN customers c   ON c.pipeline_id = cp.id
      LEFT JOIN reports r     ON r.id = c.report_id
      LEFT JOIN quotes q      ON q.customer_id = c.id
      WHERE cp.sales_id = $1
      GROUP BY cp.id
      ORDER BY
        CASE cp.stage
          WHEN 'following' THEN 1
          WHEN 'new'       THEN 2
          WHEN 'dormant'   THEN 3
          WHEN 'booked'    THEN 4
        END,
        cp.last_activity_date DESC NULLS LAST,
        cp.created_at DESC
    `, [req.user.id]);

    await client.query('COMMIT');
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/pipeline/:id — manually change stage
router.put('/:id', requireAuth, async (req, res) => {
  const { stage } = req.body;
  const valid = ['new', 'dormant', 'following', 'booked'];
  if (!valid.includes(stage)) return res.status(400).json({ error: 'Stage không hợp lệ' });

  try {
    const { rows: current } = await db.query(
      `SELECT stage FROM customer_pipeline WHERE id = $1 AND sales_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!current[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const oldStage = current[0].stage;
    const { rows } = await db.query(
      `UPDATE customer_pipeline SET stage = $1, updated_at = NOW() WHERE id = $2 AND sales_id = $3 RETURNING *`,
      [stage, req.params.id, req.user.id]
    );

    if (oldStage !== stage) {
      await db.query(
        `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, oldStage, stage, req.user.id]
      );
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/:id/detail — full detail: pipeline entry + all interactions + quotes
router.get('/:id/detail', requireAuth, async (req, res) => {
  try {
    // Sales users can only view own pipeline; leads can view any
    const ownerCheck = req.user.role === 'sales'
      ? 'AND sales_id = $2'
      : '';
    const ownerParams = req.user.role === 'sales'
      ? [req.params.id, req.user.id]
      : [req.params.id];

    const { rows: pipeRows } = await db.query(`
      SELECT cp.*,
        COUNT(DISTINCT c.id)::int                                     AS total_interactions,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'booked')::int  AS booked_count,
        COUNT(DISTINCT q.id)::int                                      AS quote_count
      FROM customer_pipeline cp
      LEFT JOIN customers c ON c.pipeline_id = cp.id
      LEFT JOIN quotes q    ON q.customer_id = c.id
      WHERE cp.id = $1 ${ownerCheck}
      GROUP BY cp.id
    `, ownerParams);

    if (!pipeRows[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows: interactions } = await db.query(`
      SELECT c.*, r.report_date
      FROM customers c
      JOIN reports r ON r.id = c.report_id
      WHERE c.pipeline_id = $1
      ORDER BY r.report_date DESC, c.created_at DESC
    `, [req.params.id]);

    const customerIds = interactions.map(c => c.id);
    let quotes = [];
    if (customerIds.length > 0) {
      const { rows } = await db.query(
        `SELECT * FROM quotes WHERE customer_id = ANY($1) ORDER BY created_at ASC`,
        [customerIds]
      );
      quotes = rows;
    }

    let updates = [];
    if (customerIds.length > 0) {
      const { rows: updateRows } = await db.query(
        `SELECT ciu.*, u.name AS created_by_name
         FROM customer_interaction_updates ciu
         LEFT JOIN users u ON u.id = ciu.created_by
         WHERE ciu.customer_id = ANY($1)
         ORDER BY ciu.created_at ASC`,
        [customerIds]
      );
      updates = updateRows;
    }

    const interactionsWithQuotes = interactions.map(c => ({
      ...c,
      quotes: quotes.filter(q => q.customer_id === c.id),
      updates: updates.filter(u => u.customer_id === c.id),
    }));

    res.json({ pipeline: pipeRows[0], interactions: interactionsWithQuotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/:customerId/updates — add a threaded update to an interaction
router.post('/customers/:customerId/updates', requireAuth, async (req, res) => {
  const { note, follow_up_date } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: 'Ghi chú không được để trống' });

  try {
    // Verify the customer belongs to a pipeline the user can access
    const { rows: check } = await db.query(`
      SELECT c.id FROM customers c
      JOIN customer_pipeline cp ON cp.id = c.pipeline_id
      WHERE c.id = $1 AND (cp.sales_id = $2 OR $3 = 'lead')
    `, [req.params.customerId, req.user.id, req.user.role]);

    if (!check[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows } = await db.query(`
      INSERT INTO customer_interaction_updates (customer_id, note, follow_up_date, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [req.params.customerId, note.trim(), follow_up_date || null, req.user.id]);

    // Also bump last_activity_date on the pipeline entry
    await db.query(`
      UPDATE customer_pipeline cp
      SET last_activity_date = CURRENT_DATE, updated_at = NOW()
      FROM customers c
      WHERE c.id = $1 AND cp.id = c.pipeline_id
    `, [req.params.customerId]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/:id/history — stage change history for a customer
router.get('/:id/history', requireAuth, async (req, res) => {
  try {
    const { rows: owner } = await db.query(
      `SELECT id FROM customer_pipeline WHERE id = $1 AND sales_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!owner[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows } = await db.query(`
      SELECT ph.*, u.name AS changed_by_name
      FROM pipeline_history ph
      LEFT JOIN users u ON u.id = ph.changed_by
      WHERE ph.pipeline_id = $1
      ORDER BY ph.changed_at DESC
    `, [req.params.id]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
