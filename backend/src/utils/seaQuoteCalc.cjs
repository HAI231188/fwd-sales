// Sea-quote calculation helpers — single source of truth (2026-05-27).
// MUST stay byte-identical with frontend/src/utils/seaQuoteCalc.js
// (module syntax aside — same logic, same numerics, same rounding).
//
// Canonical ctx: { cargo_type: 'FCL'|'LCL', containers: [{type, qty}] }
//   - FCL row stores `price_by_cont: { '40HC': '500', ... }` (string-numeric)
//   - LCL row stores `price` + `cbm` (string-numeric)
//   - unit one of 'USD/cont' | 'USD/CBM' | 'USD/B/L' | 'USD/shipment' +
//     VND/* equivalents. `/shipment` and `/B/L` are flat per-shipment fees.

function parseNum(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function unitToCurrency(unit) {
  if (!unit) return 'USD';
  const u = String(unit);
  if (u.startsWith('USD')) return 'USD';
  if (u.startsWith('VND')) return 'VND';
  return 'USD';
}

function unitBasis(unit) {
  if (!unit) return 'cont';
  const u = String(unit);
  if (u.includes('/B/L') || u.includes('/shipment')) return 'shipment';
  if (u.includes('/CBM')) return 'cbm';
  return 'cont';
}

function calcRowAmount(row, ctx) {
  if (!row || !row.ticked) return 0;
  const basis = unitBasis(row.unit);

  if (basis === 'shipment') {
    if (ctx && ctx.cargo_type === 'FCL') {
      const pbc = row.price_by_cont || {};
      return Object.values(pbc).reduce((s, v) => s + parseNum(v), 0);
    }
    return parseNum(row.price);
  }

  if (ctx && ctx.cargo_type === 'FCL') {
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

function calcGrandTotal(intlT, inlandT, target, rate) {
  if (!target) return null;
  const curs = new Set([...Object.keys(intlT || {}), ...Object.keys(inlandT || {})]);
  if (!curs.size) return 0;
  const r = parseNum(rate);
  let sum = 0;
  for (const cur of curs) {
    const s = ((intlT && intlT[cur] && intlT[cur].total) || 0)
            + ((inlandT && inlandT[cur] && inlandT[cur].total) || 0);
    if (cur === target) sum += s;
    else if (cur === 'USD' && target === 'VND' && r > 0) sum += s * r;
    else if (cur === 'VND' && target === 'USD' && r > 0) sum += s / r;
    else if (curs.size === 1) sum += s;
    else return null;
  }
  return sum;
}

function fmtAmount(n, currency) {
  if (n == null || !Number.isFinite(n)) return '0.00';
  if (currency === 'VND') {
    return Math.round(n).toLocaleString('en-US');
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function unitShort(unit) {
  if (!unit) return '';
  return String(unit)
    .replace('/shipment', '/SHPT')
    .replace('/cont', '/CONT')
    .replace('/CBM', '/CBM')
    .replace('/B/L', '/BL');
}

module.exports = {
  parseNum,
  unitToCurrency,
  unitBasis,
  calcRowAmount,
  calcSectionTotals,
  calcGrandTotal,
  fmtAmount,
  unitShort,
};
