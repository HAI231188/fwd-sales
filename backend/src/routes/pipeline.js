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

// GET /api/pipeline/lead-all — all pipeline entries across all sales users (lead only)
router.get('/lead-all', requireAuth, async (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).json({ error: 'Không có quyền' });

  const { userId, startDate, endDate } = req.query;

  const conds = [`u.role = 'sales'`];
  const params = [];
  let idx = 1;

  if (userId) {
    conds.push(`cp.sales_id = $${idx++}`);
    params.push(userId);
  }
  if (startDate) { conds.push(`cp.last_activity_date >= $${idx++}`); params.push(startDate); }
  if (endDate)   { conds.push(`cp.last_activity_date <= $${idx++}`); params.push(endDate); }

  const WHERE = 'WHERE ' + conds.join(' AND ');

  try {
    const { rows } = await db.query(`
      SELECT
        cp.id AS pipeline_id,
        cp.company_name, cp.contact_person, cp.phone, cp.industry,
        cp.stage, cp.last_activity_date,
        u.id AS user_id, u.name AS user_name, u.code AS user_code, u.avatar_color,
        COUNT(DISTINCT c.id)::int AS total_interactions,
        COUNT(DISTINCT q.id)::int AS quote_count,
        BOOL_OR(q.closing_soon) AS has_closing_soon,
        latest.interaction_type,
        latest.follow_up_date,
        latest.needs,
        MAX(r.report_date) AS report_date
      FROM customer_pipeline cp
      JOIN users u ON u.id = cp.sales_id
      LEFT JOIN customers c ON c.pipeline_id = cp.id
      LEFT JOIN reports r ON r.id = c.report_id
      LEFT JOIN quotes q ON q.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT c2.interaction_type, c2.follow_up_date, c2.needs
        FROM customers c2
        JOIN reports r2 ON r2.id = c2.report_id
        WHERE c2.pipeline_id = cp.id
        ORDER BY r2.report_date DESC, c2.created_at DESC
        LIMIT 1
      ) latest ON true
      ${WHERE}
      GROUP BY cp.id, u.id, u.name, u.code, u.avatar_color,
               latest.interaction_type, latest.follow_up_date, latest.needs
      ORDER BY
        CASE cp.stage
          WHEN 'following' THEN 1 WHEN 'new' THEN 2 WHEN 'dormant' THEN 3 WHEN 'booked' THEN 4
        END,
        cp.last_activity_date DESC NULLS LAST,
        cp.created_at DESC
    `, params);

    res.json(rows);
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

// POST /api/pipeline/:id/request-delete — sales submits a delete request
router.post('/:id/request-delete', requireAuth, async (req, res) => {
  if (req.user.role !== 'sales') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows: check } = await db.query(
      `SELECT id FROM customer_pipeline WHERE id = $1 AND sales_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!check[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows } = await db.query(`
      INSERT INTO pipeline_delete_requests (pipeline_id, requested_by)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [req.params.id, req.user.id]);

    if (!rows[0]) return res.status(409).json({ error: 'Đã có yêu cầu xóa đang chờ duyệt' });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline/delete-requests — lead sees all pending delete requests
router.get('/delete-requests', requireAuth, async (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(`
      SELECT
        dr.id, dr.pipeline_id, dr.status, dr.created_at,
        cp.company_name, cp.contact_person, cp.stage,
        u.id AS requester_id, u.name AS requester_name,
        u.code AS requester_code, u.avatar_color AS requester_avatar_color
      FROM pipeline_delete_requests dr
      JOIN customer_pipeline cp ON cp.id = dr.pipeline_id
      JOIN users u ON u.id = dr.requested_by
      WHERE dr.status = 'pending'
      ORDER BY dr.created_at ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipeline/delete-requests/:id/approve — lead approves: executes hard delete
router.post('/delete-requests/:id/approve', requireAuth, async (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).json({ error: 'Không có quyền' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: drRows } = await client.query(
      `SELECT pipeline_id FROM pipeline_delete_requests WHERE id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if (!drRows[0]) return res.status(404).json({ error: 'Không tìm thấy yêu cầu' });

    const pipelineId = drRows[0].pipeline_id;

    await client.query(`
      DELETE FROM customer_interaction_updates
      WHERE customer_id IN (SELECT id FROM customers WHERE pipeline_id = $1)
    `, [pipelineId]);

    // Deleting pipeline cascades to pipeline_history and pipeline_delete_requests
    await client.query(`DELETE FROM customer_pipeline WHERE id = $1`, [pipelineId]);

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/pipeline/delete-requests/:id/reject — lead rejects: dismisses request
router.post('/delete-requests/:id/reject', requireAuth, async (req, res) => {
  if (req.user.role !== 'lead') return res.status(403).json({ error: 'Không có quyền' });
  try {
    const { rows } = await db.query(`
      UPDATE pipeline_delete_requests
      SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $2
      WHERE id = $1 AND status = 'pending'
      RETURNING id
    `, [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy yêu cầu' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipeline — return current user's pipeline (with auto-transitions applied)
router.get('/', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  const dateFilter = [
    startDate ? `AND cp.last_activity_date >= '${startDate.replace(/'/g, '')}'` : '',
    endDate   ? `AND cp.last_activity_date <= '${endDate.replace(/'/g, '')}'`   : '',
  ].join(' ');

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
      WHERE cp.sales_id = $1 ${dateFilter}
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

// PUT /api/pipeline/:id/info — update customer info (pipeline fields + latest interaction qualification)
router.put('/:id/info', requireAuth, async (req, res) => {
  const {
    company_name, contact_person, phone, industry, source,
    potential_level, decision_maker, preferred_contact, estimated_value, competitor,
  } = req.body;

  if (!company_name?.trim()) return res.status(400).json({ error: 'Tên công ty là bắt buộc' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Sales can only edit their own; lead can edit any
    const ownerCheck = req.user.role === 'sales' ? 'AND sales_id = $2' : '';
    const ownerParams = req.user.role === 'sales'
      ? [req.params.id, req.user.id]
      : [req.params.id];

    const { rows: pipeRows } = await client.query(
      `SELECT id FROM customer_pipeline WHERE id = $1 ${ownerCheck}`,
      ownerParams
    );
    if (!pipeRows[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    // Update pipeline basic info
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
      company_name.trim(), contact_person || null, phone || null,
      industry || null, source || null, req.params.id,
    ]);

    // Update qualification fields on the most recent customer row for this pipeline
    await client.query(`
      UPDATE customers SET
        potential_level   = $1,
        decision_maker    = $2,
        preferred_contact = $3,
        estimated_value   = $4,
        competitor        = $5,
        updated_at        = NOW()
      WHERE id = (
        SELECT c.id FROM customers c
        JOIN reports r ON r.id = c.report_id
        WHERE c.pipeline_id = $6
        ORDER BY r.report_date DESC, c.created_at DESC
        LIMIT 1
      )
    `, [
      potential_level || null, decision_maker || false,
      preferred_contact || null, estimated_value || null,
      competitor || null, req.params.id,
    ]);

    await client.query('COMMIT');
    res.json({ ok: true });
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

// Shared ownership check helper for interaction updates
async function checkUpdateOwner(updateId, userId, role) {
  const { rows } = await db.query(`
    SELECT ciu.id FROM customer_interaction_updates ciu
    JOIN customers c ON c.id = ciu.customer_id
    JOIN customer_pipeline cp ON cp.id = c.pipeline_id
    WHERE ciu.id = $1 AND (cp.sales_id = $2 OR $3 = 'lead')
  `, [updateId, userId, role]);
  return rows[0] || null;
}

// PATCH /api/pipeline/customers/updates/:updateId/complete — mark follow-up done
router.patch('/customers/updates/:updateId/complete', requireAuth, async (req, res) => {
  try {
    if (!await checkUpdateOwner(req.params.updateId, req.user.id, req.user.role))
      return res.status(404).json({ error: 'Không tìm thấy' });

    const { completion_note } = req.body;
    const { rows } = await db.query(`
      UPDATE customer_interaction_updates
      SET completed = TRUE, completion_note = $2
      WHERE id = $1
      RETURNING *
    `, [req.params.updateId, completion_note || null]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pipeline/customers/updates/:updateId/uncomplete — undo follow-up completion
router.patch('/customers/updates/:updateId/uncomplete', requireAuth, async (req, res) => {
  try {
    if (!await checkUpdateOwner(req.params.updateId, req.user.id, req.user.role))
      return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows } = await db.query(`
      UPDATE customer_interaction_updates
      SET completed = FALSE, completion_note = NULL
      WHERE id = $1
      RETURNING *
    `, [req.params.updateId]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pipeline/customers/:customerId/follow-up-complete — mark/unmark customer follow-up
router.patch('/customers/:customerId/follow-up-complete', requireAuth, async (req, res) => {
  const { completed, result_note } = req.body;
  try {
    const { rows: check } = await db.query(`
      SELECT c.id FROM customers c
      JOIN customer_pipeline cp ON cp.id = c.pipeline_id
      WHERE c.id = $1 AND (cp.sales_id = $2 OR $3 = 'lead')
    `, [req.params.customerId, req.user.id, req.user.role]);

    if (!check[0]) return res.status(404).json({ error: 'Không tìm thấy' });

    const { rows } = await db.query(`
      UPDATE customers
      SET follow_up_completed = $2, follow_up_result = $3
      WHERE id = $1
      RETURNING *
    `, [req.params.customerId, completed === true, completed ? (result_note || null) : null]);

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
