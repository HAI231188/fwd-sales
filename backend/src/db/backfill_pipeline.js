/**
 * Backfill customer_pipeline from existing report data.
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING and
 * only touches rows where pipeline_id IS NULL.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

async function backfill() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 1: Insert one pipeline entry per (sales_id, company_name) ──
    // Stage logic:
    //   'booked'   — any quote for this company+salesperson is booked
    //   'dormant'  — last activity > 7 days ago
    //   'following'— last activity was before today (1-6 days ago)
    //   'new'      — last activity is today
    const { rowCount: inserted } = await client.query(`
      INSERT INTO customer_pipeline
        (customer_id, sales_id, company_name, contact_person, phone, industry, source, stage, last_activity_date)

      WITH
      -- Most recent customer row per salesperson+company (for display info)
      latest_customer AS (
        SELECT DISTINCT ON (c.user_id, LOWER(c.company_name))
          c.id,
          c.user_id AS sales_id,
          c.company_name,
          c.contact_person,
          c.phone,
          c.industry,
          c.source
        FROM customers c
        JOIN reports r ON r.id = c.report_id
        ORDER BY c.user_id, LOWER(c.company_name), r.report_date DESC, c.created_at DESC
      ),
      -- Max report date per salesperson+company = last activity
      last_activity AS (
        SELECT c.user_id AS sales_id, LOWER(c.company_name) AS co_key, MAX(r.report_date) AS last_date
        FROM customers c
        JOIN reports r ON r.id = c.report_id
        GROUP BY c.user_id, LOWER(c.company_name)
      ),
      -- Whether any quote is booked
      booking AS (
        SELECT c.user_id AS sales_id, LOWER(c.company_name) AS co_key,
               BOOL_OR(q.status = 'booked') AS is_booked
        FROM customers c
        LEFT JOIN quotes q ON q.customer_id = c.id
        GROUP BY c.user_id, LOWER(c.company_name)
      )

      SELECT
        lc.id                  AS customer_id,
        lc.sales_id,
        lc.company_name,
        lc.contact_person,
        lc.phone,
        lc.industry,
        lc.source,
        CASE
          WHEN b.is_booked                                   THEN 'booked'
          WHEN la.last_date < CURRENT_DATE - INTERVAL '7 days' THEN 'dormant'
          WHEN la.last_date < CURRENT_DATE                   THEN 'following'
          ELSE 'new'
        END                    AS stage,
        la.last_date           AS last_activity_date
      FROM latest_customer lc
      JOIN last_activity la ON la.sales_id = lc.sales_id AND la.co_key = LOWER(lc.company_name)
      JOIN booking       b  ON b.sales_id  = lc.sales_id AND b.co_key  = LOWER(lc.company_name)

      ON CONFLICT (sales_id, LOWER(company_name)) DO NOTHING
    `);

    console.log(`  ↳ Inserted ${inserted} new pipeline entries`);

    // ── Step 2: Back-link every customer row that still has no pipeline_id ──
    const { rowCount: linked } = await client.query(`
      UPDATE customers c
      SET pipeline_id = cp.id
      FROM customer_pipeline cp
      WHERE cp.sales_id        = c.user_id
        AND LOWER(cp.company_name) = LOWER(c.company_name)
        AND c.pipeline_id IS NULL
    `);

    console.log(`  ↳ Linked ${linked} customer rows to pipeline entries`);

    // ── Step 3: Seed history for pipeline entries that have no history yet ──
    const { rowCount: histAdded } = await client.query(`
      INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage)
      SELECT cp.id, NULL, cp.stage
      FROM customer_pipeline cp
      WHERE NOT EXISTS (
        SELECT 1 FROM pipeline_history ph WHERE ph.pipeline_id = cp.id
      )
    `);

    console.log(`  ↳ Added ${histAdded} initial history entries`);

    await client.query('COMMIT');
    console.log('✅ Pipeline backfill complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Pipeline backfill failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

backfill();
