import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, differenceInDays } from 'date-fns';
import { getPipelineDetail, updateQuote } from '../api';
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

export default function CustomerDetailModal({ pipelineId, onClose }) {
  const [editingQuoteId, setEditingQuoteId] = useState(null);

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

            {/* ── Left column: static info ── */}
            <div style={{
              width: '35%', flexShrink: 0,
              borderRight: '1px solid var(--border)',
              padding: '20px 20px 24px',
              overflowY: 'auto',
              background: '#fafbfc',
            }}>
              {/* Stats row */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
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

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                <InfoRow label="Người liên hệ" value={pipeline.contact_person} />
                <InfoRow label="Điện thoại" value={pipeline.phone} />
                <InfoRow label="Ngành hàng" value={pipeline.industry} />
                <InfoRow label="Nguồn" value={SOURCE_LABEL[pipeline.source] || pipeline.source} />

                {/* Last activity */}
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
                      <span style={{
                        fontSize: 12, fontWeight: 700, padding: '3px 12px', borderRadius: 20,
                        background: potential.bg, color: potential.color, border: `1px solid ${potential.border}`,
                      }}>
                        {potential.label}
                      </span>
                    </div>
                  )}

                  {latest.decision_maker && (
                    <div style={{ marginBottom: 10 }}>
                      <span style={{
                        fontSize: 12, fontWeight: 600, padding: '3px 12px', borderRadius: 20,
                        background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe',
                      }}>
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
            </div>

            {/* ── Right column: timeline ── */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 24px' }}>
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
                        {/* Card header: type badge + date */}
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
                          {c.report_date && (
                            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 500 }}>
                              {format(new Date(c.report_date), 'dd/MM/yyyy')}
                            </span>
                          )}
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
                                          fontSize: 11, padding: '2px 8px', borderRadius: 6,
                                          border: '1px solid var(--border)',
                                          background: isEditing ? '#eff6ff' : 'var(--bg)',
                                          color: isEditing ? '#1d4ed8' : 'var(--text-2)',
                                          cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 600,
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
