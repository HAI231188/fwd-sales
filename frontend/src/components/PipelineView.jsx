import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getPipeline, updatePipelineStage } from '../api';
import CustomerDetailModal from './CustomerDetailModal';

const STAGES = [
  { key: 'new',       label: 'Khách mới',   icon: '🆕', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe' },
  { key: 'dormant',   label: 'Ngủ đông',    icon: '😴', color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
  { key: 'following', label: 'Đang follow', icon: '🔄', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' },
  { key: 'booked',    label: 'Đã booking',  icon: '✅', color: '#10b981', bg: '#f0fdf4', border: '#bbf7d0' },
];

const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]));

function daysSince(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (diff === 0) return 'Hôm nay';
  if (diff === 1) return 'Hôm qua';
  return `${diff} ngày trước`;
}

function StageSelect({ currentStage, pipelineId, onUpdate, disabled }) {
  const [open, setOpen] = useState(false);
  const s = STAGE_MAP[currentStage];

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          background: s.bg, border: `1px solid ${s.border}`,
          borderRadius: 20, padding: '4px 10px',
          fontSize: 12, fontWeight: 600, color: s.color,
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {s.icon} {s.label} ▾
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 100, marginTop: 4,
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            minWidth: 150, overflow: 'hidden',
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {STAGES.map(opt => (
            <button
              key={opt.key}
              type="button"
              onClick={e => {
                e.stopPropagation();
                setOpen(false);
                if (opt.key !== currentStage) onUpdate(pipelineId, opt.key);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '9px 14px',
                background: opt.key === currentStage ? opt.bg : 'none',
                border: 'none', borderBottom: '1px solid var(--border)',
                textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font)',
                fontSize: 13, color: opt.key === currentStage ? opt.color : 'var(--text)',
                fontWeight: opt.key === currentStage ? 700 : 400,
              }}
              onMouseEnter={e => { if (opt.key !== currentStage) e.currentTarget.style.background = opt.bg; }}
              onMouseLeave={e => { if (opt.key !== currentStage) e.currentTarget.style.background = 'none'; }}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PipelineCard({ entry, onUpdate, disabled, onCompanyClick }) {
  const lastDate = entry.last_activity_date || entry.last_report_date;
  const statuses = (entry.quote_statuses || '').split(',').filter(Boolean);

  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '14px 18px',
      display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div
          style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
          onClick={() => onCompanyClick(entry.id)}
        >
          {entry.company_name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', flexWrap: 'wrap', gap: '2px 14px' }}>
          {entry.contact_person && <span>👤 {entry.contact_person}</span>}
          {entry.phone && <span>📞 {entry.phone}</span>}
          {entry.industry && <span>🏭 {entry.industry}</span>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
        {entry.stage === 'new' ? (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: STAGE_MAP.new.bg, border: `1px solid ${STAGE_MAP.new.border}`,
            borderRadius: 20, padding: '4px 10px',
            fontSize: 12, fontWeight: 600, color: STAGE_MAP.new.color,
            whiteSpace: 'nowrap',
          }}>
            {STAGE_MAP.new.icon} {STAGE_MAP.new.label}
          </span>
        ) : (
          <StageSelect
            currentStage={entry.stage}
            pipelineId={entry.id}
            onUpdate={onUpdate}
            disabled={disabled}
          />
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {entry.quote_count > 0 && (
            <span style={{
              fontSize: 11, background: '#f0f7ff', color: '#1d4ed8',
              borderRadius: 10, padding: '2px 8px', fontWeight: 600,
            }}>
              📋 {entry.quote_count} báo giá
            </span>
          )}
          {entry.has_closing_soon && (
            <span style={{
              fontSize: 11, background: '#fff7ed', color: '#ea580c',
              borderRadius: 10, padding: '2px 8px', fontWeight: 600,
            }}>
              ⚡ Sắp chốt
            </span>
          )}
          {statuses.includes('booked') && (
            <span style={{
              fontSize: 11, background: '#f0fdf4', color: '#16a34a',
              borderRadius: 10, padding: '2px 8px', fontWeight: 600,
            }}>
              ✅ Booked
            </span>
          )}
        </div>
        {lastDate && (
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            🕐 {daysSince(lastDate)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PipelineView() {
  const qc = useQueryClient();
  const [selectedStage, setSelectedStage] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const { data: pipeline = [], isLoading } = useQuery({
    queryKey: ['pipeline'],
    queryFn: getPipeline,
  });

  const stageMutation = useMutation({
    mutationFn: ({ id, stage }) => updatePipelineStage(id, stage),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pipeline'] });
      toast.success('Đã cập nhật giai đoạn');
    },
    onError: () => toast.error('Cập nhật thất bại'),
  });

  const counts = STAGES.reduce((acc, s) => {
    acc[s.key] = pipeline.filter(c => c.stage === s.key).length;
    return acc;
  }, {});

  const visibleList = selectedStage
    ? pipeline.filter(c => c.stage === selectedStage)
    : pipeline;

  return (
    <div>
      {/* Stage summary cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
        marginBottom: 24,
      }}>
        {STAGES.map(s => (
          <div
            key={s.key}
            onClick={() => setSelectedStage(selectedStage === s.key ? null : s.key)}
            style={{
              background: selectedStage === s.key ? s.bg : 'var(--bg-card)',
              border: `1.5px solid ${selectedStage === s.key ? s.color : 'var(--border)'}`,
              borderRadius: 'var(--radius)', padding: '16px 18px',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = s.color; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = selectedStage === s.key ? s.color : 'var(--border)'; }}
          >
            <div style={{ fontSize: 22, marginBottom: 6 }}>{s.icon}</div>
            <div style={{
              fontSize: 28, fontWeight: 800,
              fontFamily: 'var(--font-display)', color: s.color, lineHeight: 1,
            }}>
              {isLoading ? '—' : counts[s.key] || 0}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filter label */}
      {selectedStage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Đang xem: <strong style={{ color: STAGE_MAP[selectedStage].color }}>{STAGE_MAP[selectedStage].icon} {STAGE_MAP[selectedStage].label}</strong>
          </span>
          <button
            type="button"
            onClick={() => setSelectedStage(null)}
            style={{ fontSize: 12, background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', color: 'var(--text-2)' }}
          >
            Xem tất cả
          </button>
        </div>
      )}

      {/* Customer list */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner" style={{ margin: '0 auto' }} />
        </div>
      ) : visibleList.length === 0 ? (
        <div className="empty-state">
          <div className="icon">📊</div>
          <p>
            {selectedStage
              ? `Không có khách hàng nào ở giai đoạn "${STAGE_MAP[selectedStage].label}"`
              : 'Pipeline trống. Thêm khách hàng vào báo cáo để bắt đầu theo dõi.'
            }
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleList.map(entry => (
            <PipelineCard
              key={entry.id}
              entry={entry}
              onUpdate={(id, stage) => stageMutation.mutate({ id, stage })}
              disabled={stageMutation.isPending}
              onCompanyClick={setDetailId}
            />
          ))}
        </div>
      )}

      {detailId && (
        <CustomerDetailModal pipelineId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
