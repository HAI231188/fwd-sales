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

function drawPageHeader(doc, jobCode, bookingCode, customerName, shippingLine, todayDate) {
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
  // Right-side meta
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

  // Job/customer meta block
  doc.moveDown(0.4);
  const my = doc.y;
  doc.font('RB').fontSize(10).text(`Số job: `, left, my, { continued: true })
     .font('R').text(jobCode || '—', { continued: true })
     .font('RB').text('    Mã KH: ', { continued: true })
     .font('R').text(bookingCode || '—');
  doc.font('RB').fontSize(10).text(`Khách hàng: `, { continued: true })
     .font('R').text(customerName || '—');
  doc.font('RB').fontSize(10).text(`Hãng tàu: `, { continued: true })
     .font('R').text(shippingLine || '—');
  doc.moveDown(0.5);
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
     .text('ĐẠI DIỆN SLB', left, sigY + 4, { width: sigW, align: 'center' });
  doc.font('RI').fontSize(7).fillColor('#555')
     .text('(SLB Representative)', left, sigY + 14, { width: sigW, align: 'center' });
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

  // 1. Job
  const { rows: [job] } = await db.query(
    `SELECT id, job_code, customer_name, han_lenh, import_export,
            NULL::text AS shipping_line
       FROM jobs WHERE id = $1 AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) throw new Error('Không tìm thấy job');

  // 2. Transport company — name is the primary field; tax_code does not exist
  // on the table today, so leave it null (rendered as '—').
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
    const inv = invoiceInfo && invoiceInfo.company && invoiceInfo.tax && invoiceInfo.address
      ? invoiceInfo : null;

    bookings.forEach((b, idx) => {
      if (idx > 0) doc.addPage({ size: 'A4', margin: 36 });

      drawPageHeader(doc, job.job_code, b.booking_code,
        job.customer_name, job.shipping_line, today);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const usableW = right - left;

      // Section 1 — Transport
      let y = doc.y;
      y = drawBoxedSection(doc, left, y, usableW,
        'THÔNG TIN VẬN CHUYỂN', 'Transport Info', [
          ['Vận tải', 'Carrier', tc.name || '—'],
          ['Số xe', 'Vehicle No.', b.vehicle_number || '—'],
          ['Cước chốt', 'Cost', fmtCostVn(b.cost)],
        ]);
      y += 8;

      // Section 2 — Container (multi-cont per L20)
      const conts = Array.isArray(b.containers) ? b.containers : [];
      const contNumbers = conts.map(c => c.cont_number || '(chưa số)').join(', ') || '—';
      const contTypes   = conts.map(c => c.cont_type).filter(Boolean).join(', ') || '—';
      y = drawBoxedSection(doc, left, y, usableW,
        'THÔNG TIN CONTAINER', 'Container Info', [
          ['Số container', 'Container No.', contNumbers],
          ['Loại', 'Type', contTypes],
          ['Trọng lượng', 'Weight', fmtWeightsList(conts)],
        ]);
      y += 8;

      // Section 3 — Delivery
      y = drawBoxedSection(doc, left, y, usableW,
        'THÔNG TIN GIAO HÀNG', 'Delivery Info', [
          ['Ngày giờ giao', 'Delivery time', fmtDtVn(b.planned_datetime)],
          ['Địa điểm giao', 'Delivery location', b.delivery_location || '—'],
          ['Hạn lệnh / Cutoff', 'Deadline', fmtHanLenhVn(job.han_lenh, job.import_export)],
          ['Người liên hệ tại kho', 'Warehouse contact', b.receiver_name || '—'],
          ['SĐT', 'Phone', b.receiver_phone || '—'],
        ]);
      y += 8;

      // Section 4 — Invoice (optional)
      if (inv) {
        y = drawBoxedSection(doc, left, y, usableW,
          'THÔNG TIN XUẤT HÓA ĐƠN NÂNG HẠ', 'Lift/Drop Invoice', [
            ['Tên công ty', 'Company', inv.company],
            ['MST', 'Tax code', inv.tax],
            ['Địa chỉ', 'Address', inv.address],
          ]);
        y += 8;
      }

      // Notes (free text), placed below the boxed sections.
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

      // Signatures + footer
      drawSignatures(doc);
      drawPageFooter(doc, idx + 1, pageTotal, creatorName);
    });

    doc.end();
  });
}

module.exports = { buildBbbgPdf, generateMultiBookingBBBG };
