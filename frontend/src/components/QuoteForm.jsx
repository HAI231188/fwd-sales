const EMPTY_OPTION = { carrier: '', price: '', cost: '' };

const EMPTY_QUOTE = {
  cargo_name: '', monthly_volume_cbm: '', monthly_volume_kg: '',
  monthly_volume_containers: '', route: '', cargo_ready_date: '',
  mode: 'sea', transit_time: '',
  options: [
    { ...EMPTY_OPTION },
    { ...EMPTY_OPTION },
    { ...EMPTY_OPTION },
    { ...EMPTY_OPTION },
    { ...EMPTY_OPTION },
  ],
  status: 'quoting', follow_up_notes: '', lost_reason: '', closing_soon: false,
};

export default function QuoteForm({ quote, onChange, onRemove, index }) {
  const q = quote;
  const set = (field, value) => onChange({ ...q, [field]: value });

  const options = q.options || EMPTY_QUOTE.options;
  const setOption = (i, field, value) => {
    const next = options.map((opt, idx) => idx === i ? { ...opt, [field]: value } : opt);
    onChange({ ...q, options: next });
  };

  return (
    <div style={{
      background: '#f8f9fa',
      border: '1px solid var(--border)',
      borderRadius: 12,
      padding: 20,
      marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--font-display)' }}>
          Báo giá #{index + 1}
          {q.closing_soon && <span className="badge badge-warning" style={{ marginLeft: 8 }}>⚡ Sắp chốt</span>}
        </span>
        {onRemove && (
          <button type="button" className="btn btn-danger btn-sm btn-icon" onClick={onRemove}>✕</button>
        )}
      </div>

      {/* Mode selector */}
      <div className="form-group" style={{ marginBottom: 16 }}>
        <label className="form-label">Loại vận chuyển *</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { key: 'sea', label: '🚢 Đường biển' },
            { key: 'air', label: '✈️ Hàng không' },
            { key: 'road', label: '🚛 Đường bộ' },
          ].map(m => (
            <button
              key={m.key}
              type="button"
              onClick={() => set('mode', m.key)}
              className="btn btn-sm"
              style={{
                background: q.mode === m.key ? 'var(--primary)' : 'transparent',
                color: q.mode === m.key ? '#fff' : 'var(--text-2)',
                border: `1px solid ${q.mode === m.key ? 'var(--primary)' : 'var(--border)'}`,
              }}
            >{m.label}</button>
          ))}
        </div>
      </div>

      {/* Cargo & route */}
      <div className="grid-2" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label className="form-label">Tên hàng</label>
          <input className="form-input" placeholder="VD: Hàng dệt may, điện tử..." value={q.cargo_name} onChange={e => set('cargo_name', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Luồng tuyến</label>
          <input className="form-input" placeholder="VD: HCM → Germany" value={q.route} onChange={e => set('route', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Sản lượng CBM/tháng</label>
          <input type="number" className="form-input" placeholder="CBM" value={q.monthly_volume_cbm} onChange={e => set('monthly_volume_cbm', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Sản lượng KG/tháng</label>
          <input type="number" className="form-input" placeholder="KG" value={q.monthly_volume_kg} onChange={e => set('monthly_volume_kg', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Containers/tháng</label>
          <input className="form-input" placeholder="VD: 2x20', 3x40HC" value={q.monthly_volume_containers} onChange={e => set('monthly_volume_containers', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Ngày xong hàng</label>
          <input type="date" className="form-input" value={q.cargo_ready_date} onChange={e => set('cargo_ready_date', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Transit time</label>
          <input className="form-input" placeholder="VD: 28-30 ngày" value={q.transit_time} onChange={e => set('transit_time', e.target.value)} />
        </div>
      </div>

      {/* ── 5 Phương án rows ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '80px 1fr 1fr 1fr',
          gap: 8,
          marginBottom: 6,
          padding: '0 4px',
        }}>
          <div />
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Hãng tàu / Hãng bay
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Giá báo
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Cost giá
          </div>
        </div>

        {options.map((opt, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '80px 1fr 1fr 1fr',
            gap: 8,
            marginBottom: 6,
            alignItems: 'center',
          }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: 'var(--primary)',
              background: 'var(--primary-dim)',
              borderRadius: 6, padding: '4px 8px', textAlign: 'center',
              whiteSpace: 'nowrap',
            }}>
              PA {i + 1}
            </div>
            <input
              className="form-input"
              placeholder="VD: MSC, Vietnam Airlines..."
              value={opt.carrier}
              onChange={e => setOption(i, 'carrier', e.target.value)}
              style={{ fontSize: 13 }}
            />
            <input
              className="form-input"
              placeholder="VD: USD 2,200/40HC"
              value={opt.price}
              onChange={e => setOption(i, 'price', e.target.value)}
              style={{ fontSize: 13 }}
            />
            <input
              className="form-input"
              placeholder="VD: USD 1,900/40HC"
              value={opt.cost}
              onChange={e => setOption(i, 'cost', e.target.value)}
              style={{ fontSize: 13 }}
            />
          </div>
        ))}
      </div>

      {/* Status & closing soon */}
      <div className="grid-2" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label className="form-label">Trạng thái *</label>
          <select className="form-select" value={q.status} onChange={e => set('status', e.target.value)}>
            <option value="quoting">Đang báo giá</option>
            <option value="follow_up">Follow Up</option>
            <option value="booked">Đã Booking</option>
            <option value="lost">Lost</option>
          </select>
        </div>
        <div className="form-group" style={{ justifyContent: 'flex-end' }}>
          <label className="checkbox-wrap" style={{ marginTop: 28 }}>
            <input type="checkbox" checked={q.closing_soon} onChange={e => set('closing_soon', e.target.checked)} />
            <span style={{ fontSize: 14 }}>⚡ Sắp chốt (closing soon)</span>
          </label>
        </div>
      </div>

      <div className="form-group" style={{ marginBottom: q.status === 'lost' ? 12 : 0 }}>
        <label className="form-label">Ghi chú follow up</label>
        <textarea className="form-textarea" rows={2} placeholder="Tình trạng theo dõi, ghi chú..." value={q.follow_up_notes} onChange={e => set('follow_up_notes', e.target.value)} />
      </div>

      {q.status === 'lost' && (
        <div className="form-group">
          <label className="form-label" style={{ color: 'var(--danger)' }}>Lý do lost</label>
          <input className="form-input" placeholder="VD: Giá cao hơn competitor, hết nhu cầu..." value={q.lost_reason} onChange={e => set('lost_reason', e.target.value)} />
        </div>
      )}
    </div>
  );
}

export { EMPTY_QUOTE };
