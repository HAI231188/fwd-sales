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

  const set = (field, val) => setForm(f => ({ ...f, [field]: val }));

  const mutation = useMutation({
    mutationFn: () => quickAddCustomer({
      ...form,
      quotes: form.interaction_type === 'quoted' ? serializeQuotes(quotes) : [],
    }),
    onSuccess: () => {
      toast.success('Đã thêm khách hàng');
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      onClose();
    },
    onError: (err) => toast.error(err?.error || 'Thêm khách hàng thất bại'),
  });

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
