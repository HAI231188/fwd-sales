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

// opts.bold  — render the VALUE in bold (invoice-info block per the target).
// opts.rowH  — row pitch; the delivery block uses a tighter one than the
//              shipment grid so its five fields read as one compact group.
function fieldRow(doc, vn, en, value, x, y, labelWidth, valueWidth, opts = {}) {
  const { bold = false, rowH = 22 } = opts;
  bilingualLabel(doc, vn, en, x, y, labelWidth);
  doc.font(bold ? 'RB' : 'R').fontSize(10)
     .text(value || '', x + labelWidth, y + 2, { width: valueWidth, lineBreak: false });
  doc.font('R');
  return y + rowH;
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

// Ghi chú (Remarks) prints ONLY the real operator note — the per-booking
// "Ghi chú BBBG" (truck_bookings.bbbg_note, entered in ReceiverInfoModal) or
// the manual form's remarks. It must NOT restate the invoice entity: the
// "Thông tin xuất hóa đơn" block above already prints whichever entity the
// user picked in InvoiceRecipientModal (customer / SLB / custom). A previous
// revision prepended a hardcoded SLB block here, which printed the invoice
// info twice AND contradicted the user's pick. Empty note => empty cell.

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

// ─── THE single BBBG page renderer ──────────────────────────────────────────
// Draws one classic (KSVINA-style) BBBG page onto `doc` from a FLAT data
// object. Every entrypoint funnels through here — the manual BBBGModal export
// (buildBbbgPdf), the "Xem BBBG" preview (generateMultiBookingBBBG) and the
// carrier-mail attachment (generateSingleBookingBBBG) — so the three can never
// drift apart again (L30). Optional slots (booking_code, shipping_line,
// han_lenh) render only when supplied, so the manual export stays exactly the
// target layout while the per-booking pages keep their extra identifiers.
function renderClassicBbbg(doc, data, { pageIdx = 1, pageTotal = 1 } = {}) {
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
  // Optional — per-booking pages carry the booking code; the manual export
  // does not send one, so the line simply does not appear there.
  if (data.booking_code) {
    doc.text(`Mã KH (Booking): ${data.booking_code}`, left, metaY + 24, { width: usableW, align: 'right' });
    doc.y = metaY + 42;
  } else {
    doc.y = metaY + 30;
  }

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

  // Slightly tighter pitch than the default 22 so a long auto-expanded table
  // still leaves room for the signature block on one page.
  const SHIP = { rowH: 20 };
  let leftY = doc.y;
  let rightY = doc.y;

  leftY  = fieldRow(doc, 'Người gửi',     'Shipper',   data.shipper,   left,                 leftY,  labelW, valueW, SHIP);
  rightY = fieldRow(doc, 'Người nhận',    'Consignee', data.consignee, left + colW + colGap, rightY, labelW, valueW, SHIP);

  leftY  = fieldRow(doc, 'Tàu',           'Vessel',    data.vessel,    left,                 leftY,  labelW, valueW, SHIP);
  rightY = fieldRow(doc, 'Chuyến',        'Voy.',      data.voy,       left + colW + colGap, rightY, labelW, valueW, SHIP);

  leftY  = fieldRow(doc, 'Từ',            'From',      data.from_,     left,                 leftY,  labelW, valueW, SHIP);
  rightY = fieldRow(doc, 'Đến cảng',      'Terminal',  data.terminal,  left + colW + colGap, rightY, labelW, valueW, SHIP);

  leftY  = fieldRow(doc, 'Vận đơn phụ',   'H-B/L',     data.hbl_no,    left,                 leftY,  labelW, valueW, SHIP);
  rightY = fieldRow(doc, 'Vận đơn chính', 'M-B/L',     data.mbl_no,    left + colW + colGap, rightY, labelW, valueW, SHIP);

  // Optional 5th row — only the per-booking pages supply these (the old
  // "THÔNG TIN CHUNG" box carried them; they must not be lost in the redesign).
  if (data.shipping_line) {
    leftY  = fieldRow(doc, 'Hãng tàu',    'Shipping line', data.shipping_line, left, leftY, labelW, valueW, SHIP);
  }
  if (data.han_lenh_str) {
    rightY = fieldRow(doc, 'Hạn lệnh',    'Cutoff',        data.han_lenh_str,  left + colW + colGap, rightY, labelW, valueW, SHIP);
  }

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
  // Column x-offsets, used for both the header separators and every body row.
  const colX = colWidths.reduce((acc, w) => { acc.push(acc[acc.length - 1] + w); return acc; }, [left]);
  // Draw the vertical cell separators of one band (header or body row) so
  // EVERY cell is boxed, matching the target's ruled table.
  const drawColSeparators = (yTop, h) => {
    for (let i = 1; i < colX.length - 1; i++) {
      doc.moveTo(colX[i], yTop).lineTo(colX[i], yTop + h).strokeColor('#999').lineWidth(0.7).stroke();
    }
    doc.strokeColor('#000').lineWidth(1);
  };

  doc.rect(left, tableTop, usableW, headerH).fillAndStroke('#f3f4f6', '#000');
  doc.fillColor('#000');
  drawColSeparators(tableTop, headerH);
  for (let i = 0; i < headers.length; i++) {
    const w = colWidths[i];
    const cx = colX[i];
    doc.font('RB').fontSize(8).text(headers[i].vn, cx + 4, tableTop + 4, { width: w - 8, align: 'center' });
    doc.font('RI').fontSize(7).fillColor('#555').text(`(${headers[i].en})`, cx + 4, tableTop + 16, { width: w - 8, align: 'center' });
    doc.fillColor('#000');
  }

  // One row per container (the LCL / no-container case renders a single
  // whole-lot row). Row 0 carries the job-level weight/measurement when the
  // container itself has none, so the totals are never lost.
  const hasConts = !!(data.containers && data.containers.length);
  const rows = hasConts
    ? data.containers
    : [{ cont_number: '', cont_type: '', seal_number: '' }];
  let rowY = tableTop + headerH;
  const MIN_ROW_H = 22;
  const CELL_PAD = 4;
  const jobMeasure = jobMeasureStr(data);
  // Rows AUTO-EXPAND: a long "Tên hàng hóa" (several cartons listed across
  // multiple lines) grows the whole row, and the cell borders wrap the grown
  // height. Never hardcode the row height — measure the tallest cell first.
  const measureH = (text, font, size, w) => {
    if (!text) return 0;
    doc.font(font).fontSize(size);
    return doc.heightOfString(String(text), { width: w - CELL_PAD * 2 });
  };
  // Bottom limit for the table on this page — leaves room for the signature
  // block + footer. A table longer than this continues on a fresh page.
  const tableBottomLimit = pageH - doc.page.margins.bottom - 120;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cont = [r.cont_number || '', r.cont_type ? `(${r.cont_type})` : ''].filter(Boolean).join(' ');
    const seal = r.seal_number ? `Seal: ${r.seal_number}` : '';
    // Quantity: 1 per container row; the container-less whole-lot row shows the
    // piece count when we have one.
    const qtyCell = hasConts
      ? '1'
      : (data.so_kien != null && data.so_kien !== '' ? `${data.so_kien} kiện` : '1');
    const descCell = rowDescription(r, data);
    const ownMeasure = contMeasureStr(r);
    const measureCell = ownMeasure || (i === 0 ? jobMeasure : '');

    const contH = measureH(cont, 'R', 9, colWidths[0]) + (seal ? measureH(seal, 'RI', 6.5, colWidths[0]) + 2 : 0);
    const rowHeight = Math.max(
      MIN_ROW_H,
      contH + 10,
      measureH(qtyCell, 'R', 9, colWidths[1]) + 12,
      measureH(descCell, 'R', 9, colWidths[2]) + 12,
      measureH(measureCell, 'R', 9, colWidths[3]) + 12,
    );

    // Page break when this row would run past the usable area.
    if (rowY + rowHeight > tableBottomLimit) {
      doc.addPage({ size: 'A4', margin: 36 });
      rowY = doc.page.margins.top;
      doc.rect(left, rowY, usableW, headerH).fillAndStroke('#f3f4f6', '#000');
      doc.fillColor('#000');
      drawColSeparators(rowY, headerH);
      for (let h = 0; h < headers.length; h++) {
        doc.font('RB').fontSize(8).text(headers[h].vn, colX[h] + 4, rowY + 4, { width: colWidths[h] - 8, align: 'center' });
        doc.font('RI').fontSize(7).fillColor('#555').text(`(${headers[h].en})`, colX[h] + 4, rowY + 16, { width: colWidths[h] - 8, align: 'center' });
        doc.fillColor('#000');
      }
      rowY += headerH;
    }

    doc.rect(left, rowY, usableW, rowHeight).strokeColor('#999').lineWidth(0.7).stroke();
    doc.strokeColor('#000').lineWidth(1);
    drawColSeparators(rowY, rowHeight);

    doc.font('R').fontSize(9).fillColor('#000')
       .text(cont, colX[0] + CELL_PAD, rowY + (seal ? 3 : 6), { width: colWidths[0] - CELL_PAD * 2 });
    if (seal) {
      doc.font('RI').fontSize(6.5).fillColor('#555')
         .text(seal, colX[0] + CELL_PAD, rowY + 3 + measureH(cont, 'R', 9, colWidths[0]),
           { width: colWidths[0] - CELL_PAD * 2 });
      doc.fillColor('#000');
    }
    doc.font('R').fontSize(9)
       .text(qtyCell, colX[1] + CELL_PAD, rowY + 6, { width: colWidths[1] - CELL_PAD * 2, align: 'center' });
    doc.text(descCell, colX[2] + CELL_PAD, rowY + 6, { width: colWidths[2] - CELL_PAD * 2, align: 'center' });
    doc.text(measureCell, colX[3] + CELL_PAD, rowY + 6, { width: colWidths[3] - CELL_PAD * 2, align: 'center' });
    rowY += rowHeight;
  }

  // Totals strip — only when per-container figures displaced the job-level
  // total from row 0, so the sheet always states the shipment total once.
  const row0HadOwnMeasure = !!contMeasureStr(rows[0] || {});
  if (jobMeasure && row0HadOwnMeasure) {
    doc.rect(left, rowY, usableW, MIN_ROW_H).strokeColor('#999').lineWidth(0.7).stroke();
    doc.strokeColor('#000').lineWidth(1);
    doc.moveTo(colX[3], rowY).lineTo(colX[3], rowY + MIN_ROW_H).strokeColor('#999').lineWidth(0.7).stroke();
    doc.strokeColor('#000').lineWidth(1);
    doc.font('RB').fontSize(8.5).fillColor('#000').text('TỔNG (Total)', left + CELL_PAD, rowY + 7,
      { width: colWidths[0] + colWidths[1] + colWidths[2] - 8, lineBreak: false });
    doc.font('R').fontSize(9).text(jobMeasure, colX[3] + CELL_PAD, rowY + 7,
      { width: colWidths[3] - CELL_PAD * 2, align: 'center', lineBreak: false });
    rowY += MIN_ROW_H;
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
    // Values BOLD — this block is the legally-relevant entity on the sheet.
    // The DATA is untouched: invCompany/invTax/invAddr already reflect whatever
    // the user picked in InvoiceRecipientModal (customer / SLB / custom).
    let iy = doc.y;
    const invOpts = { bold: true, rowH: 20 };
    iy = fieldRow(doc, 'Tên công ty (xuất HĐ)', 'Company name (for invoice)', invCompany, left, iy, labelW, usableW - labelW, invOpts);
    iy = fieldRow(doc, 'MST',                   'Tax code',                   invTax,     left, iy, labelW, usableW - labelW, invOpts);
    iy = fieldRow(doc, 'Địa chỉ',               'Address',                    invAddr,    left, iy, labelW, usableW - labelW, invOpts);
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

  // Compact pitch (19 vs 22) so the five delivery fields read as one tight
  // group, matching the target's stacked block.
  const DLV = { rowH: 19 };
  let dy = doc.y;
  dy = fieldRow(doc, 'Công ty',        'Công ty',              data.delivery_company || data.consignee, left, dy, labelW, usableW - labelW, DLV);
  dy = fieldRow(doc, 'Tại địa chỉ',    'Address',              data.delivery_address,                   left, dy, labelW, usableW - labelW, DLV);
  dy = fieldRow(doc, 'Tên người nhận', 'Name of the receiver', receiverLine,                            left, dy, labelW, usableW - labelW, DLV);
  dy = fieldRow(doc, 'Thời điểm',      'Time of Delivery',     deliveryMoment,                          left, dy, labelW, usableW - labelW, DLV);
  // Remarks = the real note ONLY (bbbg_note / manual remarks). No hardcoded
  // invoice text — the invoice block above owns that, per the user's pick.
  dy = fieldRowWrap(doc, 'Ghi chú',    'Remarks',              String(data.remarks || '').trim(),       left, dy, labelW, usableW - labelW);

  // Signatures — anchored near the page bottom, but never allowed to run into
  // the footer when a long Ghi chú pushes the block down (the booking pages
  // append booking notes + the driver warning under the invoice block).
  // When a long Ghi chú (or an auto-expanded table) has pushed the content
  // past that point, the block moves to a fresh page rather than overlapping
  // — clamping it upward would draw the signatures on top of the remarks.
  const sigYMax = pageH - doc.page.margins.bottom - 14 - 34;
  let sigY;
  if (dy + 24 > sigYMax) {
    doc.addPage({ size: 'A4', margin: 36 });
    sigY = doc.page.margins.top;
  } else {
    sigY = Math.max(dy + 24, pageH - 150);
  }
  doc.y = sigY;
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
     .text(`${stamp}   page ${pageIdx}/${pageTotal} by ${data.creator_name || ''}`,
       left, footerY, { width: usableW, align: 'center' });
  doc.fillColor('#000');
}

// Manual BBBGModal export — streams a 1-page PDF. Input contract unchanged.
function buildBbbgPdf(data) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  registerFonts(doc);
  renderClassicBbbg(doc, data);
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
const { fmtVnDateTime: fmtDtVn, fmtVnHanLenh: fmtHanLenhVn, fmtVnDate } = require('../utils/vnTime');
// The old colored-block "Design B" drawing helpers (drawTwoColInfoBox /
// drawBoxedSection / drawPageHeader / drawSignatures / drawPageFooter) and the
// unused fmtCostVn / fmtWeightsList formatters were removed on 2026-07-22:
// every BBBG entrypoint now renders through renderClassicBbbg, so a second
// layout can no longer drift out of sync with the first (L24/L30).
// CP4.3 — Per-booking page renderer. Maps the job + booking rows onto the FLAT
// shape renderClassicBbbg expects, so the "Xem BBBG" preview and the emailed
// attachment render the SAME classic layout as the manual export. (Before the
// 2026-07-22 redesign this drew its own colored-block layout — the two designs
// drifted and the DD-facing preview kept the old look after the manual export
// was redesigned. One renderer now, per L30.)
function renderBookingPage(doc, {
  job, booking: b, today, inv, totalWeightStr, weightUnit,
  pageIdx, pageTotal, creatorName,
}) {
  const conts = Array.isArray(b.containers) ? b.containers : [];
  const isFcl = (job.cargo_type || 'fcl') === 'fcl';

  // Booking-level notes (b.note/b.notes) and the driver warning (b.bbbg_note)
  // used to be free-standing lines under the boxes — they now ride along in
  // Ghi chú, below the standing SLB invoice block, so neither is lost.
  const remarkParts = [];
  if (b.note || b.notes)  remarkParts.push(String(b.note || b.notes));
  if (b.bbbg_note)        remarkParts.push(`⚠️ Lưu ý cho tài xế: ${String(b.bbbg_note)}`);

  renderClassicBbbg(doc, {
    job_code:   job.job_code,
    today_date: today,
    booking_code: b.booking_code,
    shipper:    job.shipper,
    consignee:  job.customer_name,
    vessel:     job.vessel,
    voy:        job.voy,
    from_:      job.pol,
    terminal:   job.pod,
    hbl_no:     job.hbl_no,
    mbl_no:     job.mbl_no,
    shipping_line: job.shipping_line,
    han_lenh_str:  job.han_lenh ? fmtHanLenhVn(job.han_lenh, job.import_export) : '',
    // Containers of THIS booking (L20 M:N) — the classic table loops them.
    containers: conts,
    description:  job.goods_description,          // '' -> AS PER BILL in the cell
    weight_value: isFcl ? job.tons : job.kg,
    weight_unit:  weightUnit,
    cbm:          job.cbm,
    so_kien:      job.so_kien,
    // Lift/drop invoice info (may be SLB's own per InvoiceRecipientModal).
    invoice_company_name: inv ? inv.company : '',
    invoice_tax_code:     inv ? inv.tax     : '',
    invoice_address:      inv ? inv.address : '',
    delivery_company: job.customer_name,
    delivery_address: b.delivery_location,
    recipient_name:   b.receiver_name,
    recipient_phone:  b.receiver_phone,
    delivery_date:    fmtDtVn(b.planned_datetime, ''),   // already "DD/MM/YYYY HH:mm"
    delivery_time:    '',
    remarks:          remarkParts.join('\n'),
    creator_name:     creatorName,
  }, { pageIdx, pageTotal });
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
  // L3 — VN-anchored issue date. A timeZone-less toLocaleDateString prints the
  // UTC day on Railway, which flips a day early every evening after 17:00 VN.
  const today = fmtVnDate(new Date());
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
            cargo_type, tons, kg, so_kien, cbm,
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
            cargo_type, tons, kg, so_kien, cbm,
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
