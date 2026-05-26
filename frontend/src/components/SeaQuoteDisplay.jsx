// SeaQuoteDisplay — compact read-only render of a v2 sea-freight quote
// (2026-05-26, C4). Used in CustomerDetailModal's quote thread when
// q.quote_data?.version === 2. Renders ticked charges + section totals +
// grand total + PDF export button.

import { useState } from 'react';
import { generateSeaQuotePdf } from '../api';
import {
  parseNum, unitToCurrency, calcRowAmount, calcRowVat, calcRowTotal,
  calcSectionTotals, calcGrandTotal, fmtAmount,
} from '../utils/seaQuoteCalc';

function fmtDate(d) {
  if (!d) return '';
  try {
    const date = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(date.getTime())) return String(d);
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(d); }
}

export default function SeaQuoteDisplay({ quote }) {
  const qd = quote.quote_data || {};
  const ctx = { cargo_type: qd.cargo_type || 'FCL', containers: qd.containers || [] };
  const intlT = calcSectionTotals(qd.intl_charges, ctx);
  const inlandT = calcSectionTotals(qd.inland_charges, ctx);
  const target = quote.grand_total_currency || qd.grand_total_currency;
  const rate = quote.exchange_rate || qd.exchange_rate;
  const grand = calcGrandTotal(intlT, inlandT, target, rate);

  const [pdfBusy, setPdfBusy] = useState(false);
  async function handlePdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const blob = await generateSeaQuotePdf(quote.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Không thể tạo PDF';
      alert(`Lỗi xuất PDF: ${msg}`);
    } finally {
      setPdfBusy(false);
    }
  }

  const tickedIntl = (qd.intl_charges || []).filter(r => r.ticked);
  const tickedInland = (qd.inland_charges || []).filter(r => r.ticked);
  const cargoLine = ctx.cargo_type === 'FCL'
    ? (ctx.containers.filter(c => parseNum(c.qty) > 0).map(c => `${c.qty}×${c.type}`).join(', ') || '(chưa có cont)')
    : `${qd.shipment_cbm || 0} CBM`;

  return (
    <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>
          🚢 {qd.pol || '—'} → {qd.pod || '—'}
        </span>
        {qd.term && (
          <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#dbeafe', color: '#1d4ed8', fontWeight: 600 }}>
            {qd.term}
          </span>
        )}
        <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 8, background: '#f3f4f6', color: '#374151', fontWeight: 600 }}>
          {ctx.cargo_type}: {cargoLine}
        </span>
        <button type="button" onClick={handlePdf} disabled={pdfBusy}
          style={{
            marginLeft: 'auto',
            background: pdfBusy ? 'var(--text-3)' : '#0066b3',
            color: '#fff', border: 'none', borderRadius: 6, fontSize: 11,
            padding: '4px 10px', cursor: pdfBusy ? 'wait' : 'pointer', fontWeight: 600,
          }}>
          {pdfBusy ? '⏳' : '📄 PDF'}
        </button>
      </div>

      <ChargeBlock title="Phí quốc tế" rows={tickedIntl} ctx={ctx} totals={intlT} />
      <ChargeBlock title="Phí nội địa" rows={tickedInland} ctx={ctx} totals={inlandT} />

      {target && grand != null && (
        <div style={{
          marginTop: 8, padding: '6px 10px', background: '#fff7ed',
          border: '1px solid #fdba74', borderRadius: 6,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 700, color: '#9a3412', fontSize: 12 }}>GRAND TOTAL</span>
          <span style={{ fontWeight: 700, color: '#9a3412', fontSize: 13 }}>
            {fmtAmount(grand, target)} {target}
          </span>
        </div>
      )}
      {target && grand == null && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#d97706', fontStyle: 'italic' }}>
          ⚠ Cần tỷ giá để tính Grand Total (hỗn hợp USD/VND)
        </div>
      )}

      {(quote.valid_until || rate) && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {quote.valid_until && <span>Hiệu lực: {fmtDate(quote.valid_until)}</span>}
          {rate && <span>Tỷ giá: 1 USD = {Number(rate).toLocaleString('vi-VN')} VND</span>}
        </div>
      )}

      {qd.notes && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic' }}>
          📝 {qd.notes}
        </div>
      )}
    </div>
  );
}

function ChargeBlock({ title, rows, ctx, totals }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
        {title}
      </div>
      {/* Mini-header for the 3 money columns */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px', gap: 8,
        fontSize: 10, color: 'var(--text-3)', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.3px',
        borderBottom: '1px solid var(--border)', paddingBottom: 2, marginBottom: 3,
      }}>
        <span>Chi phí</span>
        <span style={{ textAlign: 'right' }}>Net</span>
        <span style={{ textAlign: 'right' }}>VAT</span>
        <span style={{ textAlign: 'right' }}>Line Total</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((r, i) => {
          const net = calcRowAmount(r, ctx);
          const vatAmt = calcRowVat(r, ctx);
          const lineTotal = calcRowTotal(r, ctx);
          const cur = unitToCurrency(r.unit);
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px', gap: 8,
              fontSize: 12, alignItems: 'baseline',
            }}>
              <span style={{ color: 'var(--text)' }}>
                {r.name}
                {r.vat && <span style={{ color: 'var(--text-3)', marginLeft: 4, fontSize: 10 }}>({r.vat})</span>}
              </span>
              <span style={{ color: 'var(--text-2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {net > 0 ? `${fmtAmount(net, cur)} ${cur}` : '—'}
              </span>
              <span style={{ color: 'var(--text-2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {net > 0 ? `${fmtAmount(vatAmt, cur)} ${cur}` : '—'}
              </span>
              <span style={{ color: 'var(--primary)', fontWeight: 700, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {lineTotal > 0 ? `${fmtAmount(lineTotal, cur)} ${cur}` : '—'}
              </span>
            </div>
          );
        })}
      </div>
      {Object.keys(totals).map(cur => {
        const { net, vat, total } = totals[cur];
        return (
          <div key={cur} style={{
            marginTop: 4, paddingTop: 3, borderTop: '1px dashed var(--border)',
            fontSize: 11, color: 'var(--text-2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Subtotal Net ({cur}):</span>
              <span>{fmtAmount(net, cur)} {cur}</span>
            </div>
            {vat > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>VAT ({cur}):</span>
                <span>{fmtAmount(vat, cur)} {cur}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--text)' }}>
              <span>Section Total ({cur}):</span>
              <span>{fmtAmount(total, cur)} {cur}</span>
            </div>
          </div>
        );
      })}
      <div style={{
        fontSize: 10, color: 'var(--text-3)', fontStyle: 'italic',
        marginTop: 4,
      }}>
        Đơn giá theo từng dòng. VAT áp dụng theo từng loại phí (0% hoặc 8%). Line Total đã bao gồm VAT.
      </div>
    </div>
  );
}
