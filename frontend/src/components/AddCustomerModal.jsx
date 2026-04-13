import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { quickAddCustomer } from '../api';
import QuoteForm, { EMPTY_QUOTE } from './QuoteForm';

const SOURCE_OPTIONS = [
  { value: '', label: '— Chọn nguồn —' },
  { value: 'cold_call', label: '📞 Cold Call' },
  { value: 'zalo_facebook', label: '💬 Zalo/Facebook' },
  { value: 'referral', label: '🤝 Referral' },
  { value: 'email', label: '📧 Email' },
  { value: 'direct', label: '🤝 Gặp trực tiếp' },
  { value: 'other', label: '💡 Khác' },
];

const EMPTY = {
  company_name: '', contact_person: '', phone: '', source: '', industry: '',
  interaction_type: 'contacted',
  needs: '', notes: '', next_action: '', follow_up_date: '',
  potential_level: '', decision_maker: false, preferred_contact: '',
  estimated_value: '', competitor: '', reason_not_closed: '',
  address: '', tax_code: '',
};

function serializeQuotes(quotes) {
  return quotes.map(q => ({
    cargo_name: q.cargo_name || null,
    monthly_volume_cbm: q.monthly_volume_cbm || null,
    monthly_volume_kg: q.monthly_volume_kg || null,
    monthly_volume_containers: q.monthly_volume_containers || null,
    route: q.route || null,
    cargo_ready_date: q.cargo_ready_date || null,
    mode: q.mode || 'sea',
    carrier: q.options?.[0]?.carrier || '',
    price: JSON.stringify(q.options || []),
    transit_time: q.transit_time || null,
    status: q.status || 'quoting',
    follow_up_notes: q.follow_up_notes || null,
    lost_reason: q.lost_reason || null,
    closing_soon: q.closing_soon || false,
  }));
}

export default function AddCustomerModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ ...EMPTY });
  const [quotes, setQuotes] = useState([]);
  const [extraOpen, setExtraOpen] = useState(false);
  const [savedCode, setSavedCode] = useState(null);
  const [savedName, setSavedName] = useState('');

  const set = (field, val) => setForm(f => ({ ...f, [field]: val }));

  const mutation = useMutation({
    mutationFn: () => quickAddCustomer({
      ...form,
      quotes: form.interaction_type === 'quoted' ? serializeQuotes(quotes) : [],
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      if (data?.customer_code) {
        setSavedCode(data.customer_code);
        setSavedName(form.company_name);
      } else {
        toast.success('Đã thêm khách hàng');
        onClose();
      }
    },
    onError: (err) => toast.error(err?.error || 'Thêm khách hàng thất bại'),
  });

  if (savedCode) {
    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '32px 16px',
        }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{
          background: 'var(--bg-card)', borderRadius: 16,
          width: '100%', maxWidth: 400,
          boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
          padding: '40px 32px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 6, fontFamily: 'var(--font-display)' }}>
            Đã thêm khách hàng
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 20 }}>{savedName}</div>
          <div style={{
            display: 'inline-block',
            padding: '10px 24px', borderRadius: 10,
            background: 'var(--primary-dim)', border: '1.5px solid var(--primary)',
            marginBottom: 28,
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>Mã khách hàng</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--primary)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{savedCode}</div>
          </div>
          <div>
            <button type="button" className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>
              Đóng
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16,
        width: '100%', maxWidth: 580,
        boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontWeight: 700, fontSize: 16, fontFamily: 'var(--font-display)' }}>
            🆕 Thêm khách hàng mới
          </span>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-2)', padding: 4, lineHeight: 1 }}>
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
          {/* Company */}
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">Tên công ty *</label>
            <input className="form-input" value={form.company_name}
              onChange={e => set('company_name', e.target.value)}
              placeholder="VD: Công ty TNHH ABC" autoFocus />
          </div>

          <div className="grid-2" style={{ gap: 12, marginBottom: 14 }}>
            <div className="form-group">
              <label className="form-label">Người liên hệ</label>
              <input className="form-input" value={form.contact_person}
                onChange={e => set('contact_person', e.target.value)}
                placeholder="Nguyễn Văn A" />
            </div>
            <div className="form-group">
              <label className="form-label">Điện thoại</label>
              <input className="form-input" value={form.phone}
                onChange={e => set('phone', e.target.value)}
                placeholder="0901234567" />
            </div>
            <div className="form-group">
              <label className="form-label">Ngành hàng</label>
              <input className="form-input" value={form.industry}
                onChange={e => set('industry', e.target.value)}
                placeholder="Dệt may, Điện tử..." />
            </div>
            <div className="form-group">
              <label className="form-label">Nguồn</label>
              <select className="form-select" value={form.source} onChange={e => set('source', e.target.value)}>
                {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Mã số thuế</label>
              <input className="form-input" value={form.tax_code}
                onChange={e => set('tax_code', e.target.value)}
                placeholder="0123456789" />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Địa chỉ</label>
              <input className="form-input" value={form.address}
                onChange={e => set('address', e.target.value)}
                placeholder="Số nhà, đường, quận, tỉnh/thành phố..." />
            </div>
          </div>

          {/* Interaction type */}
          <div className="form-group" style={{ marginBottom: 14 }}>
            <label className="form-label">Loại tương tác *</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { key: 'saved',     label: '📌 Lưu liên hệ' },
                { key: 'contacted', label: '📞 Đã liên hệ' },
                { key: 'quoted',    label: '📋 Đã báo giá' },
              ].map(t => (
                <button key={t.key} type="button"
                  onClick={() => set('interaction_type', t.key)}
                  className="btn btn-sm"
                  style={{
                    background: form.interaction_type === t.key ? 'var(--primary)' : 'transparent',
                    color:      form.interaction_type === t.key ? '#fff' : 'var(--text-2)',
                    border: `1px solid ${form.interaction_type === t.key ? 'var(--primary)' : 'var(--border)'}`,
                  }}
                >{t.label}</button>
              ))}
            </div>
          </div>

          <div className="grid-2" style={{ gap: 12, marginBottom: 14 }}>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Nhu cầu</label>
              <textarea className="form-textarea" rows={2} value={form.needs}
                onChange={e => set('needs', e.target.value)}
                placeholder="Nhu cầu vận chuyển của khách..." />
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Ghi chú</label>
              <textarea className="form-textarea" rows={2} value={form.notes}
                onChange={e => set('notes', e.target.value)}
                placeholder="Kết quả cuộc trao đổi, ghi chú thêm..." />
            </div>
            <div className="form-group">
              <label className="form-label">Hành động tiếp theo</label>
              <input className="form-input" value={form.next_action}
                onChange={e => set('next_action', e.target.value)}
                placeholder="Gửi báo giá, hẹn gặp..." />
            </div>
            <div className="form-group">
              <label className="form-label">Ngày follow up</label>
              <input type="date" className="form-input" value={form.follow_up_date}
                onChange={e => set('follow_up_date', e.target.value)} />
            </div>
          </div>

          {/* Thông tin bổ sung (collapsible) */}
          <div style={{ marginBottom: 14 }}>
            <button
              type="button"
              onClick={() => setExtraOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, color: 'var(--text-2)',
                padding: '4px 0', fontFamily: 'var(--font)',
              }}
            >
              <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform 0.15s', transform: extraOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
              Thông tin bổ sung
              {(form.potential_level || form.decision_maker || form.preferred_contact || form.estimated_value || form.competitor || form.reason_not_closed) && (
                <span style={{ fontSize: 10, background: 'var(--primary)', color: '#fff', borderRadius: 8, padding: '1px 6px', marginLeft: 2 }}>✓</span>
              )}
            </button>

            {extraOpen && (
              <div style={{ marginTop: 10, padding: 16, background: 'var(--bg)', borderRadius: 10, border: '1px solid var(--border)' }}>
                {/* Potential level + decision maker */}
                <div style={{ marginBottom: 14 }}>
                  <label className="form-label" style={{ marginBottom: 6 }}>Tiềm năng</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {[
                      { value: 'high',   label: 'Cao',        color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
                      { value: 'medium', label: 'Trung bình', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
                      { value: 'low',    label: 'Thấp',       color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => set('potential_level', form.potential_level === opt.value ? '' : opt.value)}
                        style={{
                          padding: '5px 14px', borderRadius: 20, cursor: 'pointer',
                          fontSize: 12, fontWeight: 600, fontFamily: 'var(--font)',
                          background: form.potential_level === opt.value ? opt.bg : 'transparent',
                          border: `1.5px solid ${form.potential_level === opt.value ? opt.color : 'var(--border)'}`,
                          color: form.potential_level === opt.value ? opt.color : 'var(--text-2)',
                        }}
                      >{opt.label}</button>
                    ))}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer', marginLeft: 4 }}>
                      <input
                        type="checkbox"
                        checked={form.decision_maker || false}
                        onChange={e => set('decision_maker', e.target.checked)}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--primary)' }}
                      />
                      Người quyết định
                    </label>
                  </div>
                </div>

                {/* Preferred contact + estimated value */}
                <div className="grid-2" style={{ gap: 12, marginBottom: 14 }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Kênh liên hệ ưa thích</label>
                    <select className="form-select" value={form.preferred_contact || ''} onChange={e => set('preferred_contact', e.target.value)}>
                      <option value="">— Chọn —</option>
                      <option value="zalo">💬 Zalo</option>
                      <option value="phone">📞 Điện thoại</option>
                      <option value="email">📧 Email</option>
                      <option value="direct">🤝 Gặp trực tiếp</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Giá trị ước tính (USD)</label>
                    <input
                      type="number" className="form-input"
                      placeholder="0" min="0"
                      value={form.estimated_value || ''}
                      onChange={e => set('estimated_value', e.target.value)}
                    />
                  </div>
                </div>

                {/* Competitor */}
                <div className="form-group" style={{ marginBottom: ['contacted', 'quoted'].includes(form.interaction_type) ? 14 : 0 }}>
                  <label className="form-label">Đối thủ cạnh tranh</label>
                  <input
                    className="form-input"
                    placeholder="Freight forwarder khác đang cạnh tranh..."
                    value={form.competitor || ''}
                    onChange={e => set('competitor', e.target.value)}
                  />
                </div>

                {/* Reason not closed — only for contacted/quoted */}
                {['contacted', 'quoted'].includes(form.interaction_type) && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Lý do chưa chốt</label>
                    <textarea
                      className="form-textarea" rows={2}
                      placeholder="Giá cao hơn đối thủ, đang so sánh, chờ phê duyệt..."
                      value={form.reason_not_closed || ''}
                      onChange={e => set('reason_not_closed', e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Quotes */}
          {form.interaction_type === 'quoted' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>📋 Báo giá</span>
                <button type="button" className="btn btn-sm btn-primary"
                  onClick={() => setQuotes(qs => [...qs, { ...EMPTY_QUOTE }])}>
                  + Thêm báo giá
                </button>
              </div>
              {quotes.map((q, i) => (
                <QuoteForm key={i} quote={q} index={i}
                  onChange={updated => setQuotes(qs => qs.map((x, idx) => idx === i ? updated : x))}
                  onRemove={quotes.length > 1 ? () => setQuotes(qs => qs.filter((_, idx) => idx !== i)) : undefined}
                />
              ))}
              {quotes.length === 0 && (
                <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-3)', fontSize: 13 }}>
                  Nhấn "+ Thêm báo giá" để thêm
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Hủy</button>
          <button
            type="button" className="btn btn-primary"
            disabled={!form.company_name.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Đang lưu...' : '✓ Lưu khách hàng'}
          </button>
        </div>
      </div>
    </div>
  );
}
