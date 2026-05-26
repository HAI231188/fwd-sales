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

export function unitToCurrency(unit) {
  if (!unit) return 'USD';
  const u = String(unit);
  if (u.startsWith('USD')) return 'USD';
  if (u.startsWith('VND')) return 'VND';
  return 'USD';
}

// 'cont' | 'cbm' | 'shipment' — drives calcRowAmount branch
export function unitBasis(unit) {
  if (!unit) return 'cont';
  const u = String(unit);
  if (u.includes('/B/L') || u.includes('/shipment')) return 'shipment';
  if (u.includes('/CBM')) return 'cbm';
  return 'cont';
}

// Amount rules:
//   - /shipment or /B/L (flat fee, regardless of cargo_type):
//       FCL: SUM(price_by_cont values) without qty multiplier
//       LCL: row.price (× 1)
//   - FCL cont-based: SUM(price_by_cont[type] × qty[type]) over ctx.containers
//   - LCL: row.price × row.cbm
export function calcRowAmount(row, ctx) {
  if (!row || !row.ticked) return 0;
  const basis = unitBasis(row.unit);

  if (basis === 'shipment') {
    if (ctx?.cargo_type === 'FCL') {
      const pbc = row.price_by_cont || {};
      return Object.values(pbc).reduce((s, v) => s + parseNum(v), 0);
    }
    return parseNum(row.price);
  }

  if (ctx?.cargo_type === 'FCL') {
    const pbc = row.price_by_cont || {};
    let total = 0;
    for (const c of (ctx.containers || [])) {
      const q = parseNum(c.qty);
      if (q > 0) total += parseNum(pbc[c.type]) * q;
    }
    return total;
  }

  // LCL
  return parseNum(row.price) * parseNum(row.cbm);
}

// VAT is per row, applied to the row's amount × vat%.
// Returns { [currency]: {subtotal, vat, total} } so callers can render
// each currency separately (mixed-currency quotes are real).
export function calcSectionTotals(rows, ctx) {
  const byCur = {};
  for (const r of (rows || [])) {
    if (!r.ticked) continue;
    const amount = calcRowAmount(r, ctx);
    if (amount === 0) continue;
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
