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
const { reassignPipelineRow } = require('../services/pipeline-ownership');

const ADMIN_ROLES = ['truong_phong_log', 'lead'];
function isAdmin(req) { return ADMIN_ROLES.includes(req.user?.role); }

const EDITABLE_FIELDS = ['company_name', 'company_full_name', 'tax_code', 'invoice_address'];

// Writes whichever EDITABLE_FIELDS the caller sent and bumps updated_at.
async function updateEditableFields(client, pipelineId, trimmed) {
  const sets = [];
  const params = [];
  let idx = 1;
  for (const f of EDITABLE_FIELDS) {
    if (trimmed[f] !== undefined) {
      sets.push(`${f} = $${idx++}`);
      params.push(trimmed[f]);
    }
  }
  sets.push('updated_at = NOW()');
  params.push(pipelineId);
  const { rows } = await client.query(
    `UPDATE customer_pipeline SET ${sets.join(', ')}
      WHERE id = $${idx} AND deleted_at IS NULL
      RETURNING *`,
    params
  );
  return rows[0] || null;
}

// ─── GET /api/customer-pipeline ────────────────────────────────────────────────
// List non-deleted customer_pipeline rows with sales JOIN and a per-customer
// job count. Sort + pagination are handled client-side (page size won't exceed
// a few hundred); backend honors only the ?search filter to keep this endpoint
// simple and cacheable.
router.get('/', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Không có quyền' });

  const search = (req.query.search || '').trim();
  const params = [];
  // Restrict to booked customers only: TP should see customers TP created
  // (always stage='booked' via the L14 upsert at jobs.js:1461-1466) and
  // customers Sales has booked. Sales' in-progress leads (new/following/dormant)
  // remain on the Sales pipeline view and don't appear here.
  let where = `cp.deleted_at IS NULL AND cp.stage = 'booked'`;
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
// Update editable fields. If sales_id changes, the customer is REASSIGNED to the
// new sales user (services/pipeline-ownership.js): the same pipeline row keeps
// its id, customers rows, quotes, interaction thread and history — nothing is
// deleted. Old + new sales get notifications. If the new sales already owns a
// row for the same company the change is refused (409): merging would mean
// deleting one of the two rows.
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

      const company_name = trimmed.company_name ?? cur.company_name;

      // Apply any edited fields to THIS row first, so a rename is in place
      // before the reassign looks for a clashing row under the new owner.
      await updateEditableFields(client, pipelineId, trimmed);

      // Reassign the same row to the new sales user — never delete it. Its
      // customers rows, quotes, interaction thread and pipeline_history keep
      // their ids (services/pipeline-ownership.js).
      const moved = await reassignPipelineRow(client, { pipelineId, newSalesId, actorId: req.user.id });
      if (!moved.ok) {
        await client.query('ROLLBACK');
        if (moved.reason === 'target_has_row') {
          return res.status(409).json({
            code: 'OWNER_ALREADY_HAS_CUSTOMER',
            error: `${newSales.name} đã có khách "${company_name}" trong pipeline — không thể gộp tự động. Hãy xử lý một trong hai bản ghi trước.`,
          });
        }
        return res.status(404).json({ error: 'Không tìm thấy khách hàng' });
      }

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
         VALUES ($1, 'pipeline_transferred_in', 'Khách mới chuyển vào pipeline', $2)`,
        [newSalesId, `Khách ${company_name} đã được ${req.user.name} chuyển vào pipeline của bạn`]
      );

      await client.query('COMMIT');
      return res.json({
        ok: true,
        transferred: true,
        // Kept for the response contract (L6); a transfer no longer changes the id.
        new_pipeline_id: pipelineId,
        from_sales: { id: cur.sales_id, name: cur.sales_name || null },
        to_sales:   { id: newSalesId,   name: newSales.name || null },
      });
    }

    // Simple field update path — no sales change. Only update fields the caller
    // actually sent. If nothing was sent, still bump updated_at for visibility.
    const updated = await updateEditableFields(client, pipelineId, trimmed);

    await client.query('COMMIT');
    res.json({ ok: true, transferred: false, pipeline: updated });
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
// rows in the same transaction. (The sales-transfer paths no longer delete
// anything — they reassign the pipeline row; see services/pipeline-ownership.js.)
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
