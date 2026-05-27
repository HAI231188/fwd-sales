// SeaQuoteDisplay — compact read-only render of a v2 sea-freight quote
// (2026-05-26, C4). Used in CustomerDetailModal's quote thread when
// q.quote_data?.version === 2. Renders ticked charges + section totals +
// grand total + PDF export button.

import React, { useState } from 'react';
import { generateSeaQuotePdf } from '../api';
import {
  parseNum, unitToCurrency, unitBasis,
  calcRowAmount, calcRowVat, calcRowTotal,
  calcSectionTotals, calcGrandTotal, fmtAmount, formatVolume, formatRowVol,
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
  const ctx = {
    cargo_type: qd.cargo_type || 'FCL',
    containers: qd.containers || [],
    shipment_cbm: qd.shipment_cbm,
    shipment_kg: qd.shipment_kg,
  };
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
          {ctx.cargo_type}
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

      {(() => {
        const volume = formatVolume(qd);
        if (!volume) return null;
        return (
          <div style={{
            marginTop: 4, marginBottom: 8,
            padding: '6px 10px', background: 'var(--primary-dim)',
            border: '1px solid var(--primary)', borderRadius: 6,
            display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 9.5, fontWeight: 700, color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '0.4px',
            }}>
              Volume / Khối lượng
            </span>
            <span style={{
              fontSize: 13, fontWeight: 700, color: 'var(--primary)',
              fontFamily: 'var(--font-display)',
            }}>
              {volume}
            </span>
          </div>
        );
      })()}

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

// Real <table> rendering — needed for colspan-based grouped sub-headers.
// FCL: Chi phí | {per cont: SL | Đơn giá} | Đơn giá (flat) | Đơn vị | VAT% | Net | VAT | Line Total
// LCL: Chi phí | Đơn giá (flat) | Đơn vị | VAT% | Net | VAT | Line Total
const TH_S  = { padding: '3px 6px', fontSize: 9.5, fontWeight: 700, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '0.3px', borderBottom: '1px solid var(--border)' };
const TH_SUB = { padding: '2px 6px', fontSize: 9, fontWeight: 600, color: 'var(--text-3)',
  borderBottom: '1px solid var(--border)' };
const TD_S  = { padding: '3px 6px', fontSize: 11.5, verticalAlign: 'baseline' };

function ChargeBlock({ title, rows, ctx, totals }) {
  if (!rows.length) return null;
  const isFcl = ctx.cargo_type === 'FCL';
  const activeTypes = (ctx.containers || []).filter(c => parseNum(c.qty) > 0).map(c => c.type);
  const showContCols = isFcl && activeTypes.length > 0;
  const qtyByType = Object.fromEntries((ctx.containers || []).map(c => [c.type, parseNum(c.qty)]));

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'left' }}>Chi phí</th>
            {showContCols && activeTypes.map(t => (
              <th key={t} colSpan={2} style={{ ...TH_S, textAlign: 'center' }}>{t}</th>
            ))}
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'right' }}>Đơn giá</th>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'left' }}>Đơn vị</th>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'left' }}>VAT%</th>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'right' }}>Net</th>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'right' }}>VAT</th>
            <th rowSpan={2} style={{ ...TH_S, textAlign: 'right' }}>Line Total</th>
          </tr>
          {showContCols && (
            <tr>
              {activeTypes.map(t => (
                <React.Fragment key={t}>
                  <th style={{ ...TH_SUB, textAlign: 'center' }}>SL</th>
                  <th style={{ ...TH_SUB, textAlign: 'right' }}>Đơn giá</th>
                </React.Fragment>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const basis = unitBasis(r.unit);
            const isCont = basis === 'cont';
            const net = calcRowAmount(r, ctx);
            const vatAmt = calcRowVat(r, ctx);
            const lineTotal = calcRowTotal(r, ctx);
            const cur = unitToCurrency(r.unit);
            const rbc = r.rate_by_cont || r.price_by_cont || {};
            const flatRate = parseNum(r.rate != null ? r.rate : r.price);
            return (
              <tr key={i}>
                <td style={{ ...TD_S, color: 'var(--text)', fontWeight: 500 }}>{r.name}</td>
                {showContCols && activeTypes.map(t => (
                  <React.Fragment key={t}>
                    <td style={{ ...TD_S, textAlign: 'center',
                      color: isCont ? 'var(--text)' : 'var(--text-3)',
                      fontWeight: isCont ? 600 : 400, fontSize: 10.5 }}>
                      {isCont ? (qtyByType[t] || 0) : '—'}
                    </td>
                    <td style={{ ...TD_S, textAlign: 'right',
                      color: isCont ? 'var(--text-2)' : 'var(--text-3)',
                      fontSize: 10.5, whiteSpace: 'nowrap' }}>
                      {isCont
                        ? (parseNum(rbc[t]) > 0 ? fmtAmount(parseNum(rbc[t]), cur) : '—')
                        : '—'}
                    </td>
                  </React.Fragment>
                ))}
                <td style={{ ...TD_S, textAlign: 'right',
                  color: !isCont && flatRate > 0 ? 'var(--text-2)' : 'var(--text-3)',
                  fontSize: 10.5, whiteSpace: 'nowrap' }}>
                  {isCont ? '—' : (flatRate > 0 ? fmtAmount(flatRate, cur) : '—')}
                </td>
                <td style={{ ...TD_S, color: 'var(--text-3)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{r.unit}</td>
                <td style={{ ...TD_S, color: 'var(--text-3)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{r.vat || ''}</td>
                <td style={{ ...TD_S, textAlign: 'right', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                  {net > 0 ? `${fmtAmount(net, cur)} ${cur}` : '—'}
                </td>
                <td style={{ ...TD_S, textAlign: 'right', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                  {net > 0 ? `${fmtAmount(vatAmt, cur)} ${cur}` : '—'}
                </td>
                <td style={{ ...TD_S, textAlign: 'right', color: 'var(--primary)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {lineTotal > 0 ? `${fmtAmount(lineTotal, cur)} ${cur}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
        Đơn vị quyết định cách tính: CONT = theo container, SHPT/BL = trọn lô, CBM = theo khối, KG = theo trọng lượng.
        Net = đơn giá x số lượng. Line Total đã gồm VAT.
      </div>
    </div>
  );
}
