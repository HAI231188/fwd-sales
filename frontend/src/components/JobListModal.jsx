import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFilteredJobs } from '../api';
import JobDetailModal from './JobDetailModal';

const FILTER_TITLES = {
  // TP
  pending:          'Tổng job pending',
  tp_tk_pending:    'TK pending',
  tp_truck_pending: 'Đặt xe pending',
  warning: 'Sắp hạn (48h)',
  missing: 'Thiếu thông tin',
  overdue: 'Quá deadline',
  // CUS
  cus_active: 'Tổng job đang làm',
  cus_waiting_confirm: 'Chờ xác nhận',
  cus_near_deadline: 'Sắp hạn (24h)',
  cus_overdue: 'Quá hạn',
  // DieuDo
  truck_total: 'Tổng job truck đang xử lý',
  truck_booked: 'Đã đặt xe',
  truck_not_booked: 'Chưa đặt xe',
  truck_warning: 'Cảnh báo quá hạn',
  truck_pending: 'Chưa hoàn thành',
  dd_co_kh_xe: 'Đã có KH xe',
  dd_chua_kh_xe: 'Chưa có KH xe',
  dd_canh_bao_chua_van_tai: 'Cảnh báo: chưa có vận tải',
  dd_canh_bao_chua_doi_lenh: 'Cảnh báo: chưa đổi lệnh',
  dd_canh_bao_chua_hoan_thanh: 'Cảnh báo: chưa hoàn thành',
  dd_sap_han: 'Sắp hạn (48h)',
  // OPS
  ops_total: 'Tổng job đang quản lý',
  ops_waiting_tq_doilenh: 'Chờ thông quan',
  ops_waiting_doilenh: 'Chờ xử lý đổi lệnh',
  ops_near_deadline: 'Sắp hạn (24h)',
  ops_overdue: 'Quá hạn',
  // Staff drill-down — CUS
  staff_cus_pending_tk:        'Job pending TK',
  staff_cus_awaiting_confirm:  'Job chờ xác nhận',
  staff_cus_chua_truyen:       'Chưa truyền TK',
  staff_cus_dang_tq:           'Đang chờ thông quan',
  staff_cus_overdue:           'Quá deadline',
  staff_cus_near_deadline:     'Sắp hạn (24h)',
  staff_cus_missing_info:      'Thiếu thông tin',
  // Staff drill-down — Điều Độ
  staff_dd_pending:            'Job pending Điều Độ',
  staff_dd_no_plan:            'Chưa có kế hoạch',
  staff_dd_has_plan:           'Đã có kế hoạch',
  staff_dd_booked:             'Đã đặt xe',
  staff_dd_plan_no_truck:      'Đã có KH chưa đặt xe',
  staff_dd_urgent_no_truck:    'Sắp giao chưa đặt xe (16h)',
  staff_dd_overdue_delivery:   'Giao hàng rồi chưa hoàn thành',
  // Staff drill-down — OPS
  staff_ops_managing:          'Job quản lý',
  staff_ops_tq_doi_lenh:       'Chờ TQ + đổi lệnh',
  staff_ops_doi_lenh:          'Chờ đổi lệnh',
  staff_ops_near_deadline:     'Sắp quá deadline TQ (4h)',
};

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const TK_FLOW_LABEL = { xanh: 'Xanh', vang: 'Vàng', do: 'Đỏ' };
const TK_FLOW_COLOR = { xanh: '#22c55e', vang: '#d97706', do: '#ef4444' };

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('vi-VN'); }
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function deadlineStyle(dl, filterType) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (
    filterType === 'overdue' || filterType === 'cus_overdue' || filterType === 'ops_overdue' ||
    filterType === 'staff_cus_overdue' || ms < 0
  ) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 48 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}

function getColumns(filterType) {
  if (filterType?.startsWith('truck_') || filterType?.startsWith('dd_') || filterType?.startsWith('staff_dd_')) {
    return [
      { key: 'job_code',               label: 'Số job' },
      { key: 'created_at',             label: 'Ngày tạo' },
      { key: 'customer_name',          label: 'Khách hàng' },
      { key: 'deadline',               label: 'Deadline' },
      { key: 'transport_name',         label: 'Vận tải' },
      { key: 'vehicle_number',         label: 'Số xe' },
      { key: 'planned_datetime',       label: 'KH ngày giờ' },
      { key: 'cost',                   label: 'Cước' },
      { key: 'truck_delivery_location',label: 'Địa điểm giao' },
    ];
  }
  if (filterType?.startsWith('ops_') || filterType?.startsWith('staff_ops_')) {
    return [
      { key: 'job_code',          label: 'Số job' },
      { key: 'created_at',        label: 'Ngày tạo' },
      { key: 'customer_name',     label: 'Khách hàng' },
      { key: 'deadline',          label: 'Deadline' },
      { key: 'han_lenh',          label: 'Hạn lệnh' },
      { key: 'tk_status',         label: 'TT TK' },
      { key: 'tq_datetime',       label: 'Ngày TQ' },
      { key: 'ops_tasks_pending', label: 'CV chờ xử lý' },
    ];
  }
  if (filterType?.startsWith('cus_') || filterType?.startsWith('staff_cus_')) {
    const cols = [
      { key: 'job_code',      label: 'Số job' },
      { key: 'created_at',   label: 'Ngày tạo' },
      { key: 'customer_name',label: 'Khách hàng' },
      { key: 'deadline',     label: 'Deadline' },
      { key: 'tk_flow',      label: 'Luồng TK' },
      { key: 'tk_status',    label: 'TT TK' },
      { key: 'tq_datetime',  label: 'Ngày TQ' },
      { key: 'ops_name',     label: 'OPS' },
    ];
    if (filterType === 'staff_cus_missing_info') cols.push({ key: 'missing_fields', label: 'Thiếu' });
    return cols;
  }
  // TP default
  const cols = [
    { key: 'job_code',      label: 'Số job' },
    { key: 'created_at',   label: 'Ngày tạo' },
    { key: 'customer_name',label: 'Khách hàng' },
    { key: 'deadline',     label: 'Deadline' },
    { key: 'cus_name',     label: 'CUS' },
    { key: 'ops_name',     label: 'OPS' },
    { key: 'tk_status',    label: 'TT TK' },
  ];
  if (filterType === 'missing') cols.push({ key: 'missing_fields', label: 'Thiếu' });
  return cols;
}

function renderCell(key, j, filterType) {
  switch (key) {
    case 'job_code':
      return <span style={{ fontSize: 12, color: 'var(--info)', fontWeight: 500 }}>{j.job_code || `#${j.id}`}</span>;
    case 'created_at':
      return <span style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{fmtDate(j.created_at)}</span>;
    case 'customer_name':
      return <span style={{ fontWeight: 500 }}>{j.customer_name}</span>;
    case 'deadline':
      return <span style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.deadline, filterType) }}>
        {j.deadline ? fmtDt(j.deadline) : <span style={{ color: 'var(--text-3)' }}>—</span>}
      </span>;
    case 'han_lenh':
      return <span style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.han_lenh, filterType), fontSize: 12 }}>
        {fmtDt(j.han_lenh)}
      </span>;
    case 'cus_name':
      return j.cus_name
        ? <span style={{ fontSize: 12 }}>{j.cus_name}</span>
        : <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>;
    case 'ops_name':
      return <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.ops_name || '—'}</span>;
    case 'tk_status':
      return j.tk_status
        ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500, fontSize: 12 }}>{TK_STATUS_LABEL[j.tk_status]}</span>
        : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
    case 'tk_flow':
      return j.tk_flow
        ? <span style={{ color: TK_FLOW_COLOR[j.tk_flow], fontWeight: 600, fontSize: 12 }}>{TK_FLOW_LABEL[j.tk_flow]}</span>
        : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
    case 'tq_datetime':
      return <span style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{fmtDt(j.tq_datetime)}</span>;
    case 'transport_name':
      return <span style={{ fontSize: 12 }}>{j.transport_name || '—'}</span>;
    case 'vehicle_number':
      return <span style={{ fontSize: 12 }}>{j.vehicle_number || '—'}</span>;
    case 'planned_datetime':
      return <span style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{fmtDt(j.planned_datetime)}</span>;
    case 'cost':
      return <span style={{ fontSize: 12 }}>
        {j.cost ? Number(j.cost).toLocaleString('vi-VN') + ' đ' : '—'}
      </span>;
    case 'truck_delivery_location':
      return <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.truck_delivery_location || '—'}</span>;
    case 'ops_tasks_pending':
      return <span style={{ fontSize: 12, color: j.ops_tasks_pending ? 'var(--text)' : 'var(--text-3)' }}>
        {j.ops_tasks_pending || '—'}
      </span>;
    case 'missing_fields':
      return <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 500 }}>
        {j.missing_fields?.trim() || '—'}
      </span>;
    default:
      return null;
  }
}

const TH = ({ children }) => (
  <th style={{ padding: '10px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
    {children}
  </th>
);
const TD = ({ children, style }) => (
  <td style={{ padding: '8px 10px', ...style }}>{children}</td>
);

export default function JobListModal({ filterType, staffId, staffName, onClose }) {
  const [detailJobId, setDetailJobId] = useState(null);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['filteredJobs', filterType, staffId || null],
    queryFn: () => getFilteredJobs(filterType, staffId),
  });

  const baseTitle = FILTER_TITLES[filterType] || filterType;
  const title = staffName ? `${baseTitle} — ${staffName}` : baseTitle;
  const columns = getColumns(filterType);

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
                      {columns.map(c => <TH key={c.key}>{c.label}</TH>)}
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map(j => (
                      <tr key={j.id}
                        onClick={() => setDetailJobId(j.id)}
                        style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        {columns.map(c => (
                          <TD key={c.key}>{renderCell(c.key, j, filterType)}</TD>
                        ))}
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
