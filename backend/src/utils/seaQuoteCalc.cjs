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

// Prices and quantities in freight quotes are never negative. Defensive clamp:
// guards old data entered before the form added min="0", and ensures section
// totals always equal the sum of displayed line nets.
function nn(v) {
  const n = parseNum(v);
  return n > 0 ? n : 0;
}

function unitToCurrency(unit) {
  if (!unit) return 'USD';
  const u = String(unit);
  if (u.startsWith('USD')) return 'USD';
  if (u.startsWith('VND')) return 'VND';
  return 'USD';
}

function unitBasis(unit) {
  if (!unit) return 'shipment';
  const u = String(unit).toUpperCase();
  if (u.includes('CONT')) return 'cont';
  if (u.includes('CBM')) return 'cbm';
  if (u.includes('/KG') || u.endsWith('KG')) return 'kg';
  if (u.includes('SHPT') || u.includes('SHIPMENT') ||
      u.includes('B/L') || u.includes('/BL')) return 'shipment';
  return 'shipment';
}

function rateByCont(row) { return row.rate_by_cont || row.price_by_cont || {}; }
function rowRate(row)    { return nn(row.rate != null ? row.rate : row.price); }

function calcRowAmount(row, ctx) {
  if (!row || !row.ticked) return 0;
  const basis = unitBasis(row.unit);

  if (basis === 'cont') {
    const rbc = rateByCont(row);
    let total = 0;
    for (const c of ((ctx && ctx.containers) || [])) {
      const q = nn(c.qty);
      if (q > 0) total += nn(rbc[c.type]) * q;
    }
    return total;
  }
  if (basis === 'cbm') return rowRate(row) * nn(ctx && ctx.shipment_cbm);
  if (basis === 'kg')  return rowRate(row) * nn(ctx && ctx.shipment_kg);
  return rowRate(row);
}

function formatRowVol(row, ctx) {
  const basis = unitBasis(row && row.unit);
  if (basis === 'cont') {
    const conts = ((ctx && ctx.containers) || []).filter(c => nn(c.qty) > 0);
    if (!conts.length) return '—';
    return conts.map(c => `${c.qty}x${c.type}`).join(' ');
  }
  if (basis === 'cbm') {
    const cbm = nn(ctx && ctx.shipment_cbm);
    if (cbm <= 0) return '— CBM';
    return `${cbm % 1 === 0 ? Math.round(cbm) : cbm} CBM`;
  }
  if (basis === 'kg') {
    const kg = nn(ctx && ctx.shipment_kg);
    if (kg <= 0) return '— kg';
    return `${kg % 1 === 0 ? Math.round(kg) : kg} kg`;
  }
  return '1 lô';
}

function rowVatPct(row) {
  return parseNum(String((row && row.vat) || '0').replace(/[^\d.]/g, ''));
}

function calcRowVat(row, ctx) {
  const net = calcRowAmount(row, ctx);
  return net * rowVatPct(row) / 100;
}

function calcRowTotal(row, ctx) {
  const net = calcRowAmount(row, ctx);
  return net + (net * rowVatPct(row) / 100);
}

function calcSectionTotals(rows, ctx) {
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

function calcGrandTotal(intlT, inlandT, target, rate) {
  const perCurrency = {};
  for (const cur of new Set([...Object.keys(intlT || {}), ...Object.keys(inlandT || {})])) {
    const v = ((intlT && intlT[cur] && intlT[cur].total) || 0)
            + ((inlandT && inlandT[cur] && inlandT[cur].total) || 0);
    if (v !== 0) perCurrency[cur] = v;
  }
  if (!target) {
    return { perCurrency, grand: null, needsRate: false };
  }
  const curs = Object.keys(perCurrency);
  const mixed = curs.length > 1;
  const r = parseNum(rate);
  if (mixed && r <= 0) {
    return { perCurrency, grand: null, needsRate: true };
  }
  let grand = 0;
  for (const cur of curs) {
    const s = perCurrency[cur];
    if (cur === target) grand += s;
    else if (cur === 'USD' && target === 'VND') grand += s * r;
    else if (cur === 'VND' && target === 'USD') grand += s / r;
    else grand += s;
  }
  return { perCurrency, grand, needsRate: false };
}

function fmtAmount(n, currency) {
  if (n == null || !Number.isFinite(n)) return '0.00';
  if (currency === 'VND') {
    return Math.round(n).toLocaleString('en-US');
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shipment volume in human-readable form. FCL shows the cont-qty breakdown
// plus a total count; LCL shows the total CBM. Returns '' when nothing has
// been entered yet so callers can skip rendering.
function formatVolume(qd) {
  if (!qd) return '';
  if (qd.cargo_type === 'LCL') {
    const cbm = parseNum(qd.shipment_cbm);
    if (cbm <= 0) return '';
    const shown = cbm % 1 === 0 ? String(Math.round(cbm)) : String(cbm);
    return `${shown} CBM`;
  }
  const conts = (qd.containers || []).filter(c => parseNum(c.qty) > 0);
  if (!conts.length) return '';
  const parts = conts.map(c => `${c.qty} x ${c.type}`);
  const totalCont = conts.reduce((s, c) => s + parseNum(c.qty), 0);
  return `${parts.join(' + ')}  (${totalCont} cont)`;
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
  rowVatPct,
  calcRowAmount,
  calcRowVat,
  calcRowTotal,
  calcSectionTotals,
  calcGrandTotal,
  fmtAmount,
  formatVolume,
  formatRowVol,
  unitShort,
};
