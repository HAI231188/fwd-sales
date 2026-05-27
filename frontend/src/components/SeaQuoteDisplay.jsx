// SeaQuoteDisplay — compact read-only render of a v2 sea-freight quote
// (2026-05-26, C4). Used in CustomerDetailModal's quote thread when
// q.quote_data?.version === 2. Renders ticked charges + section totals +
// grand total + PDF export button.

import { useState } from 'react';
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

// Format the row's RATE column for display. For cont basis show per-cont
// rates inline (compact); for other bases show the single rate value.
function formatRowRateDisplay(row, cur) {
  const basis = unitBasis(row.unit);
  if (basis === 'cont') {
    const rbc = row.rate_by_cont || row.price_by_cont || {};
    const parts = Object.entries(rbc)
      .filter(([, v]) => parseNum(v) > 0)
      .map(([type, v]) => `${type}:${fmtAmount(parseNum(v), cur)}`);
    return parts.length ? parts.join('  ') : '—';
  }
  const rate = parseNum(row.rate != null ? row.rate : row.price);
  return rate > 0 ? fmtAmount(rate, cur) : '—';
}

const CHARGE_GRID_COLS = '1.2fr 0.8fr 1.3fr 0.7fr 0.5fr 0.9fr 0.7fr 1fr';

function ChargeBlock({ title, rows, ctx, totals }) {
  if (!rows.length) return null;
  const HEADERS = ['Chi phí', 'VOL', 'Đơn giá', 'Đơn vị', 'VAT%', 'Net', 'VAT', 'Line Total'];
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>
        {title}
      </div>
      {/* Column header — 8 cols, money cols right-aligned */}
      <div style={{
        display: 'grid', gridTemplateColumns: CHARGE_GRID_COLS, gap: 8,
        fontSize: 9.5, color: 'var(--text-3)', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.3px',
        borderBottom: '1px solid var(--border)', paddingBottom: 2, marginBottom: 3,
      }}>
        {HEADERS.map((h, i) => (
          <span key={h} style={{ textAlign: i >= 5 ? 'right' : (i >= 1 && i <= 4 ? 'left' : 'left') }}>
            {h}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((r, i) => {
          const net = calcRowAmount(r, ctx);
          const vatAmt = calcRowVat(r, ctx);
          const lineTotal = calcRowTotal(r, ctx);
          const cur = unitToCurrency(r.unit);
          const vol = formatRowVol(r, ctx);
          const rateStr = formatRowRateDisplay(r, cur);
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: CHARGE_GRID_COLS, gap: 8,
              fontSize: 11.5, alignItems: 'baseline',
            }}>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{r.name}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 10.5, whiteSpace: 'nowrap' }}>{vol}</span>
              <span style={{ color: 'var(--text-2)', fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {rateStr}
              </span>
              <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{r.unit}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{r.vat || ''}</span>
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
        VOL tự suy ra từ Đơn vị · Net = đơn giá × VOL · VAT theo từng loại phí · Line Total đã bao gồm VAT.
      </div>
    </div>
  );
}
