import { useQuery } from '@tanstack/react-query';
import { getDrilldown } from '../api';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';

const MODE_ICON = { sea: '🚢', air: '✈️', road: '🚛' };
const STATUS_LABEL = { quoting: 'Đang báo giá', follow_up: 'Follow Up', booked: 'Đã booking', lost: 'Lost' };
const STATUS_CLASS = { quoting: 'status-quoting', follow_up: 'status-follow_up', booked: 'status-booked', lost: 'status-lost' };
const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

function QuoteRow({ q }) {
  return (
    <div style={{
      background: '#f8f9fa', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 18 }}>{MODE_ICON[q.mode] || '📦'}</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{q.company_name}</span>
            {q.closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
            <strong style={{ color: 'var(--text)' }}>{q.cargo_name}</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
            <span>📍 {q.route}</span>
            {q.carrier && <span>🏢 {q.carrier}</span>}
            {q.transit_time && <span>⏱ {q.transit_time}</span>}
          </div>
          {q.price && (
            <div style={{ marginTop: 6, fontSize: 13, color: 'var(--primary)', fontWeight: 600 }}>
              💰 {q.price}
            </div>
          )}
          {q.follow_up_notes && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic' }}>
              📝 {q.follow_up_notes}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <span className={`badge ${STATUS_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>
          {q.user_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="avatar avatar-sm" style={{ background: q.avatar_color }}>{q.user_code}</div>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{q.user_name}</span>
            </div>
          )}
          {q.report_date && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {format(new Date(q.report_date), 'dd/MM/yyyy')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomerRow({ c }) {
  return (
    <div style={{
      background: '#f8f9fa', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{c.company_name}</span>
            <span className={`badge ${TYPE_CLASS[c.interaction_type]}`}>{TYPE_LABEL[c.interaction_type]}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            👤 {c.contact_person} {c.phone && `· 📞 ${c.phone}`}
          </div>
          {c.industry && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>🏭 {c.industry}</div>}
          {c.follow_up_date && (
            <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4 }}>
              📅 Follow up: {format(new Date(c.follow_up_date), 'dd/MM/yyyy')}
            </div>
          )}
          {c.needs && <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontStyle: 'italic' }}>{c.needs}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          {c.quote_count > 0 && (
            <span className="badge badge-primary">📋 {c.quote_count} báo giá</span>
          )}
          {c.user_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="avatar avatar-sm" style={{ background: c.avatar_color }}>{c.user_code}</div>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{c.user_name}</span>
            </div>
          )}
          {c.report_date && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {format(new Date(c.report_date), 'dd/MM/yyyy')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const DRILL_CONFIG = {
  booked:          { title: '✅ Đã Booking', isQuote: true },
  follow_up:       { title: '🔄 Follow Up', isQuote: true },
  closing_soon:    { title: '⚡ Sắp Chốt', isQuote: true },
  contacts:        { title: '👥 Lượt Tiếp Cận', isQuote: false },
  total_quotes:    { title: '📋 Tổng Báo Giá', isQuote: true },
  waiting_follow_up: { title: '⏰ KH Chờ Follow Up', isQuote: false },
};

export default function DrilldownModal({ type, dateParams, userId, onClose }) {
  const config = DRILL_CONFIG[type] || {};
  const { data = [], isLoading } = useQuery({
    queryKey: ['drilldown', type, dateParams, userId],
    queryFn: () => getDrilldown(type, { ...dateParams, userId }),
    enabled: !!type,
  });

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>{config.title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="badge badge-primary">{data.length} mục</span>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div className="spinner" style={{ margin: '0 auto' }} />
            </div>
          ) : data.length === 0 ? (
            <div className="empty-state">
              <div className="icon">📭</div>
              <p>Không có dữ liệu trong khoảng thời gian này</p>
            </div>
          ) : (
            <div>
              {data.map((item, i) =>
                config.isQuote
                  ? <QuoteRow key={item.id || i} q={item} />
                  : <CustomerRow key={item.id || i} c={item} />
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  );
}
