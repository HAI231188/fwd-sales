import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import CustomerEditModal from '../components/CustomerEditModal';
import { getCustomerPipelines, deleteCustomerPipeline } from '../api';
import { useAuth } from '../App';

// "Data khách hàng" — TP + lead management view of all customer_pipeline rows.
// Search (ILIKE on company_name OR company_full_name) is served by the backend;
// sort + pagination are client-side because the row count is small enough that
// shipping all rows is cheaper than chatty pagination requests.

const PAGE_SIZE = 50;

const SORT_OPTIONS = [
  { key: 'updated',   label: 'Cập nhật mới nhất' },
  { key: 'name',      label: 'Tên (A→Z)' },
  { key: 'name_desc', label: 'Tên (Z→A)' },
  { key: 'jobs',      label: 'Job nhiều nhất' },
  { key: 'jobs_asc',  label: 'Job ít nhất' },
];

function applySort(rows, key) {
  const arr = [...rows];
  const byName = (a, b) => (a.company_name || '').localeCompare(b.company_name || '');
  switch (key) {
    case 'name':      return arr.sort(byName);
    case 'name_desc': return arr.sort((a, b) => byName(b, a));
    case 'jobs':      return arr.sort((a, b) => (b.job_count || 0) - (a.job_count || 0));
    case 'jobs_asc':  return arr.sort((a, b) => (a.job_count || 0) - (b.job_count || 0));
    case 'updated':
    default:
      return arr.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }
}

const STAGE_LABEL = {
  new: 'Mới', following: 'Đang follow', dormant: 'Dormant', booked: 'Booked',
};
const STAGE_BG = {
  new:       'rgba(59,130,246,0.12)',
  following: 'rgba(34,197,94,0.12)',
  dormant:   'rgba(107,114,128,0.12)',
  booked:    'rgba(124,58,237,0.12)',
};
const STAGE_COLOR = {
  new: '#3b82f6', following: '#16a34a',
  dormant: '#6b7280', booked: '#7c3aed',
};

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' };
const td = { padding: '10px 12px', color: 'var(--text)', verticalAlign: 'top' };

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

export default function CustomerDataPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  // Delete is open to TP + Lead, same as edit. Backend enforces both the role
  // gate and the 0-job guard — see backend/src/routes/customer-pipeline.js.
  const canDelete = user?.role === 'lead' || user?.role === 'truong_phong_log';

  const [search, setSearch] = useState('');
  const [sort, setSort]     = useState('updated');
  const [page, setPage]     = useState(0);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['customerPipelines', search],
    queryFn: () => getCustomerPipelines(search),
  });

  const sorted = useMemo(() => applySort(rows, sort), [rows, sort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [sorted, safePage]
  );

  const deleteMut = useMutation({
    mutationFn: (row) => deleteCustomerPipeline(row.id),
    onSuccess: (_data, row) => {
      qc.invalidateQueries({ queryKey: ['customerPipelines'] });
      setDeleting(null);
      toast.success(`Đã xóa khách ${row.company_name}`);
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi khi xóa'),
  });

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['customerPipelines'] });
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>
            Data khách hàng
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {sorted.length} khách
          </span>
        </div>

        <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="form-input"
            placeholder="Tìm theo tên / tên công ty..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            style={{ maxWidth: 320, flex: 1, minWidth: 180 }}
          />
          <select
            className="form-select"
            value={sort}
            onChange={e => { setSort(e.target.value); setPage(0); }}
            style={{ width: 'auto', minWidth: 180 }}
          >
            {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {isLoading && (
            <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
          )}
          {error && (
            <div style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>
              Lỗi tải dữ liệu: {error?.error || error?.message || 'Unknown'}
            </div>
          )}
          {!isLoading && !error && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                    <th style={th}>Tên khách</th>
                    <th style={th}>Tên công ty (xuất HĐ)</th>
                    <th style={th}>MST</th>
                    <th style={th}>Địa chỉ xuất HĐ</th>
                    <th style={th}>Sales</th>
                    <th style={{ ...th, textAlign: 'center' }}>Stage</th>
                    <th style={{ ...th, textAlign: 'center' }}>Job đã chạy</th>
                    <th style={{ ...th, textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                      {search ? 'Không có khách nào khớp tìm kiếm' : 'Chưa có khách hàng nào'}
                    </td></tr>
                  )}
                  {pageRows.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{c.company_name}</td>
                      <td style={td}>
                        {c.company_full_name
                          ? <span title={c.company_full_name}>{truncate(c.company_full_name, 40)}</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td style={td}>{c.tax_code || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                      <td style={td}>
                        {c.invoice_address
                          ? <span title={c.invoice_address} style={{ cursor: 'help' }}>{truncate(c.invoice_address, 36)}</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td style={td}>
                        {c.sales_name ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div className="avatar avatar-sm" style={{ background: c.sales_avatar_color || '#6b7280' }}>
                              {c.sales_code || '?'}
                            </div>
                            <span style={{ fontSize: 12 }}>{c.sales_name}</span>
                          </div>
                        ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <span style={{ background: STAGE_BG[c.stage] || 'rgba(0,0,0,0.04)',
                          color: STAGE_COLOR[c.stage] || 'var(--text)',
                          borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                          {STAGE_LABEL[c.stage] || c.stage}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'center', fontWeight: 600,
                        color: c.job_count > 0 ? 'var(--info)' : 'var(--text-3)' }}>
                        {c.job_count || 0}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginRight: 4 }}
                          onClick={() => setEditing(c)}>
                          ✏️ Sửa
                        </button>
                        {canDelete && (() => {
                          const hasJobs = (c.job_count || 0) > 0;
                          return (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{
                                fontSize: 11,
                                color: hasJobs ? 'var(--text-3)' : 'var(--danger)',
                                borderColor: hasJobs ? 'var(--border)' : 'var(--danger)',
                                cursor: hasJobs ? 'not-allowed' : 'pointer',
                                opacity: hasJobs ? 0.5 : 1,
                              }}
                              disabled={hasJobs}
                              title={hasJobs ? 'Khách còn job, không thể xóa' : 'Xóa khách'}
                              onClick={() => { if (!hasJobs) setDeleting(c); }}
                            >
                              🗑 Xóa
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination — only render when needed */}
          {!isLoading && sorted.length > PAGE_SIZE && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" disabled={safePage === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}>← Trước</button>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                Trang {safePage + 1} / {totalPages}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={safePage >= totalPages - 1}
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}>Sau →</button>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <CustomerEditModal pipeline={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved} />
      )}

      {deleting && (
        <div className="modal-overlay" style={{ zIndex: 1100 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleting(null); }}>
          <div className="modal" style={{ maxWidth: 460, width: '95%' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: 16 }}>Xóa khách hàng</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setDeleting(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 16, fontSize: 13 }}>
              <p>Xóa khách <strong>{deleting.company_name}</strong>?</p>
              <p style={{ color: 'var(--text-2)', marginTop: 8, fontSize: 12 }}>
                Hành động này ẩn khách khỏi danh sách (soft delete). Có thể khôi phục sau bằng cách clear cột deleted_at.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(null)} disabled={deleteMut.isPending}>Hủy</button>
              <button className="btn btn-danger btn-sm"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate(deleting)}>
                {deleteMut.isPending ? 'Đang xóa...' : 'Xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
