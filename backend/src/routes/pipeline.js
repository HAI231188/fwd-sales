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

  // 2. new → following: added before today (1-6 days ago), not already dormant
  const { rows: followCands } = await client.query(`
    SELECT id FROM customer_pipeline
    WHERE sales_id = $1
      AND stage = 'new'
      AND last_activity_date IS NOT NULL
      AND last_activity_date < CURRENT_DATE
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
