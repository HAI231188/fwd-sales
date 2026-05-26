// SeaQuoteDisplay — compact read-only render of a v2 sea-freight quote
// (2026-05-26, C4). Used in CustomerDetailModal's quote thread when
// q.quote_data?.version === 2. Renders ticked charges + section totals +
// grand total + PDF export button.

import { useState } from 'react';
import { generateSeaQuotePdf } from '../api';

function parseNum(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function unitToCurrency(unit) {
  if (!unit) return 'USD';
  if (unit.startsWith('USD')) return 'USD';
  if (unit.startsWith('VND')) return 'VND';
  return 'USD';
}
function calcRowAmount(row, ctx) {
  if (!row || !row.ticked) return 0;
  if (ctx.cargo_type === 'FCL') {
    const pbc = row.price_by_cont || {};
    let total = 0;
    for (const c of (ctx.containers || [])) {
      const q = parseNum(c.qty);
      if (q > 0) total += parseNum(pbc[c.type]) * q;
    }
    return total;
  }
  return parseNum(row.price) * parseNum(row.cbm);
}
function calcSectionTotals(rows, ctx) {
  const byCur = {};
  for (const r of rows || []) {
    if (!r.ticked) continue;
    const amount = calcRowAmount(r, ctx);
    const cur = unitToCurrency(r.unit);
    const vatPct = parseNum(String(r.vat || '0').replace(/[^\d.]/g, ''));
    const vat = amount * vatPct / 100;
    if (!byCur[cur]) byCur[cur] = { subtotal: 0, vat: 0, total: 0 };
    byCur[cur].subtotal += amount;
    byCur[cur].vat += vat;
    byCur[cur].total += amount + vat;
  }
  return byCur;
}
function calcGrandTotal(intlT, inlandT, target, rate) {
  if (!target) return null;
  const curs = new Set([...Object.keys(intlT), ...Object.keys(inlandT)]);
  if (!curs.size) return 0;
  const r = parseNum(rate);
  let sum = 0;
  for (const cur of curs) {
    const s = (intlT[cur]?.total || 0) + (inlandT[cur]?.total || 0);
    if (cur === target) sum += s;
    else if (cur === 'USD' && target === 'VND' && r > 0) sum += s * r;
    else if (cur === 'VND' && target === 'USD' && r > 0) sum += s / r;
    else if (curs.size === 1) sum += s;
    else return null;
  }
  return sum;
}
function fmtAmount(n, currency) {
  if (n == null || !Number.isFinite(n) || n === 0) return '0';
  if (currency === 'VND') return Math.round(n).toLocaleString('vi-VN');
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  try {
    const date = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(d); }
}

export default function SeaQuoteDisplay({ quote }) {
  const qd = quote.quote_data || {};
  const ctx = { cargo_type: qd.cargo_type || 'FCL', containers: qd.containers || [] };
  const intlT = calcSectionTotals(qd.intl_charges, ctx);
  const inlandT = calcSectionTotals(qd.inland_charges, ctx);
  const target = quote.grand_total_currency || qd.grand_total_currency;
  const rate = quote.exchange_rate || qd.exchange_rate;
  const grand = calcGrandTotal(intlT, inlandT, target, rate);

  const [pdfBusy, setPdfBusy] = useState(false);
  async function handlePdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const blob = await generateSeaQuotePdf(quote.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Không thể tạo PDF';
      alert(`Lỗi xuất PDF: ${msg}`);
    } finally {
      setPdfBusy(false);
    }
  }

  const tickedIntl = (qd.intl_charges || []).filter(r => r.ticked);
  const tickedInland = (qd.inland_charges || []).filter(r => r.ticked);
  const cargoLine = ctx.cargo_type === 'FCL'
    ? (ctx.containers.filter(c => parseNum(c.qty) > 0).map(c => `${c.qty}×${c.type}`).join(', ') || '(chưa có cont)')
    : `${qd.shipment_cbm || 0} CBM`;

  return (
    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
          🚢 {qd.pol || '—'} → {qd.pod || '—'}
        </span>
        {qd.term && (
          <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>
            {qd.term}
          </span>
        )}
        <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#f3f4f6', color: '#374151', fontWeight: 600 }}>
          {ctx.cargo_type}: {cargoLine}
        </span>
        <button type="button" onClick={handlePdf} disabled={pdfBusy}
          style={{
            marginLeft: 'auto',
            background: pdfBusy ? 'var(--text-3)' : '#0066b3',
            color: '#fff', border: 'none', borderRadius: 6, fontSize: 11,
            padding: '4px 10px', cursor: pdfBusy ? 'wait' : 'pointer', fontWeight: 600,
          }}>
          {pdfBusy ? '⏳' : '📄 PDF'}
        </button>
      </div>

      <ChargeBlock title="Phí quốc tế" rows={tickedIntl} ctx={ctx} totals={intlT} />
      <ChargeBlock title="Phí nội địa" rows={tickedInland} ctx={ctx} totals={inlandT} />

      {target && grand != null && (
        <div style={{
          marginTop: 8, padding: '6px 10px', background: '#fff7ed',
          border: '1px solid #fdba74', borderRadius: 6,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 700, color: '#9a3412', fontSize: 12 }}>GRAND TOTAL</span>
          <span style={{ fontWeight: 700, color: '#9a3412', fontSize: 13 }}>
            {fmtAmount(grand, target)} {target}
          </span>
        </div>
      )}
      {target && grand == null && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#d97706', fontStyle: 'italic' }}>
          ⚠ Cần tỷ giá để tính Grand Total (hỗn hợp USD/VND)
        </div>
      )}

      {(quote.valid_until || rate) && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {quote.valid_until && <span>Hiệu lực: {fmtDate(quote.valid_until)}</span>}
          {rate && <span>Tỷ giá: 1 USD = {Number(rate).toLocaleString('vi-VN')} VND</span>}
        </div>
      )}

      {qd.notes && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic' }}>
          📝 {qd.notes}
        </div>
      )}
    </div>
  );
}

function ChargeBlock({ title, rows, ctx, totals }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((r, i) => {
          const amount = calcRowAmount(r, ctx);
          const cur = unitToCurrency(r.unit);
          return (
            <div key={i} style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--text)' }}>
                {r.name}
                {r.vat && <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>(VAT {r.vat})</span>}
              </span>
              <span style={{ color: 'var(--primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                {amount > 0 ? `${fmtAmount(amount, cur)} ${cur}` : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {Object.keys(totals).map(cur => (
        <div key={cur} style={{
          marginTop: 3, paddingTop: 3, borderTop: '1px dashed var(--border)',
          fontSize: 11, display: 'flex', justifyContent: 'space-between', color: 'var(--text-2)', fontWeight: 600,
        }}>
          <span>Tổng ({cur}):</span>
          <span style={{ color: 'var(--text)' }}>{fmtAmount(totals[cur].total, cur)} {cur}</span>
        </div>
      ))}
    </div>
  );
}
