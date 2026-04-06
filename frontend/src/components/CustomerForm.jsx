import { useState } from 'react';
import QuoteForm, { EMPTY_QUOTE } from './QuoteForm';

const EMPTY_CUSTOMER = {
  company_name: '', contact_person: '', phone: '',
  source: 'cold_call', industry: '', interaction_type: 'contacted',
  needs: '', notes: '', next_action: '', follow_up_date: '',
  quotes: [],
};

export { EMPTY_CUSTOMER };

const SOURCE_OPTIONS = [
  { value: 'cold_call', label: '📞 Cold Call' },
  { value: 'zalo_facebook', label: '💬 Zalo/Facebook' },
  { value: 'referral', label: '🤝 Referral' },
  { value: 'email', label: '📧 Email' },
  { value: 'direct', label: '🤝 Gặp trực tiếp' },
  { value: 'other', label: '💡 Khác' },
];

export default function CustomerForm({ customer, onChange, onRemove, index }) {
  const c = customer;
  const set = (field, value) => onChange({ ...c, [field]: value });

  const addQuote = () => set('quotes', [...(c.quotes || []), { ...EMPTY_QUOTE }]);
  const updateQuote = (i, q) => {
    const quotes = [...(c.quotes || [])];
    quotes[i] = q;
    set('quotes', quotes);
  };
  const removeQuote = (i) => set('quotes', (c.quotes || []).filter((_, idx) => idx !== i));

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: 20,
      marginBottom: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h4 style={{ fontSize: 15, fontFamily: 'var(--font-display)' }}>
          Khách hàng #{index + 1}
          {c.company_name && <span style={{ color: 'var(--primary)', marginLeft: 8 }}>— {c.company_name}</span>}
        </h4>
        {onRemove && (
          <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>Xóa khách</button>
        )}
      </div>

      {/* Basic info */}
      <div className="grid-3" style={{ gap: 12, marginBottom: 12 }}>
        <div className="form-group">
          <label className="form-label">Tên công ty *</label>
          <input className="form-input" placeholder="Công ty TNHH..." required value={c.company_name} onChange={e => set('company_name', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Người liên hệ</label>
          <input className="form-input" placeholder="Anh Minh, Chị Lan..." value={c.contact_person} onChange={e => set('contact_person', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Số điện thoại</label>
          <input className="form-input" placeholder="09xx xxx xxx" value={c.phone} onChange={e => set('phone', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Nguồn</label>
          <select className="form-select" value={c.source} onChange={e => set('source', e.target.value)}>
            {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Ngành hàng</label>
          <input className="form-input" placeholder="Dệt may, điện tử, gỗ..." value={c.industry} onChange={e => set('industry', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Follow up date</label>
          <input type="date" className="form-input" value={c.follow_up_date} onChange={e => set('follow_up_date', e.target.value)} />
        </div>
      </div>

      {/* Interaction type */}
      <div className="form-group" style={{ marginBottom: 16 }}>
        <label className="form-label">Trạng thái tương tác *</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { key: 'saved', label: '📌 Lưu liên hệ', sub: 'Chưa liên hệ được' },
            { key: 'contacted', label: '📞 Đã liên hệ', sub: 'Chưa báo giá' },
            { key: 'quoted', label: '📋 Đã báo giá', sub: 'Có báo giá' },
          ].map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => set('interaction_type', t.key)}
              style={{
                padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                background: c.interaction_type === t.key ? 'var(--primary-dim)' : 'transparent',
                border: `1px solid ${c.interaction_type === t.key ? 'var(--primary)' : 'var(--border)'}`,
                color: c.interaction_type === t.key ? 'var(--primary)' : 'var(--text-2)',
                textAlign: 'left', fontFamily: 'var(--font)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</div>
              <div style={{ fontSize: 11, marginTop: 2 }}>{t.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="grid-2" style={{ gap: 12, marginBottom: 12 }}>
        {c.interaction_type !== 'saved' && (
          <div className="form-group">
            <label className="form-label">Nhu cầu khách</label>
            <textarea className="form-textarea" rows={2} placeholder="Nhu cầu vận chuyển, hàng hóa, route..." value={c.needs} onChange={e => set('needs', e.target.value)} />
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Ghi chú</label>
          <textarea className="form-textarea" rows={2} placeholder="Thông tin bổ sung, tình trạng trao đổi..." value={c.notes} onChange={e => set('notes', e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Hành động tiếp theo</label>
          <textarea className="form-textarea" rows={2} placeholder="Sẽ gọi lại, gửi báo giá, đặt lịch gặp..." value={c.next_action} onChange={e => set('next_action', e.target.value)} />
        </div>
      </div>

      {/* Quotes section */}
      {c.interaction_type === 'quoted' && (
        <div>
          <div className="divider" />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div className="section-title" style={{ margin: 0 }}>
              Báo giá ({(c.quotes || []).length})
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={addQuote}>
              + Thêm báo giá
            </button>
          </div>

          {(c.quotes || []).length === 0 ? (
            <div style={{
              border: '1px dashed var(--border)', borderRadius: 10,
              padding: '20px', textAlign: 'center', color: 'var(--text-2)', fontSize: 13,
            }}>
              Chưa có báo giá. <button type="button" onClick={addQuote} style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>Thêm ngay</button>
            </div>
          ) : (
            (c.quotes || []).map((q, i) => (
              <QuoteForm key={i} quote={q} index={i} onChange={(updated) => updateQuote(i, updated)} onRemove={() => removeQuote(i)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
