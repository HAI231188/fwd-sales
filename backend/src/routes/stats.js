const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Main stats endpoint
router.get('/', requireAuth, async (req, res) => {
  const { startDate, endDate, userId } = req.query;
  const isLead = req.user.role === 'lead';

  // Build WHERE conditions for report-date-based queries
  const conds = [];
  const params = [];
  let idx = 1;

  if (!isLead) {
    conds.push(`c.user_id = $${idx++}`);
    params.push(req.user.id);
  } else if (userId) {
    conds.push(`c.user_id = $${idx++}`);
    params.push(userId);
  }
  if (startDate) { conds.push(`r.report_date >= $${idx++}`); params.push(startDate); }
  if (endDate)   { conds.push(`r.report_date <= $${idx++}`); params.push(endDate); }

  const WHERE = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const AND   = conds.length ? 'AND' : 'WHERE';

  // Report-level conditions (same params, joins to reports directly)
  const rConds = [];
  const rParams = [];
  let ridx = 1;
  if (!isLead) { rConds.push(`r.user_id = $${ridx++}`); rParams.push(req.user.id); }
  else if (userId) { rConds.push(`r.user_id = $${ridx++}`); rParams.push(userId); }
  if (startDate) { rConds.push(`r.report_date >= $${ridx++}`); rParams.push(startDate); }
  if (endDate)   { rConds.push(`r.report_date <= $${ridx++}`); rParams.push(endDate); }
  const rWHERE = rConds.length ? 'WHERE ' + rConds.join(' AND ') : '';

  try {
    const [contacts, newCust, totalQuotes, booked, followUp, closingSoon, followToday, overdue, followUpcoming] = await Promise.all([
      // Total contacts (customers in reports)
      db.query(`SELECT COUNT(c.id) AS v FROM customers c JOIN reports r ON r.id=c.report_id ${WHERE}`, params),

      // New customers sum
      db.query(`SELECT COALESCE(SUM(r.new_customers),0) AS v FROM reports r ${rWHERE}`, rParams),

      // Total quotes
      db.query(`SELECT COUNT(q.id) AS v FROM quotes q JOIN customers c ON c.id=q.customer_id JOIN reports r ON r.id=c.report_id ${WHERE}`, params),

      // Booked
      db.query(`SELECT COUNT(q.id) AS v FROM quotes q JOIN customers c ON c.id=q.customer_id JOIN reports r ON r.id=c.report_id ${WHERE} ${AND} q.status='booked'`, params),

      // Follow up
      db.query(`SELECT COUNT(q.id) AS v FROM quotes q JOIN customers c ON c.id=q.customer_id JOIN reports r ON r.id=c.report_id ${WHERE} ${AND} q.status='follow_up'`, params),

      // Closing soon
      db.query(`SELECT COUNT(q.id) AS v FROM quotes q JOIN customers c ON c.id=q.customer_id JOIN reports r ON r.id=c.report_id ${WHERE} ${AND} q.closing_soon=TRUE AND q.status NOT IN ('booked','lost')`, params),

      // Follow today — customer-level OR ciu-level follow_up_date = TODAY
      (() => {
        const wConds = [];
        const wParams = [];
        let wi = 1;
        if (!isLead) { wConds.push(`c.user_id = $${wi++}`); wParams.push(req.user.id); }
        else if (userId) { wConds.push(`c.user_id = $${wi++}`); wParams.push(userId); }
        wConds.push(`(
          (c.follow_up_date = CURRENT_DATE AND c.follow_up_completed = FALSE AND c.interaction_type != 'saved')
          OR EXISTS (
            SELECT 1 FROM customer_interaction_updates ciu
            WHERE ciu.customer_id = c.id
              AND ciu.follow_up_date = CURRENT_DATE
              AND ciu.completed = FALSE
          )
        )`);
        return db.query(
          `SELECT COUNT(DISTINCT c.id) AS v FROM customers c WHERE ${wConds.join(' AND ')}`,
          wParams
        );
      })(),

      // Overdue — customer-level OR ciu-level follow_up_date < TODAY
      (() => {
        const wConds = [];
        const wParams = [];
        let wi = 1;
        if (!isLead) { wConds.push(`c.user_id = $${wi++}`); wParams.push(req.user.id); }
        else if (userId) { wConds.push(`c.user_id = $${wi++}`); wParams.push(userId); }
        wConds.push(`(
          (c.follow_up_date < CURRENT_DATE AND c.follow_up_completed = FALSE AND c.interaction_type != 'saved')
          OR EXISTS (
            SELECT 1 FROM customer_interaction_updates ciu
            WHERE ciu.customer_id = c.id
              AND ciu.follow_up_date < CURRENT_DATE
              AND ciu.completed = FALSE
          )
        )`);
        return db.query(
          `SELECT COUNT(DISTINCT c.id) AS v FROM customers c WHERE ${wConds.join(' AND ')}`,
          wParams
        );
      })(),

      // Upcoming — customer-level OR ciu-level follow_up_date tomorrow → +7 days
      (() => {
        const wConds = [];
        const wParams = [];
        let wi = 1;
        if (!isLead) { wConds.push(`c.user_id = $${wi++}`); wParams.push(req.user.id); }
        else if (userId) { wConds.push(`c.user_id = $${wi++}`); wParams.push(userId); }
        wConds.push(`(
          (c.follow_up_date > CURRENT_DATE AND c.follow_up_date <= CURRENT_DATE + INTERVAL '7 days' AND c.follow_up_completed = FALSE AND c.interaction_type != 'saved')
          OR EXISTS (
            SELECT 1 FROM customer_interaction_updates ciu
            WHERE ciu.customer_id = c.id
              AND ciu.follow_up_date > CURRENT_DATE
              AND ciu.follow_up_date <= CURRENT_DATE + INTERVAL '7 days'
              AND ciu.completed = FALSE
          )
        )`);
        return db.query(
          `SELECT COUNT(DISTINCT c.id) AS v FROM customers c WHERE ${wConds.join(' AND ')}`,
          wParams
        );
      })(),
    ]);

    // Per-sales breakdown for lead
    let perSales = [];
    if (isLead && !userId) {
      const { rows } = await db.query(`
        SELECT u.id, u.name, u.code, u.avatar_color,
          COUNT(DISTINCT c.id)  AS contacts,
          COUNT(DISTINCT q.id)  AS quotes,
          COUNT(DISTINCT CASE WHEN q.status='booked'   THEN q.id END) AS booked,
          COUNT(DISTINCT CASE WHEN q.closing_soon      THEN q.id END) AS closing_soon
        FROM users u
        LEFT JOIN reports r ON r.user_id = u.id
          ${startDate ? `AND r.report_date >= '${startDate.replace(/'/g, '')}'` : ''}
          ${endDate   ? `AND r.report_date <= '${endDate.replace(/'/g, '')}'`   : ''}
        LEFT JOIN customers c ON c.report_id = r.id
        LEFT JOIN quotes q ON q.customer_id = c.id
        WHERE u.role = 'sales'
        GROUP BY u.id, u.name, u.code, u.avatar_color
        ORDER BY contacts DESC
      `);
      perSales = rows;
    }

    res.json({
      total_contacts:   parseInt(contacts.rows[0].v),
      new_customers:    parseInt(newCust.rows[0].v),
      total_quotes:     parseInt(totalQuotes.rows[0].v),
      booked:           parseInt(booked.rows[0].v),
      follow_up:        parseInt(followUp.rows[0].v),
      closing_soon:      parseInt(closingSoon.rows[0].v),
      follow_today:      parseInt(followToday.rows[0].v),
      overdue:           parseInt(overdue.rows[0].v),
      follow_upcoming:   parseInt(followUpcoming.rows[0].v),
      waiting_follow_up: parseInt(followToday.rows[0].v) + parseInt(overdue.rows[0].v) + parseInt(followUpcoming.rows[0].v),
      per_sales: perSales,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drill-down data for stat cards
router.get('/drilldown/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  const { startDate, endDate, userId } = req.query;
  const isLead = req.user.role === 'lead';

  const conds = [];
  const params = [];
  let idx = 1;

  if (!isLead) { conds.push(`c.user_id = $${idx++}`); params.push(req.user.id); }
  else if (userId) { conds.push(`c.user_id = $${idx++}`); params.push(userId); }
  if (startDate) { conds.push(`r.report_date >= $${idx++}`); params.push(startDate); }
  if (endDate)   { conds.push(`r.report_date <= $${idx++}`); params.push(endDate); }

  const WHERE = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const AND   = conds.length ? 'AND' : 'WHERE';

  const quoteSelect = `
    q.*, c.company_name, c.contact_person, c.industry,
    c.pipeline_id, c.user_id AS sales_id,
    u.name AS user_name, u.code AS user_code, u.avatar_color, r.report_date
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    JOIN reports r ON r.id = c.report_id
    JOIN users u ON u.id = c.user_id
  `;
  const custSelect = `
    c.*, u.name AS user_name, u.code AS user_code, u.avatar_color, r.report_date,
    COUNT(q.id) AS quote_count
    FROM customers c
    JOIN reports r ON r.id = c.report_id
    JOIN users u ON u.id = c.user_id
    LEFT JOIN quotes q ON q.customer_id = c.id
  `;

  try {
    let rows = [];

    if (type === 'booked') {
      ({ rows } = await db.query(`SELECT ${quoteSelect} ${WHERE} ${AND} q.status='booked' ORDER BY q.updated_at DESC`, params));
    } else if (type === 'follow_up') {
      ({ rows } = await db.query(`SELECT ${quoteSelect} ${WHERE} ${AND} q.status='follow_up' ORDER BY q.updated_at DESC`, params));
    } else if (type === 'closing_soon') {
      ({ rows } = await db.query(`SELECT ${quoteSelect} ${WHERE} ${AND} q.closing_soon=TRUE AND q.status NOT IN ('booked','lost') ORDER BY q.cargo_ready_date ASC NULLS LAST`, params));
    } else if (type === 'contacts') {
      ({ rows } = await db.query(`SELECT ${custSelect} ${WHERE} GROUP BY c.id, u.name, u.code, u.avatar_color, r.report_date ORDER BY r.report_date DESC`, params));
    } else if (type === 'total_quotes') {
      ({ rows } = await db.query(`SELECT ${quoteSelect} ${WHERE} ORDER BY q.created_at DESC`, params));
    } else if (type === 'waiting_follow_up') {
      const wParams = [];
      let userCond = '';
      if (!isLead) { userCond = 'AND c.user_id = $1'; wParams.push(req.user.id); }
      else if (userId) { userCond = 'AND c.user_id = $1'; wParams.push(userId); }

      // One row per follow-up task: customer-level dates and CIU dates are separate rows.
      // KAW VIỆT NAM with CIU 18/04 AND CIU 20/04 appears twice — once per bucket.
      ({ rows } = await db.query(`
        SELECT * FROM (
          -- Source A: customer-level pending follow-ups, one per (pipeline, date)
          SELECT DISTINCT ON (COALESCE(c.pipeline_id::text, c.user_id::text || '_' || LOWER(c.company_name)), c.follow_up_date::text)
            c.company_name, c.contact_person, c.phone, c.industry,
            c.user_id, c.pipeline_id, c.interaction_type, c.needs,
            cp.stage,
            c.follow_up_date AS follow_up_date,
            c.follow_up_date AS effective_follow_up_date,
            u.name AS user_name, u.code AS user_code, u.avatar_color,
            (SELECT COUNT(q2.id) FROM customers c2 LEFT JOIN quotes q2 ON q2.customer_id = c2.id
             WHERE c2.user_id = c.user_id AND LOWER(c2.company_name) = LOWER(c.company_name))::int AS quote_count,
            COALESCE((SELECT BOOL_OR(q2.closing_soon) FROM customers c2 JOIN quotes q2 ON q2.customer_id = c2.id
                      WHERE c2.user_id = c.user_id AND LOWER(c2.company_name) = LOWER(c.company_name)), FALSE) AS has_closing_soon
          FROM customers c
          JOIN users u ON u.id = c.user_id
          LEFT JOIN customer_pipeline cp ON cp.id = c.pipeline_id
          WHERE c.follow_up_date IS NOT NULL
            AND c.follow_up_date <= CURRENT_DATE + INTERVAL '7 days'
            AND c.follow_up_completed = FALSE
            AND c.interaction_type != 'saved'
            ${userCond}
          ORDER BY COALESCE(c.pipeline_id::text, c.user_id::text || '_' || LOWER(c.company_name)),
                   c.follow_up_date::text, c.created_at DESC
        ) src_a

        UNION ALL

        SELECT * FROM (
          -- Source B: CIU-level pending follow-ups, one row per CIU
          SELECT
            c.company_name, c.contact_person, c.phone, c.industry,
            c.user_id, c.pipeline_id, c.interaction_type, c.needs,
            cp.stage,
            ciu.follow_up_date AS follow_up_date,
            ciu.follow_up_date AS effective_follow_up_date,
            u.name AS user_name, u.code AS user_code, u.avatar_color,
            (SELECT COUNT(q2.id) FROM customers c2 LEFT JOIN quotes q2 ON q2.customer_id = c2.id
             WHERE c2.user_id = c.user_id AND LOWER(c2.company_name) = LOWER(c.company_name))::int AS quote_count,
            COALESCE((SELECT BOOL_OR(q2.closing_soon) FROM customers c2 JOIN quotes q2 ON q2.customer_id = c2.id
                      WHERE c2.user_id = c.user_id AND LOWER(c2.company_name) = LOWER(c.company_name)), FALSE) AS has_closing_soon
          FROM customer_interaction_updates ciu
          JOIN customers c ON c.id = ciu.customer_id
          JOIN users u ON u.id = c.user_id
          LEFT JOIN customer_pipeline cp ON cp.id = c.pipeline_id
          WHERE ciu.follow_up_date IS NOT NULL
            AND ciu.follow_up_date <= CURRENT_DATE + INTERVAL '7 days'
            AND ciu.completed = FALSE
            ${userCond}
        ) src_b

        ORDER BY effective_follow_up_date ASC
      `, wParams));
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
