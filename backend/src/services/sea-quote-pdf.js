// Sea-freight quotation PDF builder — international-forwarder layout.
// Rewritten 2026-05-27: unified calc helpers (../utils/seaQuoteCalc.cjs)
// + full layout redesign (Maersk / DHL / K+N style).
//
// Input: { quote_data, customer_name, valid_until, exchange_rate,
//          grand_total_currency, quote_id }
//   quote_data = v2 JSONB shape produced by frontend SeaQuoteForm.
//
// Output: Promise<Buffer>  (mime application/pdf).

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const {
  parseNum, unitToCurrency, calcRowAmount, calcRowVat, calcRowTotal,
  calcSectionTotals, calcGrandTotal, fmtAmount, unitShort,
} = require('../utils/seaQuoteCalc.cjs');

// ─── Assets ──────────────────────────────────────────────────────────────
const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD    = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Bold.ttf');
const FONT_ITALIC  = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Italic.ttf');
const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'slb_logo.jpeg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.jpg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.png'),
];

// ─── Design tokens ───────────────────────────────────────────────────────
// Brand teal sampled to match SLB green; muted enough to print clean.
const COLOR = {
  brand:        '#0E7C66',   // primary brand teal (logo green, muted)
  brandDark:    '#0A5A4B',
  brandLight:   '#E8F4F1',
  text:         '#111827',   // body
  textMuted:    '#6B7280',   // labels
  textFaint:    '#9CA3AF',   // captions
  border:       '#E5E7EB',
  borderStrong: '#D1D5DB',
  rowAlt:       '#FAFAFA',
  headerBar:    '#0E7C66',
  totalBg:      '#F0FDF4',
  totalBorder:  '#A7F3D0',
};

const FS = {                // font sizes
  body: 9,
  label: 7.5,
  tableHeader: 7.5,
  tableCell: 8.5,
  sectionBar: 9.5,
  title: 18,
  subtitle: 9,
  totalLabel: 9,
  totalGrand: 13,
  footer: 7,
};

const MARGIN = 40;          // page margins
const ROW_H = 18;           // table row height (consistent baseline)
const HEAD_H = 18;          // table header row height

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function registerFonts(doc) {
  if (fileExists(FONT_REGULAR)) doc.registerFont('R',  FONT_REGULAR);  else doc.registerFont('R',  'Helvetica');
  if (fileExists(FONT_BOLD))    doc.registerFont('RB', FONT_BOLD);     else doc.registerFont('RB', 'Helvetica-Bold');
  if (fileExists(FONT_ITALIC))  doc.registerFont('RI', FONT_ITALIC);   else doc.registerFont('RI', 'Helvetica-Oblique');
  if (!fileExists(FONT_REGULAR)) {
    console.warn('[sea-quote-pdf] Roboto TTF missing — Vietnamese diacritics + special chars may not render.');
  }
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const date = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(d); }
}

function quoteNumber(id, createdAt) {
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt || Date.now());
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `SLB-Q-${id || '?'}-${yy}${mm}${dd}`;
}

// ─── Drawing helpers ─────────────────────────────────────────────────────
function hline(doc, x1, y, x2, color = COLOR.border, weight = 0.5) {
  doc.save().lineWidth(weight).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

// Reset paint state so leaked fill/stroke colors from a previous draw don't
// bleed into the next text run (pdfkit retains state across calls).
function resetPaint(doc) {
  doc.fillColor(COLOR.text).strokeColor(COLOR.text).lineWidth(0.5);
}

// ─── Section: header (logo + company info + title bar) ───────────────────
function drawHeader(doc, left, right, opts) {
  const top = doc.y;
  const logoPath = LOGO_CANDIDATES.find(fileExists);
  if (logoPath) {
    try { doc.image(logoPath, left, top, { width: 75 }); } catch { /* skip */ }
  }
  // Company block — right-aligned next to logo
  const companyX = left + (logoPath ? 90 : 0);
  const companyW = right - companyX;
  doc.font('RB').fontSize(11).fillColor(COLOR.brandDark)
    .text('SLB GLOBAL LOGISTICS CO., LTD.', companyX, top, { width: companyW });
  doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted);
  doc.text('8th Floor, Diamond Building, No 7 Lot 8A Le Hong Phong, Ngo Quyen, Hai Phong, Viet Nam',
    companyX, doc.y + 1, { width: companyW });
  doc.text('Tel  +84 931 334 331    Email  info@slbglobal.com    Web  www.slbglobal.com',
    companyX, doc.y + 1, { width: companyW });

  doc.y = Math.max(doc.y, top + (logoPath ? 60 : 50));
  doc.moveDown(0.6);

  // Title row: bilingual title left + Quote No / Date / Valid stack right
  const titleY = doc.y;
  doc.font('RB').fontSize(FS.title).fillColor(COLOR.text)
    .text('FREIGHT QUOTATION', left, titleY, { lineBreak: false });
  doc.font('R').fontSize(FS.subtitle).fillColor(COLOR.textMuted)
    .text('Báo giá vận chuyển', left, titleY + 22, { lineBreak: false });

  // Right-stacked meta block
  const metaW = 200;
  const metaX = right - metaW;
  let mY = titleY;
  const metaLine = (label, value) => {
    doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
      .text(label, metaX, mY, { width: metaW, align: 'right', lineBreak: false });
    mY = doc.y + 1;
    doc.font('RB').fontSize(FS.body + 0.5).fillColor(COLOR.text)
      .text(value || '—', metaX, mY, { width: metaW, align: 'right', lineBreak: false });
    mY = doc.y + 4;
  };
  metaLine('QUOTATION NO.', quoteNumber(opts.quote_id, opts.quote_created_at));
  metaLine('DATE', fmtDate(new Date()));
  if (opts.valid_until) metaLine('VALID UNTIL', fmtDate(opts.valid_until));

  doc.y = Math.max(doc.y, titleY + 50);
  doc.moveDown(0.4);
  hline(doc, left, doc.y, right, COLOR.borderStrong, 1);
  doc.moveDown(0.6);
  resetPaint(doc);
}

// ─── Section: parties + route (two columns) ──────────────────────────────
function drawPartiesRoute(doc, left, right, opts) {
  const usable = right - left;
  const colGap = 16;
  const colW = (usable - colGap) / 2;
  const top = doc.y;

  // ── LEFT: TO / KÍNH GỬI
  doc.font('RB').fontSize(FS.label).fillColor(COLOR.textMuted)
    .text('TO  /  KÍNH GỬI', left, top, { width: colW });
  let y = doc.y + 2;
  doc.font('RB').fontSize(FS.body + 1).fillColor(COLOR.text)
    .text(opts.customer_name || '—', left, y, { width: colW });
  y = doc.y;

  // ── RIGHT: ROUTE / TUYẾN
  const rightX = left + colW + colGap;
  doc.font('RB').fontSize(FS.label).fillColor(COLOR.textMuted)
    .text('ROUTE  /  TUYẾN', rightX, top, { width: colW });
  let yR = doc.y + 2;

  // POL → POD with a chunky arrow rendered as a separate label (not a glyph)
  // so font-coverage issues never produce "□" garbage.
  const pol = (opts.pol || '').trim() || '—';
  const pod = (opts.pod || '').trim() || '—';
  doc.font('RB').fontSize(FS.body + 1).fillColor(COLOR.text);
  // Split into segments: "POL"  "→"  "POD" with controlled spacing.
  const seg = (txt, x, w, opt) => doc.text(txt, x, yR, { width: w, lineBreak: false, ...opt });
  // Compute widths so the layout flows like: HCM  →  Hamburg
  const arrowLabel = '→'; // U+2192 RIGHTWARDS ARROW (works in Roboto)
  // Build a single line; if arrow font-coverage fails, fall back to ASCII '>'.
  // pdfkit will render the rightwards arrow with Roboto Regular cleanly.
  doc.text(`${pol}   ${arrowLabel}   ${pod}`, rightX, yR, { width: colW, lineBreak: false });
  yR = doc.y + 4;

  // Sub-meta row inside ROUTE column
  doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted);
  const subLine = (label, value) => {
    if (!value) return;
    doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
      .text(label, rightX, yR, { width: 80, lineBreak: false });
    doc.font('RB').fontSize(FS.body).fillColor(COLOR.text)
      .text(value, rightX + 80, yR, { width: colW - 80, lineBreak: false });
    yR = doc.y + 2;
  };
  if (opts.term) subLine('TERM', String(opts.term));
  // Cargo line: FCL list or LCL CBM
  let cargoDesc;
  if (opts.cargo_type === 'LCL') {
    cargoDesc = `LCL  ·  ${opts.shipment_cbm || 0} CBM`;
  } else {
    const conts = (opts.containers || []).filter(c => parseNum(c.qty) > 0)
      .map(c => `${c.qty} × ${c.type}`).join(',  ');
    cargoDesc = `FCL  ·  ${conts || '— no containers —'}`;
  }
  subLine('CARGO', cargoDesc);
  if (opts.exchange_rate) {
    subLine('FX RATE', `1 USD = ${Number(opts.exchange_rate).toLocaleString('en-US')} VND`);
  }

  // Sync y to bottom of taller column
  doc.y = Math.max(y, yR);
  doc.moveDown(0.8);
  resetPaint(doc);
}

// ─── Section: charges table ──────────────────────────────────────────────
//
// Returns the section totals { [currency]: {subtotal, vat, total} }
// so the caller can build the grand total.
function drawChargesSection(doc, left, right, opts) {
  const { title, subtitle, rows, ctx } = opts;
  const ticked = (rows || []).filter(r => r.ticked && calcRowAmount(r, ctx) > 0);
  if (!ticked.length) return { byCurrency: {} };

  const usable = right - left;
  const isFcl = ctx.cargo_type === 'FCL';
  const activeTypes = isFcl
    ? (ctx.containers || []).filter(c => parseNum(c.qty) > 0).map(c => c.type)
    : [];

  // ─ Brand-colored section header bar
  const barY = doc.y;
  doc.save().rect(left, barY, usable, 22).fill(COLOR.headerBar).restore();
  doc.font('RB').fontSize(FS.sectionBar).fillColor('#FFFFFF')
    .text(title, left + 10, barY + 6, { width: usable - 20, lineBreak: false });
  if (subtitle) {
    doc.font('R').fontSize(FS.label).fillColor('#FFFFFF')
      .text(subtitle, left + 10, barY + 6, { width: usable - 20, align: 'right', lineBreak: false });
  }
  doc.y = barY + 22;
  resetPaint(doc);

  // ─ Column layout
  // Goal: no text wrap. Use unitShort for compact unit labels.
  // FCL: Desc | <cont-qty cols (narrow)> | Unit | VAT% | NET | VAT AMT | LINE TOTAL
  // LCL: Desc | Unit Price | CBM | Unit | VAT% | NET | VAT AMT | LINE TOTAL
  // 3 money cols replace the old single Amount column.
  const MONEY_W = 70;           // each of NET / VAT AMT / LINE TOTAL
  const MONEY_BLOCK = MONEY_W * 3;
  const UNIT_W = 48;
  const VATPCT_W = 32;
  let cols;
  if (isFcl && activeTypes.length > 0) {
    // Narrow cont cols when many — cargo summary is already in CARGO line.
    const contW = activeTypes.length > 3 ? 28 : (activeTypes.length > 1 ? 34 : 42);
    const dynW = activeTypes.length * contW;
    const descW = Math.max(90, usable - dynW - UNIT_W - VATPCT_W - MONEY_BLOCK);
    cols = [
      { key: 'desc',  w: descW, label: 'Description', align: 'left' },
      ...activeTypes.map(t => ({ key: `cont-${t}`, w: contW, label: t, align: 'right' })),
      { key: 'unit',  w: UNIT_W,   label: 'Unit',       align: 'center' },
      { key: 'vatp',  w: VATPCT_W, label: 'VAT%',       align: 'center' },
      { key: 'net',   w: MONEY_W,  label: 'Net',        align: 'right' },
      { key: 'vatA',  w: MONEY_W,  label: 'VAT',        align: 'right' },
      { key: 'tot',   w: MONEY_W,  label: 'Line Total', align: 'right' },
    ];
  } else if (isFcl) {
    cols = [
      { key: 'desc',  w: usable - UNIT_W - VATPCT_W - MONEY_BLOCK, label: 'Description', align: 'left' },
      { key: 'unit',  w: UNIT_W,   label: 'Unit',       align: 'center' },
      { key: 'vatp',  w: VATPCT_W, label: 'VAT%',       align: 'center' },
      { key: 'net',   w: MONEY_W,  label: 'Net',        align: 'right' },
      { key: 'vatA',  w: MONEY_W,  label: 'VAT',        align: 'right' },
      { key: 'tot',   w: MONEY_W,  label: 'Line Total', align: 'right' },
    ];
  } else {
    cols = [
      { key: 'desc',  w: usable - 56 - 40 - UNIT_W - VATPCT_W - MONEY_BLOCK, label: 'Description', align: 'left' },
      { key: 'price', w: 56,       label: 'Unit Price', align: 'right' },
      { key: 'cbm',   w: 40,       label: 'CBM',        align: 'right' },
      { key: 'unit',  w: UNIT_W,   label: 'Unit',       align: 'center' },
      { key: 'vatp',  w: VATPCT_W, label: 'VAT%',       align: 'center' },
      { key: 'net',   w: MONEY_W,  label: 'Net',        align: 'right' },
      { key: 'vatA',  w: MONEY_W,  label: 'VAT',        align: 'right' },
      { key: 'tot',   w: MONEY_W,  label: 'Line Total', align: 'right' },
    ];
  }

  // ─ Column headers (no fill, bottom-border only)
  const headerY = doc.y;
  let cx = left;
  for (const c of cols) {
    doc.font('RB').fontSize(FS.tableHeader).fillColor(COLOR.textMuted)
      .text(c.label.toUpperCase(), cx + 4, headerY + 6, { width: c.w - 8, align: c.align, lineBreak: false });
    cx += c.w;
  }
  // Bottom border of header row
  hline(doc, left, headerY + HEAD_H, right, COLOR.borderStrong, 0.8);
  doc.y = headerY + HEAD_H;

  // ─ Data rows (alternating row shading)
  let rowIdx = 0;
  for (const r of ticked) {
    const rowY = doc.y;
    const net = calcRowAmount(r, ctx);
    const vatAmt = calcRowVat(r, ctx);
    const lineTotal = calcRowTotal(r, ctx);
    const currency = unitToCurrency(r.unit);

    if (rowIdx % 2 === 0) {
      doc.save().rect(left, rowY, usable, ROW_H).fill(COLOR.rowAlt).restore();
    }

    cx = left;
    for (const c of cols) {
      let txt = '';
      let bold = false;
      let color = COLOR.text;
      if (c.key === 'desc') { txt = r.name || ''; bold = true; }
      else if (c.key === 'price') {
        txt = r.price ? fmtAmount(parseNum(r.price), currency) : '';
      }
      else if (c.key === 'cbm') txt = r.cbm ? String(r.cbm) : '';
      else if (c.key === 'unit') txt = unitShort(r.unit);
      else if (c.key === 'vatp') txt = r.vat || '';
      else if (c.key === 'net') {
        txt = net > 0 ? `${fmtAmount(net, currency)} ${currency}` : '';
        color = COLOR.textMuted;
      }
      else if (c.key === 'vatA') {
        txt = net > 0 ? `${fmtAmount(vatAmt, currency)} ${currency}` : '';
        color = COLOR.textMuted;
      }
      else if (c.key === 'tot') {
        txt = lineTotal > 0 ? `${fmtAmount(lineTotal, currency)} ${currency}` : '';
        bold = true;
        color = COLOR.text;
      }
      else if (c.key.startsWith('cont-')) {
        const t = c.key.slice(5);
        const v = r.price_by_cont && r.price_by_cont[t];
        txt = v ? fmtAmount(parseNum(v), currency) : '';
      }
      doc.font(bold ? 'RB' : 'R').fontSize(FS.tableCell).fillColor(color)
        .text(txt, cx + 4, rowY + 5, { width: c.w - 8, align: c.align, lineBreak: false });
      cx += c.w;
    }
    // Thin row separator
    hline(doc, left, rowY + ROW_H, right, COLOR.border, 0.3);
    doc.y = rowY + ROW_H;
    rowIdx++;
  }

  // ─ Section subtotals — Net / VAT / Section Total per currency
  const totals = calcSectionTotals(rows, ctx);
  for (const cur of Object.keys(totals)) {
    const { net, vat, total } = totals[cur];
    const labelW = usable - 100;
    const valX = right - 96;
    const valW = 92;

    const netY = doc.y + 2;
    doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
      .text('Subtotal Net', left + 4, netY, { width: labelW, align: 'right', lineBreak: false });
    doc.font('RB').fontSize(FS.body).fillColor(COLOR.text)
      .text(`${fmtAmount(net, cur)} ${cur}`, valX, netY, { width: valW, align: 'right', lineBreak: false });
    doc.y = netY + 12;
    if (vat > 0) {
      const vatY = doc.y;
      doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
        .text('VAT', left + 4, vatY, { width: labelW, align: 'right', lineBreak: false });
      doc.font('R').fontSize(FS.body).fillColor(COLOR.text)
        .text(`${fmtAmount(vat, cur)} ${cur}`, valX, vatY, { width: valW, align: 'right', lineBreak: false });
      doc.y = vatY + 12;
    }
    // Section total — top border, brand color
    const totY = doc.y;
    hline(doc, right - 200, totY, right, COLOR.borderStrong, 0.8);
    doc.font('RB').fontSize(FS.body).fillColor(COLOR.text)
      .text(`Section Total (${cur})`, left + 4, totY + 4, { width: labelW, align: 'right', lineBreak: false });
    doc.font('RB').fontSize(FS.body + 0.5).fillColor(COLOR.brandDark)
      .text(`${fmtAmount(total, cur)} ${cur}`, valX, totY + 4, { width: valW, align: 'right', lineBreak: false });
    doc.y = totY + 16;
  }

  // ─ Per-line VAT explainer (small grey italic)
  doc.font('RI').fontSize(FS.footer + 0.5).fillColor(COLOR.textFaint)
    .text('Đơn giá theo từng dòng. VAT áp dụng theo từng loại phí (0% hoặc 8%). Line Total đã bao gồm VAT.',
      left, doc.y + 4, { width: usable, lineGap: 1 });
  doc.moveDown(0.6);
  resetPaint(doc);
  return { byCurrency: totals };
}

// ─── Section: grand total box ────────────────────────────────────────────
function drawGrandTotal(doc, left, right, intlT, inlandT, opts) {
  const usable = right - left;
  if (!opts.grand_total_currency) return;

  const grand = calcGrandTotal(intlT, inlandT, opts.grand_total_currency, opts.exchange_rate);
  if (grand == null) {
    doc.font('RI').fontSize(FS.body).fillColor('#B45309')
      .text('Note: mixed currencies present and no FX rate set — Grand Total cannot be computed.',
        left, doc.y, { width: usable });
    doc.fillColor(COLOR.text);
    doc.moveDown(0.4);
    return;
  }

  // Right-aligned grand total box
  const boxW = 240;
  const boxX = right - boxW;
  const boxY = doc.y + 6;
  const boxH = 36;
  doc.save()
    .rect(boxX, boxY, boxW, boxH)
    .lineWidth(1.2).strokeColor(COLOR.brand).fillAndStroke(COLOR.totalBg, COLOR.brand)
    .restore();
  doc.font('RB').fontSize(FS.totalLabel).fillColor(COLOR.brandDark)
    .text('GRAND TOTAL', boxX + 12, boxY + 8, { width: boxW - 24, align: 'left', lineBreak: false });
  doc.font('RB').fontSize(FS.totalGrand).fillColor(COLOR.brandDark)
    .text(`${fmtAmount(grand, opts.grand_total_currency)} ${opts.grand_total_currency}`,
      boxX + 12, boxY + 18, { width: boxW - 24, align: 'right', lineBreak: false });
  doc.y = boxY + boxH + 4;
  resetPaint(doc);
}

// ─── Section: notes + T&Cs + footer ──────────────────────────────────────
function drawNotes(doc, left, right, notes) {
  if (!notes || !String(notes).trim()) return;
  const usable = right - left;
  doc.font('RB').fontSize(FS.label).fillColor(COLOR.textMuted)
    .text('REMARKS  /  GHI CHÚ', left, doc.y, { width: usable });
  doc.moveDown(0.2);
  doc.font('R').fontSize(FS.body).fillColor(COLOR.text)
    .text(String(notes), left, doc.y, { width: usable, lineGap: 2 });
  doc.moveDown(0.6);
  resetPaint(doc);
}

const TERMS = [
  'Store fee at Port, Demurrage, Loading/Unloading, Container detention, Customs Inspection/Overtime, Insurance, TAX/VAT, and any special fees are EXCLUDED unless explicitly listed above.',
  'Import Tax and VAT are not included.',
  'Quoted prices are based on current oil/fuel index and may be revised if a fuel surcharge applies.',
  'Insurance Fee (0.3 % of cargo value + 10 % VAT) — added on request.',
  'Validity: effective from the quotation date until the “Valid Until” date above.',
  'Payment term: within 30 days after the cargo is loaded on board (B/L on board date).',
];

function drawTerms(doc, left, right, validUntil) {
  const usable = right - left;
  doc.moveDown(0.4);
  doc.font('RB').fontSize(FS.label).fillColor(COLOR.textMuted)
    .text('TERMS & CONDITIONS  /  ĐIỀU KHOẢN', left, doc.y, { width: usable });
  doc.moveDown(0.2);
  // Header underline
  hline(doc, left, doc.y, right, COLOR.border, 0.5);
  doc.moveDown(0.3);

  doc.font('R').fontSize(FS.label + 0.5).fillColor(COLOR.text);
  let i = 1;
  for (const t of TERMS) {
    const text = t.replace('“Valid Until” date above',
      validUntil ? `“Valid Until” date above (${fmtDate(validUntil)})` : '“Valid Until” date above');
    doc.text(`${i}.  ${text}`, left, doc.y, { width: usable, lineGap: 3, indent: 0 });
    doc.moveDown(0.1);
    i++;
  }
  doc.moveDown(0.4);
  resetPaint(doc);
}

function drawClosing(doc, left, right) {
  const usable = right - left;
  doc.moveDown(0.4);
  hline(doc, left, doc.y, right, COLOR.border, 0.5);
  doc.moveDown(0.4);
  doc.font('RI').fontSize(FS.body).fillColor(COLOR.textMuted)
    .text('Thank you for your cooperation.', left, doc.y, { width: usable });
  doc.font('R').fontSize(FS.body).fillColor(COLOR.text)
    .text('Best regards,', left, doc.y, { width: usable });
  doc.font('RB').fontSize(FS.body + 0.5).fillColor(COLOR.brandDark)
    .text('SLB GLOBAL LOGISTICS CO., LTD.', left, doc.y, { width: usable });
  resetPaint(doc);
}

// ─── Page footer (page number + company) ─────────────────────────────────
function drawPageFooter(doc) {
  // Called once at the end; pdfkit doesn't trigger on auto-paginate without
  // an event hook, so we paint a single-page footer here. Multi-page quotes
  // are rare for this domain (single shipment quotes fit one page); if they
  // grow longer, switch to doc.on('pageAdded', ...) and reuse this fn.
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - 24;
  doc.font('R').fontSize(FS.footer).fillColor(COLOR.textFaint)
    .text('SLB GLOBAL LOGISTICS CO., LTD.   ·   www.slbglobal.com',
      left, bottom, { width: right - left, align: 'left', lineBreak: false });
  doc.font('R').fontSize(FS.footer).fillColor(COLOR.textFaint)
    .text(`Page 1`, left, bottom, { width: right - left, align: 'right', lineBreak: false });
  resetPaint(doc);
}

// ─── Main entry ──────────────────────────────────────────────────────────
function buildSeaQuotePdf(opts) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
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

      drawHeader(doc, left, right, {
        quote_id: opts.quote_id,
        quote_created_at: opts.quote_created_at,
        valid_until: opts.valid_until,
      });

      drawPartiesRoute(doc, left, right, {
        customer_name: opts.customer_name,
        pol: qd.pol,
        pod: qd.pod,
        term: qd.term,
        cargo_type: ctx.cargo_type,
        containers: ctx.containers,
        shipment_cbm: qd.shipment_cbm,
        exchange_rate: opts.exchange_rate,
      });

      const intlOut = drawChargesSection(doc, left, right, {
        title: 'INTERNATIONAL CHARGES',
        subtitle: 'PHÍ QUỐC TẾ',
        rows: qd.intl_charges || [],
        ctx,
      });
      const inlandOut = drawChargesSection(doc, left, right, {
        title: 'INLAND CHARGES',
        subtitle: 'PHÍ NỘI ĐỊA',
        rows: qd.inland_charges || [],
        ctx,
      });

      drawGrandTotal(doc, left, right, intlOut.byCurrency, inlandOut.byCurrency, {
        grand_total_currency: opts.grand_total_currency,
        exchange_rate: opts.exchange_rate,
      });

      drawNotes(doc, left, right, qd.notes);
      drawTerms(doc, left, right, opts.valid_until);
      drawClosing(doc, left, right);
      drawPageFooter(doc);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildSeaQuotePdf };
