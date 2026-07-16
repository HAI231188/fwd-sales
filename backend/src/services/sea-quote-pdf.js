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
  parseNum, unitToCurrency, unitBasis,
  rateByDim, ctxDimensions, rowUsesDimensions,
  calcRowAmount, calcRowVat, calcRowTotal,
  calcSectionTotals, calcGrandTotal, fmtAmount,
  formatVolume, formatRowVol, unitShort,
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

// ─── Per-transport titles (drawHeader reads from here). Adding a future
// transport (multimodal, rail, …) is a one-line config change. ─────────
const TRANSPORT_TITLES = {
  sea:  { en: 'SEA FREIGHT QUOTATION',  vi: 'Báo giá vận tải đường biển' },
  air:  { en: 'AIR FREIGHT QUOTATION',  vi: 'Báo giá vận tải hàng không' },
  road: { en: 'ROAD FREIGHT QUOTATION', vi: 'Báo giá vận tải đường bộ' },
};

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
    .text('CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB', companyX, top, { width: companyW });
  doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted);
  doc.text('Số 18/100 Khu dân cư Tasa, Phường Đông Hải, Thành phố Hải Phòng, Việt Nam',
    companyX, doc.y + 1, { width: companyW });
  doc.text('Tel  +84 931 334 331    Email  info@slbglobal.com    Web  www.slbglobal.com',
    companyX, doc.y + 1, { width: companyW });

  doc.y = Math.max(doc.y, top + (logoPath ? 60 : 50));
  doc.moveDown(0.6);

  // Title row: bilingual title left + Quote No / Date / Valid stack right.
  // Title is driven by transport (air/sea/road) — see TRANSPORT_TITLES below.
  const titles = TRANSPORT_TITLES[opts.transport] || TRANSPORT_TITLES.sea;
  const titleY = doc.y;
  doc.font('RB').fontSize(FS.title).fillColor(COLOR.text)
    .text(titles.en, left, titleY, { lineBreak: false });
  doc.font('R').fontSize(FS.subtitle).fillColor(COLOR.textMuted)
    .text(titles.vi, left, titleY + 22, { lineBreak: false });

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

  // POL / POD rendered as separate labeled rows (no Unicode arrow).
  // ASCII-safe fallback when empty: previous versions used "—" (em-dash,
  // U+2014) which can itself fall outside PDFKit's embedded font subset
  // and render as "□" — same class of glyph-coverage failure as the old
  // "→" arrow. Stick to pure ASCII for placeholders.
  const pol = (opts.pol || '').trim() || '(chua nhap)';
  const pod = (opts.pod || '').trim() || '(chua nhap)';

  // Shared sub-meta helper: small grey label (80pt) + bold value
  const subLine = (label, value) => {
    if (value == null) return;
    doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
      .text(label, rightX, yR, { width: 80, lineBreak: false });
    doc.font('RB').fontSize(FS.body).fillColor(COLOR.text)
      .text(String(value), rightX + 80, yR, { width: colW - 80, lineBreak: false });
    yR = doc.y + 2;
  };

  // Route labels per transport: sea POL/POD, air AOL/AOD, road Pickup/Delivery/Border.
  if (opts.transport === 'air') {
    subLine('AOL', (opts.aol || '').trim() || '(chua nhap)');
    subLine('AOD', (opts.aod || '').trim() || '(chua nhap)');
  } else if (opts.transport === 'road') {
    subLine('PICKUP',   (opts.pickup   || '').trim() || '(chua nhap)');
    subLine('DELIVERY', (opts.delivery || '').trim() || '(chua nhap)');
    if (opts.border_gate) subLine('CUA KHAU', String(opts.border_gate));
  } else {
    subLine('POL', pol);
    subLine('POD', pod);
  }
  if (opts.term) subLine('TERM', String(opts.term));
  // CARGO line — just the type. VOLUME below carries the actual quantities.
  const cargoLabel = opts.transport === 'air' ? 'AIR'
    : opts.transport === 'road' ? 'ROAD'
    : String(opts.cargo_type || 'FCL');
  subLine('CARGO', cargoLabel);

  // VOLUME row — most prominent meta value (larger + brand color).
  const volumeStr = formatVolume({
    transport: opts.transport,
    cargo_type: opts.cargo_type,
    containers: opts.containers,
    shipment_cbm: opts.shipment_cbm,
    chargeable_weight: opts.chargeable_weight,
    rate_breaks: opts.rate_breaks,
    vehicles: opts.vehicles,
  });
  if (volumeStr) {
    doc.font('R').fontSize(FS.label).fillColor(COLOR.textMuted)
      .text('VOLUME', rightX, yR, { width: 80, lineBreak: false });
    doc.font('RB').fontSize(FS.body + 2).fillColor(COLOR.brandDark)
      .text(volumeStr, rightX + 80, yR - 1, { width: colW - 80, lineBreak: false });
    yR = doc.y + 3;
  }

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
  // Show ALL ticked rows — even Net=0 (e.g. complimentary X-RAY at rate 0).
  // The user explicitly opted them into the quote by ticking the row.
  const ticked = (rows || []).filter(r => r.ticked);
  if (!ticked.length) return { byCurrency: {} };

  const usable = right - left;
  // Dimension: sea = container types (FCL only); air = rate breaks;
  // road = vehicle types. `activeTypes` holds the dimension keys in render
  // order. Each key gets a paired (SL | Đơn giá) sub-column block.
  // Sourced from the same `ctxDimensions` used by the calc — guaranteed
  // to match exactly what the math sees (L27).
  const isAir  = ctx.transport === 'air';
  const isRoad = ctx.transport === 'road';
  const isFcl  = !isAir && !isRoad && ctx.cargo_type === 'FCL';
  const activeTypes = (isAir || isRoad || isFcl)
    ? ctxDimensions(ctx).filter(d => d.qty > 0).map(d => d.key)
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

  // ─ Final column layout (2026-05-27 paired) — UNIT widened to fit
  // "USD/CONT"/"USD/SHPT"/"VND/CONT" on a single line (was 44pt, wrapped).
  // SL cols tightened to 12-14pt (1-2 digits only); money/RATE trimmed slightly
  // to keep desc readable for 2-3 cont type quotes.
  const MONEY_W = 56;
  const MONEY_BLOCK = MONEY_W * 3;
  // UNIT widened to fit "USD/SHIPMENT"/"VND/SHIPMENT"/"VND/CHUYEN" on
  // a single line (air units are longer than sea's USD/CONT).
  const UNIT_W = 72;
  const VATPCT_W = 24;
  const RATE_W = 50;
  // qtyByType maps dimension key → qty. Built from the same canonical
  // ctxDimensions used by calc, so render and math can never drift.
  const qtyByType = Object.fromEntries(ctxDimensions(ctx).map(d => [d.key, d.qty]));

  const cols = [];
  cols.push({ key: 'desc', w: 0, label: 'Description', align: 'left' });
  let contGroupCount = 0;
  if (activeTypes.length > 0) {
    contGroupCount = activeTypes.length;
    // Per-transport adaptive widths. Air kg needs more digits than sea
    // cont qty; road số xe is 1-2 digits like sea but reuses air widths
    // for consistency with the longer rate values typical for trucking.
    const wide = isAir || isRoad;
    const slW  = wide
      ? (contGroupCount > 2 ? 18 : (contGroupCount > 1 ? 22 : 32))
      : (contGroupCount > 2 ? 12 : 16);
    const giaW = wide
      ? (contGroupCount > 2 ? 32 : (contGroupCount > 1 ? 40 : 56))
      : (contGroupCount > 3 ? 32 : (contGroupCount > 2 ? 36 : (contGroupCount > 1 ? 44 : 52)));
    const slLabel = isAir ? 'kg' : isRoad ? 'so xe' : 'SL';
    for (const t of activeTypes) {
      cols.push({ key: `sl-${t}`,  w: slW,  contType: t, label: slLabel, align: 'center' });
      cols.push({ key: `gia-${t}`, w: giaW, contType: t, label: 'Don gia', align: 'right' });
    }
  }
  cols.push({ key: 'rate', w: RATE_W,    label: 'Rate',       align: 'right' });
  cols.push({ key: 'unit', w: UNIT_W,    label: 'Unit',       align: 'center' });
  cols.push({ key: 'vatp', w: VATPCT_W,  label: 'VAT%',       align: 'center' });
  cols.push({ key: 'net',  w: MONEY_W,   label: 'Net',        align: 'right' });
  cols.push({ key: 'vatA', w: MONEY_W,   label: 'VAT',        align: 'right' });
  cols.push({ key: 'tot',  w: MONEY_W,   label: 'Line Total', align: 'right' });
  const usedW = cols.slice(1).reduce((s, c) => s + c.w, 0);
  cols[0].w = Math.max(60, usable - usedW);

  // ─ 2-row header. Top: cont type spans its two sub-cols. Bottom: SL/Đơn giá.
  // Static (non-cont) cols use the full height with their label vertically centered.
  const HEAD_H_TOP = contGroupCount > 0 ? 14 : 0;
  const HEAD_H_SUB = 12;
  const HEAD_H_FULL = HEAD_H_TOP + HEAD_H_SUB;
  const headerY = doc.y;
  if (contGroupCount > 0) {
    let cx0 = left;
    for (const c of cols) {
      if (c.key.startsWith('sl-')) {
        const giaCol = cols.find(cc => cc.key === `gia-${c.contType}`);
        const groupW = c.w + (giaCol ? giaCol.w : 0);
        doc.font('RB').fontSize(FS.tableHeader).fillColor(COLOR.textMuted)
          .text(c.contType, cx0, headerY + 2, { width: groupW, align: 'center', lineBreak: false });
      }
      cx0 += c.w;
    }
  }
  let cx = left;
  for (const c of cols) {
    if (c.key.startsWith('sl-') || c.key.startsWith('gia-')) {
      doc.font('R').fontSize(FS.label - 1).fillColor(COLOR.textFaint)
        .text(c.label, cx + 2, headerY + HEAD_H_TOP + 2, { width: c.w - 4, align: c.align, lineBreak: false });
    } else {
      doc.font('RB').fontSize(FS.tableHeader).fillColor(COLOR.textMuted)
        .text(c.label.toUpperCase(), cx + 4, headerY + (HEAD_H_FULL - 10) / 2 + 1, { width: c.w - 8, align: c.align, lineBreak: false });
    }
    cx += c.w;
  }
  hline(doc, left, headerY + HEAD_H_FULL, right, COLOR.borderStrong, 0.8);
  doc.y = headerY + HEAD_H_FULL;

  // ─ Data rows
  let rowIdx = 0;
  for (const r of ticked) {
    const rowY = doc.y;
    // Unified dimension predicate — true for sea cont rows AND air kg rows
    // with rate_by_break. Cell render uses this single predicate; no
    // transport-specific branch can drift out of sync (L27).
    const usesDim = rowUsesDimensions(r, ctx);
    const net = calcRowAmount(r, ctx);
    const vatAmt = calcRowVat(r, ctx);
    const lineTotal = calcRowTotal(r, ctx);
    const currency = unitToCurrency(r.unit);
    const rates = rateByDim(r);            // unified rate-map read
    const flatRate = parseNum(r.rate != null ? r.rate : r.price);

    if (rowIdx % 2 === 0) {
      doc.save().rect(left, rowY, usable, ROW_H).fill(COLOR.rowAlt).restore();
    }

    cx = left;
    for (const c of cols) {
      let txt = '';
      let bold = false;
      let color = COLOR.text;
      let sz = FS.tableCell;
      if (c.key === 'desc') { txt = r.name || ''; bold = true; }
      else if (c.key.startsWith('sl-')) {
        const t = c.contType;                // dimension key (cont/break/vehicle)
        if (usesDim) {
          const qty = qtyByType[t] || 0;
          // Air kg can be 4-5 digits → thousand-separated; sea/road typically
          // 1-2 digits but the formatter handles both fine.
          txt = (ctx.transport === 'air')
            ? Number(qty).toLocaleString('en-US')
            : String(qty);
          color = COLOR.text;
          bold = true;
          sz = FS.tableCell - 0.5;
        } else {
          txt = '-';
          color = COLOR.textFaint;
        }
      }
      else if (c.key.startsWith('gia-')) {
        const t = c.contType;
        if (usesDim) {
          const v = parseNum(rates[t]);
          txt = v > 0 ? fmtAmount(v, currency) : '';
          color = COLOR.textMuted;
          sz = FS.tableCell - 0.5;
        } else {
          txt = '-';
          color = COLOR.textFaint;
        }
      }
      else if (c.key === 'rate') {
        if (usesDim) {
          txt = '-';
          color = COLOR.textFaint;
        } else {
          txt = flatRate > 0 ? fmtAmount(flatRate, currency) : '';
          color = COLOR.textMuted;
        }
      }
      else if (c.key === 'unit') { txt = unitShort(r.unit); sz = FS.tableCell - 0.5; }
      else if (c.key === 'vatp') txt = r.vat || '';
      else if (c.key === 'net') {
        // No per-row currency suffix — UNIT column already shows USD/VND.
        // Frees ~16pt per money col so large VND (8-10 digit) fits without overlap.
        txt = net > 0 ? fmtAmount(net, currency) : '';
        color = COLOR.textMuted;
      }
      else if (c.key === 'vatA') {
        txt = net > 0 ? fmtAmount(vatAmt, currency) : '';
        color = COLOR.textMuted;
      }
      else if (c.key === 'tot') {
        txt = lineTotal > 0 ? fmtAmount(lineTotal, currency) : '';
        bold = true;
        color = COLOR.text;
      }
      doc.font(bold ? 'RB' : 'R').fontSize(sz).fillColor(color)
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

  // ─ Section explainer (small grey italic).
  // Vietnamese diacritics are fine (Roboto covers full Vietnamese set).
  // What previously broke as tofu was Unicode arrows (→) and the em-dash
  // (—). This wording uses only ASCII punctuation + Vietnamese letters.
  doc.font('RI').fontSize(FS.footer + 0.5).fillColor(COLOR.textFaint)
    .text('Đơn vị quyết định cách tính: CONT = theo container, SHPT/BL = trọn lô, CBM = theo khối, KG = theo trọng lượng. Net = đơn giá x số lượng. Line Total đã gồm VAT.',
      left, doc.y + 4, { width: usable, lineGap: 1 });
  doc.moveDown(0.6);
  resetPaint(doc);
  return { byCurrency: totals };
}

// ─── Section: grand total box ────────────────────────────────────────────
// 3 render modes:
//   - target USD/VND with valid grand → single GRAND TOTAL box
//   - no target → per-currency TỔNG lines (no conversion)
//   - needsRate (mixed + rate empty) → warning + per-currency TỔNG lines
function drawGrandTotal(doc, left, right, intlT, inlandT, opts) {
  const usable = right - left;
  const { perCurrency, grand, needsRate } = calcGrandTotal(
    intlT, inlandT, opts.grand_total_currency, opts.exchange_rate);
  const curs = Object.keys(perCurrency);
  if (curs.length === 0) return;

  const boxW = 280;          // wider than before (240) — fits big VND totals
  const boxX = right - boxW;

  if (opts.grand_total_currency && grand != null) {
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
  } else {
    if (needsRate) {
      doc.font('RI').fontSize(FS.body - 0.5).fillColor('#B45309')
        .text(`Vui long nhap ty gia de quy doi Grand Total (${curs.join(' + ')}).`,
          left, doc.y + 2, { width: usable });
      doc.moveDown(0.2);
    }
    const lineH = 18;
    const boxH = lineH * curs.length + 8;
    const boxY = doc.y + 4;
    doc.save()
      .rect(boxX, boxY, boxW, boxH)
      .lineWidth(1).strokeColor(COLOR.brand).fillAndStroke(COLOR.totalBg, COLOR.brand)
      .restore();
    let lineY = boxY + 6;
    for (const cur of curs) {
      doc.font('RB').fontSize(FS.totalLabel).fillColor(COLOR.brandDark)
        .text(`TỔNG ${cur}`, boxX + 12, lineY + 2, { width: 80, align: 'left', lineBreak: false });
      doc.font('RB').fontSize(FS.totalLabel + 2).fillColor(COLOR.brandDark)
        .text(`${fmtAmount(perCurrency[cur], cur)} ${cur}`,
          boxX + 92, lineY, { width: boxW - 104, align: 'right', lineBreak: false });
      lineY += lineH;
    }
    doc.y = boxY + boxH + 4;
  }
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
    .text('CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB', left, doc.y, { width: usable });
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
    .text('CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB   |   www.slbglobal.com',
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
      const isAir  = qd.transport === 'air'  || qd.mode === 'air';
      const isRoad = qd.transport === 'road' || qd.mode === 'road';
      const transport = isRoad ? 'road' : isAir ? 'air' : 'sea';
      const ctx = {
        transport,
        cargo_type: qd.cargo_type || 'FCL',
        containers: qd.containers || [],
        shipment_cbm: qd.shipment_cbm,
        shipment_kg: qd.shipment_kg,
        // Air:
        rate_breaks: qd.rate_breaks || [],
        chargeable_weight: qd.chargeable_weight,
        // Road:
        vehicles: qd.vehicles || [],
      };

      drawHeader(doc, left, right, {
        quote_id: opts.quote_id,
        quote_created_at: opts.quote_created_at,
        valid_until: opts.valid_until,
        transport: ctx.transport,
      });

      drawPartiesRoute(doc, left, right, {
        customer_name: opts.customer_name,
        transport: ctx.transport,
        // Sea fields
        pol: qd.pol,
        pod: qd.pod,
        cargo_type: ctx.cargo_type,
        containers: ctx.containers,
        shipment_cbm: qd.shipment_cbm,
        // Air fields
        aol: qd.aol,
        aod: qd.aod,
        chargeable_weight: qd.chargeable_weight,
        rate_breaks: qd.rate_breaks,
        // Road fields
        pickup: qd.pickup,
        delivery: qd.delivery,
        border_gate: qd.border_gate,
        vehicles: qd.vehicles,
        // Common
        term: qd.term,
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
