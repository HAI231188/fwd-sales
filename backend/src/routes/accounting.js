// KT2 — Backend endpoints for the Kế toán công nợ (Accounting) module.
//
// This file exports TWO routers so we can honour both URL prefixes the
// spec requires while keeping all 6 handlers in a single source file:
//   • accountingRouter  → mounted at /api/accounting   (the GET list)
//   • jobActionsRouter  → mounted at /api/jobs         (the 5 PATCH/POST
//                                                       lifecycle mutations)
// Both routers role-gate to req.user.role === 'ke_toan'.
//
// No notification fan-out (KT notifies LOG/Sales verbally per spec).
// No "send back to KT" endpoint — when LOG/Sales fix the issue, KT just
// clicks "Đã kiểm tra" again, which implicitly clears returned_to/reason
// via the accounting-check UPDATE (see PART C).
//
// Hard-coded threshold below; Phase 2 will lift to a settings table.

const router            = require('express').Router();
const jobActionsRouter  = require('express').Router();
const db                = require('../db');
const { requireAuth }   = require('../middleware/auth');
const { recordHistory } = require('../services/job-history');

const OVERDUE_DAYS = 30;
const ALLOWED_RETURN_TARGETS = ['log', 'sales'];

// Role gate. requireAuth has already populated req.user from the JWT;
// we just need to bounce non-KT requests with a clear Vietnamese message.
function requireKeToan(req, res, next) {
  if (req.user?.role !== 'ke_toan') {
    return res.status(403).json({ error: 'Chỉ kế toán mới có quyền' });
  }
  next();
}

router.use(requireAuth, requireKeToan);
jobActionsRouter.use(requireAuth, requireKeToan);

// Lightweight pre-fetch used by every mutation handler for validation gates.
// Returns just the lifecycle fields — full denormalised payload is only
// needed for the list endpoint.
async function fetchJobForKt(client, id) {
  const { rows } = await client.query(
    `SELECT id, deleted_at, completed_at,
            revenue_entered_at,
            accounting_checked_at, accounting_checked_by,
            debit_sent_at, debit_sent_by,
            payment_received_at, payment_received_by, payment_amount,
            invoice_issued_at, invoice_issued_by,
            returned_to, returned_reason,
            sales_id, job_code
       FROM jobs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ─── GET /api/accounting/jobs ──────────────────────────────────────────────
// Lists jobs by lifecycle tab. Denormalised JOIN pattern mirrors
// GET /api/jobs (routes/jobs.js around line 1184-1269), but trimmed to the
// fields KT actually needs — no containers / ops_tasks / first_booking
// blobs (the KT page doesn't manage those).
router.get('/jobs', async (req, res) => {
  const { tab: rawTab, overdue, from_date, to_date } = req.query;
  const tab = rawTab || 'pending_check';
  const ALLOWED_TABS = ['pending_check', 'checked', 'debit_sent', 'paid'];
  if (!ALLOWED_TABS.includes(tab)) {
    return res.status(400).json({ error: `tab phải là 1 trong ${ALLOWED_TABS.join('/')}` });
  }

  const conditions = ['j.deleted_at IS NULL'];
  let orderBy;

  switch (tab) {
    case 'pending_check':
      conditions.push('j.completed_at IS NOT NULL');
      conditions.push('j.revenue_entered_at IS NOT NULL');
      conditions.push('j.accounting_checked_at IS NULL');
      orderBy = 'j.revenue_entered_at ASC';
      break;
    case 'checked':
      conditions.push('j.accounting_checked_at IS NOT NULL');
      conditions.push('j.debit_sent_at IS NULL');
      orderBy = 'j.accounting_checked_at ASC';
      break;
    case 'debit_sent':
      conditions.push('j.debit_sent_at IS NOT NULL');
      conditions.push('j.payment_received_at IS NULL');
      if (String(overdue) === 'true') {
        conditions.push(`j.debit_sent_at < NOW() - INTERVAL '${OVERDUE_DAYS} days'`);
      }
      orderBy = 'j.debit_sent_at ASC';
      break;
    case 'paid':
      conditions.push('j.payment_received_at IS NOT NULL');
      // KT4 — date filter applies to j.payment_received_at on the paid tab.
      // Default last 30 days if neither bound supplied. Sanitize the date
      // strings the same way jobs.js does for completed-tab dates.
      if (from_date) {
        conditions.push(`j.payment_received_at >= '${from_date.replace(/'/g, '')}'::date`);
      }
      if (to_date) {
        conditions.push(`j.payment_received_at < '${to_date.replace(/'/g, '')}'::date + INTERVAL '1 day'`);
      }
      if (!from_date && !to_date) {
        conditions.push(`j.payment_received_at >= NOW() - INTERVAL '30 days'`);
      }
      orderBy = 'j.payment_received_at DESC';
      break;
  }

  const WHERE = 'WHERE ' + conditions.join(' AND ');

  try {
    const { rows } = await db.query(`
      SELECT j.*,
        u_sales.name        AS sales_name,
        u_created.name      AS created_by_name,
        u_revenue.name      AS revenue_entered_by_name,
        u_kt_checked.name   AS accounting_checked_by_name,
        u_debit_sent.name   AS debit_sent_by_name,
        u_payment_recv.name AS payment_received_by_name,
        u_invoice.name      AS invoice_issued_by_name,
        u_cus.name          AS cus_name,
        u_ops.name          AS ops_name,
        u_dd.name           AS dieu_do_name,
        jt.tk_status        AS tk_status,
        jt.completed_at     AS tk_completed_at,
        get_truck_booking_status(j.id) AS truck_booking_status
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON true
      LEFT JOIN users u_sales        ON u_sales.id        = j.sales_id
      LEFT JOIN users u_created      ON u_created.id      = j.created_by
      LEFT JOIN users u_revenue      ON u_revenue.id      = j.revenue_entered_by
      LEFT JOIN users u_kt_checked   ON u_kt_checked.id   = j.accounting_checked_by
      LEFT JOIN users u_debit_sent   ON u_debit_sent.id   = j.debit_sent_by
      LEFT JOIN users u_payment_recv ON u_payment_recv.id = j.payment_received_by
      LEFT JOIN users u_invoice      ON u_invoice.id      = j.invoice_issued_by
      LEFT JOIN users u_cus          ON u_cus.id          = ja.cus_id
      LEFT JOIN users u_ops          ON u_ops.id          = ja.ops_id
      LEFT JOIN users u_dd           ON u_dd.id           = ja.dieu_do_id
      LEFT JOIN job_tk jt            ON jt.job_id         = j.id
      ${WHERE}
      ORDER BY ${orderBy}
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/accounting/stats ─────────────────────────────────────────────
// KT3 — header KPIs + 30-day completion histogram for the dashboard.
// Single FILTER-COUNT query for the 5 buckets keeps it cheap (one scan of
// the jobs table); the 30-day histogram is a separate GROUP BY day. JS
// gap-fills missing days so the frontend always gets exactly 30 entries.
router.get('/stats', async (req, res) => {
  try {
    const [counts, hist] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE j.completed_at IS NOT NULL
              AND j.revenue_entered_at IS NOT NULL
              AND j.accounting_checked_at IS NULL
          )::int AS pending_check,
          COUNT(*) FILTER (
            WHERE j.accounting_checked_at IS NOT NULL
              AND j.debit_sent_at IS NULL
          )::int AS checked,
          COUNT(*) FILTER (
            WHERE j.debit_sent_at IS NOT NULL
              AND j.payment_received_at IS NULL
          )::int AS debit_sent,
          COUNT(*) FILTER (
            WHERE j.debit_sent_at IS NOT NULL
              AND j.payment_received_at IS NULL
              AND j.debit_sent_at < NOW() - INTERVAL '${OVERDUE_DAYS} days'
          )::int AS debit_sent_overdue,
          COUNT(*) FILTER (
            WHERE j.payment_received_at IS NOT NULL
          )::int AS paid
        FROM jobs j
        WHERE j.deleted_at IS NULL
      `),
      db.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('day', j.completed_at), 'YYYY-MM-DD') AS date,
          COUNT(*)::int AS count
        FROM jobs j
        WHERE j.deleted_at IS NULL
          AND j.completed_at IS NOT NULL
          AND j.completed_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE_TRUNC('day', j.completed_at)
        ORDER BY date ASC
      `),
    ]);

    // Gap-fill: produce exactly 30 entries from (today - 29) through today,
    // substituting count=0 for days the SQL didn't return. Done in JS rather
    // than SQL (generate_series) for portability + clearer intent.
    const map = new Map(hist.rows.map(r => [r.date, r.count]));
    const completed_per_day_30d = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      completed_per_day_30d.push({ date: dateStr, count: map.get(dateStr) || 0 });
    }

    res.json({
      counts: counts.rows[0],
      completed_per_day_30d,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/jobs/:id/accounting-check ──────────────────────────────────
// KT marks the job as reviewed. SIDE EFFECT: clears returned_to + reason
// (implicit "issue resolved" path — see KT2 spec PART C2 note).
jobActionsRouter.patch('/:id/accounting-check', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForKt(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (!job.completed_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa hoàn thành' });
    }
    if (!job.revenue_entered_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sales chưa nhập thu' });
    }
    if (job.accounting_checked_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job đã được kiểm tra trước đó' });
    }

    const { rows } = await client.query(`
      UPDATE jobs
         SET accounting_checked_at = NOW(),
             accounting_checked_by = $1,
             returned_to           = NULL,
             returned_reason       = NULL,
             updated_at            = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING *
    `, [req.user.id, req.params.id]);

    await recordHistory(
      client, req.params.id, req.user.id,
      'accounting_checked_at', null,
      rows[0].accounting_checked_at?.toISOString?.() || 'NOW()'
    );
    // If returned_to had been set, log the implicit clear too so the
    // audit trail shows when the issue was considered resolved.
    if (job.returned_to) {
      await recordHistory(
        client, req.params.id, req.user.id,
        'returned_to', job.returned_to, null
      );
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

// ─── PATCH /api/jobs/:id/debit-sent ────────────────────────────────────────
// KT marks the debit note as dispatched. Optional body.sent_at lets KT
// back-date when they actually mailed the debit (default NOW()).
jobActionsRouter.patch('/:id/debit-sent', async (req, res) => {
  const { sent_at } = req.body || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForKt(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (!job.accounting_checked_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa được kiểm tra' });
    }
    if (job.debit_sent_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job đã gửi debit trước đó' });
    }

    const { rows } = await client.query(`
      UPDATE jobs
         SET debit_sent_at = COALESCE($1::timestamptz, NOW()),
             debit_sent_by = $2,
             updated_at    = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING *
    `, [sent_at || null, req.user.id, req.params.id]);

    await recordHistory(
      client, req.params.id, req.user.id,
      'debit_sent_at', null,
      rows[0].debit_sent_at?.toISOString?.() || 'NOW()'
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/jobs/:id/invoice-issued ────────────────────────────────────
// KT marks that the VAT invoice has been issued. INDEPENDENT marker — it does
// NOT gate or reorder the pending_check→checked→debit_sent→paid lifecycle. The
// only precondition is that the job has been accounting-checked; KT may issue
// the invoice before OR after the debit note. Optional body.issued_at lets KT
// pick the actual issue date (default NOW()). No un-tick; double-issue rejected.
jobActionsRouter.patch('/:id/invoice-issued', async (req, res) => {
  const { issued_at } = req.body || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForKt(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (!job.accounting_checked_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa được kiểm tra' });
    }
    if (job.invoice_issued_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job đã xuất hóa đơn trước đó' });
    }

    const { rows } = await client.query(`
      UPDATE jobs
         SET invoice_issued_at = COALESCE($1::timestamptz, NOW()),
             invoice_issued_by = $2,
             updated_at        = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING *
    `, [issued_at || null, req.user.id, req.params.id]);

    await recordHistory(
      client, req.params.id, req.user.id,
      'invoice_issued_at', null,
      rows[0].invoice_issued_at?.toISOString?.() || 'NOW()'
    );

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── PATCH /api/jobs/:id/payment-received ──────────────────────────────────
// KT marks the customer payment as received. Optional body.received_at +
// body.amount; amount is stored on jobs.payment_amount for future reports
// (Phase 2 will expose it on the dashboard).
jobActionsRouter.patch('/:id/payment-received', async (req, res) => {
  const { received_at, amount } = req.body || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const job = await fetchJobForKt(client, req.params.id);
    if (!job || job.deleted_at) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job không tồn tại' });
    }
    if (!job.debit_sent_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job chưa gửi debit' });
    }
    if (job.payment_received_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Job đã được thu trước đó' });
    }

    const { rows } = await client.query(`
      UPDATE jobs
         SET payment_received_at = COALESCE($1::timestamptz, NOW()),
             payment_received_by = $2,
             payment_amount      = $3,
             updated_at          = NOW()
       WHERE id = $4 AND deleted_at IS NULL
       RETURNING *
    `, [received_at || null, req.user.id, amount ?? null, req.params.id]);

    await recordHistory(
      client, req.params.id, req.user.id,
      'payment_received_at', null,
      rows[0].payment_received_at?.toISOString?.() || 'NOW()'
    );
    if (amount != null) {
      await recordHistory(
        client, req.params.id, req.user.id,
        'payment_amount', null, String(amount)
      );
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

// ─── POST /api/jobs/:id/return-to-log + /return-to-sales ───────────────────
// Two endpoints share the same body shape (just a reason) + the same
// validation chain; the only difference is which value goes into the
// returned_to column. Factor a shared handler builder to avoid drift.
function returnHandler(target) {
  if (!ALLOWED_RETURN_TARGETS.includes(target)) {
    throw new Error(`Bad return target: ${target}`); // wiring-time guard
  }
  return async (req, res) => {
    const { reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Lý do bắt buộc' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const job = await fetchJobForKt(client, req.params.id);
      if (!job || job.deleted_at) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Job không tồn tại' });
      }
      if (!job.revenue_entered_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Sales chưa nhập thu' });
      }
      if (job.accounting_checked_at) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Job đã được kiểm tra — không thể trả về' });
      }

      const { rows } = await client.query(`
        UPDATE jobs
           SET returned_to     = $1,
               returned_reason = $2,
               updated_at      = NOW()
         WHERE id = $3 AND deleted_at IS NULL
         RETURNING *
      `, [target, String(reason).trim(), req.params.id]);

      await recordHistory(
        client, req.params.id, req.user.id,
        'returned_to', job.returned_to || null, target
      );

      await client.query('COMMIT');
      res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  };
}

jobActionsRouter.post('/:id/return-to-log',   returnHandler('log'));
jobActionsRouter.post('/:id/return-to-sales', returnHandler('sales'));

module.exports = { accountingRouter: router, jobActionsRouter };
