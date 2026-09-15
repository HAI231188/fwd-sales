// Customer ownership = customer_pipeline.sales_id. One home for the rules every
// sales-change path shares (L30): job create (POST /api/jobs), job edit
// (PUT /api/jobs/:id), the "Data khách hàng" admin PATCH, and the deploy-time
// backfill (db/backfill_pipeline.js).
//
// A sales change REASSIGNS the pipeline row in place. It never deletes a
// customer_pipeline or customers row: quotes and customer_interaction_updates
// hang off customers (ON DELETE CASCADE), and pipeline_history and
// pipeline_delete_requests hang off customer_pipeline (ON DELETE CASCADE), so a
// delete there wipes the customer's whole thread.
//
// customers.user_id is deliberately NOT rewritten. It records who made each
// contact — it matches reports.user_id and is what stats.js attributes KPIs by —
// just as past jobs keep their own sales_id. The new owner reaches the whole
// thread through customers.pipeline_id, which is how every pipeline read and
// ownership check joins (routes/pipeline.js).

// "Has ever had a shipment": ANY job row — completed, pending, even
// soft-deleted — matched by the same (customer_id OR name) key used wherever a
// job is linked to a pipeline row. Such a customer is booked and is never
// demoted out of 'booked' (applyAutoTransitions, backfill_pipeline.js).
// `alias` must expose customer_id and company_name.
function hasAnyJobSql(alias) {
  return `EXISTS (SELECT 1 FROM jobs j
                   WHERE j.customer_id = ${alias}.customer_id
                      OR LOWER(j.customer_name) = LOWER(${alias}.company_name))`;
}

// "Has ever won a quote": ANY quote with status='booked' in this customer's
// thread. Stage is derived PER QUOTE — one booked quote makes the CUSTOMER
// "đã booking", and a later quote (or a later contact marked 'following')
// describes only THAT quote/contact and must never pull the customer's own
// stage back down. Paired with hasAnyJobSql this is the whole promotion rule:
// booked quote OR job => 'booked', never demoted out of it; the
// newest-interaction logic then decides only among new/following/dormant, and
// only for customers that have neither.
//
// Three ways a quote reaches this pipeline row, because no single one survives
// every path: (1) customers.pipeline_id — the link that SURVIVES an L14 sales
// transfer (the row changes owner; customers.user_id deliberately does not);
// (2) the pipeline row's own customer_id; (3) author + name, for legacy
// customers rows Step 2 has not back-linked. The name branch is scoped by
// OWNER (L14 — never match a company across sales users), unlike hasAnyJobSql,
// whose "has ever shipped" is a company-level fact.
//
// `alias` must be a customer_pipeline row (needs id, customer_id, sales_id,
// company_name).
function hasBookedQuoteSql(alias) {
  return `EXISTS (SELECT 1 FROM quotes q
                    JOIN customers c ON c.id = q.customer_id
                   WHERE q.status = 'booked'
                     AND ( c.pipeline_id = ${alias}.id
                           OR c.id = ${alias}.customer_id
                           OR ( c.user_id = ${alias}.sales_id
                                AND LOWER(TRIM(c.company_name)) = LOWER(TRIM(${alias}.company_name)) ) ))`;
}

// Active pipeline rows for this customer owned by anyone other than salesId.
// Booked first, so the row carrying the customer's won status is the one that
// moves when only one can.
async function findOtherOwners(client, { customerName, customerId, salesId }) {
  const { rows } = await client.query(
    `SELECT cp.id, cp.sales_id, cp.stage, cp.company_name, u.name AS sales_name
       FROM customer_pipeline cp
       LEFT JOIN users u ON u.id = cp.sales_id
      WHERE cp.sales_id <> $1
        AND cp.deleted_at IS NULL
        AND ( LOWER(cp.company_name) = LOWER($2)
              OR ($3::int IS NOT NULL AND cp.customer_id = $3::int) )
      ORDER BY (cp.stage = 'booked') DESC, cp.updated_at DESC NULLS LAST, cp.id`,
    [salesId, customerName, customerId || null]
  );
  return rows;
}

// Hand ONE pipeline row to newSalesId. Refuses — never deletes — when
// newSalesId already owns an active row for the same company: the partial
// unique index allows one per (sales_id, LOWER(company_name)), and merging would
// mean deleting one of the two.
async function reassignPipelineRow(client, { pipelineId, newSalesId, actorId }) {
  const { rows: [row] } = await client.query(
    `SELECT id, sales_id, stage, company_name FROM customer_pipeline
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [pipelineId]
  );
  if (!row) return { ok: false, reason: 'not_found' };
  if (Number(row.sales_id) === Number(newSalesId)) return { ok: true, row };

  const { rows: clash } = await client.query(
    `SELECT id FROM customer_pipeline
      WHERE sales_id = $1 AND LOWER(company_name) = LOWER($2)
        AND deleted_at IS NULL AND id <> $3`,
    [newSalesId, row.company_name, pipelineId]
  );
  if (clash[0]) return { ok: false, reason: 'target_has_row', targetId: clash[0].id, row };

  await client.query(
    `UPDATE customer_pipeline SET sales_id = $1, updated_at = NOW() WHERE id = $2`,
    [newSalesId, pipelineId]
  );
  // Owner-change marker in the row's own audit trail. The stage is unchanged,
  // so from_stage = to_stage (the convention the old admin transfer used).
  await client.query(
    `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by)
     VALUES ($1, $2, $2, $3)`,
    [pipelineId, row.stage, actorId || null]
  );
  return { ok: true, row };
}

// Job-save path: move every other owner's row for this customer to newSalesId.
// `moved` rows changed owner; `kept` rows could not (newSalesId already owns
// one) and are left exactly as they were.
async function transferCustomerTo(client, { customerName, customerId, newSalesId, actorId }) {
  const others = await findOtherOwners(client, { customerName, customerId, salesId: newSalesId });
  const moved = [];
  const kept = [];
  for (const o of others) {
    const r = await reassignPipelineRow(client, { pipelineId: o.id, newSalesId, actorId });
    (r.ok ? moved : kept).push({ id: o.id, sales_id: o.sales_id, sales_name: o.sales_name });
  }
  return { moved, kept };
}

// 409 body telling the client this save would move the customer to another
// sales user, or null when it would not. The client names both owners and
// re-sends with confirm_owner_change: true.
async function ownerChangeConflict(client, { customerName, customerId, newSalesId }) {
  const others = await findOtherOwners(client, { customerName, customerId, salesId: newSalesId });
  if (others.length === 0) return null;
  const owners = [...new Map(others.map(o => [o.sales_id, { id: o.sales_id, name: o.sales_name || null }])).values()];
  const { rows: [to] } = await client.query(`SELECT name FROM users WHERE id = $1`, [newSalesId]);
  return {
    code: 'OWNER_CHANGE_CONFIRM_REQUIRED',
    error: `Khách ${customerName} đang thuộc ${owners.map(o => o.name || '—').join(', ')}. `
      + `Cần xác nhận chuyển sang ${to?.name || 'sales mới'}.`,
    customer_name: customerName,
    current_owners: owners,
    new_owner: { id: Number(newSalesId), name: to?.name || null },
  };
}

// Notifications for a completed transfer — the wording POST /api/jobs has
// always used.
async function notifyOwnerTransfer(client, { moved, newSalesId, customerName, actorName, jobId }) {
  for (const old of moved) {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, message, job_id)
       VALUES ($1, 'pipeline_transferred_out', 'Khách bị chuyển khỏi pipeline', $2, $3)`,
      [old.sales_id, `Khách ${customerName} đã được chuyển khỏi pipeline của bạn bởi ${actorName}`, jobId]
    );
  }
  await client.query(
    `INSERT INTO notifications (user_id, type, title, message, job_id)
     VALUES ($1, 'pipeline_transferred_in', 'Khách được chuyển vào pipeline', $2, $3)`,
    [newSalesId, `Khách ${customerName} đã được thêm vào pipeline của bạn (stage Đã booking)`, jobId]
  );
}

module.exports = {
  hasAnyJobSql,
  hasBookedQuoteSql,
  findOtherOwners,
  reassignPipelineRow,
  transferCustomerTo,
  ownerChangeConflict,
  notifyOwnerTransfer,
};
