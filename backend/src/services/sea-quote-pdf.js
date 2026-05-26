// Sea freight quotation PDF builder (2026-05-26, C3).
// Mirrors backend/src/services/bbbg-pdf.js patterns:
//   - pdfkit + same SLB logo + Roboto fonts (with Helvetica fallback)
//   - Returns Promise<Buffer> so the route can pipe it as a blob response
//
// Input: { quote_data, customer_name, valid_until, exchange_rate, grand_total_currency }
// where quote_data is the v2 JSONB shape produced by frontend SeaQuoteForm.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD    = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Bold.ttf');
const FONT_ITALIC  = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Italic.ttf');
const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'slb_logo.jpeg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.jpg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.png'),
];

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function registerFonts(doc) {
  if (fileExists(FONT_REGULAR)) doc.registerFont('R',  FONT_REGULAR);  else doc.registerFont('R',  'Helvetica');
  if (fileExists(FONT_BOLD))    doc.registerFont('RB', FONT_BOLD);     else doc.registerFont('RB', 'Helvetica-Bold');
  if (fileExists(FONT_ITALIC))  doc.registerFont('RI', FONT_ITALIC);   else doc.registerFont('RI', 'Helvetica-Oblique');
  if (!fileExists(FONT_REGULAR)) {
    console.warn('[sea-quote-pdf] Roboto TTF not found — Vietnamese diacritics will not render. Drop fonts into backend/src/assets/fonts/ to enable.');
  }
}

// ─── Calc helpers (mirror frontend SeaQuoteForm logic) ───────────────────
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
  if (n == null || !Number.isFinite(n) || n === 0) return '';
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

// ─── Layout helpers ──────────────────────────────────────────────────────
function drawHeader(doc, left, right) {
  const headerY = doc.y;
  const logoPath = LOGO_CANDIDATES.find(fileExists) || null;
  if (logoPath) {
    try { doc.image(logoPath, left, headerY, { width: 90 }); } catch { /* skip */ }
  }
  const companyX = left + (logoPath ? 110 : 0);
  doc.font('RB').fontSize(11).fillColor('#0066b3').text('SLB GLOBAL LOGISTICS CO., LTD.', companyX, headerY);
  doc.font('R').fontSize(8).fillColor('#000');
  doc.text('Address: 8th Floor, Diamond Building, No 7 Lot 8A Le Hong Phong, Ngo Quyen, Hai Phong, Viet Nam',
    companyX, doc.y + 1);
  doc.text('Tel: +84 931 334 331   |   Email: info@slbglobal.com', companyX, doc.y + 1);
  doc.text('Website: www.slbglobal.com', companyX, doc.y + 1);
  doc.y = Math.max(doc.y, headerY + (logoPath ? 70 : 50));

  doc.moveDown(0.5);
  doc.font('RB').fontSize(16).fillColor('#000').text('BÁO GIÁ VẬN CHUYỂN', { align: 'center' });
  doc.font('RI').fontSize(10).fillColor('#444').text('(Freight Quotation)', { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.4);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(0.5).strokeColor('#888').stroke();
  doc.strokeColor('#000');
  doc.moveDown(0.4);
}

function drawMeta(doc, left, right, opts) {
  const usableW = right - left;
  const colGap = 12;
  const colW = (usableW - colGap) / 2;
  const todayStr = new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let y = doc.y;
  doc.font('RB').fontSize(10).fillColor('#000');
  doc.text(`Kính gửi / To: ${opts.customer_name || '—'}`, left, y, { width: colW });
  doc.text(`Ngày / Date: ${todayStr}`, left + colW + colGap, y, { width: colW, align: 'right' });
  y = doc.y + 2;

  doc.font('R').fontSize(10);
  const route = `POL: ${opts.pol || '—'}   →   POD: ${opts.pod || '—'}`;
  doc.text(route, left, y, { width: colW });
  doc.text(`Term: ${opts.term || '—'}`, left + colW + colGap, y, { width: colW, align: 'right' });
  y = doc.y + 2;

  let cargoDesc;
  if (opts.cargo_type === 'FCL') {
    const conts = (opts.containers || []).filter(c => parseNum(c.qty) > 0).map(c => `${c.qty}x${c.type}`).join(', ');
    cargoDesc = `FCL: ${conts || '(chưa có cont)'}`;
  } else {
    cargoDesc = `LCL: ${opts.shipment_cbm || 0} CBM`;
  }
  doc.text(cargoDesc, left, y, { width: usableW });
  y = doc.y + 2;
  doc.y = y;

  if (opts.valid_until || opts.exchange_rate) {
    const ly = doc.y;
    if (opts.valid_until) {
      doc.text(`Hiệu lực đến / Valid until: ${fmtDate(opts.valid_until)}`, left, ly, { width: colW });
    }
    if (opts.exchange_rate) {
      doc.text(`Tỷ giá / Rate: 1 USD = ${Number(opts.exchange_rate).toLocaleString('vi-VN')} VND`,
        left + colW + colGap, ly, { width: colW, align: 'right' });
    }
    doc.y = ly + 14;
  }
  doc.moveDown(0.4);
}

// Returns the totals object so the caller can compute grand total.
function drawChargeSection(doc, left, right, title, rows, ctx) {
  const usableW = right - left;
  const ticked = (rows || []).filter(r => r.ticked);
  if (!ticked.length) return { byCurrency: {} };

  doc.font('RB').fontSize(11).fillColor('#0066b3').text(title, left, doc.y);
  doc.fillColor('#000');
  doc.moveDown(0.2);

  const isFcl = ctx.cargo_type === 'FCL';
  const activeTypes = isFcl
    ? (ctx.containers || []).filter(c => parseNum(c.qty) > 0).map(c => c.type)
    : [];

  let cols;
  if (isFcl) {
    if (activeTypes.length > 0) {
      const dynW = activeTypes.length * 50;
      const fixedW = 50 + 50 + 80;
      const descW = Math.max(120, usableW - dynW - fixedW);
      cols = [
        { key: 'desc', w: descW, label: 'Description / Mô tả', align: 'left' },
        ...activeTypes.map(t => ({ key: `cont-${t}`, w: 50, label: t, align: 'right' })),
        { key: 'unit', w: 50, label: 'Unit', align: 'center' },
        { key: 'vat', w: 50, label: 'VAT', align: 'center' },
        { key: 'amount', w: 80, label: 'Amount', align: 'right' },
      ];
    } else {
      cols = [
        { key: 'desc', w: usableW - 180, label: 'Description / Mô tả', align: 'left' },
        { key: 'unit', w: 50, label: 'Unit', align: 'center' },
        { key: 'vat', w: 50, label: 'VAT', align: 'center' },
        { key: 'amount', w: 80, label: 'Amount', align: 'right' },
      ];
    }
  } else {
    cols = [
      { key: 'desc', w: usableW - 280, label: 'Description / Mô tả', align: 'left' },
      { key: 'price', w: 60, label: 'Unit price', align: 'right' },
      { key: 'cbm', w: 50, label: 'CBM', align: 'right' },
      { key: 'unit', w: 50, label: 'Unit', align: 'center' },
      { key: 'vat', w: 40, label: 'VAT', align: 'center' },
      { key: 'amount', w: 80, label: 'Amount', align: 'right' },
    ];
  }

  const headerY = doc.y;
  const rowH = 18;
  doc.rect(left, headerY, usableW, rowH).fillAndStroke('#f3f4f6', '#888');
  doc.fillColor('#000');
  let cx = left;
  for (const c of cols) {
    doc.font('RB').fontSize(8).text(c.label, cx + 3, headerY + 5, { width: c.w - 6, align: c.align, lineBreak: false });
    cx += c.w;
  }
  doc.y = headerY + rowH;

  const totals = calcSectionTotals(rows, ctx);
  for (const r of ticked) {
    const rowY = doc.y;
    const amount = calcRowAmount(r, ctx);
    const currency = unitToCurrency(r.unit);
    doc.moveTo(left, rowY + rowH).lineTo(right, rowY + rowH).lineWidth(0.3).strokeColor('#ddd').stroke();
    doc.strokeColor('#000');

    cx = left;
    for (const c of cols) {
      let txt = '';
      if (c.key === 'desc') txt = r.name || '';
      else if (c.key === 'price') txt = r.price ? fmtAmount(parseNum(r.price), currency) : '';
      else if (c.key === 'cbm') txt = r.cbm || '';
      else if (c.key === 'unit') txt = r.unit || '';
      else if (c.key === 'vat') txt = r.vat || '';
      else if (c.key === 'amount') txt = amount > 0 ? `${fmtAmount(amount, currency)} ${currency}` : '';
      else if (c.key.startsWith('cont-')) {
        const t = c.key.slice(5);
        txt = r.price_by_cont?.[t] ? fmtAmount(parseNum(r.price_by_cont[t]), currency) : '';
      }
      doc.font('R').fontSize(8.5).fillColor('#000')
        .text(txt, cx + 3, rowY + 5, { width: c.w - 6, align: c.align, lineBreak: false });
      cx += c.w;
    }
    doc.y = rowY + rowH;
  }

  for (const cur of Object.keys(totals)) {
    const { subtotal, vat, total } = totals[cur];
    const rowY = doc.y;
    doc.rect(left, rowY, usableW, rowH).fillAndStroke('#fafafa', '#888');
    doc.fillColor('#000').font('RB').fontSize(9)
      .text(`Subtotal (${cur})`, left + 6, rowY + 5, { width: usableW - 90, align: 'right', lineBreak: false });
    doc.text(`${fmtAmount(total, cur)} ${cur}`, right - 84, rowY + 5, { width: 80, align: 'right', lineBreak: false });
    doc.y = rowY + rowH;
    if (vat > 0) {
      doc.font('RI').fontSize(7).fillColor('#666')
        .text(`(Sub ${fmtAmount(subtotal, cur)} + VAT ${fmtAmount(vat, cur)})`, left + 6, doc.y, { width: usableW - 12, align: 'right' });
      doc.fillColor('#000');
      doc.moveDown(0.2);
    }
  }
  doc.moveDown(0.4);
  return { byCurrency: totals };
}

function drawGrandTotal(doc, left, right, intlT, inlandT, opts) {
  const usableW = right - left;
  if (!opts.grand_total_currency) return;
  const grand = calcGrandTotal(intlT, inlandT, opts.grand_total_currency, opts.exchange_rate);
  if (grand == null) {
    doc.font('RI').fontSize(9).fillColor('#d97706')
      .text('⚠ Mixed currencies + no exchange rate → Grand Total chưa tính được', left, doc.y, { width: usableW });
    doc.fillColor('#000');
    doc.moveDown(0.4);
    return;
  }
  const y = doc.y;
  doc.rect(left, y, usableW, 24).fillAndStroke('#fff7ed', '#ea580c');
  doc.font('RB').fontSize(12).fillColor('#9a3412')
    .text('GRAND TOTAL', left + 8, y + 6, { width: usableW / 2, align: 'left' });
  doc.font('RB').fontSize(13).fillColor('#9a3412')
    .text(`${fmtAmount(grand, opts.grand_total_currency)} ${opts.grand_total_currency}`,
      left + usableW / 2, y + 5, { width: usableW / 2 - 8, align: 'right' });
  doc.fillColor('#000');
  doc.y = y + 26;
  doc.moveDown(0.4);
}

function drawNotes(doc, left, right, notes) {
  if (!notes || !String(notes).trim()) return;
  const usableW = right - left;
  doc.font('RB').fontSize(10).text('Ghi chú / Notes:', left, doc.y, { width: usableW });
  doc.moveDown(0.1);
  doc.font('R').fontSize(9).text(String(notes), left, doc.y, { width: usableW });
  doc.moveDown(0.4);
}

const EXCLUDING_FOOTER = [
  '1. Store fee at Port, Demurrage fee, Loading/Unloading fee, Container detention fee, Customs Inspections fee, Customs Overtime fee, Insurance fee, TAX/VAT, Any Special fee.',
  '2. Import Tax, VAT is not including',
  '3. Above prices are based on present oil price and subject to change if oil price is increased.',
  '4. Insurance Fee (0.3% of cargo value + 10%VAT), Any Special Fee, If Any',
  '5. Valid: Effect from quotation until {valid_until}',
  '6. Payment term: Within 30 days after the day of the cargo go into the board.',
];

function drawFooter(doc, left, right, valid_until) {
  const usableW = right - left;
  doc.moveDown(0.4);
  doc.font('RB').fontSize(8).text('Excluding Note:', left, doc.y, { width: usableW });
  doc.font('R').fontSize(7.5);
  for (const line of EXCLUDING_FOOTER) {
    const out = line.replace('{valid_until}', valid_until ? fmtDate(valid_until) : '—');
    doc.text(out, left, doc.y, { width: usableW });
  }
  doc.moveDown(0.4);
  doc.font('RI').fontSize(9).text('Thank you for your cooperation.', left, doc.y, { width: usableW });
  doc.font('R').fontSize(9).text('Best regards', left, doc.y, { width: usableW });
  doc.font('RB').fontSize(9).text('SLB GLOBAL LOGISTICS', left, doc.y, { width: usableW });
}

// ─── Main entry ──────────────────────────────────────────────────────────
function buildSeaQuotePdf(opts) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;

      const qd = opts.quote_data || {};
      const ctx = {
        cargo_type: qd.cargo_type || 'FCL',
        containers: qd.containers || [],
      };

      drawHeader(doc, left, right);
      drawMeta(doc, left, right, {
        customer_name: opts.customer_name,
        pol: qd.pol, pod: qd.pod, term: qd.term,
        cargo_type: ctx.cargo_type, containers: ctx.containers, shipment_cbm: qd.shipment_cbm,
        valid_until: opts.valid_until, exchange_rate: opts.exchange_rate,
      });

      const intlOut = drawChargeSection(doc, left, right,
        'INTERNATIONAL CHARGES / Phí quốc tế', qd.intl_charges || [], ctx);
      const inlandOut = drawChargeSection(doc, left, right,
        'INLAND CHARGES / Phí nội địa', qd.inland_charges || [], ctx);

      drawGrandTotal(doc, left, right, intlOut.byCurrency, inlandOut.byCurrency, {
        grand_total_currency: opts.grand_total_currency,
        exchange_rate: opts.exchange_rate,
      });

      drawNotes(doc, left, right, qd.notes);
      drawFooter(doc, left, right, opts.valid_until);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildSeaQuotePdf };
