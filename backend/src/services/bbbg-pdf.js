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
// CP4.2.2 — English variant used when the caller picks "SLB Logistics" in
// InvoiceRecipientModal. The BBBG goes to the customer for signature and is
// an international document; the mail body keeps the Vietnamese variant.
const { SLB_INVOICE_INFO_EN } = require('./email-sender');

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

function buildBbbgPdf(data) {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  registerFonts(doc);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = doc.page.margins.left;
  const right = pageW - doc.page.margins.right;
  const usableW = right - left;

  // Header
  const headerY = doc.y;
  const logoPath = LOGO_CANDIDATES.find(fileExists) || null;
  const hasLogo = !!logoPath;
  if (hasLogo) {
    try { doc.image(logoPath, left, headerY, { width: 90 }); } catch { /* skip */ }
  }
  const companyX = left + (hasLogo ? 110 : 0);
  doc.font('RB').fontSize(11).fillColor('#0066b3').text('SLB GLOBAL LOGISTICS CO., LTD.', companyX, headerY);
  doc.font('R').fontSize(8).fillColor('#000');
  doc.text('Address: Floor 5, SLB Building, Hanoi, Vietnam', companyX, doc.y + 1);
  doc.text('Tel: +84 24 1234 5678   |   Hotline: 0900 123 456', companyX, doc.y + 1);
  doc.text('Website: www.slbglobal.com   |   Email: info@slbglobal.com', companyX, doc.y + 1);
  doc.y = Math.max(doc.y, headerY + (hasLogo ? 70 : 50));

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

  const rows = (data.containers && data.containers.length)
    ? data.containers
    : [{ cont_number: '', cont_type: '', seal_number: '' }];
  let rowY = tableTop + headerH;
  const rowH = 22;
  const totalQty = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    doc.rect(left, rowY, usableW, rowH).stroke('#999');
    let x2 = left;
    const cont = [r.cont_number || '', r.cont_type ? `(${r.cont_type})` : ''].filter(Boolean).join(' ');
    doc.font('R').fontSize(9).text(cont, x2 + 4, rowY + 6, { width: colWidths[0] - 8, lineBreak: false });
    x2 += colWidths[0];
    doc.text(i === 0 ? `${totalQty}` : '', x2 + 4, rowY + 6, { width: colWidths[1] - 8, align: 'center', lineBreak: false });
    x2 += colWidths[1];
    doc.text(i === 0 ? (data.description || 'AS PER BILL') : '', x2 + 4, rowY + 6, { width: colWidths[2] - 8, align: 'center', lineBreak: false });
    x2 += colWidths[2];
    let weightCell = '';
    if (i === 0) {
      const parts = [];
      if (data.weight_value != null && data.weight_value !== '') parts.push(`${fmtNumber(data.weight_value)} ${data.weight_unit || ''}`.trim());
      if (data.so_kien != null && data.so_kien !== '') parts.push(`${data.so_kien} kiện`);
      weightCell = parts.join(' / ');
    }
    doc.text(weightCell, x2 + 4, rowY + 6, { width: colWidths[3] - 8, align: 'center', lineBreak: false });
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

  // Delivery confirmation block
  doc.font('RB').fontSize(10).text('Đã được giao trong tình trạng hoàn hảo đến:', left);
  doc.font('RI').fontSize(8.5).fillColor('#444').text('(Has been delivered in perfect condition to:)', left, doc.y);
  doc.fillColor('#000');
  doc.moveDown(0.5);

  let dy = doc.y;
  dy = fieldRow(doc, 'Công ty',        'Company',        data.delivery_company || data.consignee, left, dy, labelW, usableW - labelW);
  dy = fieldRow(doc, 'Tại địa chỉ',    'At address',     data.delivery_address,                   left, dy, labelW, usableW - labelW);
  dy = fieldRow(doc, 'Tên người nhận', 'Recipient name', data.recipient_name,                     left, dy, labelW, usableW - labelW);

  bilingualLabel(doc, 'Thời điểm', 'Time', left, dy, labelW);
  doc.font('R').fontSize(10).text(data.delivery_time || '', left + labelW, dy + 2, { width: colW - labelW, lineBreak: false });
  bilingualLabel(doc, 'Ngày', 'Date', left + colW + colGap, dy, labelW);
  doc.font('R').fontSize(10).text(data.delivery_date || '', left + colW + colGap + labelW, dy + 2, { width: colW - labelW, lineBreak: false });
  dy += 22;

  dy = fieldRow(doc, 'Ghi chú', 'Remarks', data.remarks, left, dy, labelW, usableW - labelW);

  // Signatures
  doc.y = Math.max(dy + 30, pageH - 140);
  const sigY = doc.y;
  const sigW = (usableW - colGap) / 2;
  doc.font('RB').fontSize(9).text('NGƯỜI GIAO HÀNG', left, sigY, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(8).fillColor('#444').text('(Deliverer)', left, sigY + 11, { width: sigW, align: 'center' });
  doc.font('RB').fontSize(9).fillColor('#000').text('NGƯỜI NHẬN HÀNG', left + sigW + colGap, sigY, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(8).fillColor('#444').text('(Receiver)', left + sigW + colGap, sigY + 11, { width: sigW, align: 'center' });
  doc.fillColor('#000');

  // Footer
  const footerY = pageH - doc.page.margins.bottom - 14;
  const stamp = new Date().toLocaleString('vi-VN', { hour12: false });
  doc.font('RI').fontSize(7).fillColor('#666')
     .text(`Generated ${stamp}   |   page 1/1   |   by ${data.creator_name || ''}`, left, footerY, { width: usableW, align: 'center' });

  doc.end();
  return doc;
}

// ════════════════════════════════════════════════════════════════════════════
// CP4.2 — Multi-booking BBBG (1 PDF, N pages, 1 page per booking)
// ════════════════════════════════════════════════════════════════════════════

function fmtDtVn(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// L19 — han_lenh meaning depends on jobs.import_export. 'import' = date only,
// 'export' = full datetime cutoff.
function fmtHanLenhVn(val, impExp) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  if (impExp === 'import') {
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
  }
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
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
     .text('SLB GLOBAL LOGISTICS CO., LTD.', txtX, headerY);
  doc.font('R').fontSize(8).fillColor('#000');
  doc.text('Floor 5, SLB Building, Hanoi, Vietnam', txtX, doc.y + 1);
  doc.text('Tel: +84 24 1234 5678   |   Hotline: 0900 123 456', txtX, doc.y + 1);
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

  // 4. Render — collect into a Buffer.
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    registerFonts(doc);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const today = new Date().toLocaleDateString('vi-VN');
    const pageTotal = bookings.length;
    // CP4.2.2 — when the caller picked SLB, swap the company/tax/address in
    // for the EN variant before the renderer reads them. This keeps the
    // override on the server so the frontend can't spoof a different name
    // by sending type='slb' with arbitrary text.
    const invSource = invoiceInfo?.type === 'slb'
      ? { ...invoiceInfo, ...SLB_INVOICE_INFO_EN }
      : invoiceInfo;
    const inv = invSource && invSource.company && invSource.tax && invSource.address
      ? invSource : null;

    // Cargo totals — FCL uses tons, LCL uses kg. Unit follows cargo_type.
    const isFcl = (job.cargo_type || 'fcl') === 'fcl';
    const totalWeight = isFcl ? job.tons : job.kg;
    const weightUnit  = isFcl ? 'TONS' : 'KGS';
    const totalWeightStr = (totalWeight != null && totalWeight !== '')
      ? `${Number(totalWeight).toLocaleString('vi-VN')} ${weightUnit}`
      : '—';

    bookings.forEach((b, idx) => {
      if (idx > 0) doc.addPage({ size: 'A4', margin: 36 });

      // CP4.2.1 — slim header (booking code + date only); manifest fields
      // moved into the THÔNG TIN CHUNG boxed section.
      drawPageHeader(doc, b.booking_code, today);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const usableW = right - left;

      // Section 1 — THÔNG TIN CHUNG (2-col compact). 12 manifest fields:
      // Số lô hàng / Ngày / Shipper / Consignee / Vessel / Voy / From (POL) /
      // Terminal (POD) / Shipping line / H-B/L / M-B/L / Hạn lệnh.
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

      // Section 2 — CONTAINER. Per-cont rows; legacy spec shows 1 cont but
      // L20 allows multi. For 1 cont we emit 4 single-col rows; for 2+ we
      // prefix each label with "Cont N — " so the user can tell them apart.
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

      // Section 3 — HÀNG HÓA (job-level cargo totals). 2-col compact.
      y = drawTwoColInfoBox(doc, left, y, usableW,
        'HÀNG HÓA', 'Cargo Info', [
          { label: 'Tên hàng hóa', en: 'Description', value: job.goods_description || 'AS PER BILL' },
          { label: 'Trọng lượng', en: 'Weight',     value: totalWeightStr },
          { label: 'Đơn vị',      en: 'Unit',       value: weightUnit },
          { label: 'Số kiện',     en: 'Pieces',     value: job.so_kien != null ? String(job.so_kien) : '—' },
        ]);
      y += 6;

      // Section 4 — THÔNG TIN GIAO HÀNG (booking-specific delivery + contact).
      // 2-col compact.
      y = drawTwoColInfoBox(doc, left, y, usableW,
        'THÔNG TIN GIAO HÀNG', 'Delivery Info', [
          { label: 'Ngày giờ giao',          en: 'Delivery time',     value: fmtDtVn(b.planned_datetime) },
          { label: 'Địa điểm giao',          en: 'Delivery location', value: b.delivery_location },
          { label: 'Người liên hệ tại kho',  en: 'Warehouse contact', value: b.receiver_name },
          { label: 'SĐT',                    en: 'Phone',             value: b.receiver_phone },
        ]);
      y += 6;

      // Section 5 — Invoice (optional, only when caller supplied a complete set).
      if (inv) {
        y = drawBoxedSection(doc, left, y, usableW,
          'THÔNG TIN XUẤT HÓA ĐƠN NÂNG HẠ', 'Lift/Drop Invoice', [
            ['Tên công ty', 'Company',  inv.company],
            ['MST',         'Tax code', inv.tax],
            ['Địa chỉ',     'Address',  inv.address],
          ]);
        y += 6;
      }

      // Notes + driver warning. bbbg_note is the only place bbbg_note flows
      // into the PDF (per CP4.1 — never the mail body).
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

      // Signatures + footer. CP4.2.1: "ĐẠI DIỆN GIAO" (not "ĐẠI DIỆN SLB") —
      // BBBG is signed in person at delivery so the giao/nhận pair is the
      // accurate framing.
      drawSignatures(doc);
      drawPageFooter(doc, idx + 1, pageTotal, creatorName);
    });

    doc.end();
  });
}

module.exports = { buildBbbgPdf, generateMultiBookingBBBG };
