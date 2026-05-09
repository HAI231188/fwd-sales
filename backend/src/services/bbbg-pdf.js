// BBBG (Biên Bản Bàn Giao) PDF builder.
// Stateless — produces a PDFKit document piped to caller's writable stream.
// No DB writes, no filesystem writes (only optional reads of font/logo assets).

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

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

module.exports = { buildBbbgPdf };
