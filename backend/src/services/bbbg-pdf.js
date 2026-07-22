// BBBG (Biên Bản Bàn Giao) PDF builder.
//
// Exports:
//   buildBbbgPdf(data)                       — legacy single-page form-driven
//                                              flow used by the manual BBBGModal.
//                                              Returns a piped PDFDocument.
//   generateMultiBookingBBBG({...})          — CP4.2 multi-booking BBBG (one
//                                              page per booking) used by Vùng 2
//                                              "Xem BBBG" + CP4.3 email attach.
//                                              Returns Promise<Buffer>.
//                                              Reads job + transport + bookings
//                                              from DB itself.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const db = require('../db');
// The BBBG is a Vietnamese-facing driver-handover document, so the SLB invoice
// block + letterheads render the Vietnamese SLB_INVOICE_INFO (the carrier mail
// body already uses it too). The English SLB_INVOICE_INFO_EN is no longer read
// here — it stays exported from email-sender.js for any future international doc.
const { SLB_INVOICE_INFO } = require('./email-sender');

const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Regular.ttf');
const FONT_BOLD    = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Bold.ttf');
const FONT_ITALIC  = path.join(__dirname, '..', 'assets', 'fonts', 'Roboto-Italic.ttf');
// pdfkit's doc.image() detects format from magic bytes, not extension — so a
// .jpeg with PNG extension would still work. Prefer the actual file we ship.
const LOGO_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'slb_logo.jpeg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.jpg'),
  path.join(__dirname, '..', 'assets', 'slb_logo.png'),
];

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function registerFonts(doc) {
  // If a Vietnamese-capable TTF is bundled, use it. Otherwise fall back to
  // pdfkit's built-in Helvetica — diacritics will render as boxes, but the
  // PDF still generates so the endpoint never breaks.
  if (fileExists(FONT_REGULAR)) doc.registerFont('R',  FONT_REGULAR);  else doc.registerFont('R',  'Helvetica');
  if (fileExists(FONT_BOLD))    doc.registerFont('RB', FONT_BOLD);     else doc.registerFont('RB', 'Helvetica-Bold');
  if (fileExists(FONT_ITALIC))  doc.registerFont('RI', FONT_ITALIC);   else doc.registerFont('RI', 'Helvetica-Oblique');
  if (!fileExists(FONT_REGULAR)) {
    console.warn('[bbbg-pdf] Roboto TTF not found — Vietnamese diacritics will not render. Drop fonts into backend/src/assets/fonts/ to enable.');
  }
}

function fmtNumber(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('vi-VN');
}

function bilingualLabel(doc, vn, en, x, y, width) {
  doc.font('RB').fontSize(9).text(vn, x, y, { width, lineBreak: false });
  doc.font('RI').fontSize(7.5).fillColor('#444').text(`(${en})`, x, y + 11, { width, lineBreak: false });
  doc.fillColor('#000');
}

function fieldRow(doc, vn, en, value, x, y, labelWidth, valueWidth) {
  bilingualLabel(doc, vn, en, x, y, labelWidth);
  doc.font('R').fontSize(10).text(value || '', x + labelWidth, y + 2, { width: valueWidth, lineBreak: false });
  return y + 22;
}

// Wrapping variant of fieldRow — same bilingual label, but the value may flow
// onto several lines (Ghi chú carries the multi-line invoice block). Returns
// the y of the next row: a normal 22pt row, taller when the value wrapped.
function fieldRowWrap(doc, vn, en, value, x, y, labelWidth, valueWidth) {
  bilingualLabel(doc, vn, en, x, y, labelWidth);
  const text = value || '';
  doc.font('R').fontSize(10);
  const h = text ? doc.heightOfString(text, { width: valueWidth }) : 0;
  doc.text(text, x + labelWidth, y + 2, { width: valueWidth });
  doc.fillColor('#000');
  return y + Math.max(22, h + 8);
}

// ─── Classic BBBG (Design A) constants + cell helpers ───────────────────────
// English letterhead — the BBBG is signed by the consignee and travels with the
// driver, so the printed letterhead is the international one. NOTE: this is a
// 7th SLB-identity edit point (root CLAUDE.md "SLB company identity" Note) —
// the landline/hotline pair lives ONLY here; grep 'Tasa Residence Area' when
// the address changes again.
const SLB_LETTERHEAD_EN = Object.freeze({
  company: 'SLB GLOBAL LOGISTICS COMPANY LIMITED',
  address: 'No 18/100 Tasa Residence Area, Dong Hai Ward, Hai Phong City, Viet Nam',
  tel:     'Tel: 0084 2257 301 333/302 333     Hotline: 0084 931 334 331',
  web:     'Website: www.slbglobal.com     Email: info@slbglobal.com',
});

// Ghi chú (Remarks) always carries SLB's own Vietnamese invoice block, built
// from the shared SLB_INVOICE_INFO constant (L30 — the carrier mail body reads
// the same object) so an address change flows through. Any operator-typed
// remark is appended below it.
function buildRemarksText(userRemarks) {
  const block =
    `Thông tin xuất hoá đơn: ${SLB_INVOICE_INFO.company}.\n` +
    `MST: ${SLB_INVOICE_INFO.tax}\n` +
    `${SLB_INVOICE_INFO.address}.`;
  const extra = (userRemarks || '').trim();
  return extra ? `${block}\n${extra}` : block;
}

// Per-container weight/measurement — only when the caller supplies per-cont
// figures; otherwise the cell falls back to the job-level total on row 0.
function contMeasureStr(r) {
  const parts = [];
  if (r.weight_kgs != null && r.weight_kgs !== '')        parts.push(`${fmtNumber(r.weight_kgs)} KGS`);
  else if (r.weight_tons != null && r.weight_tons !== '') parts.push(`${fmtNumber(r.weight_tons)} TONS`);
  if (r.cbm != null && r.cbm !== '')                      parts.push(`${fmtNumber(r.cbm)} CBM`);
  return parts.join(' / ');
}

// Job-level weight/measurement — weight (KGS/TONS per weight_unit) + CBM + kiện.
// data.cbm renders when present; POST /bbbg-pdf does not forward it yet (GET
// /bbbg-data already returns `cbm`), so it stays blank until that wiring line
// is added in routes/jobs.js — out of scope here (bbbg-pdf.js only).
function jobMeasureStr(data) {
  const parts = [];
  if (data.weight_value != null && data.weight_value !== '') {
    parts.push(`${fmtNumber(data.weight_value)} ${data.weight_unit || ''}`.trim());
  }
  if (data.cbm != null && data.cbm !== '')         parts.push(`${fmtNumber(data.cbm)} CBM`);
  if (data.so_kien != null && data.so_kien !== '') parts.push(`${data.so_kien} kiện`);
  return parts.join(' / ');
}

// Description per table row: the container's own goods name wins, then the
// job-level goods name, then "AS PER BILL" when both are empty.
function rowDescription(r, data) {
  const own = String(r.goods_description || r.description || '').trim();
  if (own) return own;
  const job = String(data.description || '').trim();
  return job || 'AS PER BILL';
}

function buildBbbgPdf(data) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  registerFonts(doc);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const usableW = right - left;

  // Header — logo top-left, English letterhead centered in the block to its
  // right. Degrades gracefully to a full-width centered letterhead when the
  // logo asset is missing.
  const headerY = doc.y;
  const logoPath = LOGO_CANDIDATES.find(fileExists) || null;
  const hasLogo = !!logoPath;
  if (hasLogo) {
    try { doc.image(logoPath, left, headerY, { width: 90 }); } catch { /* skip */ }
  }
  const headX = left + (hasLogo ? 104 : 0);
  const headW = right - headX;
  doc.font('RB').fontSize(12).fillColor('#000')
     .text(SLB_LETTERHEAD_EN.company, headX, headerY, { width: headW, align: 'center' });
  doc.font('R').fontSize(8).fillColor('#000');
  doc.text(SLB_LETTERHEAD_EN.address, headX, doc.y + 2, { width: headW, align: 'center' });
  doc.text(SLB_LETTERHEAD_EN.tel,     headX, doc.y + 1, { width: headW, align: 'center' });
  doc.text(SLB_LETTERHEAD_EN.web,     headX, doc.y + 1, { width: headW, align: 'center' });
  doc.y = Math.max(doc.y, headerY + (hasLogo ? 70 : 50));
  // Letterhead rule
  doc.moveTo(left, doc.y + 4).lineTo(right, doc.y + 4).strokeColor('#000').lineWidth(1).stroke();
  doc.lineWidth(1);
  doc.y += 8;

  // Title
  doc.moveDown(0.5);
  doc.font('RB').fontSize(16).text('BIÊN BẢN GIAO HÀNG', { align: 'center' });
  doc.font('RI').fontSize(10).fillColor('#444').text('(Proof of Delivery)', { align: 'center' });
  doc.fillColor('#000');

  // Top-right meta (Job ID + Date)
  const metaY = doc.y + 8;
  doc.font('RB').fontSize(9);
  doc.text(`Số lô hàng (Job ID): ${data.job_code || ''}`, left, metaY,      { width: usableW, align: 'right' });
  doc.text(`Ngày (Date): ${data.today_date || ''}`,       left, metaY + 12, { width: usableW, align: 'right' });
  doc.y = metaY + 30;

  // Intro line
  doc.font('RB').fontSize(10).text('Lô hàng với chi tiết như sau:', left);
  doc.font('RI').fontSize(8.5).fillColor('#444').text('(This is to certify that the following shipment)', left, doc.y);
  doc.fillColor('#000');
  doc.moveDown(0.5);

  // Field grid (2 columns)
  const colGap = 12;
  const colW = (usableW - colGap) / 2;
  const labelW = 110;
  const valueW = colW - labelW;

  let leftY = doc.y;
  let rightY = doc.y;

  leftY  = fieldRow(doc, 'Người gửi',     'Shipper',   data.shipper,   left,                 leftY,  labelW, valueW);
  rightY = fieldRow(doc, 'Người nhận',    'Consignee', data.consignee, left + colW + colGap, rightY, labelW, valueW);

  leftY  = fieldRow(doc, 'Tàu',           'Vessel',    data.vessel,    left,                 leftY,  labelW, valueW);
  rightY = fieldRow(doc, 'Chuyến',        'Voy.',      data.voy,       left + colW + colGap, rightY, labelW, valueW);

  leftY  = fieldRow(doc, 'Từ',            'From',      data.from_,     left,                 leftY,  labelW, valueW);
  rightY = fieldRow(doc, 'Đến cảng',      'Terminal',  data.terminal,  left + colW + colGap, rightY, labelW, valueW);

  leftY  = fieldRow(doc, 'Vận đơn phụ',   'H-B/L',     data.hbl_no,    left,                 leftY,  labelW, valueW);
  rightY = fieldRow(doc, 'Vận đơn chính', 'M-B/L',     data.mbl_no,    left + colW + colGap, rightY, labelW, valueW);

  doc.y = Math.max(leftY, rightY) + 4;

  // Container table
  const tableTop = doc.y;
  const colWidths = [usableW * 0.30, usableW * 0.18, usableW * 0.27, usableW * 0.25];
  const headers = [
    { vn: 'SỐ CONTAINER',     en: 'Container No.' },
    { vn: 'SỐ LƯỢNG',         en: 'Quantity' },
    { vn: 'TÊN HÀNG HÓA',     en: 'Description' },
    { vn: 'TRỌNG/KHỐI LƯỢNG', en: 'Weight/Measurement' },
  ];
  const headerH = 28;

  doc.rect(left, tableTop, usableW, headerH).fillAndStroke('#f3f4f6', '#000');
  doc.fillColor('#000');
  let cx = left;
  for (let i = 0; i < headers.length; i++) {
    const w = colWidths[i];
    doc.font('RB').fontSize(8).text(headers[i].vn, cx + 4, tableTop + 4, { width: w - 8, align: 'center' });
    doc.font('RI').fontSize(7).fillColor('#555').text(`(${headers[i].en})`, cx + 4, tableTop + 16, { width: w - 8, align: 'center' });
    doc.fillColor('#000');
    cx += w;
  }

  // One row per container (the LCL / no-container case renders a single
  // whole-lot row). Row 0 carries the job-level weight/measurement when the
  // container itself has none, so the totals are never lost.
  const hasConts = !!(data.containers && data.containers.length);
  const rows = hasConts
    ? data.containers
    : [{ cont_number: '', cont_type: '', seal_number: '' }];
  let rowY = tableTop + headerH;
  const rowH = 22;
  const jobMeasure = jobMeasureStr(data);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    doc.rect(left, rowY, usableW, rowH).stroke('#999');
    let x2 = left;
    const cont = [r.cont_number || '', r.cont_type ? `(${r.cont_type})` : ''].filter(Boolean).join(' ');
    const seal = r.seal_number ? `Seal: ${r.seal_number}` : '';
    doc.font('R').fontSize(9).fillColor('#000')
       .text(cont, x2 + 4, rowY + (seal ? 3 : 6), { width: colWidths[0] - 8, lineBreak: false });
    if (seal) {
      doc.font('RI').fontSize(6.5).fillColor('#555')
         .text(seal, x2 + 4, rowY + 13, { width: colWidths[0] - 8, lineBreak: false });
      doc.fillColor('#000');
    }
    x2 += colWidths[0];
    // Quantity: 1 per container row; the container-less whole-lot row shows the
    // piece count when we have one.
    const qtyCell = hasConts
      ? '1'
      : (data.so_kien != null && data.so_kien !== '' ? `${data.so_kien} kiện` : '1');
    doc.font('R').fontSize(9)
       .text(qtyCell, x2 + 4, rowY + 6, { width: colWidths[1] - 8, align: 'center', lineBreak: false });
    x2 += colWidths[1];
    doc.text(rowDescription(r, data), x2 + 4, rowY + 6, { width: colWidths[2] - 8, align: 'center', lineBreak: false });
    x2 += colWidths[2];
    const ownMeasure = contMeasureStr(r);
    const measureCell = ownMeasure || (i === 0 ? jobMeasure : '');
    doc.text(measureCell, x2 + 4, rowY + 6, { width: colWidths[3] - 8, align: 'center', lineBreak: false });
    rowY += rowH;
  }

  // Totals strip — only when per-container figures displaced the job-level
  // total from row 0, so the sheet always states the shipment total once.
  const row0HadOwnMeasure = !!contMeasureStr(rows[0] || {});
  if (jobMeasure && row0HadOwnMeasure) {
    doc.rect(left, rowY, usableW, rowH).stroke('#999');
    doc.font('RB').fontSize(8.5).text('TỔNG (Total)', left + 4, rowY + 7,
      { width: colWidths[0] + colWidths[1] + colWidths[2] - 8, lineBreak: false });
    doc.font('R').fontSize(9).text(jobMeasure,
      left + colWidths[0] + colWidths[1] + colWidths[2] + 4, rowY + 7,
      { width: colWidths[3] - 8, align: 'center', lineBreak: false });
    rowY += rowH;
  }

  doc.y = rowY + 10;

  // Invoice info section (L15) — render only if at least one of the 3 fields is non-empty.
  const invCompany = (data.invoice_company_name || '').trim();
  const invTax     = (data.invoice_tax_code     || '').trim();
  const invAddr    = (data.invoice_address      || '').trim();
  if (invCompany || invTax || invAddr) {
    doc.font('RB').fontSize(10).text('Thông tin xuất hóa đơn', left);
    doc.font('RI').fontSize(8.5).fillColor('#444').text('(Invoice information)', left, doc.y);
    doc.fillColor('#000');
    doc.moveDown(0.5);
    let iy = doc.y;
    iy = fieldRow(doc, 'Tên công ty (xuất HĐ)', 'Company name (for invoice)', invCompany, left, iy, labelW, usableW - labelW);
    iy = fieldRow(doc, 'MST',                   'Tax code',                   invTax,     left, iy, labelW, usableW - labelW);
    iy = fieldRow(doc, 'Địa chỉ',               'Address',                    invAddr,    left, iy, labelW, usableW - labelW);
    doc.y = iy + 4;
  }

  // Delivery confirmation block — the static certification line always prints,
  // regardless of which delivery fields are filled in.
  doc.font('RB').fontSize(10).text('Đã được giao trong tình trạng hoàn hảo đến:', left);
  doc.font('RI').fontSize(8.5).fillColor('#444')
     .text('(Has been delivered in good order and conditions to)', left, doc.y);
  doc.fillColor('#000');
  doc.moveDown(0.5);

  // Người nhận = name + phone on one line (the form's single free-text field
  // already carries both today; recipient_phone is honoured when sent).
  const receiverLine = [data.recipient_name, data.recipient_phone]
    .map(v => String(v || '').trim()).filter(Boolean).join(' — ');
  // Thời điểm = ngày giao + giờ trả hàng (both preserved, one row).
  const deliveryMoment = [data.delivery_date, data.delivery_time]
    .map(v => String(v || '').trim()).filter(Boolean).join(' ');

  let dy = doc.y;
  dy = fieldRow(doc, 'Công ty',        'Công ty',              data.delivery_company || data.consignee, left, dy, labelW, usableW - labelW);
  dy = fieldRow(doc, 'Tại địa chỉ',    'Address',              data.delivery_address,                   left, dy, labelW, usableW - labelW);
  dy = fieldRow(doc, 'Tên người nhận', 'Name of the receiver', receiverLine,                            left, dy, labelW, usableW - labelW);
  dy = fieldRow(doc, 'Thời điểm',      'Time of Delivery',     deliveryMoment,                          left, dy, labelW, usableW - labelW);
  dy = fieldRowWrap(doc, 'Ghi chú',    'Remarks',              buildRemarksText(data.remarks),          left, dy, labelW, usableW - labelW);

  // Signatures
  doc.y = Math.max(dy + 24, pageH - 150);
  const sigY = doc.y;
  const sigW = (usableW - colGap) / 2;
  doc.font('RB').fontSize(9.5).fillColor('#000')
     .text('ĐẠI DIỆN BÊN GIAO', left, sigY, { width: sigW, align: 'center' });
  doc.font('RB').fontSize(9.5)
     .text('ĐẠI DIỆN BÊN NHẬN', left + sigW + colGap, sigY, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(8).fillColor('#555')
     .text('Ký, ghi rõ họ tên', left, sigY + 14, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(8)
     .text('Ký, ghi rõ họ tên', left + sigW + colGap, sigY + 14, { width: sigW, align: 'center' });
  doc.fillColor('#000');

  // Footer — VN-time stamp (L3: the server runs UTC, a timeZone-less
  // toLocaleString printed −7h on the sheet the driver carries).
  const footerY = pageH - doc.page.margins.bottom - 14;
  const stamp = fmtDtVn(new Date());
  doc.font('RI').fontSize(7).fillColor('#666')
     .text(`${stamp}   page 1/1 by ${data.creator_name || ''}`, left, footerY, { width: usableW, align: 'center' });

  doc.end();
  return doc;
}

// ════════════════════════════════════════════════════════════════════════════
// CP4.2 — Multi-booking BBBG (1 PDF, N pages, 1 page per booking)
// ════════════════════════════════════════════════════════════════════════════

// Vietnam-time datetime rendering (L3) — shared helper in utils/vnTime.js,
// imported under the historical local names so the call sites below stay
// unchanged. fmtDtVn = "DD/MM/YYYY HH:mm" for planned_datetime; fmtHanLenhVn
// branches on import (date only) / export (full datetime) per L19. Storage is
// UTC; the old Date#getHours()/getDate() getters printed −7h on this PDF (the
// sheet the driver carries) and day-shifted the import han_lenh.
const { fmtVnDateTime: fmtDtVn, fmtVnHanLenh: fmtHanLenhVn } = require('../utils/vnTime');
function fmtCostVn(c) {
  if (c == null || c === '') return '—';
  const n = Number(c);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('vi-VN') + 'đ';
}
function fmtWeightsList(containers) {
  // Multi-cont per L20 — emit `25.5 tấn / 26 tấn` for two conts, or `—` when
  // every container is missing weight_tons.
  const parts = (containers || [])
    .map(c => c.weight_tons)
    .filter(w => w != null && w !== '')
    .map(w => {
      const n = Number(w);
      if (!Number.isFinite(n) || n === 0) return null;
      const s = Number.isInteger(n) ? String(n) : n.toString();
      return `${s} tấn`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : '—';
}

// Drawing primitives ─────────────────────────────────────────────────────────

// CP4.2.1 — compact 2-column variant for big info blocks (THÔNG TIN CHUNG /
// HÀNG HÓA / GIAO HÀNG). `fields` is an array of {label, en, value}; rows are
// paired into 2 columns left→right, top→bottom. Per-cell label+sublabel sit
// stacked on the left, value on the right.
function drawTwoColInfoBox(doc, x, y, w, titleVn, titleEn, fields) {
  const titleH = 18;
  doc.rect(x, y, w, titleH).fillAndStroke('#0066b3', '#0066b3');
  doc.fillColor('#fff').font('RB').fontSize(9)
     .text(titleVn, x + 8, y + 4, { width: w - 16, lineBreak: false });
  doc.font('RI').fontSize(7).fillColor('#dbeafe')
     .text(titleEn, x + 8, y + 4, { width: w - 16, align: 'right', lineBreak: false });
  doc.fillColor('#000');

  const cols = 2;
  const colW = w / cols;
  const labelW = 110;
  const rowH = 19;
  const visualRows = Math.ceil(fields.length / cols);
  const bodyH = visualRows * rowH;
  doc.rect(x, y + titleH, w, bodyH).stroke('#999');

  fields.forEach((f, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const cx = x + col * colW;
    const cy = y + titleH + row * rowH;
    if (col > 0) {
      doc.moveTo(cx, cy).lineTo(cx, cy + rowH).strokeColor('#d1d5db').stroke();
    }
    if (row > 0 && col === 0) {
      doc.moveTo(x, cy).lineTo(x + w, cy).strokeColor('#d1d5db').stroke();
    }
    doc.strokeColor('#000');
    doc.font('RB').fontSize(8).fillColor('#374151')
       .text(f.label, cx + 6, cy + 2, { width: labelW - 8, lineBreak: false });
    doc.font('RI').fontSize(6.5).fillColor('#6b7280')
       .text(`(${f.en})`, cx + 6, cy + 11, { width: labelW - 8, lineBreak: false });
    doc.font('R').fontSize(9).fillColor('#000')
       .text(f.value || '—', cx + labelW, cy + 4, { width: colW - labelW - 6, lineBreak: false });
  });
  doc.fillColor('#000');
  return y + titleH + bodyH;
}

function drawBoxedSection(doc, x, y, w, titleVn, titleEn, rows) {
  // Title strip
  const titleH = 18;
  doc.rect(x, y, w, titleH).fillAndStroke('#0066b3', '#0066b3');
  doc.fillColor('#fff').font('RB').fontSize(9)
     .text(titleVn, x + 8, y + 4, { width: w - 16, lineBreak: false });
  doc.font('RI').fontSize(7).fillColor('#dbeafe')
     .text(titleEn, x + 8, y + 4, { width: w - 16, align: 'right', lineBreak: false });
  doc.fillColor('#000');
  // Body rows
  const rowH = 18;
  const bodyH = rowH * rows.length;
  doc.rect(x, y + titleH, w, bodyH).stroke('#999');
  const labelW = 170;
  for (let i = 0; i < rows.length; i++) {
    const ry = y + titleH + i * rowH;
    if (i > 0) doc.moveTo(x, ry).lineTo(x + w, ry).strokeColor('#d1d5db').stroke().strokeColor('#000');
    const [labelVn, labelEn, value] = rows[i];
    doc.font('RB').fontSize(9).fillColor('#374151')
       .text(labelVn, x + 8, ry + 3, { width: labelW - 8, lineBreak: false });
    doc.font('RI').fontSize(7).fillColor('#6b7280')
       .text(`(${labelEn})`, x + 8, ry + 14, { width: labelW - 8, lineBreak: false });
    doc.font('R').fontSize(10).fillColor('#000')
       .text(value || '—', x + labelW, ry + 4, { width: w - labelW - 8, lineBreak: false });
  }
  doc.fillColor('#000');
  return y + titleH + bodyH;
}

function drawPageHeader(doc, bookingCode, todayDate) {
  // CP4.2.1 — Slim header. Job code / customer name / shipping line moved
  // into the "THÔNG TIN CHUNG" boxed section below so the page reads more
  // like the legacy single-BBBG. The header carries only the SLB letterhead
  // and the BBBG-level identifiers (booking code + issue date).
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableW = right - left;

  const headerY = doc.y;
  const logoPath = LOGO_CANDIDATES.find(fileExists) || null;
  if (logoPath) {
    try { doc.image(logoPath, left, headerY, { width: 80 }); } catch { /* skip */ }
  }
  const txtX = left + (logoPath ? 96 : 0);
  doc.font('RB').fontSize(11).fillColor('#0066b3')
     .text('CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB', txtX, headerY);
  doc.font('R').fontSize(8).fillColor('#000');
  // CP4.2.3 — real address is long; render at 7pt with an explicit width that
  // stops short of the right-aligned meta block ("Mã KH:" / "Ngày:") to avoid
  // horizontal collision. lineBreak:false keeps it on one line.
  doc.fontSize(7).text(
    'Số 18/100 Khu dân cư Tasa, Phường Đông Hải, Thành phố Hải Phòng, Việt Nam',
    txtX, doc.y + 1,
    { width: usableW - 96 - 120, lineBreak: false }
  );
  doc.fontSize(8).text('Tel: +84 931 334 331   |   Email: info@slbglobal.com', txtX, doc.y + 1);
  // Right-side meta — booking code + date only.
  doc.font('RB').fontSize(9).text(`Mã KH: ${bookingCode || '—'}`,
    left, headerY, { width: usableW, align: 'right' });
  doc.font('R').fontSize(8).text(`Ngày: ${todayDate}`,
    left, headerY + 14, { width: usableW, align: 'right' });
  doc.y = Math.max(doc.y, headerY + (logoPath ? 60 : 44));

  // Title
  doc.moveDown(0.3);
  doc.font('RB').fontSize(16).fillColor('#000')
     .text('BIÊN BẢN BÀN GIAO', { align: 'center' });
  doc.font('RI').fontSize(9).fillColor('#444')
     .text('(Handover Record / Proof of Delivery)', { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.3);
}

function drawSignatures(doc) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableW = right - left;
  const pageH = doc.page.height;
  const sigY = Math.max(doc.y + 8, pageH - 130);
  const colGap = 12;
  const sigW = (usableW - colGap) / 2;
  // Box headers
  doc.rect(left, sigY, sigW, 22).fillAndStroke('#f3f4f6', '#999');
  doc.rect(left + sigW + colGap, sigY, sigW, 22).fillAndStroke('#f3f4f6', '#999');
  doc.fillColor('#000').font('RB').fontSize(9)
     .text('ĐẠI DIỆN GIAO', left, sigY + 4, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(7).fillColor('#555')
     .text('(Deliverer)', left, sigY + 14, { width: sigW, align: 'center' });
  doc.font('RB').fontSize(9).fillColor('#000')
     .text('ĐẠI DIỆN NHẬN HÀNG', left + sigW + colGap, sigY + 4, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(7).fillColor('#555')
     .text('(Receiver Representative)', left + sigW + colGap, sigY + 14, { width: sigW, align: 'center' });
  doc.fillColor('#000');
  // Sign area
  const signAreaH = 60;
  doc.rect(left, sigY + 22, sigW, signAreaH).stroke('#999');
  doc.rect(left + sigW + colGap, sigY + 22, sigW, signAreaH).stroke('#999');
  doc.font('RI').fontSize(8).fillColor('#888')
     .text('Ký, ghi rõ họ tên', left, sigY + 22 + signAreaH - 14,
       { width: sigW, align: 'center' });
  doc.text('Ký, ghi rõ họ tên', left + sigW + colGap, sigY + 22 + signAreaH - 14,
       { width: sigW, align: 'center' });
  doc.fillColor('#000');
}

function drawPageFooter(doc, pageIdx, pageTotal, creatorName) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableW = right - left;
  const footerY = doc.page.height - doc.page.margins.bottom - 12;
  const stamp = new Date().toLocaleString('vi-VN', { hour12: false });
  doc.font('RI').fontSize(7).fillColor('#666')
     .text(`Generated ${stamp}   |   page ${pageIdx}/${pageTotal}   |   by ${creatorName || ''}`,
       left, footerY, { width: usableW, align: 'center' });
  doc.fillColor('#000');
}

// CP4.3 — Per-booking page renderer. Shared between the multi-booking and
// single-booking entrypoints so layout stays in lockstep. ctx must carry
// the job, the booking, the pre-computed invoice/cargo totals, and the
// page index/total for the footer "page N/M" stamp.
function renderBookingPage(doc, {
  job, booking: b, today, inv, totalWeightStr, weightUnit,
  pageIdx, pageTotal, creatorName,
}) {
  drawPageHeader(doc, b.booking_code, today);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usableW = right - left;

  let y = doc.y;
  y = drawTwoColInfoBox(doc, left, y, usableW,
    'THÔNG TIN CHUNG', 'General Info', [
      { label: 'Số lô hàng',     en: 'Job ID',         value: job.job_code },
      { label: 'Ngày phát hành', en: 'Date',           value: today },
      { label: 'Người gửi',      en: 'Shipper',        value: job.shipper },
      { label: 'Người nhận',     en: 'Consignee',      value: job.customer_name },
      { label: 'Tàu',            en: 'Vessel',         value: job.vessel },
      { label: 'Chuyến',         en: 'Voy.',           value: job.voy },
      { label: 'Từ',             en: 'From',           value: job.pol },
      { label: 'Đến cảng',       en: 'Terminal',       value: job.pod },
      { label: 'Hãng tàu',       en: 'Shipping line',  value: job.shipping_line },
      { label: 'Hạn lệnh',       en: 'Cutoff',         value: fmtHanLenhVn(job.han_lenh, job.import_export) },
      { label: 'Vận đơn phụ',    en: 'H-B/L',          value: job.hbl_no },
      { label: 'Vận đơn chính',  en: 'M-B/L',          value: job.mbl_no },
    ]);
  y += 6;

  const conts = Array.isArray(b.containers) ? b.containers : [];
  const contRows = [];
  if (conts.length === 0) {
    contRows.push(['Số container', 'Container No.', '—']);
    contRows.push(['Loại',         'Type',          '—']);
    contRows.push(['Seal',         'Seal No.',      '—']);
    contRows.push(['Trọng lượng',  'Weight',        '—']);
  } else {
    conts.forEach((c, i) => {
      const prefix = conts.length > 1 ? `Cont ${i + 1} — ` : '';
      contRows.push([prefix + 'Số container', 'Container No.', c.cont_number || '(chưa số)']);
      contRows.push([prefix + 'Loại',         'Type',          c.cont_type   || '—']);
      contRows.push([prefix + 'Seal',         'Seal No.',      c.seal_number || '—']);
      const w = c.weight_tons;
      const wStr = (w != null && w !== '')
        ? `${Number(w).toLocaleString('vi-VN')} TONS`
        : '—';
      contRows.push([prefix + 'Trọng lượng',  'Weight',        wStr]);
    });
  }
  y = drawBoxedSection(doc, left, y, usableW,
    'CONTAINER', 'Container Info', contRows);
  y += 6;

  y = drawTwoColInfoBox(doc, left, y, usableW,
    'HÀNG HÓA', 'Cargo Info', [
      { label: 'Tên hàng hóa', en: 'Description', value: job.goods_description || 'AS PER BILL' },
      { label: 'Trọng lượng', en: 'Weight',     value: totalWeightStr },
      { label: 'Đơn vị',      en: 'Unit',       value: weightUnit },
      { label: 'Số kiện',     en: 'Pieces',     value: job.so_kien != null ? String(job.so_kien) : '—' },
    ]);
  y += 6;

  y = drawTwoColInfoBox(doc, left, y, usableW,
    'THÔNG TIN GIAO HÀNG', 'Delivery Info', [
      { label: 'Ngày giờ giao',          en: 'Delivery time',     value: fmtDtVn(b.planned_datetime) },
      { label: 'Địa điểm giao',          en: 'Delivery location', value: b.delivery_location },
      { label: 'Người liên hệ tại kho',  en: 'Warehouse contact', value: b.receiver_name },
      { label: 'SĐT',                    en: 'Phone',             value: b.receiver_phone },
    ]);
  y += 6;

  if (inv) {
    y = drawBoxedSection(doc, left, y, usableW,
      'THÔNG TIN XUẤT HÓA ĐƠN NÂNG HẠ', 'Lift/Drop Invoice', [
        ['Tên công ty', 'Company',  inv.company],
        ['MST',         'Tax code', inv.tax],
        ['Địa chỉ',     'Address',  inv.address],
      ]);
    y += 6;
  }

  doc.y = y;
  if (b.note || b.notes) {
    doc.font('RB').fontSize(9).fillColor('#000')
       .text('Ghi chú: ', left, doc.y, { continued: true })
       .font('R').text(String(b.note || b.notes));
  }
  if (b.bbbg_note) {
    doc.font('RB').fontSize(9).fillColor('#d97706')
       .text('⚠️ Lưu ý cho tài xế: ', { continued: true })
       .font('R').fillColor('#b45309').text(String(b.bbbg_note));
    doc.fillColor('#000');
  }

  drawSignatures(doc);
  drawPageFooter(doc, pageIdx, pageTotal, creatorName);
}

// Per-job context (invoice + cargo totals) — same for every page of a job.
function buildPageCtx({ job, invoiceInfo }) {
  const invSource = invoiceInfo?.type === 'slb'
    ? { ...invoiceInfo, ...SLB_INVOICE_INFO }
    : invoiceInfo;
  const inv = invSource && invSource.company && invSource.tax && invSource.address
    ? invSource : null;
  const isFcl = (job.cargo_type || 'fcl') === 'fcl';
  const totalWeight = isFcl ? job.tons : job.kg;
  const weightUnit  = isFcl ? 'TONS' : 'KGS';
  const totalWeightStr = (totalWeight != null && totalWeight !== '')
    ? `${Number(totalWeight).toLocaleString('vi-VN')} ${weightUnit}`
    : '—';
  const today = new Date().toLocaleDateString('vi-VN');
  return { today, inv, totalWeightStr, weightUnit };
}

// Public entry ───────────────────────────────────────────────────────────────

async function generateMultiBookingBBBG({
  jobId, transportCompanyId, bookingIds, invoiceInfo, creatorName,
}) {
  if (!Number.isFinite(jobId)) throw new Error('jobId không hợp lệ');
  if (!Number.isFinite(transportCompanyId)) throw new Error('transportCompanyId không hợp lệ');
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    throw new Error('bookingIds rỗng');
  }

  // 1. Job — CP4.2.1 pulls the full manifest/cargo set used by the redesigned
  // BBBG layout. The 5 shipping-document columns (shipper/vessel/voy/
  // shipping_line/goods_description) are nullable; the renderer falls back to
  // an em-dash when they're blank.
  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name, han_lenh, import_export,
            pol, pod, hbl_no, mbl_no,
            cargo_type, tons, kg, so_kien,
            shipper, vessel, voy, shipping_line, goods_description
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  // 2. Transport company — kept as a scoping check only. CP4.2.1 removes the
  // "THÔNG TIN VẬN CHUYỂN" section because BBBG goes to the customer for
  // signature and carrier identity is internal; tc.name is therefore NOT
  // rendered on the page. The lookup still happens so a deleted/wrong carrier
  // surfaces the right error before we waste time generating pages.
  const { rows: [tc] } = await db.query(
    `SELECT id, name FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
    [transportCompanyId]
  );
  if (!tc) throw new Error('Không tìm thấy vận tải');

  // 3. Bookings + containers (M:N per L20). Scope by both id list AND
  // job_id + transport_company_id so a stray id from another job can't leak
  // through.
  const { rows: bookings } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.planned_datetime, tb.delivery_location,
           tb.cost, tb.note, tb.notes, tb.vehicle_number,
           tb.receiver_name, tb.receiver_phone, tb.bbbg_note,
           COALESCE((
             SELECT json_agg(json_build_object(
               'id', jc.id,
               'cont_number', jc.cont_number,
               'cont_type', jc.cont_type,
               'seal_number', jc.seal_number,
               'weight_tons', jc.weight_tons
             ) ORDER BY jc.id)
             FROM truck_booking_containers tbc
             JOIN job_containers jc ON jc.id = tbc.container_id
             WHERE tbc.booking_id = tb.id
           ), '[]'::json) AS containers
      FROM truck_bookings tb
     WHERE tb.id = ANY($1::int[])
       AND tb.job_id = $2
       AND tb.transport_company_id = $3
       AND tb.deleted_at IS NULL
     ORDER BY tb.planned_datetime ASC NULLS LAST, tb.id ASC
  `, [bookingIds, jobId, transportCompanyId]);

  if (bookings.length === 0) {
    throw new Error('Không tìm thấy booking nào khớp');
  }

  // 4. Render — collect into a Buffer. CP4.3: per-page rendering moved into
  // renderBookingPage so the single-booking entrypoint can share it.
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ctx = buildPageCtx({ job, invoiceInfo });
    const pageTotal = bookings.length;
    bookings.forEach((b, idx) => {
      if (idx > 0) doc.addPage({ size: 'A4', margin: 36 });
      renderBookingPage(doc, {
        ...ctx, job, booking: b,
        pageIdx: idx + 1, pageTotal, creatorName,
      });
    });

    doc.end();
  });
}

// CP4.3 — Single-booking BBBG generator used by sendPlanningEmail to attach
// one PDF per booking. Scope-validates that bookingId belongs to BOTH the
// supplied job_id AND transport_company_id so a stray id from another job
// can never leak into a transport's mail. Returns a 1-page PDF Buffer.
async function generateSingleBookingBBBG({
  jobId, transportCompanyId, bookingId, invoiceInfo, creatorName,
}) {
  if (!Number.isFinite(jobId))            throw new Error('jobId không hợp lệ');
  if (!Number.isFinite(transportCompanyId)) throw new Error('transportCompanyId không hợp lệ');
  if (!Number.isFinite(bookingId))        throw new Error('bookingId không hợp lệ');

  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name, han_lenh, import_export,
            pol, pod, hbl_no, mbl_no,
            cargo_type, tons, kg, so_kien,
            shipper, vessel, voy, shipping_line, goods_description
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  const { rows: [tc] } = await db.query(
    `SELECT id FROM transport_companies WHERE id = $1 AND deleted_at IS NULL`,
    [transportCompanyId]
  );
  if (!tc) throw new Error('Không tìm thấy vận tải');

  // Single booking scoped by (id, job_id, transport_company_id) so we catch
  // cross-job and cross-transport mismatches at load time.
  const { rows: bks } = await db.query(`
    SELECT tb.id, tb.booking_code, tb.planned_datetime, tb.delivery_location,
           tb.cost, tb.note, tb.notes, tb.vehicle_number,
           tb.receiver_name, tb.receiver_phone, tb.bbbg_note,
           COALESCE((
             SELECT json_agg(json_build_object(
               'id', jc.id,
               'cont_number', jc.cont_number,
               'cont_type', jc.cont_type,
               'seal_number', jc.seal_number,
               'weight_tons', jc.weight_tons
             ) ORDER BY jc.id)
             FROM truck_booking_containers tbc
             JOIN job_containers jc ON jc.id = tbc.container_id
             WHERE tbc.booking_id = tb.id
           ), '[]'::json) AS containers
      FROM truck_bookings tb
     WHERE tb.id = $1 AND tb.job_id = $2 AND tb.transport_company_id = $3
       AND tb.deleted_at IS NULL
  `, [bookingId, jobId, transportCompanyId]);
  if (bks.length === 0) {
    throw new Error('Booking không thuộc job/vận tải này hoặc đã bị xóa');
  }
  const booking = bks[0];

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ctx = buildPageCtx({ job, invoiceInfo });
    renderBookingPage(doc, {
      ...ctx, job, booking,
      pageIdx: 1, pageTotal: 1, creatorName,
    });

    doc.end();
  });
}

module.exports = { buildBbbgPdf, generateMultiBookingBBBG, generateSingleBookingBBBG };
