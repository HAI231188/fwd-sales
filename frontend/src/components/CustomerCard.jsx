import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { updateQuote, deleteQuote } from '../api';
import QuoteForm, { EMPTY_QUOTE } from './QuoteForm';
import CustomerDetailModal from './CustomerDetailModal';

const MODE_ICON = { sea: '🚢', air: '✈️', road: '🚛' };
const MODE_CLASS = { sea: 'mode-sea', air: 'mode-air', road: 'mode-road' };
const STATUS_LABEL = { quoting: 'Đang báo giá', follow_up: 'Follow Up', booked: 'Đã booking', lost: 'Lost' };
const STATUS_CLASS = { quoting: 'status-quoting', follow_up: 'status-follow_up', booked: 'status-booked', lost: 'status-lost' };
const SOURCE_LABEL = {
  cold_call: '📞 Cold Call', zalo_facebook: '💬 Zalo/Facebook',
  referral: '🤝 Referral', email: '📧 Email',
  direct: '🤝 Gặp trực tiếp', other: '💡 Khác',
};
const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

// Parse stored price JSON → options array, or fall back to legacy plain text
function parseOptions(price, carrier) {
  try {
    const p = JSON.parse(price);
    if (Array.isArray(p)) return p;
  } catch {}
  // Legacy: single carrier/price
  return [
    { carrier: carrier || '', price: price || '', cost: '' },
    ...Array(4).fill(null).map(() => ({ carrier: '', price: '', cost: '' })),
  ];
}

// Options table used in both view and detail modal
function OptionsTable({ price, carrier }) {
  const options = parseOptions(price, carrier);
  const filled = options.filter(o => o.carrier || o.price || o.cost);
  if (filled.length === 0) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: 4, marginBottom: 4, padding: '0 2px' }}>
        {['', 'Hãng tàu / Hãng bay', 'Giá báo', 'Cost giá'].map((h, i) => (
          <div key={i} style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</div>
        ))}
      </div>
      {options.map((opt, i) => {
        if (!opt.carrier && !opt.price && !opt.cost) return null;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: 4, marginBottom: 3, alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: 'rgba(34,197,94,0.1)', borderRadius: 4, padding: '2px 6px', textAlign: 'center' }}>
              PA {i + 1}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>{opt.carrier || '—'}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>{opt.price || '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{opt.cost || '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function QuoteCard({ q, canEdit, onEdit, onDelete }) {
  const closingSoon = q.closing_soon;
  return (
    <div
      className={closingSoon ? 'closing-soon-glow' : ''}
      style={{
        background: '#f8f9fa',
        border: `1px solid ${closingSoon ? 'rgba(217,119,6,0.35)' : 'var(--border)'}`,
        borderRadius: 10, padding: '14px 16px', marginBottom: 10,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className={`badge ${MODE_CLASS[q.mode]}`}>{MODE_ICON[q.mode]} {q.mode?.toUpperCase()}</span>
          <span className={`badge ${STATUS_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>
          {q.closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onEdit(q)}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >✏️ Sửa</button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => onDelete(q)}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >🗑 Xóa</button>
          </div>
        )}
      </div>

      <div className="grid-2" style={{ gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Tên hàng</div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{q.cargo_name || '—'}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Luồng tuyến</div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{q.route || '—'}</div>
        </div>
        {(q.monthly_volume_cbm || q.monthly_volume_kg || q.monthly_volume_containers) && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Sản lượng/tháng</div>
            <div style={{ fontSize: 13 }}>
              {q.monthly_volume_cbm && `${q.monthly_volume_cbm} CBM `}
              {q.monthly_volume_kg && `${q.monthly_volume_kg} KG `}
              {q.monthly_volume_containers}
            </div>
          </div>
        )}
        {q.transit_time && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Transit time</div>
            <div style={{ fontSize: 13 }}>{q.transit_time}</div>
          </div>
        )}
        {q.cargo_ready_date && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Ngày xong hàng</div>
            <div style={{ fontSize: 13 }}>{new Date(q.cargo_ready_date).toLocaleDateString('vi-VN')}</div>
          </div>
        )}
      </div>

      <OptionsTable price={q.price} carrier={q.carrier} />

      {q.follow_up_notes && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontStyle: 'italic' }}>
          📝 {q.follow_up_notes}
        </div>
      )}
      {q.lost_reason && (
        <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
          ❌ Lost reason: {q.lost_reason}
        </div>
      )}
    </div>
  );
}

// Edit modal — wraps QuoteForm for an existing quote
function EditQuoteModal({ quote, onClose, onSaved }) {
  const [formData, setFormData] = useState({
    ...quote,
    options: parseOptions(quote.price, quote.carrier),
  });

  const mutation = useMutation({
    mutationFn: (data) => updateQuote(quote.id, {
      ...data,
      carrier: (data.options || []).find(o => o.carrier)?.carrier || '',
      price: data.options ? JSON.stringify(data.options) : data.price,
    }),
    onSuccess: () => {
      toast.success('Đã cập nhật báo giá');
      onSaved();
      onClose();
    },
    onError: (err) => toast.error(err?.error || 'Cập nhật thất bại'),
  });

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3>✏️ Chỉnh sửa báo giá</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <QuoteForm
            quote={formData}
            index={0}
            onChange={setFormData}
          />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Hủy</button>
          <button
            className="btn btn-primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(formData)}
          >
            {mutation.isPending
              ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Đang lưu...</>
              : '💾 Lưu thay đổi'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CustomerCard({ customer, canEdit = false, onRefresh }) {
  const [expanded, setExpanded] = useState(true);
  const [editingQuote, setEditingQuote] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const quotes = customer.quotes || [];
  const hasClosingSoon = quotes.some(q => q.closing_soon);

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteQuote(id),
    onSuccess: () => {
      toast.success('Đã xóa báo giá');
      if (onRefresh) onRefresh();
    },
    onError: (err) => toast.error(err?.error || 'Xóa thất bại'),
  });

  const handleDelete = (q) => {
    if (window.confirm(`Xóa báo giá này?\n${q.cargo_name || q.route || 'Báo giá #' + q.id}`)) {
      deleteMutation.mutate(q.id);
    }
  };

  return (
    <>
      <div
        className={hasClosingSoon ? 'closing-soon-glow' : ''}
        style={{
          background: 'var(--bg-card)',
          border: `1px solid ${hasClosingSoon ? 'rgba(217,119,6,0.3)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          marginBottom: 16,
          overflow: 'hidden',
        }}
      >
        {/* Customer header */}
        <div
          style={{ padding: '16px 20px', cursor: 'pointer', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}
          onClick={() => setExpanded(!expanded)}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span
                style={{ fontWeight: 600, fontSize: 15, cursor: customer.pipeline_id ? 'pointer' : 'default', color: customer.pipeline_id ? 'var(--primary)' : 'inherit', textDecoration: customer.pipeline_id ? 'underline' : 'none', textDecorationStyle: 'dotted' }}
                onClick={e => { if (customer.pipeline_id) { e.stopPropagation(); setShowDetail(true); } }}
              >{customer.company_name}</span>
              <span className={`badge ${TYPE_CLASS[customer.interaction_type]}`}>{TYPE_LABEL[customer.interaction_type]}</span>
              {hasClosingSoon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: 'var(--text-2)' }}>
              {customer.contact_person && <span>👤 {customer.contact_person}</span>}
              {customer.phone && <span>📞 {customer.phone}</span>}
              {customer.source && <span>{SOURCE_LABEL[customer.source]}</span>}
              {customer.industry && <span>🏭 {customer.industry}</span>}
            </div>
            {customer.follow_up_date && (
              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--warning)' }}>
                📅 Follow up: {new Date(customer.follow_up_date).toLocaleDateString('vi-VN')}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {quotes.length > 0 && <span className="badge badge-primary">📋 {quotes.length} báo giá</span>}
            <span style={{ fontSize: 16, color: 'var(--text-2)', transform: expanded ? 'rotate(180deg)' : '', transition: '0.2s' }}>▾</span>
          </div>
        </div>

        {/* Expanded details */}
        {expanded && (
          <div style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}>
            {(customer.needs || customer.notes || customer.next_action) && (
              <div className="grid-3" style={{ gap: 12, marginBottom: quotes.length > 0 ? 16 : 0 }}>
                {customer.needs && (
                  <div>
                    <div className="section-title">Nhu cầu</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{customer.needs}</div>
                  </div>
                )}
                {customer.notes && (
                  <div>
                    <div className="section-title">Ghi chú</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{customer.notes}</div>
                  </div>
                )}
                {customer.next_action && (
                  <div>
                    <div className="section-title">Hành động tiếp theo</div>
                    <div style={{ fontSize: 13, color: 'var(--primary)' }}>{customer.next_action}</div>
                  </div>
                )}
              </div>
            )}

            {quotes.length > 0 && (
              <div>
                <div className="section-title">Báo giá ({quotes.length})</div>
                {quotes.map((q, i) => (
                  <QuoteCard
                    key={q.id || i}
                    q={q}
                    canEdit={canEdit}
                    onEdit={setEditingQuote}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}

            {customer.interaction_type === 'saved' && quotes.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-2)', fontStyle: 'italic' }}>
                📌 Đã lưu liên hệ — chưa kết nối được. Sẽ liên hệ vào{' '}
                {customer.follow_up_date ? new Date(customer.follow_up_date).toLocaleDateString('vi-VN') : '...'}
              </div>
            )}
          </div>
        )}
      </div>

      {editingQuote && (
        <EditQuoteModal
          quote={editingQuote}
          onClose={() => setEditingQuote(null)}
          onSaved={() => { if (onRefresh) onRefresh(); }}
        />
      )}
      {showDetail && customer.pipeline_id && (
        <CustomerDetailModal pipelineId={customer.pipeline_id} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}
