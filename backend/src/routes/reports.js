const router = require('express').Router();
const db = require('../db');
const { requireAuth, requireLead } = require('../middleware/auth');

// List reports
router.get('/', requireAuth, async (req, res) => {
  const { userId, startDate, endDate, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let conditions = [];
  let params = [];
  let idx = 1;

  // Sales can only see their own reports
  if (req.user.role === 'sales') {
    conditions.push(`r.user_id = $${idx++}`);
    params.push(req.user.id);
  } else if (userId) {
    conditions.push(`r.user_id = $${idx++}`);
    params.push(userId);
  }

  if (startDate) { conditions.push(`r.report_date >= $${idx++}`); params.push(startDate); }
  if (endDate)   { conditions.push(`r.report_date <= $${idx++}`); params.push(endDate); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const { rows } = await db.query(`
      SELECT
        r.*,
        u.name AS user_name, u.code AS user_code, u.avatar_color,
        COUNT(DISTINCT c.id) AS customer_count,
        COUNT(DISTINCT q.id) AS quote_count
      FROM reports r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN customers c ON c.report_id = r.id
      LEFT JOIN quotes q ON q.customer_id = c.id
      ${where}
      GROUP BY r.id, u.name, u.code, u.avatar_color
      ORDER BY r.report_date DESC, r.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    const countRes = await db.query(
      `SELECT COUNT(*) FROM reports r ${where}`, params
    );

    res.json({
      reports: rows,
      total: parseInt(countRes.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single report with customers + quotes
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows: reportRows } = await db.query(`
      SELECT r.*, u.name AS user_name, u.code AS user_code, u.avatar_color
      FROM reports r JOIN users u ON u.id = r.user_id
      WHERE r.id = $1
    `, [req.params.id]);

    if (!reportRows[0]) return res.status(404).json({ error: 'Báo cáo không tồn tại' });
    const report = reportRows[0];

    // Sales can only see their own
    if (req.user.role === 'sales' && report.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Không có quyền truy cập' });
    }

    const { rows: customers } = await db.query(`
      SELECT * FROM customers WHERE report_id = $1 ORDER BY created_at ASC
    `, [req.params.id]);

    const customerIds = customers.map(c => c.id);
    let quotes = [];
    if (customerIds.length > 0) {
      const { rows } = await db.query(
        `SELECT * FROM quotes WHERE customer_id = ANY($1) ORDER BY created_at ASC`,
        [customerIds]
      );
      quotes = rows;
    }

    const customersWithQuotes = customers.map(c => ({
      ...c,
      quotes: quotes.filter(q => q.customer_id === c.id),
    }));

    res.json({ ...report, customers: customersWithQuotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create report (with customers + quotes in one transaction)
router.post('/', requireAuth, async (req, res) => {
  const { report_date, total_contacts, new_customers, issues, customers = [] } = req.body;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert report
    const { rows: reportRows } = await client.query(`
      INSERT INTO reports (user_id, report_date, total_contacts, new_customers, issues)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, report_date)
      DO UPDATE SET total_contacts=$3, new_customers=$4, issues=$5, updated_at=NOW()
      RETURNING *
    `, [req.user.id, report_date, total_contacts || 0, new_customers || 0, issues]);

    const report = reportRows[0];

    for (const cust of customers) {
      const { rows: custRows } = await client.query(`
        INSERT INTO customers
          (report_id, user_id, company_name, contact_person, phone, source, industry,
           interaction_type, needs, notes, next_action, follow_up_date,
           potential_level, decision_maker, preferred_contact,
           reason_not_closed, estimated_value, competitor)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING *
      `, [
        report.id, req.user.id,
        cust.company_name, cust.contact_person, cust.phone,
        cust.source, cust.industry, cust.interaction_type,
        cust.needs, cust.notes, cust.next_action, cust.follow_up_date || null,
        cust.potential_level || null, cust.decision_maker || false,
        cust.preferred_contact || null, cust.reason_not_closed || null,
        cust.estimated_value || null, cust.competitor || null,
      ]);

      const customer = custRows[0];

      // ── Pipeline: upsert entry for this company+salesperson ──
      const { rows: existingPipeline } = await client.query(`
        SELECT id, stage FROM customer_pipeline
        WHERE sales_id = $1 AND LOWER(company_name) = LOWER($2)
      `, [req.user.id, cust.company_name]);

      let pipelineId;
      if (existingPipeline.length === 0) {
        // Brand new company — stage depends on interaction_type
        const initStage = ['contacted', 'quoted'].includes(cust.interaction_type) ? 'following' : 'new';
        const { rows: pRows } = await client.query(`
          INSERT INTO customer_pipeline
            (customer_id, sales_id, company_name, contact_person, phone, industry, source, stage, last_activity_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id
        `, [
          customer.id, req.user.id,
          cust.company_name, cust.contact_person || null, cust.phone || null,
          cust.industry || null, cust.source || null, initStage, report_date,
        ]);
        pipelineId = pRows[0].id;
        await client.query(
          `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by) VALUES ($1, NULL, $2, $3)`,
          [pipelineId, initStage, req.user.id]
        );
      } else {
        // Known company — refresh last activity and contact info
        pipelineId = existingPipeline[0].id;
        const currentStage = existingPipeline[0].stage;

        // Promote to 'following' if now being contacted/quoted and was new/dormant
        const shouldPromote = ['contacted', 'quoted'].includes(cust.interaction_type)
          && ['new', 'dormant'].includes(currentStage);

        await client.query(`
          UPDATE customer_pipeline
          SET last_activity_date = $1,
              contact_person = COALESCE($2, contact_person),
              phone = COALESCE($3, phone),
              ${shouldPromote ? "stage = 'following'," : ''}
              updated_at = NOW()
          WHERE id = $4
        `, [report_date, cust.contact_person || null, cust.phone || null, pipelineId]);

        if (shouldPromote) {
          await client.query(
            `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by) VALUES ($1, $2, 'following', $3)`,
            [pipelineId, currentStage, req.user.id]
          );
        }
      }

      // Back-link this customer row to its pipeline entry
      await client.query(
        `UPDATE customers SET pipeline_id = $1 WHERE id = $2`,
        [pipelineId, customer.id]
      );

      for (const q of (cust.quotes || [])) {
        const { rows: qRows } = await client.query(`
          INSERT INTO quotes
            (customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg,
             monthly_volume_containers, route, cargo_ready_date, mode, carrier,
             transit_time, price, status, follow_up_notes, lost_reason, closing_soon)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id, status
        `, [
          customer.id, q.cargo_name,
          q.monthly_volume_cbm || null, q.monthly_volume_kg || null,
          q.monthly_volume_containers,
          q.route, q.cargo_ready_date || null, q.mode,
          q.carrier, q.transit_time, q.price,
          q.status || 'quoting', q.follow_up_notes,
          q.lost_reason, q.closing_soon || false,
        ]);

        // Auto-promote pipeline to 'booked' when quote is booked
        if (qRows[0]?.status === 'booked') {
          const { rows: prevStage } = await client.query(
            `SELECT stage FROM customer_pipeline WHERE id = $1`,
            [pipelineId]
          );
          if (prevStage[0] && prevStage[0].stage !== 'booked') {
            await client.query(
              `UPDATE customer_pipeline SET stage = 'booked', updated_at = NOW() WHERE id = $1`,
              [pipelineId]
            );
            await client.query(
              `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by) VALUES ($1, $2, 'booked', $3)`,
              [pipelineId, prevStage[0].stage, req.user.id]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: report.id, message: 'Đã lưu báo cáo' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update report summary
router.put('/:id', requireAuth, async (req, res) => {
  const { total_contacts, new_customers, issues } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE reports SET total_contacts=$1, new_customers=$2, issues=$3, updated_at=NOW()
       WHERE id=$4 AND user_id=$5 RETURNING *`,
      [total_contacts, new_customers, issues, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy báo cáo' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete report
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM reports WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy báo cáo' });
    res.json({ message: 'Đã xóa báo cáo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
