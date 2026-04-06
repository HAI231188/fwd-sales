import { useState } from 'react';

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

function QuoteCard({ q }) {
  const closingSoon = q.closing_soon;
  return (
    <div
      className={closingSoon ? 'closing-soon-glow' : ''}
      style={{
        background: 'var(--bg)', border: `1px solid ${closingSoon ? 'rgba(255,215,0,0.3)' : 'var(--border)'}`,
        borderRadius: 10, padding: '14px 16px', marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className={`badge ${MODE_CLASS[q.mode]}`}>{MODE_ICON[q.mode]} {q.mode?.toUpperCase()}</span>
        <span className={`badge ${STATUS_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>
        {q.closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
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
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Hãng tàu/Hãng bay</div>
          <div style={{ fontSize: 13 }}>{q.carrier || '—'}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Transit time</div>
          <div style={{ fontSize: 13 }}>{q.transit_time || '—'}</div>
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
        {q.cargo_ready_date && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 2 }}>Ngày xong hàng</div>
            <div style={{ fontSize: 13 }}>{new Date(q.cargo_ready_date).toLocaleDateString('vi-VN')}</div>
          </div>
        )}
      </div>

      {q.price && (
        <div style={{
          background: 'var(--primary-dim)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px', marginBottom: 8,
          fontSize: 14, fontWeight: 600, color: 'var(--primary)',
        }}>
          💰 {q.price}
        </div>
      )}

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

export default function CustomerCard({ customer, readOnly = false }) {
  const [expanded, setExpanded] = useState(true);
  const quotes = customer.quotes || [];

  const hasClosingSoon = quotes.some(q => q.closing_soon);

  return (
    <div
      className={hasClosingSoon ? 'closing-soon-glow' : ''}
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${hasClosingSoon ? 'rgba(255,215,0,0.25)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        marginBottom: 16,
        overflow: 'hidden',
      }}
    >
      {/* Customer header */}
      <div
        style={{
          padding: '16px 20px', cursor: 'pointer',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{customer.company_name}</span>
            <span className={`badge ${TYPE_CLASS[customer.interaction_type]}`}>
              {TYPE_LABEL[customer.interaction_type]}
            </span>
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
          {quotes.length > 0 && (
            <span className="badge badge-primary">📋 {quotes.length} báo giá</span>
          )}
          <span style={{ fontSize: 16, color: 'var(--text-2)', transform: expanded ? 'rotate(180deg)' : '', transition: '0.2s' }}>
            ▾
          </span>
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
              {quotes.map((q, i) => <QuoteCard key={q.id || i} q={q} />)}
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
  );
}
