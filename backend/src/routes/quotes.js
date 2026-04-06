const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// Add quote to customer
router.post('/', requireAuth, async (req, res) => {
  const {
    customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg,
    monthly_volume_containers, route, cargo_ready_date, mode,
    carrier, transit_time, price, status, follow_up_notes, lost_reason, closing_soon,
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
         carrier, transit_time, price, status, follow_up_notes, lost_reason, closing_soon)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      customer_id, cargo_name,
      monthly_volume_cbm || null, monthly_volume_kg || null, monthly_volume_containers,
      route, cargo_ready_date || null, mode,
      carrier, transit_time, price,
      status || 'quoting', follow_up_notes, lost_reason, closing_soon || false,
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
  } = req.body;

  try {
    // Verify ownership via join
    const { rows } = await db.query(`
      UPDATE quotes q SET
        cargo_name=$1, monthly_volume_cbm=$2, monthly_volume_kg=$3,
        monthly_volume_containers=$4, route=$5, cargo_ready_date=$6, mode=$7,
        carrier=$8, transit_time=$9, price=$10, status=$11,
        follow_up_notes=$12, lost_reason=$13, closing_soon=$14, updated_at=NOW()
      FROM customers c
      WHERE q.id=$15 AND q.customer_id=c.id AND c.user_id=$16
      RETURNING q.*
    `, [
      cargo_name, monthly_volume_cbm || null, monthly_volume_kg || null,
      monthly_volume_containers, route, cargo_ready_date || null, mode,
      carrier, transit_time, price, status || 'quoting',
      follow_up_notes, lost_reason, closing_soon || false,
      req.params.id, req.user.id,
    ]);

    if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json(rows[0]);
  } catch (err) {
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
