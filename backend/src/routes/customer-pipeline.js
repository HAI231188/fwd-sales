// /api/customer-pipeline — "Data khách hàng" management page for TP + lead.
//
// Mounted at /api/customer-pipeline (not /api/customers) on purpose: routes/customers.js
// already owns PUT/DELETE on the `customers` (interaction) table. Re-using
// /api/customers/:id for a *different* table (customer_pipeline) would silently
// shadow or be shadowed by those handlers depending on method/order — confusing
// and exactly the alias contract risk L6 warns about. Keep the path namespaces
// distinct: /api/customers = customers (interaction) table, /api/customer-pipeline =
// customer_pipeline (CRM company) table.
//
// Auth: GET + PATCH + DELETE all require role IN ('truong_phong_log','lead').
// DELETE additionally requires 0 live jobs for the customer (see L17 + 0-job guard).

const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const ADMIN_ROLES = ['truong_phong_log', 'lead'];
function isAdmin(req) { return ADMIN_ROLES.includes(req.user?.role); }

const EDITABLE_FIELDS = ['company_name', 'company_full_name', 'tax_code', 'invoice_address'];

// ─── GET /api/customer-pipeline ────────────────────────────────────────────────
// List non-deleted customer_pipeline rows with sales JOIN and a per-customer
// job count. Sort + pagination are handled client-side (page size won't exceed
// a few hundred); backend honors only the ?search filter to keep this endpoint
// simple and cacheable.
router.get('/', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Không có quyền' });

  const search = (req.query.search || '').trim();
  const params = [];
  let where = 'cp.deleted_at IS NULL';
  if (search) {
    params.push(`%${search}%`);
    // ILIKE on either the internal short name OR the legal/invoice name.
    where += ` AND (cp.company_name ILIKE $${params.length} OR cp.company_full_name ILIKE $${params.length})`;
  }

  try {
    const { rows } = await db.query(`
      SELECT
        cp.id,
        cp.company_name,
        cp.company_full_name,
        cp.tax_code,
        cp.invoice_address,
        cp.stage,
        cp.created_at,
        cp.updated_at,
        cp.sales_id,
        u.name AS sales_name,
        u.code AS sales_code,
        u.avatar_color AS sales_avatar_color,
        COALESCE((
          SELECT COUNT(*)::int FROM jobs j
          WHERE j.deleted_at IS NULL
            AND LOWER(j.customer_name) = LOWER(cp.company_name)
        ), 0) AS job_count
      FROM customer_pipeline cp
      LEFT JOIN users u ON u.id = cp.sales_id
      WHERE ${where}
      ORDER BY cp.updated_at DESC NULLS LAST, cp.id DESC
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/customer-pipeline error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/customer-pipeline/:id ───────────────────────────────────────────
// Update editable fields. If sales_id changes, apply the L14 transfer pattern:
// the existing pipeline row is hard-deleted (with its customers cascade) and a
// fresh one is upserted under the new sales user. Old + new sales get notifications;
// the destroyed pipeline's history dies with it (intentional — that's the spec).
router.patch('/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Không có quyền' });

  const pipelineId = parseInt(req.params.id, 10);
  if (!Number.isFinite(pipelineId)) {
    return res.status(400).json({ error: 'ID không hợp lệ' });
  }

  // Normalize input — trim strings, treat empty as missing for required fields.
  const body = req.body || {};
  const trimmed = {};
  for (const f of EDITABLE_FIELDS) {
    if (body[f] !== undefined) trimmed[f] = String(body[f] ?? '').trim();
  }
  const newSalesIdRaw = body.sales_id;
  const newSalesId = (newSalesIdRaw === undefined || newSalesIdRaw === null || newSalesIdRaw === '')
    ? undefined : parseInt(newSalesIdRaw, 10);
  if (newSalesIdRaw !== undefined && newSalesIdRaw !== null && newSalesIdRaw !== '' && !Number.isFinite(newSalesId)) {
    return res.status(400).json({ error: 'sales_id không hợp lệ' });
  }

  // Required-field check on whatever was provided (we don't force the caller to
  // send every field, but any field they DO send must be non-empty).
  for (const f of EDITABLE_FIELDS) {
    if (trimmed[f] !== undefined && trimmed[f] === '') {
      return res.status(400).json({ error: `Trường ${f} không được để trống` });
    }
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: curRows } = await client.query(
      `SELECT cp.*, u.name AS sales_name
         FROM customer_pipeline cp
         LEFT JOIN users u ON u.id = cp.sales_id
        WHERE cp.id = $1 AND cp.deleted_at IS NULL`,
      [pipelineId]
    );
    if (!curRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
    }
    const cur = curRows[0];

    const isSalesChange = newSalesId !== undefined && newSalesId !== cur.sales_id;

    if (isSalesChange) {
      // Validate the new sales user exists and is sales/lead.
      const { rows: sRows } = await client.query(
        `SELECT id, name, role FROM users WHERE id = $1`, [newSalesId]
      );
      if (!sRows[0] || !['sales', 'lead'].includes(sRows[0].role)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Sales mới không hợp lệ' });
      }
      const newSales = sRows[0];

      // The fields to write to the new pipeline. Prefer the edited values from
      // the request; fall back to the current pipeline's values for fields the
      // caller didn't touch.
      const company_name      = trimmed.company_name      ?? cur.company_name;
      const company_full_name = trimmed.company_full_name ?? (cur.company_full_name || '');
      const tax_code          = trimmed.tax_code          ?? (cur.tax_code          || '');
      const invoice_address   = trimmed.invoice_address   ?? (cur.invoice_address   || '');
      const customer_id_to_copy = cur.customer_id;
      const stage_to_copy       = cur.stage;

      // Destroy the OLD pipeline first (and its child customers — FK is SET NULL
      // not CASCADE, so customers rows would otherwise outlive the pipeline).
      // pipeline_history + pipeline_delete_requests cascade automatically.
      await client.query(`DELETE FROM customers WHERE pipeline_id = $1`, [pipelineId]);
      await client.query(`DELETE FROM customer_pipeline WHERE id = $1`, [pipelineId]);

      // UPSERT into new sales' pipeline. The ON CONFLICT clause uses the partial
      // unique index predicate `WHERE deleted_at IS NULL` to match the new index.
      // RETURNING xmax=0 distinguishes a fresh INSERT from an UPDATE-on-existing.
      const { rows: ups } = await client.query(
        `INSERT INTO customer_pipeline
           (sales_id, company_name, customer_id, stage,
            company_full_name, invoice_address, tax_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sales_id, LOWER(company_name)) WHERE deleted_at IS NULL
           DO UPDATE SET
             company_full_name = EXCLUDED.company_full_name,
             invoice_address   = EXCLUDED.invoice_address,
             tax_code          = EXCLUDED.tax_code,
             updated_at        = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`,
        [newSalesId, company_name, customer_id_to_copy, stage_to_copy,
         company_full_name, invoice_address, tax_code]
      );
      const newPipelineId  = ups[0].id;
      const wasNewInserted = ups[0].was_inserted;

      // Notifications. Old sales loses the customer; new sales gains it.
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, 'pipeline_transferred_out', $2, $3)`,
        [cur.sales_id,
         'Khách bị chuyển khỏi pipeline',
         `Khách ${company_name} đã được chuyển khỏi pipeline của bạn bởi ${req.user.name}`]
      );
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, $2, $3, $4)`,
        [newSalesId,
         wasNewInserted ? 'pipeline_transferred_in' : 'pipeline_added',
         wasNewInserted ? 'Khách mới chuyển vào pipeline' : 'Cập nhật pipeline',
         `Khách ${company_name} đã được ${req.user.name} chuyển vào pipeline của bạn`]
      );

      // Stage transition audit on the NEW pipeline (history of the old one was
      // destroyed with the pipeline). The "from_stage" is whatever the old row
      // was at when transferred.
      await client.query(
        `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [newPipelineId, stage_to_copy, stage_to_copy, req.user.id]
      );

      await client.query('COMMIT');
      return res.json({
        ok: true,
        transferred: true,
        new_pipeline_id: newPipelineId,
        from_sales: { id: cur.sales_id, name: cur.sales_name || null },
        to_sales:   { id: newSalesId,   name: newSales.name || null },
      });
    }

    // Simple field update path — no sales change. Only update fields the caller
    // actually sent. If nothing was sent, still bump updated_at for visibility.
    const sets = [];
    const params = [];
    let idx = 1;
    for (const f of EDITABLE_FIELDS) {
      if (trimmed[f] !== undefined) {
        sets.push(`${f} = $${idx++}`);
        params.push(trimmed[f]);
      }
    }
    sets.push(`updated_at = NOW()`);
    params.push(pipelineId);
    const { rows: updated } = await client.query(
      `UPDATE customer_pipeline SET ${sets.join(', ')}
        WHERE id = $${idx} AND deleted_at IS NULL
        RETURNING *`,
      params
    );

    await client.query('COMMIT');
    res.json({ ok: true, transferred: false, pipeline: updated[0] || null });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /api/customer-pipeline/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE /api/customer-pipeline/:id ─────────────────────────────────────────
// Soft delete only on customer_pipeline. Guarded by 0 live jobs.
//
// L17 backfill protection: `backfill_pipeline.js` Step 1 inserts a fresh pipeline
// row on every deploy for any `customers` row whose (user_id, LOWER(company_name))
// has no live pipeline. Just soft-deleting the pipeline would let backfill resurrect
// it on the next deploy. To prevent that, also hard-DELETE the matching `customers`
// rows in the same transaction. The same hard-delete pattern is used at L14
// transfer (`customer-pipeline.js:153` and `jobs.js:1450`).
//
// The DELETE keys on BOTH `pipeline_id = $1` (directly linked rows) AND
// `(user_id, LOWER(company_name))` (detached rows that backfill would otherwise
// pick up). Together this guarantees soft-deleted pipeline rows stay deleted.
router.delete('/:id', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Không có quyền' });

  const pipelineId = parseInt(req.params.id, 10);
  if (!Number.isFinite(pipelineId)) {
    return res.status(400).json({ error: 'ID không hợp lệ' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch the row first — need company_name + sales_id for the job count,
    // customers cleanup, and notification. SELECT ... FOR UPDATE locks it so a
    // concurrent UPDATE/DELETE on the same id can't race us.
    const { rows: curRows } = await client.query(
      `SELECT id, sales_id, company_name
         FROM customer_pipeline
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [pipelineId]
    );
    if (!curRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy hoặc đã bị xóa' });
    }
    const cur = curRows[0];

    // 0-job guard. Same predicate as the list endpoint's job_count column
    // (`customer-pipeline.js:59-63`) so the UI count is the contract.
    const { rows: jobCountRows } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM jobs
        WHERE deleted_at IS NULL
          AND LOWER(customer_name) = LOWER($1)`,
      [cur.company_name]
    );
    const liveJobs = jobCountRows[0].n;
    if (liveJobs > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Khách còn ${liveJobs} job, không thể xóa`,
        live_job_count: liveJobs,
      });
    }

    // L17 cleanup: hard-DELETE the matching customers rows so backfill_pipeline.js
    // won't recreate the soft-deleted pipeline on the next deploy. Keys on both
    // pipeline_id (directly linked) AND (user_id, LOWER(company_name)) (detached
    // rows that share the company name with the same sales user).
    const { rowCount: customersDeleted } = await client.query(
      `DELETE FROM customers
        WHERE pipeline_id = $1
           OR ($2::int IS NOT NULL
               AND user_id = $2::int
               AND LOWER(company_name) = LOWER($3))`,
      [pipelineId, cur.sales_id, cur.company_name]
    );

    // Soft-delete the pipeline row. The partial unique index
    // `idx_pipeline_sales_company_active WHERE deleted_at IS NULL` lets the same
    // (sales, company) pair be re-created later if needed.
    await client.query(
      `UPDATE customer_pipeline
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [pipelineId]
    );

    // Notify the owner sales (if any) that their pipeline entry was removed.
    if (cur.sales_id) {
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message)
         VALUES ($1, 'pipeline_deleted', 'Khách bị xóa khỏi pipeline', $2)`,
        [cur.sales_id,
         `Khách ${cur.company_name} đã được xóa khỏi pipeline bởi ${req.user.name}`]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      soft_deleted: true,
      customers_purged: customersDeleted,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/customer-pipeline/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
