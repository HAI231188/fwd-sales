// RoadQuoteForm — road freight quote v2 (2026-05-27).
// Same architecture as Sea/Air through the unified parametric engine.
// Dimension = vehicle types (13m/15m/17.5m/45HC/Khác). Math runs through
// shared seaQuoteCalc via rate_by_break / ctxDimensions on road branch.

import React, { useState, useEffect } from 'react';
import { generateSeaQuotePdf, generateSeaQuotePreviewPdf } from '../api';
import {
  parseNum, unitToCurrency, unitBasis,
  calcRowAmount, calcRowVat, calcRowTotal,
  calcSectionTotals, calcGrandTotal, fmtAmount, formatVolume, formatRowVol,
} from '../utils/seaQuoteCalc';

const ROAD_VEHICLES = ['13m', '15m', '17.5m', '45HC', 'Khác'];
const ROAD_TERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

const ROAD_INTL_NAMES = [
  'EXW charge', 'FCA charge', 'DAP charge', 'DDP charge',
  'Trucking phí trục', 'Phí cửa khẩu', 'Phí XNK', 'CFS',
];
const ROAD_INLAND_NAMES = [
  'Trucking nội địa', 'Customs', 'Nâng hàng', 'Hạ hàng',
  'Lưu kho', 'Bốc xếp', 'Kiểm dịch', 'Hun trùng',
  'KTCL', 'Khai báo hóa chất', 'Phí khai báo', 'Bảo hiểm',
];

const ROAD_UNIT_OPTIONS = [
  'USD/XE', 'VND/XE',
  'USD/SHIPMENT', 'VND/SHIPMENT',
  'VND/CHUYEN',
];
const VAT_OPTIONS = ['0%', '8%', '10%', 'KCT'];

const INTL_DEFAULT_UNIT = 'USD/XE';
const INTL_DEFAULT_VAT = '0%';
const INLAND_DEFAULT_UNIT = 'VND/XE';
const INLAND_DEFAULT_VAT = '8%';

function buildRoadChargeRow(name, unit, vat) {
  return {
    name, ticked: false,
    rate_by_break: {}, // keyed by vehicle type — unified field for rateByDim helper
    rate: '',
    unit, vat, note: '', amount: null,
  };
}

export const EMPTY_ROAD_QUOTE = {
  version: 2,
  mode: 'road',
  transport: 'road',
  pickup: '', delivery: '', border_gate: '',
  term: 'CPT',
  vehicles: [],
  valid_until: '',
  exchange_rate: '',
  grand_total_currency: null,
  intl_default_unit: INTL_DEFAULT_UNIT,
  intl_default_vat: INTL_DEFAULT_VAT,
  inland_default_unit: INLAND_DEFAULT_UNIT,
  inland_default_vat: INLAND_DEFAULT_VAT,
  intl_charges: ROAD_INTL_NAMES.map(n => buildRoadChargeRow(n, INTL_DEFAULT_UNIT, INTL_DEFAULT_VAT)),
  inland_charges: ROAD_INLAND_NAMES.map(n => buildRoadChargeRow(n, INLAND_DEFAULT_UNIT, INLAND_DEFAULT_VAT)),
  notes: '',
};

function vehiclesFromMap(vehicleQty) {
  if (!vehicleQty) return [];
  return ROAD_VEHICLES
    .map(t => ({ type: t, qty: parseNum(vehicleQty[t]) }))
    .filter(v => v.qty > 0);
}

function TickGrid({ rows, onToggle, onEditCustomName, onDeleteCustom, onAddCustom }) {
  return (
    <div style={{
      padding: 12, background: 'var(--bg)', borderRadius: 8,
      border: '1px solid var(--border)', marginBottom: 12,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {rows.map((r, idx) => r.custom ? null : (
          <label key={`preset-${r.name}`} style={{
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
            background: r.ticked ? 'rgba(59,130,246,0.12)' : 'transparent',
            color: r.ticked ? '#1d4ed8' : 'var(--text-2)',
            border: `1px solid ${r.ticked ? '#3b82f6' : 'transparent'}`,
          }}>
            <input type="checkbox" checked={r.ticked} onChange={() => onToggle(idx)}
              style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#3b82f6' }} />
            <span>{r.name}</span>
          </label>
        ))}
      </div>
      {rows.some(r => r.custom) && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, idx) => r.custom ? (
            <div key={`custom-${idx}`} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: r.ticked ? 'rgba(59,130,246,0.08)' : '#fff',
              border: `1px dashed ${r.ticked ? '#3b82f6' : 'var(--border)'}`,
            }}>
              <input type="checkbox" checked={r.ticked} onChange={() => onToggle(idx)}
                style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#3b82f6', flexShrink: 0 }} />
              <input className="form-input" value={r.name}
                onChange={e => onEditCustomName(idx, e.target.value)}
                placeholder="Tên chi phí khác..."
                style={{ flex: 1, fontSize: 12, padding: '3px 8px', minWidth: 0,
                  color: r.ticked ? '#1d4ed8' : 'var(--text)', fontWeight: r.ticked ? 500 : 400 }} />
              <button type="button" onClick={() => onDeleteCustom(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--danger)', fontSize: 14, padding: '2px 6px', flexShrink: 0 }}>✕</button>
            </div>
          ) : null)}
        </div>
      )}
      <button type="button" onClick={onAddCustom}
        style={{
          marginTop: 8, padding: '6px 12px', borderRadius: 6,
          border: '1px dashed var(--primary)', background: 'transparent',
          color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          fontFamily: 'var(--font)',
        }}>
        + Thêm chi phí khác
      </button>
    </div>
  );
}

function DefaultBar({ unit, vat, onUnitChange, onVatChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '8px 12px', background: '#f8fafc', borderRadius: 6,
      border: '1px dashed var(--border)', marginBottom: 8, fontSize: 12,
    }}>
      <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>Mặc định:</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>Đơn vị:</span>
        <select value={unit} onChange={e => onUnitChange(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px', borderRadius: 4 }}>
          {ROAD_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>VAT:</span>
        <select value={vat} onChange={e => onVatChange(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px', borderRadius: 4 }}>
          {VAT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    </div>
  );
}

export default function RoadQuoteForm({ value, onChange, quoteId, customerName }) {
  const v = value || EMPTY_ROAD_QUOTE;
  const [pdfBusy, setPdfBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);

  async function handleExportPdf() {
    if (!quoteId || pdfBusy) return;
    setPdfBusy(true);
    try {
      const blob = await generateSeaQuotePdf(quoteId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      alert(`Lỗi xuất PDF: ${e?.response?.data?.error || e?.message || 'Không thể tạo PDF'}`);
    } finally { setPdfBusy(false); }
  }
  async function handlePreviewPdf() {
    if (previewBusy) return;
    setPreviewBusy(true);
    try {
      const blob = await generateSeaQuotePreviewPdf({
        quote_data: v,
        customer_name: customerName || '(chưa lưu)',
        valid_until: v.valid_until || null,
        exchange_rate: v.exchange_rate || null,
        grand_total_currency: v.grand_total_currency || null,
      });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      alert(`Lỗi xem trước PDF: ${e?.response?.data?.error || e?.message || 'Không thể tạo PDF'}`);
    } finally { setPreviewBusy(false); }
  }

  const [vehicleQty, setVehicleQty] = useState(() => {
    const init = {};
    ROAD_VEHICLES.forEach(t => { init[t] = ''; });
    (v.vehicles || []).forEach(rv => { if (init[rv.type] !== undefined) init[rv.type] = rv.qty || ''; });
    return init;
  });
  useEffect(() => {
    onChange({ ...v, vehicles: vehiclesFromMap(vehicleQty) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(vehicleQty)]);

  const activeVehicles = ROAD_VEHICLES.filter(t => parseNum(vehicleQty[t]) > 0);
  const totalVehicles = activeVehicles.reduce((s, t) => s + parseNum(vehicleQty[t]), 0);

  const set = (field, val) => onChange({ ...v, [field]: val });
  const setVehicleQtyVal = (t, raw) => {
    const n = raw === '' ? '' : Math.max(0, Number(raw) || 0);
    setVehicleQty(prev => ({ ...prev, [t]: n }));
  };

  const setIntlDefaultUnit = unit => onChange({ ...v, intl_default_unit: unit,
    intl_charges: v.intl_charges.map(r => ({ ...r, unit })) });
  const setIntlDefaultVat = vat => onChange({ ...v, intl_default_vat: vat,
    intl_charges: v.intl_charges.map(r => ({ ...r, vat })) });
  const setInlandDefaultUnit = unit => onChange({ ...v, inland_default_unit: unit,
    inland_charges: v.inland_charges.map(r => ({ ...r, unit })) });
  const setInlandDefaultVat = vat => onChange({ ...v, inland_default_vat: vat,
    inland_charges: v.inland_charges.map(r => ({ ...r, vat })) });

  const toggleIntl = idx => onChange({ ...v, intl_charges: v.intl_charges.map((r, i) =>
    i === idx ? { ...r, ticked: !r.ticked } : r) });
  const toggleInland = idx => onChange({ ...v, inland_charges: v.inland_charges.map((r, i) =>
    i === idx ? { ...r, ticked: !r.ticked } : r) });
  const patchIntlRow = (idx, patch) => onChange({ ...v,
    intl_charges: v.intl_charges.map((r, i) => i === idx ? { ...r, ...patch } : r) });
  const patchInlandRow = (idx, patch) => onChange({ ...v,
    inland_charges: v.inland_charges.map((r, i) => i === idx ? { ...r, ...patch } : r) });

  const addCustomIntl = () => onChange({ ...v, intl_charges: [...v.intl_charges,
    { ...buildRoadChargeRow('', v.intl_default_unit, v.intl_default_vat), custom: true, ticked: true }] });
  const addCustomInland = () => onChange({ ...v, inland_charges: [...v.inland_charges,
    { ...buildRoadChargeRow('', v.inland_default_unit, v.inland_default_vat), custom: true, ticked: true }] });
  const editCustomIntlName = (idx, name) => onChange({ ...v,
    intl_charges: v.intl_charges.map((r, i) => i === idx ? { ...r, name } : r) });
  const editCustomInlandName = (idx, name) => onChange({ ...v,
    inland_charges: v.inland_charges.map((r, i) => i === idx ? { ...r, name } : r) });
  const deleteCustomIntl = idx => onChange({ ...v,
    intl_charges: v.intl_charges.filter((_, i) => i !== idx) });
  const deleteCustomInland = idx => onChange({ ...v,
    inland_charges: v.inland_charges.filter((_, i) => i !== idx) });

  return (
    <div style={{
      background: '#f8f9fa', border: '1px solid var(--border)', borderRadius: 12,
      padding: 20, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-display)' }}>
          🚛 Báo giá đường bộ
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic', marginLeft: 8 }}>v2</span>
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={handlePreviewPdf} disabled={previewBusy}
            style={{
              background: previewBusy ? 'var(--text-3)' : '#0E7C66',
              color: '#fff', border: 'none', fontSize: 12,
              padding: '6px 12px', cursor: previewBusy ? 'wait' : 'pointer',
            }}>
            {previewBusy ? '⏳ Đang tạo…' : '👁 Xem trước PDF'}
          </button>
          {quoteId && (
            <button type="button" className="btn btn-sm" onClick={handleExportPdf} disabled={pdfBusy}
              style={{
                background: pdfBusy ? 'var(--text-3)' : '#0066b3',
                color: '#fff', border: 'none', fontSize: 12,
                padding: '6px 12px', cursor: pdfBusy ? 'wait' : 'pointer',
              }}>
              {pdfBusy ? '⏳ Đang tạo…' : '📄 Xuất PDF (đã lưu)'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Pickup (điểm lấy hàng)</label>
          <input className="form-input" value={v.pickup} onChange={e => set('pickup', e.target.value)}
            placeholder="VD: Quảng Châu" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Delivery (điểm giao hàng)</label>
          <input className="form-input" value={v.delivery} onChange={e => set('delivery', e.target.value)}
            placeholder="VD: Hà Nội" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Cửa khẩu (Border gate)</label>
          <input className="form-input" value={v.border_gate} onChange={e => set('border_gate', e.target.value)}
            placeholder="VD: Hữu Nghị, Móng Cái, Lào Cai" />
        </div>
      </div>

      <div style={{
        padding: 12, background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 8, marginBottom: 12,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
          Loại xe + Số lượng
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          {ROAD_VEHICLES.map(t => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ minWidth: 50, fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{t}:</span>
              <input type="number" min="0" step="1" className="form-input"
                value={vehicleQty[t] || ''}
                onChange={e => setVehicleQtyVal(t, e.target.value)}
                style={{ width: 70, fontSize: 13, padding: '4px 8px' }}
                placeholder="0" />
            </div>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
          Tổng: <strong style={{ color: 'var(--text)' }}>{totalVehicles}</strong> xe
        </div>
      </div>

      {(() => {
        const volume = formatVolume({ transport: 'road', vehicles: vehiclesFromMap(vehicleQty) });
        if (!volume) return null;
        return (
          <div style={{
            padding: '10px 14px', marginBottom: 12,
            background: 'var(--primary-dim)', border: '1px solid var(--primary)',
            borderRadius: 8, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
              textTransform: 'uppercase', letterSpacing: '0.5px' }}>Volume / Khối lượng</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-display)' }}>
              {volume}
            </span>
          </div>
        );
      })()}

      <div className="form-group" style={{ marginBottom: 12 }}>
        <label className="form-label">Điều kiện giao hàng (Term — multimodal)</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {ROAD_TERMS.map(t => (
            <button key={t} type="button" onClick={() => set('term', t)}
              className="btn btn-sm"
              style={{
                background: v.term === t ? 'var(--primary)' : 'transparent',
                color: v.term === t ? '#fff' : 'var(--text-2)',
                border: `1px solid ${v.term === t ? 'var(--primary)' : 'var(--border)'}`,
                fontSize: 12, padding: '4px 12px',
              }}>{t}</button>
          ))}
          <input className="form-input" placeholder="Khác..."
            value={!ROAD_TERMS.includes(v.term) ? (v.term || '') : ''}
            onChange={e => set('term', e.target.value)}
            style={{ width: 140, fontSize: 12, padding: '4px 10px' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Tỷ giá (1 USD =</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" className="form-input"
              value={v.exchange_rate} onChange={e => set('exchange_rate', e.target.value)}
              placeholder="26,000" />
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>VND)</span>
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Có hiệu lực đến</label>
          <input type="date" className="form-input"
            value={v.valid_until} onChange={e => set('valid_until', e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Tiền tệ tổng</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {[{ k: null, l: '— (2 dòng)' }, { k: 'USD', l: 'USD' }, { k: 'VND', l: 'VND' }].map(opt => (
              <button key={opt.l} type="button" onClick={() => set('grand_total_currency', opt.k)}
                className="btn btn-sm"
                style={{
                  flex: 1,
                  background: v.grand_total_currency === opt.k ? 'var(--primary)' : 'transparent',
                  color: v.grand_total_currency === opt.k ? '#fff' : 'var(--text-2)',
                  border: `1px solid ${v.grand_total_currency === opt.k ? 'var(--primary)' : 'var(--border)'}`,
                  fontSize: 12,
                }}>{opt.l}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>
          🌐 Phí quốc tế (International Charges)
        </div>
        <TickGrid rows={v.intl_charges} onToggle={toggleIntl}
          onEditCustomName={editCustomIntlName} onDeleteCustom={deleteCustomIntl} onAddCustom={addCustomIntl} />
        <DefaultBar unit={v.intl_default_unit} vat={v.intl_default_vat}
          onUnitChange={setIntlDefaultUnit} onVatChange={setIntlDefaultVat} />
        {v.intl_charges.some(r => r.ticked) && (
          <ChargesTable rows={v.intl_charges} activeVehicles={activeVehicles}
            vehicleQty={vehicleQty} defaultUnit={v.intl_default_unit} defaultVat={v.intl_default_vat}
            onPatch={patchIntlRow}
            ctx={{ transport: 'road', vehicles: vehiclesFromMap(vehicleQty) }} />
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>
          🇻🇳 Phí nội địa (Inland Charges)
        </div>
        <TickGrid rows={v.inland_charges} onToggle={toggleInland}
          onEditCustomName={editCustomInlandName} onDeleteCustom={deleteCustomInland} onAddCustom={addCustomInland} />
        <DefaultBar unit={v.inland_default_unit} vat={v.inland_default_vat}
          onUnitChange={setInlandDefaultUnit} onVatChange={setInlandDefaultVat} />
        {v.inland_charges.some(r => r.ticked) && (
          <ChargesTable rows={v.inland_charges} activeVehicles={activeVehicles}
            vehicleQty={vehicleQty} defaultUnit={v.inland_default_unit} defaultVat={v.inland_default_vat}
            onPatch={patchInlandRow}
            ctx={{ transport: 'road', vehicles: vehiclesFromMap(vehicleQty) }} />
        )}
      </div>

      <TotalsBox quote={v} vehicleQty={vehicleQty} />

      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">Ghi chú chung</label>
        <textarea className="form-textarea" rows={2}
          value={v.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Điều kiện thanh toán, lưu ý cho khách..." />
      </div>
    </div>
  );
}

function TotalsBox({ quote, vehicleQty }) {
  const ctx = { transport: 'road', vehicles: vehiclesFromMap(vehicleQty) };
  const intlT = calcSectionTotals(quote.intl_charges, ctx);
  const inlandT = calcSectionTotals(quote.inland_charges, ctx);
  const { perCurrency, grand, needsRate } = calcGrandTotal(
    intlT, inlandT, quote.grand_total_currency, quote.exchange_rate);
  const currencyKeys = Object.keys(perCurrency);
  const mixed = currencyKeys.length > 1;
  const anyTicked = quote.intl_charges.some(r => r.ticked) || quote.inland_charges.some(r => r.ticked);
  if (!anyTicked) return null;

  const renderSectionRow = (label, totals) => {
    const currencies = Object.keys(totals);
    if (!currencies.length) return null;
    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>{label}:</span>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {currencies.map(cur => {
            const { net, vat, total } = totals[cur];
            const hasVat = vat > 0;
            return (
              <div key={cur} style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  {fmtAmount(total, cur)} {cur}
                </div>
                {hasVat && (
                  <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    (Net {fmtAmount(net, cur)} + VAT {fmtAmount(vat, cur)})
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div style={{
      marginTop: 8, marginBottom: 16,
      padding: '12px 16px', background: '#fff',
      border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        💰 Tổng chi phí
      </div>
      {renderSectionRow('International Total', intlT)}
      {renderSectionRow('Inland Total', inlandT)}
      <div style={{ height: 1, background: 'var(--border)', margin: '10px 0' }} />
      {!quote.grand_total_currency && currencyKeys.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {currencyKeys.map(cur => (
            <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', fontFamily: 'var(--font-display)' }}>
                TỔNG {cur}
              </span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-display)' }}>
                {fmtAmount(perCurrency[cur], cur)} {cur}
              </span>
            </div>
          ))}
        </div>
      )}
      {needsRate && (
        <>
          <div style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 600, textAlign: 'right',
            padding: '6px 10px', background: 'rgba(217,119,6,0.10)', borderRadius: 6, marginBottom: 6 }}>
            ⚠ Vui lòng nhập tỷ giá để quy đổi Grand Total ({currencyKeys.join(' + ')})
          </div>
          {currencyKeys.map(cur => (
            <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>TỔNG {cur}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-2)' }}>
                {fmtAmount(perCurrency[cur], cur)} {cur}
              </span>
            </div>
          ))}
        </>
      )}
      {quote.grand_total_currency && grand != null && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-display)' }}>
            GRAND TOTAL
            {mixed && (
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-3)', marginLeft: 6 }}>
                (quy đổi tỷ giá 1 USD = {Number(quote.exchange_rate).toLocaleString('vi-VN')} VND)
              </span>
            )}
          </span>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-display)' }}>
            {fmtAmount(grand, quote.grand_total_currency)} {quote.grand_total_currency}
          </span>
        </div>
      )}
    </div>
  );
}

const TH_STYLE = {
  padding: '6px 8px', fontSize: 11, fontWeight: 700, color: 'var(--text-3)',
  textAlign: 'left', textTransform: 'uppercase', letterSpacing: '0.04em',
  background: '#f1f5f9', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap',
};
const TD_STYLE = {
  padding: '6px 8px', fontSize: 12, borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
};
const CELL_INPUT = { fontSize: 12, padding: '3px 6px', width: '100%', boxSizing: 'border-box' };

function ChargesTable({ rows, activeVehicles, vehicleQty, defaultUnit, defaultVat, onPatch, ctx }) {
  const ticked = rows.map((r, i) => ({ r, i })).filter(x => x.r.ticked);
  if (!ticked.length) return null;
  const showVehCols = activeVehicles.length > 0;
  return (
    <div style={{ overflowX: 'auto', marginBottom: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', borderRadius: 6 }}>
        <thead>
          <tr>
            <th rowSpan={2} style={TH_STYLE}>Chi phí</th>
            {showVehCols && activeVehicles.map(t => (
              <th key={t} colSpan={2}
                style={{ ...TH_STYLE, textAlign: 'center', borderBottom: '1px solid var(--border)' }}
                title={`Loại xe ${t}: SL = số xe, Đơn giá = rate/xe.`}>
                {t}
              </th>
            ))}
            <th rowSpan={2} style={TH_STYLE} title="Đơn giá cho phí trọn lô (SHPT/CHUYEN).">Đơn giá</th>
            <th rowSpan={2} style={{ ...TH_STYLE, whiteSpace: 'nowrap' }}>Đơn vị</th>
            <th rowSpan={2} style={TH_STYLE}>VAT%</th>
            <th rowSpan={2} style={TH_STYLE}>Ghi chú</th>
            <th rowSpan={2} style={{ ...TH_STYLE, textAlign: 'right' }}>Net</th>
            <th rowSpan={2} style={{ ...TH_STYLE, textAlign: 'right' }}>VAT</th>
            <th rowSpan={2} style={{ ...TH_STYLE, textAlign: 'right' }}>Line Total</th>
          </tr>
          {showVehCols && (
            <tr>
              {activeVehicles.map(t => (
                <React.Fragment key={t}>
                  <th style={{ ...TH_STYLE, textAlign: 'center', fontSize: 10, minWidth: 56, whiteSpace: 'nowrap' }}>SL (xe)</th>
                  <th style={{ ...TH_STYLE, textAlign: 'right',  fontSize: 10, minWidth: 76, whiteSpace: 'nowrap' }}>Đơn giá</th>
                </React.Fragment>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {ticked.map(({ r, i }) => {
            const unitOverridden = r.unit !== defaultUnit;
            const vatOverridden = r.vat !== defaultVat;
            const basis = unitBasis(r.unit);
            const isXe = basis === 'xe';
            const net = calcRowAmount(r, ctx);
            const vatAmt = calcRowVat(r, ctx);
            const lineTotal = calcRowTotal(r, ctx);
            const currency = unitToCurrency(r.unit);
            return (
              <tr key={`${r.custom ? 'c' : 'p'}-${i}`}>
                <td style={{ ...TD_STYLE, fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                {showVehCols && activeVehicles.map(t => (
                  <React.Fragment key={t}>
                    <td style={{ ...TD_STYLE, textAlign: 'center', whiteSpace: 'nowrap',
                      color: isXe ? 'var(--text)' : 'var(--text-3)',
                      fontWeight: isXe ? 600 : 400, minWidth: 56 }}>
                      {isXe ? (parseNum(vehicleQty[t]) || 0) : '—'}
                    </td>
                    <td style={{ ...TD_STYLE, whiteSpace: 'nowrap', minWidth: 76 }}>
                      {isXe ? (
                        <input className="form-input" type="number" min="0" step="any"
                          value={r.rate_by_break?.[t] || ''}
                          onChange={e => onPatch(i, {
                            rate_by_break: { ...(r.rate_by_break || {}), [t]: e.target.value },
                          })}
                          style={CELL_INPUT} />
                      ) : (
                        <span style={{ color: 'var(--text-3)', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>—</span>
                      )}
                    </td>
                  </React.Fragment>
                ))}
                <td style={TD_STYLE}>
                  {isXe ? (
                    <span style={{ color: 'var(--text-3)', fontStyle: 'italic', textAlign: 'center', display: 'block' }}>—</span>
                  ) : (
                    <input className="form-input" type="number" min="0" step="any"
                      value={r.rate || ''} onChange={e => onPatch(i, { rate: e.target.value })}
                      style={{ ...CELL_INPUT, minWidth: 80 }} placeholder="0" />
                  )}
                </td>
                <td style={{ ...TD_STYLE, whiteSpace: 'nowrap' }}>
                  <select value={r.unit} onChange={e => onPatch(i, { unit: e.target.value })}
                    style={{ ...CELL_INPUT, color: unitOverridden ? '#d97706' : 'inherit',
                      fontWeight: unitOverridden ? 600 : 400, minWidth: 130, whiteSpace: 'nowrap' }}>
                    {ROAD_UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </td>
                <td style={TD_STYLE}>
                  <select value={r.vat} onChange={e => onPatch(i, { vat: e.target.value })}
                    style={{ ...CELL_INPUT, color: vatOverridden ? '#d97706' : 'inherit',
                      fontWeight: vatOverridden ? 600 : 400 }}>
                    {VAT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td style={TD_STYLE}>
                  <input className="form-input"
                    value={r.note || ''} onChange={e => onPatch(i, { note: e.target.value })}
                    style={CELL_INPUT} placeholder="—" />
                </td>
                <td style={{ ...TD_STYLE, textAlign: 'right', whiteSpace: 'nowrap',
                  color: net > 0 ? 'var(--text-2)' : 'var(--text-3)' }}>
                  {net > 0 ? fmtAmount(net, currency) : '—'}
                </td>
                <td style={{ ...TD_STYLE, textAlign: 'right', whiteSpace: 'nowrap',
                  color: vatAmt > 0 ? 'var(--text-2)' : 'var(--text-3)' }}>
                  {net > 0 ? fmtAmount(vatAmt, currency) : '—'}
                </td>
                <td style={{ ...TD_STYLE, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700,
                  color: lineTotal > 0 ? 'var(--text)' : 'var(--text-3)' }}>
                  {lineTotal > 0 ? fmtAmount(lineTotal, currency) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{
        fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic',
        marginTop: 4, paddingLeft: 4,
      }}>
        Đơn vị quyết định cách tính: XE = theo loại xe × số xe, SHPT/CHUYEN = trọn lô.
        Net = đơn giá × số lượng. Line Total đã gồm VAT.
        Số xe nhập 1 lần ở phần "Loại xe + Số lượng" phía trên.
      </div>
    </div>
  );
}
