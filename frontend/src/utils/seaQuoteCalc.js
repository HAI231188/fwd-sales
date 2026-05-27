// Sea-quote calculation helpers — single source of truth (2026-05-27).
// MUST stay byte-identical with backend/src/utils/seaQuoteCalc.cjs
// (module syntax aside — same logic, same numerics, same rounding).
//
// Canonical ctx: { cargo_type: 'FCL'|'LCL', containers: [{type, qty}] }
//   - FCL row stores `price_by_cont: { '40HC': '500', ... }` (string-numeric)
//   - LCL row stores `price` + `cbm` (string-numeric)
//   - unit one of 'USD/cont' | 'USD/CBM' | 'USD/B/L' | 'USD/shipment' +
//     VND/* equivalents. `/shipment` and `/B/L` are flat per-shipment fees.

export function parseNum(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Prices and quantities in freight quotes are never negative. Defensive clamp:
// guards old data that may have been entered before the form added min="0",
// and ensures section totals always equal sum of displayed line nets.
function nn(v) {
  const n = parseNum(v);
  return n > 0 ? n : 0;
}

export function unitToCurrency(unit) {
  if (!unit) return 'USD';
  const u = String(unit);
  if (u.startsWith('USD')) return 'USD';
  if (u.startsWith('VND')) return 'VND';
  return 'USD';
}

// 'cont' | 'shipment' | 'cbm' | 'kg' — drives calcRowAmount + formatRowVol.
// Case-insensitive, tolerates both new (USD/CONT, USD/SHPT, USD/BL, USD/KG)
// and legacy (USD/cont, USD/shipment, USD/B/L) unit tokens.
export function unitBasis(unit) {
  if (!unit) return 'shipment';
  const u = String(unit).toUpperCase();
  if (u.includes('CONT')) return 'cont';
  if (u.includes('CBM')) return 'cbm';
  if (u.includes('/KG') || u.endsWith('KG')) return 'kg';
  if (u.includes('SHPT') || u.includes('SHIPMENT') ||
      u.includes('B/L') || u.includes('/BL')) return 'shipment';
  return 'shipment';
}

// Amount rules:
//   - /shipment or /B/L (flat fee, regardless of cargo_type):
//       FCL: SUM(price_by_cont values) without qty multiplier
//       LCL: row.price (× 1)
//   - FCL cont-based: SUM(price_by_cont[type] × qty[type]) over ctx.containers
//   - LCL: row.price × row.cbm
// Net = rate × VOL, where VOL depends ENTIRELY on unit basis (not cargo_type):
//   cont     → Σ rate_by_cont[type] × ctx.containers[type].qty
//   shipment → rate × 1
//   cbm      → rate × ctx.shipment_cbm
//   kg       → rate × ctx.shipment_kg
//
// Backward compat: legacy v2 quotes stored `price_by_cont` / `price`; new
// quotes may use `rate_by_cont` / `rate`. We read both so existing data still
// renders correctly (no migration required).
function rateByCont(row) { return row.rate_by_cont || row.price_by_cont || {}; }
function rowRate(row)    { return nn(row.rate != null ? row.rate : row.price); }

export function calcRowAmount(row, ctx) {
  if (!row || !row.ticked) return 0;
  const basis = unitBasis(row.unit);

  if (basis === 'cont') {
    const rbc = rateByCont(row);
    let total = 0;
    for (const c of (ctx?.containers || [])) {
      const q = nn(c.qty);
      if (q > 0) total += nn(rbc[c.type]) * q;
    }
    return total;
  }
  if (basis === 'cbm') return rowRate(row) * nn(ctx?.shipment_cbm);
  if (basis === 'kg')  return rowRate(row) * nn(ctx?.shipment_kg);
  // shipment / B/L — flat per-shipment fee
  return rowRate(row);
}

// VOL display string per row, in the same wording form/display/PDF all share.
export function formatRowVol(row, ctx) {
  const basis = unitBasis(row?.unit);
  if (basis === 'cont') {
    const conts = (ctx?.containers || []).filter(c => nn(c.qty) > 0);
    if (!conts.length) return '—';
    return conts.map(c => `${c.qty}×${c.type}`).join(' ');
  }
  if (basis === 'cbm') {
    const cbm = nn(ctx?.shipment_cbm);
    if (cbm <= 0) return '— CBM';
    return `${cbm % 1 === 0 ? Math.round(cbm) : cbm} CBM`;
  }
  if (basis === 'kg') {
    const kg = nn(ctx?.shipment_kg);
    if (kg <= 0) return '— kg';
    return `${kg % 1 === 0 ? Math.round(kg) : kg} kg`;
  }
  return '1 lô';
}

// Per-row VAT amount = net × (vat_pct / 100). vat string may be "8%" / "0%"
// / "KCT" / "" — anything non-digit is stripped (KCT → 0).
export function rowVatPct(row) {
  return parseNum(String(row?.vat || '0').replace(/[^\d.]/g, ''));
}

export function calcRowVat(row, ctx) {
  const net = calcRowAmount(row, ctx);
  return net * rowVatPct(row) / 100;
}

// Line total = net + VAT (the customer-facing per-line "total" column).
export function calcRowTotal(row, ctx) {
  const net = calcRowAmount(row, ctx);
  return net + (net * rowVatPct(row) / 100);
}

// Section totals: { [currency]: { net, vat, total } }.
// net = sum of unit_price × qty (no tax);
// vat = sum of per-row VAT amounts;
// total = net + vat (= sum of LINE TOTAL per row).
export function calcSectionTotals(rows, ctx) {
  const byCur = {};
  for (const r of (rows || [])) {
    if (!r.ticked) continue;
    const net = calcRowAmount(r, ctx);
    if (net === 0) continue;
    const cur = unitToCurrency(r.unit);
    const vat = net * rowVatPct(r) / 100;
    if (!byCur[cur]) byCur[cur] = { net: 0, vat: 0, total: 0 };
    byCur[cur].net += net;
    byCur[cur].vat += vat;
    byCur[cur].total += net + vat;
  }
  return byCur;
}

// Combines intl + inland totals into target currency.
// Returns null when mixed currencies AND no exchange rate set.
export function calcGrandTotal(intlT, inlandT, target, rate) {
  if (!target) return null;
  const curs = new Set([...Object.keys(intlT || {}), ...Object.keys(inlandT || {})]);
  if (!curs.size) return 0;
  const r = parseNum(rate);
  let sum = 0;
  for (const cur of curs) {
    const s = (intlT?.[cur]?.total || 0) + (inlandT?.[cur]?.total || 0);
    if (cur === target) sum += s;
    else if (cur === 'USD' && target === 'VND' && r > 0) sum += s * r;
    else if (cur === 'VND' && target === 'USD' && r > 0) sum += s / r;
    else if (curs.size === 1) sum += s;
    else return null; // mixed currencies + no rate
  }
  return sum;
}

// 1,000.00 for USD (and any non-VND); 1,000,000 for VND (integer).
// en-US grouping is the international forwarder convention
// (Maersk / DHL / K+N quotes — Vietnamese accounting uses a different
// separator but that's a domestic-doc convention, not a quotation one).
export function fmtAmount(n, currency) {
  if (n == null || !Number.isFinite(n)) return '0.00';
  if (currency === 'VND') {
    return Math.round(n).toLocaleString('en-US');
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shipment volume in human-readable form. FCL shows the cont-qty breakdown
// plus a total count; LCL shows the total CBM. Returns '' when nothing has
// been entered yet so callers can skip rendering.
export function formatVolume(qd) {
  if (!qd) return '';
  if (qd.cargo_type === 'LCL') {
    const cbm = parseNum(qd.shipment_cbm);
    if (cbm <= 0) return '';
    // Trim trailing zeros: 45.00 → 45, 12.5 → 12.5
    const shown = cbm % 1 === 0 ? String(Math.round(cbm)) : String(cbm);
    return `${shown} CBM`;
  }
  // FCL — only types with qty > 0
  const conts = (qd.containers || []).filter(c => parseNum(c.qty) > 0);
  if (!conts.length) return '';
  const parts = conts.map(c => `${c.qty} × ${c.type}`);
  const totalCont = conts.reduce((s, c) => s + parseNum(c.qty), 0);
  return `${parts.join(' + ')}  (${totalCont} cont)`;
}

// Short unit labels for PDF table cells (column-width-safe).
// Used by the redesigned PDF only — form/display keep the verbose label.
export function unitShort(unit) {
  if (!unit) return '';
  return String(unit)
    .replace('/shipment', '/SHPT')
    .replace('/cont', '/CONT')
    .replace('/CBM', '/CBM')
    .replace('/B/L', '/BL');
}
