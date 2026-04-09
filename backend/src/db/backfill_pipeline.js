/**
 * Backfill customer_pipeline from existing report data.
 * Safe to run multiple times:
 *   - Step 0 corrects any existing entries with wrong stage
 *   - Step 1 inserts entries for companies not yet in the pipeline
 *   - Step 2 links customer rows that still have no pipeline_id
 *   - Step 3 seeds history for entries that have none
 *
 * Stage logic (based on interaction_type of most recent customer row):
 *   'booked'    — any quote for this company+salesperson is booked
 *   'following' — most recent interaction_type is 'contacted' or 'quoted'
 *   'dormant'   — most recent interaction_type is 'saved' AND no activity for 7+ days
 *   'new'       — most recent interaction_type is 'saved' AND active within 7 days
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');

// Shared CTEs used in both UPDATE (step 0) and INSERT (step 1)
const STAGE_CTES = `
  -- Most recent customer row per salesperson+company (interaction_type + display info)
  latest_customer AS (
    SELECT DISTINCT ON (c.user_id, LOWER(c.company_name))
      c.id,
      c.user_id          AS sales_id,
      c.company_name,
      c.contact_person,
      c.phone,
      c.industry,
      c.source,
      c.interaction_type
    FROM customers c
    JOIN reports r ON r.id = c.report_id
    ORDER BY c.user_id, LOWER(c.company_name), r.report_date DESC, c.created_at DESC
  ),
  -- Last report date per salesperson+company
  last_activity AS (
    SELECT c.user_id AS sales_id, LOWER(c.company_name) AS co_key,
           MAX(r.report_date) AS last_date
    FROM customers c
    JOIN reports r ON r.id = c.report_id
    GROUP BY c.user_id, LOWER(c.company_name)
  ),
  -- Whether any quote for this company+salesperson is booked
  booking AS (
    SELECT c.user_id AS sales_id, LOWER(c.company_name) AS co_key,
           BOOL_OR(q.status = 'booked') AS is_booked
    FROM customers c
    LEFT JOIN quotes q ON q.customer_id = c.id
    GROUP BY c.user_id, LOWER(c.company_name)
  ),
  -- Computed correct stage for every company+salesperson pair
  correct_stages AS (
    SELECT
      lc.id              AS customer_id,
      lc.sales_id,
      lc.company_name,
      lc.contact_person,
      lc.phone,
      lc.industry,
      lc.source,
      la.last_date       AS last_activity_date,
      CASE
        WHEN b.is_booked
          THEN 'booked'
        WHEN lc.interaction_type IN ('contacted', 'quoted')
          THEN 'following'
        WHEN lc.interaction_type = 'saved'
          AND la.last_date < CURRENT_DATE - INTERVAL '7 days'
          THEN 'dormant'
        ELSE 'new'
      END                AS stage
    FROM latest_customer lc
    JOIN last_activity la ON la.sales_id = lc.sales_id AND la.co_key = LOWER(lc.company_name)
    JOIN booking       b  ON b.sales_id  = lc.sales_id AND b.co_key  = LOWER(lc.company_name)
  )
`;

async function backfill() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 0: Correct stage on existing pipeline entries ──────────────────
    const { rowCount: corrected } = await client.query(`
      WITH ${STAGE_CTES}
      UPDATE customer_pipeline cp
      SET stage = cs.stage, updated_at = NOW()
      FROM correct_stages cs
      WHERE cs.sales_id = cp.sales_id
        AND LOWER(cs.company_name) = LOWER(cp.company_name)
        AND cp.stage != cs.stage
    `);
    console.log(`  ↳ Corrected ${corrected} existing pipeline stages`);

    // ── Step 1: Insert entries for companies not yet in pipeline ─────────────
    const { rowCount: inserted } = await client.query(`
      WITH ${STAGE_CTES}
      INSERT INTO customer_pipeline
        (customer_id, sales_id, company_name, contact_person, phone, industry, source, stage, last_activity_date)
      SELECT customer_id, sales_id, company_name, contact_person, phone, industry, source, stage, last_activity_date
      FROM correct_stages
      ON CONFLICT (sales_id, LOWER(company_name)) DO NOTHING
    `);
    console.log(`  ↳ Inserted ${inserted} new pipeline entries`);

    // ── Step 2: Link customer rows that still have no pipeline_id ────────────
    const { rowCount: linked } = await client.query(`
      UPDATE customers c
      SET pipeline_id = cp.id
      FROM customer_pipeline cp
      WHERE cp.sales_id            = c.user_id
        AND LOWER(cp.company_name) = LOWER(c.company_name)
        AND c.pipeline_id IS NULL
    `);
    console.log(`  ↳ Linked ${linked} customer rows to pipeline entries`);

    // ── Step 3: Seed history for entries that have none ──────────────────────
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
