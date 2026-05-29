const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildSeaQuotePdf } = require('../services/sea-quote-pdf');

// Add quote to customer
router.post('/', requireAuth, async (req, res) => {
  const {
    customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg,
    monthly_volume_containers, route, cargo_ready_date, mode,
    carrier, transit_time, price, status, follow_up_notes, lost_reason, closing_soon,
    // 2026-05-26 C1 — sea-quote v2 fields. quote_data is the full structured
    // payload (JSONB); the 3 sibling columns are denormalized for queryability.
    quote_data, valid_until, exchange_rate, grand_total_currency,
  } = req.body;

  try {
    // Verify customer belongs to this user
    const { rows: check } = await db.query(
      'SELECT id FROM customers WHERE id=$1 AND user_id=$2',
      [customer_id, req.user.id]
    );
    if (!check[0]) return res.status(403).json({ error: 'Không có quyền' });

    const { rows } = await db.query(`
      INSERT INTO quotes
        (customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg,
         monthly_volume_containers, route, cargo_ready_date, mode,
         carrier, transit_time, price, status, follow_up_notes, lost_reason, closing_soon,
         quote_data, valid_until, exchange_rate, grand_total_currency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
              $16,$17,$18,$19)
      RETURNING *
    `, [
      customer_id, cargo_name,
      monthly_volume_cbm || null, monthly_volume_kg || null, monthly_volume_containers,
      route, cargo_ready_date || null, mode,
      carrier, transit_time, price,
      status || 'quoting', follow_up_notes, lost_reason, closing_soon || false,
      quote_data || null, valid_until || null,
      exchange_rate || null, grand_total_currency || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update quote
router.put('/:id', requireAuth, async (req, res) => {
  const {
    cargo_name, monthly_volume_cbm, monthly_volume_kg, monthly_volume_containers,
    route, cargo_ready_date, mode, carrier, transit_time, price,
    status, follow_up_notes, lost_reason, closing_soon,
    // 2026-05-26 C1 — sea-quote v2 fields (see POST for shape).
    quote_data, valid_until, exchange_rate, grand_total_currency,
  } = req.body;

  // Wrap quote UPDATE + (on booked) pipeline UPDATE + pipeline_history INSERT
  // in a single transaction so a mid-flight failure can't leave the quote
  // flipped to 'booked' while the pipeline / history rows are out of sync.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Verify ownership via join
    const { rows } = await client.query(`
      UPDATE quotes q SET
        cargo_name=$1, monthly_volume_cbm=$2, monthly_volume_kg=$3,
        monthly_volume_containers=$4, route=$5, cargo_ready_date=$6, mode=$7,
        carrier=$8, transit_time=$9, price=$10, status=$11,
        follow_up_notes=$12, lost_reason=$13, closing_soon=$14,
        quote_data=$15, valid_until=$16, exchange_rate=$17, grand_total_currency=$18,
        updated_at=NOW()
      FROM customers c
      WHERE q.id=$19 AND q.customer_id=c.id AND c.user_id=$20
      RETURNING q.*
    `, [
      cargo_name, monthly_volume_cbm || null, monthly_volume_kg || null,
      monthly_volume_containers, route, cargo_ready_date || null, mode,
      carrier, transit_time, price, status || 'quoting',
      follow_up_notes, lost_reason, closing_soon || false,
      quote_data || null, valid_until || null,
      exchange_rate || null, grand_total_currency || null,
      req.params.id, req.user.id,
    ]);

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy' });
    }

    // Auto-promote pipeline to 'booked' when quote status is set to booked
    if (status === 'booked') {
      const { rows: link } = await client.query(`
        SELECT c.pipeline_id, cp.stage
        FROM customers c
        LEFT JOIN customer_pipeline cp ON cp.id = c.pipeline_id
        WHERE c.id = $1
      `, [rows[0].customer_id]);

      if (link[0]?.pipeline_id && link[0].stage !== 'booked') {
        await client.query(
          `UPDATE customer_pipeline SET stage = 'booked', updated_at = NOW() WHERE id = $1`,
          [link[0].pipeline_id]
        );
        await client.query(
          `INSERT INTO pipeline_history (pipeline_id, from_stage, to_stage, changed_by) VALUES ($1, $2, 'booked', $3)`,
          [link[0].pipeline_id, link[0].stage, req.user.id]
        );
      }
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

// 2026-05-27 — preview PDF from in-memory form state (no DB lookup, no save).
// Body: { quote_data, customer_name, valid_until, exchange_rate, grand_total_currency }.
// Any authenticated user can preview their own quote-in-progress.
// Quotation No on the PDF reads "SLB-Q-PREVIEW-YYMMDD" so customers can't
// confuse a draft preview with a saved quote. Path is declared BEFORE
// /:id/pdf so Express matches the literal route first.
router.post('/preview-pdf', requireAuth, async (req, res) => {
  try {
    const { quote_data, customer_name, valid_until, exchange_rate, grand_total_currency } = req.body || {};
    if (!quote_data || typeof quote_data !== 'object') {
      return res.status(400).json({ error: 'quote_data là bắt buộc' });
    }
    const buf = await buildSeaQuotePdf({
      quote_data,
      customer_name: customer_name || '(chưa lưu)',
      valid_until: valid_until || null,
      exchange_rate: exchange_rate || null,
      grand_total_currency: grand_total_currency || null,
      quote_id: 'PREVIEW',
      quote_created_at: new Date(),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="quote_preview.pdf"');
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    console.error('[POST /api/quotes/preview-pdf]', err);
    res.status(500).json({ error: err.message });
  }
});

// 2026-05-26 C3 — sea-quote v2 PDF export.
// Owner-only (sales who created) or lead (sees all). Returns application/pdf.
router.post('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const isLead = req.user.role === 'lead';
    const { rows } = await db.query(`
      SELECT q.id, q.quote_data, q.valid_until, q.exchange_rate, q.grand_total_currency,
             q.created_at,
             c.company_name, c.user_id
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.id = $1
      LIMIT 1
    `, [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Không tìm thấy báo giá' });
    if (!isLead && row.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Không có quyền' });
    }
    if (!row.quote_data) {
      return res.status(400).json({ error: 'Báo giá chưa có dữ liệu (chỉ hỗ trợ báo giá biển v2)' });
    }
    const buf = await buildSeaQuotePdf({
      quote_data: row.quote_data,
      customer_name: row.company_name,
      valid_until: row.valid_until,
      exchange_rate: row.exchange_rate,
      grand_total_currency: row.grand_total_currency,
      quote_id: row.id,
      quote_created_at: row.created_at,
    });
    const safeName = String(row.company_name || 'quote').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="quote_${row.id}_${safeName}.pdf"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  } catch (err) {
    console.error('[POST /api/quotes/:id/pdf]', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete quote
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await db.query(`
      DELETE FROM quotes q USING customers c
      WHERE q.id=$1 AND q.customer_id=c.id AND c.user_id=$2
    `, [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ message: 'Đã xóa' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
