const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const LOG_ROLES = ['truong_phong_log', 'cus', 'cus1', 'cus2', 'cus3', 'dieu_do', 'ops'];

// GET /api/customers/:pipelineId/jobs?from=&to= — LOG-team customer-jobs view.
// Returns the canonical customer info from the pipeline (joined with the
// latest customers row for tax_code/address) plus all jobs whose customer_name
// matches that company within the date range.
// Defined BEFORE GET /:id so the more specific path wins in Express routing.
router.get('/:pipelineId/jobs', requireAuth, async (req, res) => {
  if (!LOG_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền' });
  }

  const pipelineId = parseInt(req.params.pipelineId, 10);
  if (!Number.isFinite(pipelineId)) {
    return res.status(400).json({ error: 'pipelineId không hợp lệ' });
  }

  const from = (req.query.from || '').replace(/'/g, '');
  const to   = (req.query.to   || '').replace(/'/g, '');

  try {
    const { rows: cpRows } = await db.query(`
      SELECT
        cp.id,
        cp.company_name,
        cp.contact_person,
        cp.phone,
        (SELECT c.tax_code FROM customers c
           WHERE c.pipeline_id = cp.id AND c.tax_code IS NOT NULL
           ORDER BY c.created_at DESC LIMIT 1) AS tax_code,
        (SELECT c.address  FROM customers c
           WHERE c.pipeline_id = cp.id AND c.address  IS NOT NULL
           ORDER BY c.created_at DESC LIMIT 1) AS address
      FROM customer_pipeline cp
      WHERE cp.id = $1
    `, [pipelineId]);

    if (!cpRows[0]) return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    const customer = cpRows[0];

    const conds  = [`j.deleted_at IS NULL`, `LOWER(j.customer_name) = LOWER($1)`];
    const params = [customer.company_name];
    let idx = 2;

    if (from) { conds.push(`j.created_at >= $${idx++}::date`);                       params.push(from); }
    if (to)   { conds.push(`j.created_at <  $${idx++}::date + INTERVAL '1 day'`);    params.push(to);   }
    if (req.user.role === 'ops') conds.push(`j.destination = 'hai_phong'`);

    const where = `WHERE ${conds.join(' AND ')}`;

    const { rows: jobs } = await db.query(`
      SELECT
        j.id,
        j.job_code,
        j.created_at,
        j.etd,
        j.eta,
        jt.tk_status,
        u_cus.name AS cus_name,
        u_ops.name AS ops_name,
        jtr.planned_datetime AS delivery_datetime,
        jtr.transport_name,
        COALESCE((
          SELECT string_agg(grp.cnt || ' x ' || grp.cont_type, ', ' ORDER BY grp.cont_type)
          FROM (
            SELECT jc.cont_type, COUNT(*)::int AS cnt
            FROM job_containers jc
            WHERE jc.job_id = j.id
            GROUP BY jc.cont_type
          ) grp
        ), '') AS containers_summary
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON TRUE
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN job_truck jtr ON jtr.job_id = j.id
      LEFT JOIN job_tk    jt  ON jt.job_id  = j.id
      ${where}
      ORDER BY j.created_at DESC
    `, params);

    res.json({
      customer: {
        company_name:   customer.company_name,
        tax_code:       customer.tax_code,
        contact_person: customer.contact_person,
        phone:          customer.phone,
        address:        customer.address,
      },
      jobs,
      total_jobs: jobs.length,
    });
  } catch (err) {
    console.error('GET /api/customers/:pipelineId/jobs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
