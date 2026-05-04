const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const LOG_ROLES = ['truong_phong_log', 'cus', 'cus1', 'cus2', 'cus3', 'dieu_do', 'ops'];

// GET /api/search?q=<keyword>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
// LOG-team global search across jobs (date-scoped) and customer pipeline (no date filter).
router.get('/', requireAuth, async (req, res) => {
  if (!LOG_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Không có quyền tìm kiếm' });
  }

  const q = (req.query.q || '').trim();
  const from = (req.query.from || '').replace(/'/g, '');
  const to   = (req.query.to   || '').replace(/'/g, '');

  if (!q) {
    return res.json({ jobs: [], customers: [], total_jobs: 0, total_customers: 0 });
  }

  const pattern = `%${q}%`;

  try {
    let jobsRows = [];
    let totalJobs = 0;

    // JOBS: only when a date range is supplied (frontend disables search input until then;
    // backend re-enforces here so a missing range never returns the entire jobs table).
    if (from && to) {
      const opsClause = req.user.role === 'ops' ? `AND j.destination = 'hai_phong'` : '';

      const jobsWhere = `
        WHERE j.deleted_at IS NULL
          AND j.created_at >= $2::date
          AND j.created_at <  $3::date + INTERVAL '1 day'
          AND (
                j.job_code      ILIKE $1
             OR j.si_number     ILIKE $1
             OR j.mbl_no        ILIKE $1
             OR j.hbl_no        ILIKE $1
             OR j.customer_name ILIKE $1
             OR EXISTS (
                  SELECT 1 FROM job_containers jc
                  WHERE jc.job_id = j.id AND jc.cont_number ILIKE $1
                )
          )
          ${opsClause}
      `;

      const params = [pattern, from, to];

      const [jobsList, jobsCount] = await Promise.all([
        db.query(`
          SELECT
            j.id, j.job_code, j.customer_name, j.si_number, j.deadline,
            jt.tk_status
          FROM jobs j
          LEFT JOIN job_tk jt ON jt.job_id = j.id
          ${jobsWhere}
          ORDER BY j.created_at DESC
          LIMIT 10
        `, params),
        db.query(`SELECT COUNT(*)::int AS c FROM jobs j ${jobsWhere}`, params),
      ]);

      jobsRows = jobsList.rows;
      totalJobs = jobsCount.rows[0]?.c || 0;
    }

    // CUSTOMERS: search the pipeline (one row per company per sales rep).
    // Returns pipeline_id because the LOG-team modal opens by pipelineId.
    // Note: tax_code lives on `customers`, not `customer_pipeline` — so the
    // tax_code/phone match runs as a child-customers EXISTS, not on cp directly.
    // Scope filter: customer must have ≥1 non-deleted job whose customer_name
    // matches the pipeline's company_name. For OPS, the job must also be in
    // Hải Phòng — so OPS only sees customers they could actually work on.
    const opsCustClause = req.user.role === 'ops' ? `AND j.destination = 'hai_phong'` : '';
    const custWhere = `
      WHERE (
            cp.company_name   ILIKE $1
         OR cp.contact_person ILIKE $1
         OR cp.phone          ILIKE $1
         OR EXISTS (
              SELECT 1 FROM customers c
              WHERE c.pipeline_id = cp.id
                AND (c.tax_code ILIKE $1 OR c.phone ILIKE $1)
            )
      )
      AND EXISTS (
        SELECT 1 FROM jobs j
        WHERE LOWER(j.customer_name) = LOWER(cp.company_name)
          AND j.deleted_at IS NULL
          ${opsCustClause}
      )
    `;

    const [custList, custCount] = await Promise.all([
      db.query(`
        SELECT
          cp.id AS pipeline_id,
          cp.company_name,
          cp.contact_person,
          cp.phone,
          (SELECT c2.tax_code FROM customers c2
            WHERE c2.pipeline_id = cp.id AND c2.tax_code IS NOT NULL
            ORDER BY c2.created_at DESC LIMIT 1) AS tax_code
        FROM customer_pipeline cp
        ${custWhere}
        ORDER BY cp.last_activity_date DESC NULLS LAST, cp.created_at DESC
        LIMIT 10
      `, [pattern]),
      db.query(`SELECT COUNT(*)::int AS c FROM customer_pipeline cp ${custWhere}`, [pattern]),
    ]);

    res.json({
      jobs: jobsRows,
      customers: custList.rows,
      total_jobs: totalJobs,
      total_customers: custCount.rows[0]?.c || 0,
    });
  } catch (err) {
    console.error('GET /api/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
