// SeaQuoteForm — structured sea-freight quote authoring form (2026-05-26, C1).
// Replaces the legacy 5-PA QuoteForm for mode='sea' + interaction_type='quoted'.
// Saves to quotes.quote_data (JSONB) with version: 2.
//
// C1 scope:
//   - FCL cargo type only (LCL UI deferred to C2)
//   - Form renders + serializes to quote_data
//   - Amount column: read-only placeholder "—" (calc deferred to C2)
//   - No PDF export (deferred to C3)
//
// Owner spec answers baked in (2026-05-26):
//   - FCL cont selector mirrors CreateJobModal.jsx quantity matrix
//   - Tick grid: 4-col, ticked = blue highlight, unticked = gray
//   - Default unit/VAT bar: dropdowns; on change applies to all rows;
//     row override shows orange text in the row's unit/vat cell
//   - Intl default: USD/cont + 0% VAT
//   - Inland default: VND/cont + 10% VAT
//   - Term pills: EXW/FCA/FOB/CFR/CIF/DAP/DDP + 1 custom input
//   - Grand total currency: USD / VND / (none — no total shown)

import { useState, useEffect } from 'react';

const CONT_TYPES = ['20DC', '40DC', '40HC', '45HC', '20RF', '40RF'];
const ZERO_QTY = () => Object.fromEntries(CONT_TYPES.map(t => [t, 0]));

const TERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'];

// 14 international charge names per spec.
const INTL_CHARGE_NAMES = [
  'EXW Charge', 'FCA Charge', 'DAP Charge', 'Ocean Freight',
  'THC', 'DO', 'CIC', 'CFS',
  'Clean', 'EMC', 'Bill', 'Seal',
  'Telex', 'Handling',
];
// 12 inland charge names per spec.
const INLAND_CHARGE_NAMES = [
  'Customs', 'Trucking', 'Nâng hàng', 'Hạ hàng',
  'Lưu bãi', 'Lưu cont', 'Lưu kho', 'Bốc xếp',
  'Kiểm dịch', 'Hun trùng', 'KTCL', 'Khai báo hóa chất',
];

const UNIT_OPTIONS = [
  'USD/cont', 'USD/CBM', 'USD/B/L', 'USD/shipment',
  'VND/cont', 'VND/CBM', 'VND/B/L', 'VND/shipment',
];
const VAT_OPTIONS = ['0%', '8%', '10%', 'KCT'];

const INTL_DEFAULT_UNIT = 'USD/cont';
const INTL_DEFAULT_VAT = '0%';
const INLAND_DEFAULT_UNIT = 'VND/cont';
const INLAND_DEFAULT_VAT = '10%';

function buildIntlChargeRow(name, unit, vat) {
  return {
    name, ticked: false,
    price_by_cont: {}, // { '20DC': '500', '40HC': '700', ... }
    unit, vat, note: '', amount: null,
  };
}
function buildInlandChargeRow(name, unit, vat) {
  return {
    name, ticked: false,
    price: '', cbm: '',
    unit, vat, note: '', amount: null,
  };
}

export const EMPTY_SEA_QUOTE = {
  version: 2,
  mode: 'sea',
  cargo_type: 'FCL',
  containers: [], // [{ type: '20DC', qty: 2 }, ...] — derived from contQty matrix on save
  pol: '', pod: '', term: 'FOB',
  valid_until: '',
  exchange_rate: '',
  grand_total_currency: null, // 'USD' | 'VND' | null (= no total shown)
  intl_default_unit: INTL_DEFAULT_UNIT,
  intl_default_vat: INTL_DEFAULT_VAT,
  inland_default_unit: INLAND_DEFAULT_UNIT,
  inland_default_vat: INLAND_DEFAULT_VAT,
  intl_charges: INTL_CHARGE_NAMES.map(n => buildIntlChargeRow(n, INTL_DEFAULT_UNIT, INTL_DEFAULT_VAT)),
  inland_charges: INLAND_CHARGE_NAMES.map(n => buildInlandChargeRow(n, INLAND_DEFAULT_UNIT, INLAND_DEFAULT_VAT)),
  notes: '',
};

// ─── Shared sub-components ───────────────────────────────────────────────

function TickGrid({ rows, onToggle }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
      padding: 12, background: 'var(--bg)', borderRadius: 8,
      border: '1px solid var(--border)', marginBottom: 12,
    }}>
      {rows.map((r, idx) => (
        <label key={r.name} style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
          padding: '6px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500,
          background: r.ticked ? 'rgba(59,130,246,0.12)' : 'transparent',
          color: r.ticked ? '#1d4ed8' : 'var(--text-2)',
          border: `1px solid ${r.ticked ? '#3b82f6' : 'transparent'}`,
          transition: 'background 0.1s',
        }}>
          <input type="checkbox" checked={r.ticked}
            onChange={() => onToggle(idx)}
            style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#3b82f6' }} />
          <span>{r.name}</span>
        </label>
      ))}
    </div>
  );
}

function DefaultBar({ unitLabel, unit, vat, onUnitChange, onVatChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '8px 12px', background: '#f8fafc', borderRadius: 6,
      border: '1px dashed var(--border)', marginBottom: 8, fontSize: 12,
    }}>
      <span style={{ color: 'var(--text-2)', fontWeight: 500 }}>Mặc định:</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{unitLabel || 'Đơn vị'}:</span>
        <select className="form-select" value={unit} onChange={e => onUnitChange(e.target.value)}
          style={{ fontSize: 12, padding: '2px 6px', height: 28, minWidth: 110 }}>
          {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>VAT:</span>
        <select className="form-select" value={vat} onChange={e => onVatChange(e.target.value)}
          style={{ fontSize: 12, padding: '2px 6px', height: 28, minWidth: 70 }}>
          {VAT_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <span style={{ color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' }}>
        (Thay đổi sẽ áp cho mọi dòng; chỉnh từng dòng để override — hiện chữ cam)
      </span>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────

export default function SeaQuoteForm({ value, onChange }) {
  const v = value || EMPTY_SEA_QUOTE;

  // contQty is the source-of-truth for FCL row count + types.
  // Derived from v.containers on mount; serialized back via setContainers().
  const [contQty, setContQty] = useState(() => {
    const init = ZERO_QTY();
    (v.containers || []).forEach(c => { if (init[c.type] !== undefined) init[c.type] = c.qty || 0; });
    return init;
  });

  // Push contQty → v.containers whenever the matrix changes.
  useEffect(() => {
    const containers = CONT_TYPES.map(t => ({ type: t, qty: contQty[t] || 0 }))
      .filter(c => c.qty > 0);
    onChange({ ...v, containers });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(contQty)]);

  const totalCont = Object.values(contQty).reduce((s, n) => s + (Number(n) || 0), 0);
  const activeContTypes = CONT_TYPES.filter(t => (contQty[t] || 0) > 0);

  const set = (field, val) => onChange({ ...v, [field]: val });

  function setContQtyValue(type, raw) {
    const n = Math.max(0, parseInt(raw, 10) || 0);
    setContQty(prev => ({ ...prev, [type]: n }));
  }

  // ─── Default-bar handlers — write the default + propagate to every row.
  function setIntlDefaultUnit(unit) {
    onChange({
      ...v,
      intl_default_unit: unit,
      intl_charges: v.intl_charges.map(r => ({ ...r, unit })),
    });
  }
  function setIntlDefaultVat(vat) {
    onChange({
      ...v,
      intl_default_vat: vat,
      intl_charges: v.intl_charges.map(r => ({ ...r, vat })),
    });
  }
  function setInlandDefaultUnit(unit) {
    onChange({
      ...v,
      inland_default_unit: unit,
      inland_charges: v.inland_charges.map(r => ({ ...r, unit })),
    });
  }
  function setInlandDefaultVat(vat) {
    onChange({
      ...v,
      inland_default_vat: vat,
      inland_charges: v.inland_charges.map(r => ({ ...r, vat })),
    });
  }

  // ─── Row-level mutators
  function toggleIntl(idx) {
    onChange({
      ...v,
      intl_charges: v.intl_charges.map((r, i) => i === idx ? { ...r, ticked: !r.ticked } : r),
    });
  }
  function toggleInland(idx) {
    onChange({
      ...v,
      inland_charges: v.inland_charges.map((r, i) => i === idx ? { ...r, ticked: !r.ticked } : r),
    });
  }
  function patchIntlRow(idx, patch) {
    onChange({
      ...v,
      intl_charges: v.intl_charges.map((r, i) => i === idx ? { ...r, ...patch } : r),
    });
  }
  function patchInlandRow(idx, patch) {
    onChange({
      ...v,
      inland_charges: v.inland_charges.map((r, i) => i === idx ? { ...r, ...patch } : r),
    });
  }

  return (
    <div style={{
      background: '#f8f9fa', border: '1px solid var(--border)', borderRadius: 12,
      padding: 20, marginBottom: 12,
    }}>
      {/* ─── Header ─── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-display)' }}>
          🚢 Báo giá đường biển
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>v2</span>
      </div>

      {/* ─── POL / POD / cargo type ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 140px', gap: 12, marginBottom: 12 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">POL (cảng đi)</label>
          <input className="form-input" value={v.pol} onChange={e => set('pol', e.target.value)}
            placeholder="VD: HCM" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">POD (cảng đến)</label>
          <input className="form-input" value={v.pod} onChange={e => set('pod', e.target.value)}
            placeholder="VD: Hamburg" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Loại hàng</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['FCL', 'LCL'].map(ct => (
              <button key={ct} type="button"
                onClick={() => set('cargo_type', ct)}
                className="btn btn-sm"
                style={{
                  flex: 1,
                  background: v.cargo_type === ct ? 'var(--primary)' : 'transparent',
                  color: v.cargo_type === ct ? '#fff' : 'var(--text-2)',
                  border: `1px solid ${v.cargo_type === ct ? 'var(--primary)' : 'var(--border)'}`,
                  fontSize: 12,
                }}>{ct}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ─── FCL container matrix (mirrors CreateJobModal) ─── */}
      {v.cargo_type === 'FCL' && (
        <div style={{
          padding: 12, background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 8, marginBottom: 12,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
            Số lượng cont theo loại
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {CONT_TYPES.map(t => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ minWidth: 48, fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{t}:</span>
                <input type="number" min="0" step="1" className="form-input"
                  value={contQty[t] || 0}
                  onChange={e => setContQtyValue(t, e.target.value)}
                  style={{ width: 70, fontSize: 13, padding: '4px 8px' }} />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
            Tổng: <strong style={{ color: 'var(--text)' }}>{totalCont}</strong> cont
          </div>
        </div>
      )}
      {v.cargo_type === 'LCL' && (
        <div style={{
          padding: 12, background: 'rgba(217,119,6,0.08)', borderRadius: 8,
          border: '1px dashed var(--warning)', marginBottom: 12,
          fontSize: 12, color: 'var(--warning)', fontStyle: 'italic',
        }}>
          ⚠ LCL form sẽ build ở C2 (đơn giá × CBM). Tạm thời chọn FCL để tiếp tục.
        </div>
      )}

      {/* ─── Term pills + custom ─── */}
      <div className="form-group" style={{ marginBottom: 12 }}>
        <label className="form-label">Điều kiện giao hàng (Term)</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {TERMS.map(t => (
            <button key={t} type="button"
              onClick={() => set('term', t)}
              className="btn btn-sm"
              style={{
                background: v.term === t ? 'var(--primary)' : 'transparent',
                color: v.term === t ? '#fff' : 'var(--text-2)',
                border: `1px solid ${v.term === t ? 'var(--primary)' : 'var(--border)'}`,
                fontSize: 12, padding: '4px 12px',
              }}>{t}</button>
          ))}
          <input className="form-input"
            placeholder="Khác..."
            value={!TERMS.includes(v.term) ? (v.term || '') : ''}
            onChange={e => set('term', e.target.value)}
            style={{ width: 140, fontSize: 12, padding: '4px 10px' }} />
        </div>
      </div>

      {/* ─── Exchange rate + Valid until + Grand total currency ─── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Tỷ giá (1 USD =</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" className="form-input"
              value={v.exchange_rate} onChange={e => set('exchange_rate', e.target.value)}
              placeholder="24,500" />
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
            {[
              { key: 'USD', label: 'USD' },
              { key: 'VND', label: 'VND' },
              { key: null,  label: 'Không' },
            ].map(opt => (
              <button key={String(opt.key)} type="button"
                onClick={() => set('grand_total_currency', opt.key)}
                className="btn btn-sm"
                style={{
                  flex: 1,
                  background: v.grand_total_currency === opt.key ? 'var(--primary)' : 'transparent',
                  color: v.grand_total_currency === opt.key ? '#fff' : 'var(--text-2)',
                  border: `1px solid ${v.grand_total_currency === opt.key ? 'var(--primary)' : 'var(--border)'}`,
                  fontSize: 11, padding: '4px 6px',
                }}>{opt.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ═══════════ INTERNATIONAL CHARGES ═══════════ */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>
          🌐 Phí quốc tế (International Charges)
        </div>
        <TickGrid rows={v.intl_charges} onToggle={toggleIntl} />
        <DefaultBar
          unitLabel="Đơn vị"
          unit={v.intl_default_unit}
          vat={v.intl_default_vat}
          onUnitChange={setIntlDefaultUnit}
          onVatChange={setIntlDefaultVat}
        />
        {v.intl_charges.some(r => r.ticked) && (
          <IntlChargesTable
            rows={v.intl_charges}
            activeContTypes={activeContTypes}
            defaultUnit={v.intl_default_unit}
            defaultVat={v.intl_default_vat}
            onPatch={patchIntlRow}
          />
        )}
      </div>

      {/* ═══════════ INLAND CHARGES ═══════════ */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontFamily: 'var(--font-display)' }}>
          🇻🇳 Phí nội địa (Inland Charges)
        </div>
        <TickGrid rows={v.inland_charges} onToggle={toggleInland} />
        <DefaultBar
          unitLabel="Đơn vị"
          unit={v.inland_default_unit}
          vat={v.inland_default_vat}
          onUnitChange={setInlandDefaultUnit}
          onVatChange={setInlandDefaultVat}
        />
        {v.inland_charges.some(r => r.ticked) && (
          <InlandChargesTable
            rows={v.inland_charges}
            defaultUnit={v.inland_default_unit}
            defaultVat={v.inland_default_vat}
            onPatch={patchInlandRow}
          />
        )}
      </div>

      {/* ─── Notes ─── */}
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">Ghi chú chung</label>
        <textarea className="form-textarea" rows={2}
          value={v.notes} onChange={e => set('notes', e.target.value)}
          placeholder="Điều kiện thanh toán, lưu ý cho khách..." />
      </div>
    </div>
  );
}

// ─── Charge tables ──────────────────────────────────────────────────────

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

function IntlChargesTable({ rows, activeContTypes, defaultUnit, defaultVat, onPatch }) {
  const ticked = rows.map((r, i) => ({ r, i })).filter(x => x.r.ticked);
  if (!ticked.length) return null;
  return (
    <div style={{ overflowX: 'auto', marginBottom: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', borderRadius: 6 }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Chi phí</th>
            {activeContTypes.length > 0 ? (
              activeContTypes.map(t => <th key={t} style={TH_STYLE}>{t}</th>)
            ) : (
              <th style={TH_STYLE}>Đơn giá (chưa chọn cont)</th>
            )}
            <th style={TH_STYLE}>Đơn vị</th>
            <th style={TH_STYLE}>VAT</th>
            <th style={TH_STYLE}>Ghi chú</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {ticked.map(({ r, i }) => {
            const unitOverridden = r.unit !== defaultUnit;
            const vatOverridden = r.vat !== defaultVat;
            return (
              <tr key={r.name}>
                <td style={{ ...TD_STYLE, fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                {activeContTypes.length > 0 ? activeContTypes.map(t => (
                  <td key={t} style={TD_STYLE}>
                    <input className="form-input" type="number"
                      value={r.price_by_cont?.[t] || ''}
                      onChange={e => onPatch(i, {
                        price_by_cont: { ...(r.price_by_cont || {}), [t]: e.target.value },
                      })}
                      style={CELL_INPUT} />
                  </td>
                )) : (
                  <td style={{ ...TD_STYLE, color: 'var(--text-3)', fontStyle: 'italic' }}>—</td>
                )}
                <td style={TD_STYLE}>
                  <select value={r.unit} onChange={e => onPatch(i, { unit: e.target.value })}
                    style={{ ...CELL_INPUT, color: unitOverridden ? '#d97706' : 'inherit',
                      fontWeight: unitOverridden ? 600 : 400 }}>
                    {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
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
                <td style={{ ...TD_STYLE, textAlign: 'right', color: 'var(--text-3)', fontStyle: 'italic' }}>—</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic', padding: '4px 8px' }}>
        Amount sẽ auto-calc ở C2 (sau khi nhập đơn giá theo loại cont).
      </div>
    </div>
  );
}

function InlandChargesTable({ rows, defaultUnit, defaultVat, onPatch }) {
  const ticked = rows.map((r, i) => ({ r, i })).filter(x => x.r.ticked);
  if (!ticked.length) return null;
  return (
    <div style={{ overflowX: 'auto', marginBottom: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', borderRadius: 6 }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Chi phí</th>
            <th style={TH_STYLE}>Đơn giá</th>
            <th style={TH_STYLE}>CBM</th>
            <th style={TH_STYLE}>Đơn vị</th>
            <th style={TH_STYLE}>VAT</th>
            <th style={TH_STYLE}>Ghi chú</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {ticked.map(({ r, i }) => {
            const unitOverridden = r.unit !== defaultUnit;
            const vatOverridden = r.vat !== defaultVat;
            return (
              <tr key={r.name}>
                <td style={{ ...TD_STYLE, fontWeight: 600, color: 'var(--text)' }}>{r.name}</td>
                <td style={TD_STYLE}>
                  <input className="form-input" type="number"
                    value={r.price || ''} onChange={e => onPatch(i, { price: e.target.value })}
                    style={CELL_INPUT} />
                </td>
                <td style={TD_STYLE}>
                  <input className="form-input" type="number"
                    value={r.cbm || ''} onChange={e => onPatch(i, { cbm: e.target.value })}
                    style={CELL_INPUT} placeholder="—" />
                </td>
                <td style={TD_STYLE}>
                  <select value={r.unit} onChange={e => onPatch(i, { unit: e.target.value })}
                    style={{ ...CELL_INPUT, color: unitOverridden ? '#d97706' : 'inherit',
                      fontWeight: unitOverridden ? 600 : 400 }}>
                    {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
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
                <td style={{ ...TD_STYLE, textAlign: 'right', color: 'var(--text-3)', fontStyle: 'italic' }}>—</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic', padding: '4px 8px' }}>
        Amount sẽ auto-calc ở C2 (đơn giá × CBM).
      </div>
    </div>
  );
}
