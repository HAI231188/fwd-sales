import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getCustomerJobs } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';
import JobDetailModal from './JobDetailModal';

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền',
  dang_lam:    'Đang làm',
  thong_quan:  'Thông quan',
  giai_phong:  'Giải phóng',
  bao_quan:    'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280',
  dang_lam:    '#d97706',
  thong_quan:  '#22c55e',
  giai_phong:  '#3b82f6',
  bao_quan:    '#7c3aed',
};

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function InfoLine({ label, value }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--text-3)', fontWeight: 600, marginRight: 6 }}>{label}:</span>
      <span style={{ color: 'var(--text)' }}>{value || '—'}</span>
    </div>
  );
}

const TH_STYLE = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-2)',
  background: 'var(--bg)',
  borderBottom: '2px solid var(--border)',
  whiteSpace: 'nowrap',
};
const TD_STYLE = {
  padding: '8px 10px',
  fontSize: 12,
  color: 'var(--text)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export default function CustomerJobsModal({ pipelineId, from, to, onClose }) {
  const zIndex = useModalZIndex();
  const [selectedJobId, setSelectedJobId] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['customerJobs', pipelineId, from, to],
    queryFn: () => getCustomerJobs(pipelineId, from || '', to || ''),
    enabled: !!pipelineId,
  });

  const customer = data?.customer || {};
  const jobs     = data?.jobs     || [];
  const total    = data?.total_jobs ?? jobs.length;

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 24, zIndex,
      }}
    >
      <div style={{
        background: '#fff',
        borderRadius: 12,
        width: '100%',
        maxWidth: 900,
        maxHeight: 'calc(100vh - 48px)',
        overflowY: 'auto',
        boxShadow: '0 12px 36px rgba(0,0,0,0.2)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Title bar */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
            🏢 {customer.company_name || '—'}
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 16, color: 'var(--text-2)', padding: '4px 10px' }}
            title="Đóng"
          >
            ✕
          </button>
        </div>

        {/* Customer info */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 24px',
          }}>
            <InfoLine label="Tên công ty" value={customer.company_name} />
            <InfoLine label="MST"          value={customer.tax_code} />
            <InfoLine label="Liên hệ"      value={customer.contact_person} />
            <InfoLine label="SĐT"          value={customer.phone} />
            {customer.address && (
              <div style={{ gridColumn: '1 / span 2' }}>
                <InfoLine label="Địa chỉ" value={customer.address} />
              </div>
            )}
          </div>
        </div>

        {/* Jobs section */}
        <div style={{ padding: '14px 20px', flex: 1 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10, flexWrap: 'wrap', gap: 8,
          }}>
            <div style={{
              fontSize: 13, fontWeight: 700, color: 'var(--text)',
              textTransform: 'uppercase', letterSpacing: '0.5px',
            }}>
              Danh sách job ({total})
            </div>
            {(from || to) && (
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                Khoảng thời gian: <strong>{fmtDate(from)}</strong> → <strong>{fmtDate(to)}</strong>
              </div>
            )}
          </div>

          {isLoading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-2)', fontSize: 12 }}>
              Đang tải...
            </div>
          )}

          {!isLoading && error && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--danger)', fontSize: 12 }}>
              Lỗi tải dữ liệu: {error?.error || error?.message || 'Unknown'}
            </div>
          )}

          {!isLoading && !error && jobs.length === 0 && (
            <div style={{
              padding: 30, textAlign: 'center',
              color: 'var(--text-2)', fontSize: 12,
              border: '1px dashed var(--border)', borderRadius: 8,
            }}>
              Khách hàng chưa có job nào trong khoảng thời gian này
            </div>
          )}

          {!isLoading && !error && jobs.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={TH_STYLE}>Số job</th>
                    <th style={TH_STYLE}>Ngày tạo</th>
                    <th style={TH_STYLE}>Số cont</th>
                    <th style={TH_STYLE}>ETD</th>
                    <th style={TH_STYLE}>ETA</th>
                    <th style={TH_STYLE}>TT TK</th>
                    <th style={TH_STYLE}>CUS</th>
                    <th style={TH_STYLE}>OPS</th>
                    <th style={TH_STYLE}>Ngày trả hàng</th>
                    <th style={TH_STYLE}>Vận tải</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr
                      key={j.id}
                      onClick={() => setSelectedJobId(j.id)}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.06)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td style={{ ...TD_STYLE, fontWeight: 600, color: 'var(--primary)' }}>
                        {j.job_code || '—'}
                      </td>
                      <td style={TD_STYLE}>{fmtDate(j.created_at)}</td>
                      <td style={TD_STYLE}>{j.containers_summary || '—'}</td>
                      <td style={TD_STYLE}>{fmtDate(j.etd)}</td>
                      <td style={TD_STYLE}>{fmtDate(j.eta)}</td>
                      <td style={TD_STYLE}>
                        {j.tk_status ? (
                          <span style={{
                            color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)',
                            fontWeight: 600,
                          }}>
                            {TK_STATUS_LABEL[j.tk_status] || j.tk_status}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={TD_STYLE}>{j.cus_name || '—'}</td>
                      <td style={TD_STYLE}>{j.ops_name || '—'}</td>
                      <td style={TD_STYLE}>{fmtDt(j.delivery_datetime)}</td>
                      <td style={TD_STYLE}>{j.transport_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selectedJobId && (
          <JobDetailModal jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
        )}
      </div>
    </div>,
    document.body
  );
}
