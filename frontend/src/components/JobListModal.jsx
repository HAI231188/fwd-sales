import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFilteredJobs } from '../api';
import JobDetailModal from './JobDetailModal';

const FILTER_TITLES = {
  pending: 'Tổng job pending',
  warning: 'Sắp hạn (48h)',
  missing: 'Thiếu thông tin',
  overdue: 'Quá deadline',
};

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('vi-VN'); }
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function deadlineStyle(dl, type) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (type === 'overdue' || ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 48 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}

const TH = ({ children }) => (
  <th style={{ padding: '10px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
    {children}
  </th>
);
const TD = ({ children, style }) => (
  <td style={{ padding: '8px 10px', ...style }}>{children}</td>
);

export default function JobListModal({ filterType, onClose }) {
  const [detailJobId, setDetailJobId] = useState(null);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['filteredJobs', filterType],
    queryFn: () => getFilteredJobs(filterType),
  });

  const title = FILTER_TITLES[filterType] || filterType;

  return (
    <>
      <div className="modal-overlay" style={{ zIndex: 1050 }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal modal-lg" style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
          <div className="modal-header">
            <h3>{title} ({isLoading ? '…' : jobs.length})</h3>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>

          <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: 0 }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : jobs.length === 0 ? (
              <div className="empty-state">
                <div className="icon">✅</div>
                <p>Không có job nào</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <TH>Số job</TH>
                      <TH>Ngày tạo</TH>
                      <TH>Khách hàng</TH>
                      <TH>Deadline</TH>
                      <TH>CUS</TH>
                      <TH>OPS</TH>
                      <TH>TT TK</TH>
                      {filterType === 'missing' && <TH>Thiếu</TH>}
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map(j => (
                      <tr key={j.id}
                        onClick={() => setDetailJobId(j.id)}
                        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        <TD>
                          <span style={{ fontSize: 12, color: 'var(--info)', fontWeight: 500 }}>
                            {j.job_code || `#${j.id}`}
                          </span>
                        </TD>
                        <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>
                          {fmtDate(j.created_at)}
                        </TD>
                        <TD style={{ fontWeight: 500 }}>{j.customer_name}</TD>
                        <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline, filterType) }}>
                          {j.deadline ? fmtDt(j.deadline) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                        </TD>
                        <TD>
                          {j.cus_name
                            ? <span style={{ fontSize: 12 }}>{j.cus_name}</span>
                            : <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>}
                        </TD>
                        <TD style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.ops_name || '—'}</TD>
                        <TD>
                          {j.tk_status
                            ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500, fontSize: 12 }}>{TK_STATUS_LABEL[j.tk_status]}</span>
                            : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}
                        </TD>
                        {filterType === 'missing' && (
                          <TD style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 500 }}>
                            {j.missing_fields?.trim() || '—'}
                          </TD>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {detailJobId && (
        <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
      )}
    </>
  );
}
