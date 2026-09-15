/**
 * Backfill customer_pipeline from existing report data.
 * Safe to run multiple times:
 *   - Step 0 corrects any existing entries with wrong stage
 *   - Step 1 inserts entries for companies not yet in the pipeline
 *   - Step 2 links customer rows that still have no pipeline_id
 *   - Step 3 seeds history for entries that have none
 *
 * Stage logic (based on interaction_type of most recent customer row):
 *   'booked'    — ANY quote in the customer's thread is booked, OR the customer
 *                 has ANY job. Either fact is permanent: the row is never
 *                 demoted out of 'booked' by a newer interaction.
 *   The three stages below are decided by the most recent interaction_type, and
 *   ONLY for customers that have never had a booked quote and never had a job.
 *   'following' — most recent interaction_type is 'contacted' or 'quoted'
 *   'dormant'   — most recent interaction_type is 'saved' AND no activity for 7+ days
 *   'new'       — most recent interaction_type is 'saved' AND active within 7 days
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const db = require('./index');
const { hasAnyJobSql, hasBookedQuoteSql } = require('../services/pipeline-ownership');

// Shared CTEs used in both UPDATE (step 0) and INSERT (step 1)
const STAGE_CTES = `
  -- Most recent customer row per salesperson+company (interaction_type + display info)
  -- NOTE: company_name is TRIM()'d everywhere it is grouped, matched, or selected.
  -- customers.company_name may carry leading/trailing whitespace from legacy writes;
  -- without TRIM here the backfill would (a) fail to match a cleaned pipeline row by
  -- LOWER() and (b) re-INSERT a whitespace duplicate. Trimming makes the backfill
  -- whitespace-tolerant and idempotent against the cleaned pipeline (2026-06-25).
  --
  -- OWNER, not author (2026-09-14): a customers row counts toward the owner of
  -- the ACTIVE pipeline row it is linked to — COALESCE(lp.sales_id, c.user_id) —
  -- not necessarily c.user_id. A sales transfer reassigns customer_pipeline.sales_id
  -- and keeps customers.user_id (who made the contact); grouping by c.user_id
  -- would make Step 1 re-create a pipeline row for the previous owner on every
  -- deploy. Unlinked rows, and rows linked to a soft-deleted pipeline, still
  -- count toward c.user_id exactly as before.
  latest_customer AS (
    SELECT DISTINCT ON (COALESCE(lp.sales_id, c.user_id), LOWER(TRIM(c.company_name)))
      c.id,
      COALESCE(lp.sales_id, c.user_id) AS sales_id,
      TRIM(c.company_name)   AS company_name,
      c.contact_person,
      c.phone,
      c.industry,
      c.source,
      c.interaction_type
    FROM customers c
    JOIN reports r ON r.id = c.report_id AND r.deleted_at IS NULL
    LEFT JOIN customer_pipeline lp ON lp.id = c.pipeline_id AND lp.deleted_at IS NULL
    ORDER BY COALESCE(lp.sales_id, c.user_id), LOWER(TRIM(c.company_name)), r.report_date DESC, c.created_at DESC
  ),
  -- Last report date per salesperson+company
  last_activity AS (
    SELECT COALESCE(lp.sales_id, c.user_id) AS sales_id, LOWER(TRIM(c.company_name)) AS co_key,
           MAX(r.report_date) AS last_date
    FROM customers c
    JOIN reports r ON r.id = c.report_id AND r.deleted_at IS NULL
    LEFT JOIN customer_pipeline lp ON lp.id = c.pipeline_id AND lp.deleted_at IS NULL
    GROUP BY COALESCE(lp.sales_id, c.user_id), LOWER(TRIM(c.company_name))
  ),
  -- Whether any quote for this company+salesperson is booked
  booking AS (
    SELECT COALESCE(lp.sales_id, c.user_id) AS sales_id, LOWER(TRIM(c.company_name)) AS co_key,
           BOOL_OR(q.status = 'booked') AS is_booked
    FROM customers c
    LEFT JOIN customer_pipeline lp ON lp.id = c.pipeline_id AND lp.deleted_at IS NULL
    LEFT JOIN quotes q ON q.customer_id = c.id
    GROUP BY COALESCE(lp.sales_id, c.user_id), LOWER(TRIM(c.company_name))
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
    // Stage is derived PER QUOTE: a customer with ANY booked quote, or ANY job,
    // is 'booked' and is never demoted out of it. A newer 'contacted'/'quoted'
    // row describes only THAT contact — it must not pull the customer's own
    // stage back down. hasAnyJobSql is the same rule as applyAutoTransitions'
    // dormant guard; hasBookedQuoteSql states the booked-quote half explicitly
    // here instead of relying on correct_stages' `booking` CTE, which is
    // reachable only through latest_customer's JOIN on a non-deleted report and
    // an (owner, name) grouping — so it silently yields NO booked verdict for a
    // row whose reports are all soft-deleted (2 live rows: PAX VIỆT NAM 1646,
    // TRUNG ĐỨC 1648). Rows with neither fact keep EXACTLY the old recompute
    // (correct_stages), and rows correct_stages cannot see keep their stage.
    // Only live rows are touched, and every change is written to
    // pipeline_history (this step used to rewrite stage silently).
    //
    // Step 1 (INSERT) needs no matching change: correct_stages already puts
    // `WHEN b.is_booked THEN 'booked'` first, so a brand-new row with a booked
    // quote is inserted as 'booked'. This guard is about never DEMOTING an
    // existing row, which only Step 0 can do.
    const { rowCount: corrected } = await client.query(`
      WITH ${STAGE_CTES},
      target AS (
        SELECT cp.id, cp.stage AS from_stage,
               CASE WHEN ${hasAnyJobSql('cp')} OR ${hasBookedQuoteSql('cp')} THEN 'booked'
                    ELSE COALESCE(cs.stage, cp.stage) END AS to_stage
          FROM customer_pipeline cp
          LEFT JOIN correct_stages cs
            ON cs.sales_id = cp.sales_id
           AND LOWER(cs.company_name) = LOWER(TRIM(cp.company_name))
         WHERE cp.deleted_at IS NULL
      ),
      changed AS (
        UPDATE customer_pipeline cp
           SET stage = t.to_stage, updated_at = NOW()
          FROM target t
         WHERE cp.id = t.id AND t.from_stage <> t.to_stage
        RETURNING cp.id
      )
      INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage)
      SELECT t.id, t.from_stage, t.to_stage
        FROM target t JOIN changed ch ON ch.id = t.id
    `);
    console.log(`  ↳ Corrected ${corrected} existing pipeline stages (each logged to pipeline_history)`);

    // ── Step 1: Insert entries for companies not yet in pipeline ─────────────
    const { rowCount: inserted } = await client.query(`
      WITH ${STAGE_CTES}
      INSERT INTO customer_pipeline
        (customer_id, sales_id, company_name, contact_person, phone, industry, source, stage, last_activity_date)
      SELECT customer_id, sales_id, company_name, contact_person, phone, industry, source,
             CASE WHEN ${hasAnyJobSql('correct_stages')} THEN 'booked' ELSE stage END,
             last_activity_date
      FROM correct_stages
      ON CONFLICT (sales_id, LOWER(company_name)) WHERE deleted_at IS NULL DO NOTHING
    `);
    console.log(`  ↳ Inserted ${inserted} new pipeline entries`);

    // ── Step 2: Link customer rows that still have no pipeline_id ────────────
    const { rowCount: linked } = await client.query(`
      UPDATE customers c
      SET pipeline_id = cp.id
      FROM customer_pipeline cp
      WHERE cp.sales_id            = c.user_id
        AND LOWER(TRIM(cp.company_name)) = LOWER(TRIM(c.company_name))
        AND cp.deleted_at IS NULL
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
