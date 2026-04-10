import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { getPipelineDetail } from '../api';

const STAGE_INFO = {
  new:       { label: 'Khách mới',   icon: '🆕', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
  dormant:   { label: 'Ngủ đông',    icon: '😴', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
  following: { label: 'Đang follow', icon: '🔄', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' },
  booked:    { label: 'Đã booking',  icon: '✅', color: '#10b981', bg: '#f0fdf4', border: '#bbf7d0' },
};

const TYPE_LABEL = {
  saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá',
};
const TYPE_COLOR = {
  saved: '#6b7280', contacted: '#3b82f6', quoted: '#f59e0b',
};

const POTENTIAL_INFO = {
  high:   { label: 'Cao',        color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
  medium: { label: 'Trung bình', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  low:    { label: 'Thấp',       color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
};

const PREFERRED_CONTACT_LABEL = {
  zalo: '💬 Zalo', phone: '📞 Điện thoại', email: '📧 Email', direct: '🤝 Gặp trực tiếp',
};

const STATUS_LABEL = {
  quoting: 'Đang báo giá', follow_up: 'Follow up', booked: 'Đã booking', lost: 'Mất',
};
const STATUS_COLOR = {
  quoting: '#3b82f6', follow_up: '#f59e0b', booked: '#10b981', lost: '#ef4444',
};

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
  // Legacy: single carrier/price plain text
  return carrier || price ? [{ carrier: carrier || '', price: price || '', cost: '' }] : [];
}

export default function CustomerDetailModal({ pipelineId, onClose }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pipeline-detail', pipelineId],
    queryFn: () => getPipelineDetail(pipelineId),
    enabled: !!pipelineId,
  });

  const pipeline = data?.pipeline;
  const interactions = data?.interactions || [];
  const stage = pipeline ? STAGE_INFO[pipeline.stage] : null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg-card)', borderRadius: 16,
        width: '100%', maxWidth: 680, boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="spinner" />
              <span style={{ color: 'var(--text-2)' }}>Đang tải...</span>
            </div>
          ) : pipeline ? (
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-display)', margin: 0 }}>
                  {pipeline.company_name}
                </h2>
                {stage && (
                  <span style={{
                    fontSize: 12, fontWeight: 600, padding: '3px 10px',
                    borderRadius: 20, background: stage.bg,
                    color: stage.color, border: `1px solid ${stage.border}`,
                  }}>
                    {stage.icon} {stage.label}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px', fontSize: 13, color: 'var(--text-2)' }}>
                {pipeline.contact_person && <span>👤 {pipeline.contact_person}</span>}
                {pipeline.phone && <span>📞 {pipeline.phone}</span>}
                {pipeline.industry && <span>🏭 {pipeline.industry}</span>}
                {pipeline.source && <span>{SOURCE_LABEL[pipeline.source] || pipeline.source}</span>}
              </div>
              {/* Stats chips */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <span style={{ fontSize: 12, background: '#f0f7ff', color: '#1d4ed8', borderRadius: 10, padding: '3px 10px', fontWeight: 600 }}>
                  📋 {pipeline.total_interactions} lượt tiếp cận
                </span>
                {pipeline.quote_count > 0 && (
                  <span style={{ fontSize: 12, background: '#fff7ed', color: '#c2410c', borderRadius: 10, padding: '3px 10px', fontWeight: 600 }}>
                    📊 {pipeline.quote_count} báo giá
                  </span>
                )}
                {pipeline.booked_count > 0 && (
                  <span style={{ fontSize: 12, background: '#f0fdf4', color: '#15803d', borderRadius: 10, padding: '3px 10px', fontWeight: 600 }}>
                    ✅ {pipeline.booked_count} đã booking
                  </span>
                )}
                {pipeline.last_activity_date && (
                  <span style={{ fontSize: 12, background: '#f9fafb', color: '#6b7280', borderRadius: 10, padding: '3px 10px' }}>
                    🕐 {format(new Date(pipeline.last_activity_date), 'dd/MM/yyyy')}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <span style={{ color: 'var(--text-2)' }}>Không tìm thấy dữ liệu</span>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 20, color: 'var(--text-2)', padding: 4, lineHeight: 1, flexShrink: 0,
            }}
          >✕</button>
        </div>

        {/* Timeline */}
        {!isLoading && !isError && interactions.length > 0 && (
          <div style={{ padding: '16px 24px 24px', overflowY: 'auto', maxHeight: '60vh' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>
              Lịch sử hoạt động ({interactions.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {interactions.map((c, idx) => (
                <div key={c.id} style={{
                  background: idx === 0 ? '#f8faff' : 'var(--bg)',
                  border: `1px solid ${idx === 0 ? '#bfdbfe' : 'var(--border)'}`,
                  borderRadius: 10, padding: '12px 16px',
                }}>
                  {/* Interaction header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: c.needs || c.notes || c.next_action || c.potential_level || c.decision_maker || c.preferred_contact || c.estimated_value || c.competitor || c.reason_not_closed || c.quotes?.length ? 8 : 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px',
                        borderRadius: 8, background: TYPE_COLOR[c.interaction_type] + '20',
                        color: TYPE_COLOR[c.interaction_type],
                      }}>
                        {TYPE_LABEL[c.interaction_type] || c.interaction_type}
                      </span>
                      {idx === 0 && (
                        <span style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>Gần nhất</span>
                      )}
                    </div>
                    {c.report_date && (
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        {format(new Date(c.report_date), 'dd/MM/yyyy')}
                      </span>
                    )}
                  </div>

                  {/* Details */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {c.needs && (
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        <span style={{ fontWeight: 600 }}>Nhu cầu:</span> {c.needs}
                      </div>
                    )}
                    {c.notes && (
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        <span style={{ fontWeight: 600 }}>Ghi chú:</span> {c.notes}
                      </div>
                    )}
                    {c.next_action && (
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                        <span style={{ fontWeight: 600 }}>Hành động tiếp theo:</span> {c.next_action}
                      </div>
                    )}
                    {c.follow_up_date && (
                      <div style={{ fontSize: 12, color: 'var(--warning)' }}>
                        📅 Follow up: {format(new Date(c.follow_up_date), 'dd/MM/yyyy')}
                      </div>
                    )}
                  </div>

                  {/* Qualification fields */}
                  {(c.potential_level || c.decision_maker || c.preferred_contact || c.estimated_value || c.competitor || c.reason_not_closed) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {c.potential_level && (() => {
                        const p = POTENTIAL_INFO[c.potential_level];
                        return p ? (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, background: p.bg, color: p.color, border: `1px solid ${p.border}` }}>
                            Tiềm năng: {p.label}
                          </span>
                        ) : null;
                      })()}
                      {c.decision_maker && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 10, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                          👤 Người quyết định
                        </span>
                      )}
                      {c.preferred_contact && (
                        <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 10, background: '#f9fafb', color: '#374151', border: '1px solid #e5e7eb' }}>
                          {PREFERRED_CONTACT_LABEL[c.preferred_contact] || c.preferred_contact}
                        </span>
                      )}
                      {c.estimated_value && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 10, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                          💰 ${Number(c.estimated_value).toLocaleString()}
                        </span>
                      )}
                      {c.competitor && (
                        <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 10, background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}>
                          ⚔️ {c.competitor}
                        </span>
                      )}
                      {c.reason_not_closed && (
                        <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 10, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', maxWidth: '100%' }}>
                          ⚠️ {c.reason_not_closed}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Quotes for this interaction */}
                  {c.quotes?.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {c.quotes.map(q => {
                        const opts = parseOptions(q.price, q.carrier).filter(o => o.carrier || o.price);
                        const statusColor = STATUS_COLOR[q.status] || '#6b7280';
                        return (
                          <div key={q.id} style={{
                            background: 'var(--bg-card)', border: '1px solid var(--border)',
                            borderRadius: 8, padding: '8px 12px',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, fontWeight: 600 }}>{q.cargo_name}</span>
                              <span style={{
                                fontSize: 11, fontWeight: 700, padding: '2px 8px',
                                borderRadius: 8, background: statusColor + '18', color: statusColor,
                              }}>
                                {STATUS_LABEL[q.status] || q.status}
                              </span>
                            </div>
                            {q.route && (
                              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>📍 {q.route}</div>
                            )}
                            {opts.length > 0 && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                                {opts.map((o, i) => (
                                  <div key={i} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ color: '#16a34a', fontWeight: 700, minWidth: 28 }}>PA{i + 1}:</span>
                                    {o.carrier && <span style={{ color: 'var(--text-2)' }}>{o.carrier}</span>}
                                    {o.carrier && o.price && <span style={{ color: 'var(--text-3)' }}>–</span>}
                                    {o.price && <span style={{ color: 'var(--primary)', fontWeight: 600 }}>{o.price} USD</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                            {q.follow_up_notes && (
                              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4, fontStyle: 'italic' }}>
                                📝 {q.follow_up_notes}
                              </div>
                            )}
                            {q.closing_soon && (
                              <div style={{ fontSize: 12, color: '#ea580c', fontWeight: 600, marginTop: 4 }}>⚡ Sắp chốt</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {!isLoading && !isError && interactions.length === 0 && (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-2)', fontSize: 14 }}>
            Chưa có lịch sử hoạt động
          </div>
        )}
      </div>
    </div>
  );
}
