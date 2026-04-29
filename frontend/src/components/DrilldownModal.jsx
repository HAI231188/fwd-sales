import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getDrilldown } from '../api';
import { format } from 'date-fns';
import CustomerDetailModal from './CustomerDetailModal';
import { useModalZIndex } from '../hooks/useModalZIndex';

const MODE_ICON = { sea: '🚢', air: '✈️', road: '🚛' };
const MODE_CLASS = { sea: 'mode-sea', air: 'mode-air', road: 'mode-road' };
const STATUS_LABEL = { quoting: 'Nhận TT check giá', follow_up: 'Báo giá follow', booked: 'Đã booking', lost: 'Lost' };
const STATUS_CLASS = { quoting: 'status-quoting', follow_up: 'status-follow_up', booked: 'status-booked', lost: 'status-lost' };
const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

function parseOptions(price, carrier) {
  try {
    const p = JSON.parse(price);
    if (Array.isArray(p)) return p;
  } catch {}
  return carrier || price
    ? [{ carrier: carrier || '', price: price || '', cost: '' }]
    : [];
}

// Full quote detail modal shown when lead clicks a quote row
function QuoteDetailModal({ q, onClose }) {
  const options = parseOptions(q.price, q.carrier).filter(o => o.carrier || o.price || o.cost);
  const zIndex = useModalZIndex();

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <div>
            <h3 style={{ marginBottom: 4 }}>{q.company_name}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {q.mode && <span className={`badge ${MODE_CLASS[q.mode]}`}>{MODE_ICON[q.mode]} {q.mode?.toUpperCase()}</span>}
              {q.status && <span className={`badge ${STATUS_CLASS[q.status]}`}>{STATUS_LABEL[q.status]}</span>}
              {q.closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Sales person */}
          {q.user_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, padding: '10px 14px', background: '#f8f9fa', borderRadius: 8 }}>
              <div className="avatar avatar-sm" style={{ background: q.avatar_color }}>{q.user_code}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{q.user_name}</div>
                {q.report_date && <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Báo cáo ngày {format(new Date(q.report_date), 'dd/MM/yyyy')}</div>}
              </div>
            </div>
          )}

          {/* Cargo & route info */}
          <div className="grid-2" style={{ gap: 12, marginBottom: 16 }}>
            {q.cargo_name && (
              <div>
                <div className="section-title">Tên hàng</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{q.cargo_name}</div>
              </div>
            )}
            {q.route && (
              <div>
                <div className="section-title">Luồng tuyến</div>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{q.route}</div>
              </div>
            )}
            {(q.monthly_volume_cbm || q.monthly_volume_kg || q.monthly_volume_containers) && (
              <div>
                <div className="section-title">Sản lượng / tháng</div>
                <div style={{ fontSize: 13 }}>
                  {q.monthly_volume_cbm && `${q.monthly_volume_cbm} CBM `}
                  {q.monthly_volume_kg && `${q.monthly_volume_kg} KG `}
                  {q.monthly_volume_containers}
                </div>
              </div>
            )}
            {q.transit_time && (
              <div>
                <div className="section-title">Transit time</div>
                <div style={{ fontSize: 13 }}>{q.transit_time}</div>
              </div>
            )}
            {q.cargo_ready_date && (
              <div>
                <div className="section-title">Ngày xong hàng</div>
                <div style={{ fontSize: 13 }}>{format(new Date(q.cargo_ready_date), 'dd/MM/yyyy')}</div>
              </div>
            )}
          </div>

          {/* PA options table */}
          {options.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="section-title" style={{ marginBottom: 8 }}>Phương án báo giá</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '72px 1fr 1fr 1fr',
                  gap: 0, background: '#f8f9fa',
                  borderBottom: '1px solid var(--border)',
                  padding: '8px 12px',
                }}>
                  {['', 'Hãng tàu / Hãng bay', 'Giá báo', 'Cost giá'].map((h, i) => (
                    <div key={i} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</div>
                  ))}
                </div>
                {options.map((opt, i) => (
                  <div key={i} style={{
                    display: 'grid', gridTemplateColumns: '72px 1fr 1fr 1fr',
                    padding: '10px 12px', alignItems: 'center',
                    borderBottom: i < options.length - 1 ? '1px solid var(--border)' : 'none',
                    background: '#fff',
                  }}>
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: '#16a34a',
                      background: 'rgba(34,197,94,0.1)', borderRadius: 4,
                      padding: '3px 8px', textAlign: 'center', width: 'fit-content',
                    }}>PA {i + 1}</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{opt.carrier || '—'}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)' }}>{opt.price || '—'}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{opt.cost || '—'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {q.follow_up_notes && (
            <div style={{ marginBottom: 12 }}>
              <div className="section-title">Ghi chú follow up</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)', fontStyle: 'italic' }}>📝 {q.follow_up_notes}</div>
            </div>
          )}
          {q.lost_reason && (
            <div>
              <div className="section-title" style={{ color: 'var(--danger)' }}>Lý do lost</div>
              <div style={{ fontSize: 13, color: 'var(--danger)' }}>❌ {q.lost_reason}</div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  ), document.body);
}

function QuoteRow({ q, onClick, onCompanyClick }) {
  return (
    <div
      onClick={() => onClick(q)}
      style={{
        background: '#f8f9fa', border: '1px solid var(--border)',
        borderRadius: 10, padding: '14px 16px', marginBottom: 10,
        cursor: 'pointer', transition: 'all 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = 'rgba(34,197,94,0.04)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = '#f8f9fa'; }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 18 }}>{MODE_ICON[q.mode] || '📦'}</span>
            <span
              style={{ fontWeight: 600, fontSize: 14, cursor: q.pipeline_id ? 'pointer' : 'default', color: q.pipeline_id ? 'var(--primary)' : 'inherit', textDecoration: q.pipeline_id ? 'underline' : 'none', textDecorationStyle: 'dotted' }}
              onClick={e => { if (q.pipeline_id) { e.stopPropagation(); onCompanyClick(q.pipeline_id); } }}
            >{q.company_name}</span>
            {q.closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
            <strong style={{ color: 'var(--text)' }}>{q.cargo_name}</strong>
            {q.route && <span> · 📍 {q.route}</span>}
          </div>
          {/* Show first filled option inline */}
          {(() => {
            const opts = parseOptions(q.price, q.carrier).filter(o => o.carrier || o.price);
            if (!opts.length) return null;
            return (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                {opts.slice(0, 2).map((o, i) => (
                  <span key={i}>
                    <span style={{ color: '#16a34a', fontWeight: 700 }}>PA{i+1}</span>
                    {o.carrier && <span> {o.carrier}</span>}
                    {o.price && <span style={{ color: 'var(--primary)', fontWeight: 600 }}> · {o.price}</span>}
                  </span>
                ))}
                {opts.length > 2 && <span style={{ color: 'var(--text-3)' }}>+{opts.length - 2} PA nữa...</span>}
              </div>
            );
          })()}
          {q.follow_up_notes && (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic' }}>📝 {q.follow_up_notes}</div>
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
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{format(new Date(q.report_date), 'dd/MM/yyyy')}</span>
          )}
          <span style={{ fontSize: 11, color: 'var(--primary)' }}>Xem chi tiết →</span>
        </div>
      </div>
    </div>
  );
}

function CustomerRow({ c, onCompanyClick }) {
  return (
    <div style={{
      background: '#f8f9fa', border: '1px solid var(--border)',
      borderRadius: 10, padding: '14px 16px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span
              style={{ fontWeight: 600, fontSize: 14, cursor: c.pipeline_id ? 'pointer' : 'default', color: c.pipeline_id ? 'var(--primary)' : 'inherit', textDecoration: c.pipeline_id ? 'underline' : 'none', textDecorationStyle: 'dotted' }}
              onClick={() => c.pipeline_id && onCompanyClick(c.pipeline_id)}
            >{c.company_name}</span>
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
          {c.quote_count > 0 && <span className="badge badge-primary">📋 {c.quote_count} báo giá</span>}
          {c.user_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="avatar avatar-sm" style={{ background: c.avatar_color }}>{c.user_code}</div>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{c.user_name}</span>
            </div>
          )}
          {c.report_date && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{format(new Date(c.report_date), 'dd/MM/yyyy')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

const DRILL_CONFIG = {
  booked:            { title: '✅ Đã Booking', isQuote: true },
  follow_up:         { title: '🔄 Báo giá follow', isQuote: true },
  closing_soon:      { title: '⚡ Sắp Chốt', isQuote: true },
  contacts:          { title: '👥 Lượt Tiếp Cận', isQuote: false },
  total_quotes:      { title: '📋 Tổng Báo Giá', isQuote: true },
  waiting_follow_up: { title: '⏰ Chờ Follow Up', isQuote: false, splitByDate: true },
};

const TYPE_TABS = [
  { key: '', label: 'Tất cả' },
  { key: 'saved', label: 'Lưu liên hệ' },
  { key: 'contacted', label: 'Đã liên hệ' },
  { key: 'quoted', label: 'Đã báo giá' },
];

function SectionHeader({ label, count, color, bg, border }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8, marginBottom: 10,
      background: bg, border: `1px solid ${border}`,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{label}</span>
      <span style={{
        fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 10,
        background: color, color: '#fff',
      }}>{count}</span>
    </div>
  );
}

export default function DrilldownModal({ type, dateParams, userId, onClose }) {
  const zIndex = useModalZIndex();
  const config = DRILL_CONFIG[type] || {};
  const [selectedQuote, setSelectedQuote] = useState(null);
  const [filterType, setFilterType] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [detailPipelineId, setDetailPipelineId] = useState(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ['drilldown', type, dateParams, userId],
    queryFn: () => getDrilldown(type, { ...dateParams, userId }),
    enabled: !!type,
  });

  // Use local date parts to avoid UTC offset shifting the date across midnight in UTC+7
  const localDateStr = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const today = localDateStr(new Date());
  const plus7 = localDateStr(new Date(Date.now() + 7 * 86400000));

  const sq = searchQuery.trim().toLowerCase();
  const matchesSearch = (item) => !sq || item.company_name?.toLowerCase().includes(sq);

  // For waiting_follow_up: partition using effective_follow_up_date (covers both c.follow_up_date and ciu dates)
  // Parse via new Date() then extract local parts so '2026-04-18T00:00:00.000Z' in UTC+7 stays '2026-04-18'
  const effDate = (c) => {
    const raw = c.effective_follow_up_date ?? c.follow_up_date;
    if (!raw) return undefined;
    return localDateStr(new Date(raw));
  };
  const todayRows    = config.splitByDate ? data.filter(c => effDate(c) === today && matchesSearch(c))                              : [];
  const upcomingRows = config.splitByDate ? data.filter(c => effDate(c) > today && effDate(c) <= plus7 && matchesSearch(c)) : [];
  const overdueRows  = config.splitByDate ? data.filter(c => effDate(c) < today && matchesSearch(c))                               : [];

  const filteredData = data
    .filter(item => !config.isQuote && !config.splitByDate && filterType ? item.interaction_type === filterType : true)
    .filter(matchesSearch);

  const totalCount = config.splitByDate
    ? todayRows.length + upcomingRows.length + overdueRows.length
    : filteredData.length;

  return (
    <>
      {createPortal((
      <div className="modal-overlay" style={{ zIndex }} onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-lg">
          <div className="modal-header">
            <h3>{config.title}</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="badge badge-primary">{totalCount} mục</span>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
            </div>
          </div>
          <div className="modal-body">
            {/* Search */}
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 15, pointerEvents: 'none' }}>🔍</span>
              <input
                className="form-input"
                type="text"
                placeholder="Tìm theo tên công ty..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ width: '100%', paddingLeft: 36, boxSizing: 'border-box' }}
              />
            </div>

            {isLoading ? (
              <div style={{ textAlign: 'center', padding: 40 }}>
                <div className="spinner" style={{ margin: '0 auto' }} />
              </div>
            ) : data.length === 0 ? (
              <div className="empty-state">
                <div className="icon">📭</div>
                <p>Không có dữ liệu trong khoảng thời gian này</p>
              </div>
            ) : config.splitByDate ? (
              /* ── Split layout for waiting_follow_up ── */
              <div>
                {/* Today section */}
                <SectionHeader
                  label="📅 Follow hôm nay"
                  count={todayRows.length}
                  color="#d97706" bg="#fffbeb" border="#fde68a"
                />
                {todayRows.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '12px 0 20px', color: 'var(--text-3)', fontSize: 13 }}>
                    Không có khách nào cần follow hôm nay
                  </div>
                ) : todayRows.map((c, i) => (
                  <CustomerRow key={c.id || i} c={c} onCompanyClick={setDetailPipelineId} />
                ))}

                {/* Upcoming section (tomorrow → +7 days) */}
                <SectionHeader
                  label="📆 7 ngày tới"
                  count={upcomingRows.length}
                  color="#3b82f6" bg="#eff6ff" border="#bfdbfe"
                />
                {upcomingRows.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '12px 0 20px', color: 'var(--text-3)', fontSize: 13 }}>
                    Không có lịch follow nào trong 7 ngày tới
                  </div>
                ) : upcomingRows.map((c, i) => (
                  <CustomerRow key={c.id || i} c={c} onCompanyClick={setDetailPipelineId} />
                ))}

                {/* Overdue section */}
                <SectionHeader
                  label="🚨 Quá hạn"
                  count={overdueRows.length}
                  color="#ef4444" bg="#fef2f2" border="#fecaca"
                />
                {overdueRows.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text-3)', fontSize: 13 }}>
                    Không có khách nào quá hạn
                  </div>
                ) : overdueRows.map((c, i) => (
                  <CustomerRow key={c.id || i} c={c} onCompanyClick={setDetailPipelineId} />
                ))}
              </div>
            ) : (
              <div>
                {/* Filter tabs for standard customer lists */}
                {!config.isQuote && (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                    {TYPE_TABS.map(({ key, label }) => {
                      const count = key === '' ? data.length : data.filter(c => c.interaction_type === key).length;
                      return (
                        <button
                          key={key}
                          className={`btn btn-sm ${filterType === key ? 'btn-primary' : 'btn-ghost'}`}
                          onClick={() => setFilterType(key)}
                        >
                          {label}
                          <span style={{
                            marginLeft: 6,
                            background: filterType === key ? 'rgba(255,255,255,0.25)' : 'var(--border)',
                            borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700,
                          }}>
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {config.isQuote && (
                  <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>
                    💡 Nhấn vào một báo giá để xem chi tiết đầy đủ
                  </p>
                )}

                {filteredData.length === 0 ? (
                  <div className="empty-state">
                    <div className="icon">📭</div>
                    <p>Không có khách hàng nào trong mục này</p>
                  </div>
                ) : filteredData.map((item, i) =>
                  config.isQuote
                    ? <QuoteRow key={item.id || i} q={item} onClick={setSelectedQuote} onCompanyClick={setDetailPipelineId} />
                    : <CustomerRow key={item.id || i} c={item} onCompanyClick={setDetailPipelineId} />
                )}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={onClose}>Đóng</button>
          </div>
        </div>
      </div>
      ), document.body)}

      {selectedQuote && (
        <QuoteDetailModal q={selectedQuote} onClose={() => setSelectedQuote(null)} />
      )}
      {detailPipelineId && (
        <CustomerDetailModal pipelineId={detailPipelineId} onClose={() => setDetailPipelineId(null)} />
      )}
    </>
  );
}
