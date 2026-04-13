import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, differenceInDays } from 'date-fns';
import { getPipelineDetail, updateQuote, quickAddCustomer, addInteractionUpdate, updateCustomer } from '../api';
import QuoteForm, { EMPTY_QUOTE } from './QuoteForm';
import toast from 'react-hot-toast';

const STAGE_INFO = {
  new:       { label: 'Khách mới',   icon: '🆕', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
  dormant:   { label: 'Ngủ đông',    icon: '😴', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
  following: { label: 'Đang follow', icon: '🔄', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' },
  booked:    { label: 'Đã booking',  icon: '✅', color: '#10b981', bg: '#f0fdf4', border: '#bbf7d0' },
};

const TYPE_LABEL  = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_COLOR  = { saved: '#6b7280', contacted: '#3b82f6', quoted: '#f59e0b' };

const POTENTIAL_INFO = {
  high:   { label: 'Cao',        color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
  medium: { label: 'Trung bình', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  low:    { label: 'Thấp',       color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
};

const PREFERRED_CONTACT_LABEL = {
  zalo: '💬 Zalo', phone: '📞 Điện thoại', email: '📧 Email', direct: '🤝 Gặp trực tiếp',
};

const STATUS_LABEL = { quoting: 'Nhận TT check giá', follow_up: 'Báo giá follow', booked: 'Đã booking', lost: 'Mất' };
const STATUS_COLOR = { quoting: '#3b82f6', follow_up: '#f59e0b', booked: '#10b981', lost: '#ef4444' };

const SOURCE_LABEL = {
  cold_call: '📞 Cold Call', zalo_facebook: '💬 Zalo/Facebook',
  referral: '🤝 Referral', email: '📧 Email',
  direct: '🤝 Gặp trực tiếp', other: '💡 Khác',
};

function parseOptions(price, carrier) {
  try {
    const p = JSON.parse(price);
    if (Array.isArray(p)) return p;
  } catch {}
  return carrier || price ? [{ carrier: carrier || '', price: price || '', cost: '' }] : [];
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = differenceInDays(new Date(), new Date(dateStr));
  if (d === 0) return 'Hôm nay';
  if (d === 1) return 'Hôm qua';
  return `${d} ngày trước`;
}

function InfoRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

const EMPTY_OPTION = { carrier: '', price: '', cost: '' };

function QuoteEditForm({ quote, pipelineId, onDone }) {
  const qc = useQueryClient();
  const allOpts = parseOptions(quote.price, quote.carrier);
  // Ensure we always have 5 rows
  const padded = [...allOpts, ...Array(5).fill(null).map(() => ({ ...EMPTY_OPTION }))].slice(0, 5);

  const [status, setStatus] = useState(quote.status || 'quoting');
  const [options, setOptions] = useState(padded);
  const [notes, setNotes] = useState(quote.follow_up_notes || '');

  const setOpt = (i, field, val) =>
    setOptions(opts => opts.map((o, idx) => idx === i ? { ...o, [field]: val } : o));

  const mutation = useMutation({
    mutationFn: () => updateQuote(quote.id, {
      status,
      price: JSON.stringify(options),
      carrier: JSON.stringify(options.map(o => o.carrier)),
      follow_up_notes: notes,
    }),
    onSuccess: () => {
      toast.success('Đã cập nhật báo giá');
      qc.invalidateQueries({ queryKey: ['pipeline-detail', pipelineId] });
      onDone();
    },
    onError: () => toast.error('Cập nhật thất bại'),
  });

  return (
    <div style={{ background: '#f0f7ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 14px', marginTop: 8 }}>
      {/* Status */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>
          Trạng thái
        </label>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)' }}
        >
          <option value="quoting">Nhận thông tin check giá</option>
          <option value="follow_up">Báo giá follow</option>
          <option value="booked">Đã Booking</option>
          <option value="lost">Lost</option>
        </select>
      </div>

      {/* PA options */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr 1fr 1fr', gap: 6, marginBottom: 4 }}>
          <div />
          {['Hãng tàu/bay', 'Giá báo', 'Cost giá'].map(h => (
            <div key={h} style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</div>
          ))}
        </div>
        {options.map((o, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '36px 1fr 1fr 1fr', gap: 6, marginBottom: 5, alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-dim)', borderRadius: 4, padding: '3px 0', textAlign: 'center' }}>PA{i + 1}</span>
            {['carrier', 'price', 'cost'].map(field => (
              <input
                key={field}
                value={o[field]}
                onChange={e => setOpt(i, field, e.target.value)}
                placeholder={field === 'carrier' ? 'MSC, CMA...' : 'USD 2,200/40HC'}
                style={{ fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontFamily: 'var(--font)', width: '100%', boxSizing: 'border-box' }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Notes */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>
          Ghi chú follow up
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="Tình trạng theo dõi..."
          style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDone}
          style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font)' }}
        >
          Hủy
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600, opacity: mutation.isPending ? 0.7 : 1 }}
        >
          {mutation.isPending ? 'Đang lưu...' : 'Lưu'}
        </button>
      </div>
    </div>
  );
}

const SOURCE_OPTIONS = [
  { value: '', label: '— Chọn nguồn —' },
  { value: 'cold_call', label: '📞 Cold Call' },
  { value: 'zalo_facebook', label: '💬 Zalo/Facebook' },
  { value: 'referral', label: '🤝 Referral' },
  { value: 'email', label: '📧 Email' },
  { value: 'direct', label: '🤝 Gặp trực tiếp' },
  { value: 'other', label: '💡 Khác' },
];

function InfoEditForm({ pipeline, latest, pipelineId, customerId, customerCode, onDone }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    company_name:      pipeline.company_name || '',
    contact_person:    pipeline.contact_person || '',
    phone:             pipeline.phone || '',
    industry:          pipeline.industry || '',
    source:            pipeline.source || '',
    potential_level:   latest?.potential_level || '',
    decision_maker:    latest?.decision_maker || false,
    preferred_contact: latest?.preferred_contact || '',
    estimated_value:   latest?.estimated_value || '',
    competitor:        latest?.competitor || '',
    address:           latest?.address || '',
    tax_code:          latest?.tax_code || '',
  });
  const set = (f, v) => setForm(s => ({ ...s, [f]: v }));

  const mutation = useMutation({
    mutationFn: () => updateCustomer(customerId, {
      ...form,
      interaction_type: latest?.interaction_type || 'contacted',
    }),
    onSuccess: () => {
      toast.success('Đã cập nhật thông tin');
      qc.invalidateQueries({ queryKey: ['pipeline-detail', pipelineId] });
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      onDone();
    },
    onError: (err) => toast.error(err?.error || 'Cập nhật thất bại'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Customer code — readonly */}
      {customerCode && (
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Mã khách hàng</label>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-display)', padding: '7px 10px', background: 'var(--primary-dim)', borderRadius: 6, letterSpacing: '0.5px' }}>
            {customerCode}
          </div>
        </div>
      )}
      {/* Basic info */}
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Tên công ty *</label>
        <input value={form.company_name} onChange={e => set('company_name', e.target.value)}
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Người liên hệ</label>
        <input value={form.contact_person} onChange={e => set('contact_person', e.target.value)}
          placeholder="Nguyễn Văn A"
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Điện thoại</label>
        <input value={form.phone} onChange={e => set('phone', e.target.value)}
          placeholder="0901234567"
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Ngành hàng</label>
        <input value={form.industry} onChange={e => set('industry', e.target.value)}
          placeholder="Dệt may, Điện tử..."
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Nguồn</label>
        <select value={form.source} onChange={e => set('source', e.target.value)}
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)' }}>
          {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Mã số thuế</label>
        <input value={form.tax_code} onChange={e => set('tax_code', e.target.value)}
          placeholder="0123456789"
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>
      <div>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Địa chỉ</label>
        <input value={form.address} onChange={e => set('address', e.target.value)}
          placeholder="Số nhà, đường, quận, tỉnh/thành phố..."
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 10 }}>Đánh giá</div>

        {/* Potential level */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 6 }}>Tiềm năng</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { value: 'high',   label: 'Cao',        color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
              { value: 'medium', label: 'Trung bình', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
              { value: 'low',    label: 'Thấp',       color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
            ].map(opt => (
              <button key={opt.value} type="button"
                onClick={() => set('potential_level', form.potential_level === opt.value ? '' : opt.value)}
                style={{
                  flex: 1, padding: '5px 0', borderRadius: 20, cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, fontFamily: 'var(--font)',
                  background: form.potential_level === opt.value ? opt.bg : 'transparent',
                  border: `1.5px solid ${form.potential_level === opt.value ? opt.color : 'var(--border)'}`,
                  color: form.potential_level === opt.value ? opt.color : 'var(--text-2)',
                }}
              >{opt.label}</button>
            ))}
          </div>
        </div>

        {/* Decision maker */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)', cursor: 'pointer', marginBottom: 12 }}>
          <input type="checkbox" checked={form.decision_maker || false} onChange={e => set('decision_maker', e.target.checked)}
            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: 'var(--primary)' }} />
          Người quyết định
        </label>

        {/* Preferred contact */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Kênh liên hệ ưa thích</label>
          <select value={form.preferred_contact || ''} onChange={e => set('preferred_contact', e.target.value)}
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)' }}>
            <option value="">— Chọn —</option>
            <option value="zalo">💬 Zalo</option>
            <option value="phone">📞 Điện thoại</option>
            <option value="email">📧 Email</option>
            <option value="direct">🤝 Gặp trực tiếp</option>
          </select>
        </div>

        {/* Estimated value */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Giá trị ước tính (USD)</label>
          <input type="number" min="0" value={form.estimated_value || ''} onChange={e => set('estimated_value', e.target.value)}
            placeholder="0"
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
        </div>

        {/* Competitor */}
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>Đối thủ cạnh tranh</label>
          <input value={form.competitor || ''} onChange={e => set('competitor', e.target.value)}
            placeholder="Freight forwarder khác..."
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
        <button type="button" onClick={onDone}
          style={{ flex: 1, fontSize: 13, padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
          Hủy
        </button>
        <button type="button" onClick={() => mutation.mutate()} disabled={!form.company_name.trim() || mutation.isPending || !customerId}
          style={{ flex: 1, fontSize: 13, padding: '8px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600, opacity: (!form.company_name.trim() || mutation.isPending) ? 0.6 : 1 }}>
          {mutation.isPending ? 'Đang lưu...' : '✓ Lưu'}
        </button>
      </div>
    </div>
  );
}

function InteractionUpdateForm({ customerId, pipelineId, onDone }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');

  const mutation = useMutation({
    mutationFn: () => addInteractionUpdate(customerId, { note, follow_up_date: followUpDate || null }),
    onSuccess: () => {
      toast.success('Đã thêm cập nhật');
      qc.invalidateQueries({ queryKey: ['pipeline-detail', pipelineId] });
      onDone();
    },
    onError: (err) => toast.error(err?.error || 'Lưu thất bại'),
  });

  return (
    <div style={{
      marginTop: 10, padding: '12px 14px',
      background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8,
    }}>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>
          Ghi chú cập nhật *
        </label>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          autoFocus
          placeholder="Kết quả follow up, thông tin mới..."
          style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 4 }}>
            Follow up tiếp theo
          </label>
          <input
            type="date"
            value={followUpDate}
            onChange={e => setFollowUpDate(e.target.value)}
            style={{ fontSize: 13, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button type="button" onClick={onDone}
            style={{ fontSize: 12, padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            Hủy
          </button>
          <button type="button" onClick={() => mutation.mutate()} disabled={!note.trim() || mutation.isPending}
            style={{ fontSize: 12, padding: '7px 12px', borderRadius: 6, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600, opacity: (!note.trim() || mutation.isPending) ? 0.6 : 1 }}>
            {mutation.isPending ? 'Đang lưu...' : '✓ Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TodayInteractionForm({ pipeline, pipelineId, onDone }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    interaction_type: 'contacted',
    needs: '', notes: '', next_action: '', follow_up_date: '',
  });
  const [quotes, setQuotes] = useState([]);
  const set = (field, val) => setForm(f => ({ ...f, [field]: val }));

  const mutation = useMutation({
    mutationFn: () => quickAddCustomer({
      company_name: pipeline.company_name,
      contact_person: pipeline.contact_person || '',
      phone: pipeline.phone || '',
      source: pipeline.source || '',
      industry: pipeline.industry || '',
      ...form,
      quotes: form.interaction_type === 'quoted' ? quotes.map(q => ({
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
      })) : [],
    }),
    onSuccess: () => {
      toast.success('Đã cập nhật tương tác');
      qc.invalidateQueries({ queryKey: ['pipeline-detail', pipelineId] });
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      onDone();
    },
    onError: (err) => toast.error(err?.error || 'Lưu thất bại'),
  });

  return (
    <div style={{
      background: '#f0fdf4', border: '1px solid #bbf7d0',
      borderRadius: 12, padding: '16px 18px', marginBottom: 14,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>📝 Tương tác hôm nay — {pipeline.company_name}</span>
        <button type="button" onClick={onDone}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 16, lineHeight: 1 }}>✕</button>
      </div>

      {/* Interaction type */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
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
              fontSize: 12,
            }}
          >{t.label}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 3 }}>Nhu cầu</label>
          <textarea value={form.needs} onChange={e => set('needs', e.target.value)} rows={2}
            placeholder="Nhu cầu vận chuyển..."
            style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', resize: 'vertical', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 3 }}>Ghi chú</label>
          <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={2}
            placeholder="Kết quả cuộc gặp..."
            style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', resize: 'vertical', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 3 }}>Hành động tiếp theo</label>
          <input value={form.next_action} onChange={e => set('next_action', e.target.value)}
            placeholder="Gửi báo giá, hẹn gặp..."
            style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: 3 }}>Ngày follow up</label>
          <input type="date" value={form.follow_up_date} onChange={e => set('follow_up_date', e.target.value)}
            style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', width: '100%', fontFamily: 'var(--font)', boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* Quotes */}
      {form.interaction_type === 'quoted' && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>📋 Báo giá</span>
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
            <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--text-3)', fontSize: 12 }}>
              Nhấn "+ Thêm báo giá" để thêm
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onDone}
          style={{ fontSize: 13, padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-2)', cursor: 'pointer', fontFamily: 'var(--font)' }}>
          Hủy
        </button>
        <button type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}
          style={{ fontSize: 13, padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--primary)', color: '#fff', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600, opacity: mutation.isPending ? 0.7 : 1 }}>
          {mutation.isPending ? 'Đang lưu...' : '✓ Lưu tương tác'}
        </button>
      </div>
    </div>
  );
}

export default function CustomerDetailModal({ pipelineId, onClose }) {
  const [editingQuoteId, setEditingQuoteId] = useState(null);
  const [showTodayForm, setShowTodayForm] = useState(false);
  const [updatingCustomerId, setUpdatingCustomerId] = useState(null);
  const [editingInfo, setEditingInfo] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['pipeline-detail', pipelineId],
    queryFn: () => getPipelineDetail(pipelineId),
    enabled: !!pipelineId,
  });

  const pipeline = data?.pipeline;
  const interactions = data?.interactions || [];
  const stage = pipeline ? STAGE_INFO[pipeline.stage] : null;

  // Get the most recent qualification fields from the latest interaction
  const latest = interactions[0];
  const potential = latest?.potential_level ? POTENTIAL_INFO[latest.potential_level] : null;
  // customer_code is only set on the first interaction (new company)
  const customerCode = interactions.find(i => i.customer_code)?.customer_code || null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16,
        width: '100%', maxWidth: 900,
        boxShadow: '0 12px 48px rgba(0,0,0,0.22)',
        display: 'flex', flexDirection: 'column',
        maxHeight: 'calc(100vh - 64px)',
      }}>

        {/* Top bar */}
        <div style={{
          padding: '16px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isLoading ? (
              <div className="spinner" />
            ) : (
              <>
                <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'var(--font-display)' }}>
                  {pipeline?.company_name || '—'}
                </span>
                {stage && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                    background: stage.bg, color: stage.color, border: `1px solid ${stage.border}`,
                  }}>
                    {stage.icon} {stage.label}
                  </span>
                )}
              </>
            )}
          </div>
          <button
            type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-2)', padding: 4, lineHeight: 1 }}
          >✕</button>
        </div>

        {/* Body: 2-column */}
        {!isLoading && pipeline && (
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

            {/* ── Left column ── */}
            <div style={{
              width: '35%', flexShrink: 0,
              borderRight: '1px solid var(--border)',
              padding: '20px 20px 24px',
              overflowY: 'auto',
              background: '#fafbfc',
            }}>
              {editingInfo ? (
                <InfoEditForm
                  pipeline={pipeline}
                  latest={latest}
                  pipelineId={pipelineId}
                  customerId={latest?.id}
                  customerCode={customerCode}
                  onDone={() => setEditingInfo(false)}
                />
              ) : (
                <>
                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                    <div style={{ flex: 1, minWidth: 60, background: '#eff6ff', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#1d4ed8', lineHeight: 1 }}>{pipeline.total_interactions}</div>
                      <div style={{ fontSize: 10, color: '#3b82f6', marginTop: 2 }}>Tiếp cận</div>
                    </div>
                    {pipeline.quote_count > 0 && (
                      <div style={{ flex: 1, minWidth: 60, background: '#fff7ed', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#c2410c', lineHeight: 1 }}>{pipeline.quote_count}</div>
                        <div style={{ fontSize: 10, color: '#ea580c', marginTop: 2 }}>Báo giá</div>
                      </div>
                    )}
                    {pipeline.booked_count > 0 && (
                      <div style={{ flex: 1, minWidth: 60, background: '#f0fdf4', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#15803d', lineHeight: 1 }}>{pipeline.booked_count}</div>
                        <div style={{ fontSize: 10, color: '#16a34a', marginTop: 2 }}>Booked</div>
                      </div>
                    )}
                  </div>

                  {/* Edit button */}
                  {latest && (
                    <button
                      type="button"
                      onClick={() => setEditingInfo(true)}
                      style={{
                        width: '100%', marginBottom: 16,
                        padding: '7px 12px', borderRadius: 8,
                        border: '1px solid #d1d5db', background: '#f3f4f6',
                        color: '#374151', cursor: 'pointer',
                        fontFamily: 'var(--font)', fontSize: 12, fontWeight: 600,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      }}
                    >
                      ✏️ Chỉnh sửa thông tin
                    </button>
                  )}

                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    {customerCode && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Mã KH</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-display)', letterSpacing: '0.5px' }}>{customerCode}</div>
                      </div>
                    )}
                    <InfoRow label="Người liên hệ" value={pipeline.contact_person} />
                    <InfoRow label="Điện thoại" value={pipeline.phone} />
                    <InfoRow label="Ngành hàng" value={pipeline.industry} />
                    <InfoRow label="Nguồn" value={SOURCE_LABEL[pipeline.source] || pipeline.source} />
                    <InfoRow label="Mã số thuế" value={latest?.tax_code} />
                    <InfoRow label="Địa chỉ" value={latest?.address} />

                    {pipeline.last_activity_date && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>
                          Hoạt động cuối
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text)' }}>
                          {format(new Date(pipeline.last_activity_date), 'dd/MM/yyyy')}
                          <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 6 }}>
                            ({daysSince(pipeline.last_activity_date)})
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Qualification fields from latest interaction */}
                  {latest && (potential || latest.decision_maker || latest.preferred_contact || latest.estimated_value || latest.competitor) && (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 12 }}>
                        Đánh giá
                      </div>

                      {potential && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 4 }}>Tiềm năng</div>
                          <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 12px', borderRadius: 20, background: potential.bg, color: potential.color, border: `1px solid ${potential.border}` }}>
                            {potential.label}
                          </span>
                        </div>
                      )}

                      {latest.decision_maker && (
                        <div style={{ marginBottom: 10 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 12px', borderRadius: 20, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                            👤 Người quyết định
                          </span>
                        </div>
                      )}

                      {latest.preferred_contact && (
                        <InfoRow label="Kênh ưa thích" value={PREFERRED_CONTACT_LABEL[latest.preferred_contact] || latest.preferred_contact} />
                      )}

                      {latest.estimated_value && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Giá trị ước tính</div>
                          <div style={{ fontSize: 15, fontWeight: 800, color: '#15803d', fontFamily: 'var(--font-display)' }}>
                            ${Number(latest.estimated_value).toLocaleString()} USD
                          </div>
                        </div>
                      )}

                      {latest.competitor && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 2 }}>Đối thủ</div>
                          <div style={{ fontSize: 13, color: '#b91c1c' }}>⚔️ {latest.competitor}</div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ── Right column: timeline ── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 24px' }}>
              {/* Today interaction button */}
              {!showTodayForm && (
                <button
                  type="button"
                  onClick={() => setShowTodayForm(true)}
                  style={{
                    width: '100%', marginBottom: 16,
                    padding: '10px 16px', borderRadius: 10,
                    border: '1.5px dashed #86efac',
                    background: '#f0fdf4', color: '#15803d',
                    cursor: 'pointer', fontFamily: 'var(--font)',
                    fontSize: 13, fontWeight: 600,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  📝 Cập nhật tương tác hôm nay
                </button>
              )}
              {showTodayForm && pipeline && (
                <TodayInteractionForm
                  pipeline={pipeline}
                  pipelineId={pipelineId}
                  onDone={() => setShowTodayForm(false)}
                />
              )}

              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>
                Lịch sử hoạt động ({interactions.length})
              </div>

              {interactions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-2)', fontSize: 13 }}>
                  Chưa có lịch sử hoạt động
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {interactions.map((c, idx) => {
                    const typeColor = TYPE_COLOR[c.interaction_type] || '#6b7280';
                    return (
                      <div key={c.id} style={{
                        background: idx === 0 ? '#f8faff' : 'var(--bg)',
                        border: `1px solid ${idx === 0 ? '#bfdbfe' : 'var(--border)'}`,
                        borderRadius: 12, padding: '14px 16px',
                      }}>
                        {/* Card header: type badge + date + update button */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                              background: typeColor + '18', color: typeColor, border: `1px solid ${typeColor}30`,
                            }}>
                              {TYPE_LABEL[c.interaction_type] || c.interaction_type}
                            </span>
                            {idx === 0 && (
                              <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>● Gần nhất</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {c.report_date && (
                              <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 500 }}>
                                {format(new Date(c.report_date), 'dd/MM/yyyy')}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setUpdatingCustomerId(updatingCustomerId === c.id ? null : c.id)}
                              style={{
                                fontSize: 11, padding: '3px 10px', borderRadius: 6,
                                border: `1px solid ${updatingCustomerId === c.id ? '#fbbf24' : '#d1d5db'}`,
                                background: updatingCustomerId === c.id ? '#fef3c7' : '#f3f4f6',
                                color: updatingCustomerId === c.id ? '#92400e' : '#374151',
                                cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600,
                              }}
                            >
                              {updatingCustomerId === c.id ? '✕ Đóng' : '➕ Cập nhật'}
                            </button>
                          </div>
                        </div>

                        {/* Core fields */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                          {c.needs && (
                            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Nhu cầu: </span>{c.needs}
                            </div>
                          )}
                          {c.notes && (
                            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Ghi chú: </span>{c.notes}
                            </div>
                          )}
                          {c.next_action && (
                            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                              <span style={{ fontWeight: 600, color: 'var(--text)' }}>Hành động tiếp theo: </span>{c.next_action}
                            </div>
                          )}
                          {c.follow_up_date && (
                            <div style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 500 }}>
                              📅 Follow up: {format(new Date(c.follow_up_date), 'dd/MM/yyyy')}
                            </div>
                          )}
                          {c.reason_not_closed && (
                            <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', borderRadius: 6, padding: '4px 8px', marginTop: 2 }}>
                              <span style={{ fontWeight: 600 }}>Lý do chưa chốt: </span>{c.reason_not_closed}
                            </div>
                          )}
                        </div>

                        {/* Qualification chips */}
                        {(c.potential_level || c.decision_maker || c.preferred_contact || c.estimated_value || c.competitor) && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                            {c.potential_level && (() => {
                              const p = POTENTIAL_INFO[c.potential_level];
                              return p ? (
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: p.bg, color: p.color, border: `1px solid ${p.border}` }}>
                                  {p.label}
                                </span>
                              ) : null;
                            })()}
                            {c.decision_maker && (
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                                👤 Người QĐ
                              </span>
                            )}
                            {c.preferred_contact && (
                              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#f9fafb', color: '#374151', border: '1px solid #e5e7eb' }}>
                                {PREFERRED_CONTACT_LABEL[c.preferred_contact] || c.preferred_contact}
                              </span>
                            )}
                            {c.estimated_value && (
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                                💰 ${Number(c.estimated_value).toLocaleString()}
                              </span>
                            )}
                            {c.competitor && (
                              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>
                                ⚔️ {c.competitor}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Quotes */}
                        {c.quotes?.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                              Báo giá ({c.quotes.length})
                            </div>
                            {c.quotes.map(q => {
                              const opts = parseOptions(q.price, q.carrier).filter(o => o.carrier || o.price);
                              const sc = STATUS_COLOR[q.status] || '#6b7280';
                              const isEditing = editingQuoteId === q.id;
                              return (
                                <div key={q.id} style={{
                                  background: 'var(--bg-card)', border: `1px solid ${isEditing ? '#bfdbfe' : 'var(--border)'}`,
                                  borderRadius: 8, padding: '10px 12px',
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600 }}>{q.cargo_name}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, background: sc + '18', color: sc }}>
                                        {STATUS_LABEL[q.status] || q.status}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => setEditingQuoteId(isEditing ? null : q.id)}
                                        style={{
                                          fontSize: 11, padding: '3px 10px', borderRadius: 6,
                                          border: `1px solid ${isEditing ? '#93c5fd' : '#d1d5db'}`,
                                          background: isEditing ? '#dbeafe' : '#f3f4f6',
                                          color: isEditing ? '#1d4ed8' : '#374151',
                                          cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600,
                                          flexShrink: 0,
                                        }}
                                      >
                                        {isEditing ? '✕ Đóng' : '✏️ Sửa'}
                                      </button>
                                    </div>
                                  </div>
                                  {q.route && <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>📍 {q.route}</div>}
                                  {!isEditing && (
                                    <>
                                      {opts.length > 0 && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                          {opts.map((o, i) => (
                                            <div key={i} style={{ fontSize: 12, display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                                              <span style={{ color: '#16a34a', fontWeight: 700, minWidth: 28, flexShrink: 0 }}>PA{i + 1}:</span>
                                              {o.carrier && <span style={{ color: 'var(--text)' }}>{o.carrier}</span>}
                                              {o.price && (
                                                <span style={{ color: 'var(--text-2)' }}>
                                                  — Giá: <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{o.price}</span>
                                                </span>
                                              )}
                                              {o.cost && (
                                                <span style={{ color: 'var(--text-2)' }}>
                                                  / Cost: <span style={{ color: '#6b7280', fontWeight: 600 }}>{o.cost}</span>
                                                </span>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      {q.follow_up_notes && (
                                        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, fontStyle: 'italic' }}>📝 {q.follow_up_notes}</div>
                                      )}
                                      {q.closing_soon && (
                                        <div style={{ fontSize: 12, color: '#ea580c', fontWeight: 600, marginTop: 4 }}>⚡ Sắp chốt</div>
                                      )}
                                    </>
                                  )}
                                  {isEditing && (
                                    <QuoteEditForm
                                      quote={q}
                                      pipelineId={pipelineId}
                                      onDone={() => setEditingQuoteId(null)}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Update thread */}
                        {(c.updates?.length > 0 || updatingCustomerId === c.id) && (
                          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                            {c.updates?.map(u => (
                              <div key={u.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                                <span style={{ fontSize: 13, color: 'var(--text-3)', flexShrink: 0, marginTop: 1 }}>└─</span>
                                <div>
                                  <span style={{ fontSize: 11, color: 'var(--text-3)', marginRight: 6 }}>
                                    {format(new Date(u.created_at), 'dd/MM/yyyy HH:mm')}
                                    {u.created_by_name && ` · ${u.created_by_name}`}
                                  </span>
                                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{u.note}</span>
                                  {u.follow_up_date && (
                                    <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 500, marginLeft: 8 }}>
                                      📅 {format(new Date(u.follow_up_date), 'dd/MM/yyyy')}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                            {updatingCustomerId === c.id && (
                              <InteractionUpdateForm
                                customerId={c.id}
                                pipelineId={pipelineId}
                                onDone={() => setUpdatingCustomerId(null)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48, gap: 12 }}>
            <div className="spinner" />
            <span style={{ color: 'var(--text-2)' }}>Đang tải...</span>
          </div>
        )}
      </div>
    </div>
  );
}
