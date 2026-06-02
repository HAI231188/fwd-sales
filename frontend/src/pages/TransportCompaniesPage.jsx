import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import TransportFormModal from '../components/TransportFormModal';
import { getTransportCompanies, deleteTransportCompany, getRoutePriceHistory } from '../api';
import { fmtDate } from '../utils/dateFmt';

const SORT_OPTIONS = [
  { key: 'name',        label: 'Tên (A→Z)' },
  { key: 'name_desc',   label: 'Tên (Z→A)' },
  { key: 'jobs_desc',   label: 'Job nhiều nhất' },
  { key: 'jobs_asc',    label: 'Job ít nhất' },
  { key: 'recent',      label: 'Mới nhất' },
];

function applySort(rows, key) {
  const arr = [...rows];
  switch (key) {
    case 'name_desc': return arr.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
    case 'jobs_desc': return arr.sort((a, b) => (b.job_count || 0) - (a.job_count || 0));
    case 'jobs_asc':  return arr.sort((a, b) => (a.job_count || 0) - (b.job_count || 0));
    case 'recent':    return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    case 'name':
    default:          return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
}

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' };
const td = { padding: '10px 12px', color: 'var(--text)' };

export default function TransportCompaniesPage() {
  const qc = useQueryClient();
  const [mainTab, setMainTab] = useState('carriers'); // 'carriers' | 'routes'
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);    // full row object
  const [deleting, setDeleting] = useState(null);  // { id, name, job_count } awaiting confirm

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ['transportCompanies', search],
    queryFn: () => getTransportCompanies(search),
  });

  const sorted = useMemo(() => applySort(rows, sort), [rows, sort]);

  const deleteMut = useMutation({
    mutationFn: id => deleteTransportCompany(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transportCompanies'] });
      setDeleting(null);
      toast.success('Đã xóa vận tải');
    },
    onError: (err) => toast.error(err?.error || err?.message || 'Lỗi khi xóa'),
  });

  function handleSaved() {
    qc.invalidateQueries({ queryKey: ['transportCompanies'] });
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>
            Quản lý vận tải
          </h2>
          {mainTab === 'carriers' && (
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              + Thêm vận tải mới
            </button>
          )}
        </div>

        <div className="tabs" style={{ marginBottom: 16 }}>
          <button className={`tab ${mainTab === 'carriers' ? 'active' : ''}`} onClick={() => setMainTab('carriers')}>Danh sách vận tải</button>
          <button className={`tab ${mainTab === 'routes' ? 'active' : ''}`} onClick={() => setMainTab('routes')}>Lịch sử giá tuyến</button>
        </div>

        {mainTab === 'routes' && <RoutePriceHistory />}

        {mainTab === 'carriers' && (<>
        <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="form-input"
            placeholder="Tìm theo tên..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: 320, flex: 1, minWidth: 180 }}
          />
          <select
            className="form-select"
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{ width: 'auto', minWidth: 160 }}
          >
            {SORT_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
          <span style={{ fontSize: 12, color: 'var(--text-2)', marginLeft: 'auto' }}>
            {sorted.length} vận tải
          </span>
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
                    <th style={th}>Tên</th>
                    <th style={th}>MST</th>
                    <th style={th}>Email</th>
                    <th style={{ ...th, textAlign: 'center' }}>Email CC</th>
                    <th style={th}>SĐT</th>
                    <th style={th}>Người liên hệ</th>
                    <th style={{ ...th, textAlign: 'center' }}>Số job đã chạy</th>
                    <th style={{ ...th, textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                      {search ? 'Không có vận tải nào khớp tìm kiếm' : 'Chưa có vận tải nào — bấm "+ Thêm vận tải mới" để tạo'}
                    </td></tr>
                  )}
                  {sorted.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={td}><strong>{c.name}</strong></td>
                      <td style={td}>{c.tax_code || '—'}</td>
                      <td style={td}>{c.email || '—'}</td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        {Array.isArray(c.email_cc) && c.email_cc.length > 0 ? (
                          <span title={c.email_cc.join('\n')} style={{ cursor: 'help', fontWeight: 500, color: 'var(--info)' }}>
                            {c.email_cc.length} email{c.email_cc.length > 1 ? 's' : ''}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-3)' }}>—</span>
                        )}
                      </td>
                      <td style={td}>{c.phone || '—'}</td>
                      <td style={td}>{c.contact_person || '—'}</td>
                      <td style={{ ...td, textAlign: 'center', fontWeight: 600, color: c.job_count > 0 ? 'var(--info)' : 'var(--text-3)' }}>
                        {c.job_count || 0}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginRight: 4 }}
                          onClick={() => setEditing(c)}>
                          ✏️ Sửa
                        </button>
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          onClick={() => setDeleting({ id: c.id, name: c.name, job_count: c.job_count })}>
                          🗑 Xóa
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </>)}
      </div>

      {showCreate && (
        <TransportFormModal
          onClose={() => setShowCreate(false)}
          onSaved={handleSaved}
        />
      )}
      {editing && (
        <TransportFormModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
      {deleting && (
        <div className="modal-overlay" style={{ zIndex: 1100 }}
          onClick={e => { if (e.target === e.currentTarget) setDeleting(null); }}>
          <div className="modal" style={{ maxWidth: 460, width: '95%' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: 16 }}>Xóa vận tải</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setDeleting(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 16, fontSize: 13 }}>
              <p>Xóa vận tải <strong>{deleting.name}</strong>?</p>
              {deleting.job_count > 0 && (
                <p style={{ color: 'var(--warning)', marginTop: 8 }}>
                  ⚠ Vận tải này đang được dùng trong <strong>{deleting.job_count}</strong> job. Tên vận tải vẫn được giữ trên các job cũ làm snapshot.
                </p>
              )}
              <p style={{ color: 'var(--text-2)', marginTop: 8, fontSize: 12 }}>
                Soft delete — có thể khôi phục sau bằng cách clear cột deleted_at.
              </p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(null)} disabled={deleteMut.isPending}>Hủy</button>
              <button className="btn btn-danger btn-sm"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate(deleting.id)}>
                {deleteMut.isPending ? 'Đang xóa...' : 'Xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Đợt 1: Route price-history lookup ──────────────────────────────────────
function fmtVnd(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('vi-VN') + 'đ';
}
const rpTh = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' };
const rpTd = { padding: '9px 12px', color: 'var(--text)', fontSize: 13, verticalAlign: 'top' };

function RoutePriceHistory() {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Only updated on submit so typing doesn't spam the API.
  const [submitted, setSubmitted] = useState(null); // { q, from, to } | null

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['route-price-history', submitted?.q, submitted?.from, submitted?.to],
    queryFn: () => getRoutePriceHistory({
      q: submitted.q,
      ...(submitted.from ? { from: submitted.from } : {}),
      ...(submitted.to ? { to: submitted.to } : {}),
    }),
    enabled: !!submitted?.q,
  });

  function doSearch(e) {
    e?.preventDefault?.();
    const qq = q.trim();
    if (!qq) return;
    setSubmitted({ q: qq, from: from || '', to: to || '' });
  }

  const rows = data?.rows || [];
  const agg = data?.aggregates || { count: 0, avg_cost: null, min_cost: null, max_cost: null };
  const totalMatched = data?.total_matched || 0;
  const busy = isLoading || isFetching;

  return (
    <>
      <form onSubmit={doSearch} className="card"
        style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <label style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
            Tìm theo địa điểm (điểm đi / điểm đến)
          </label>
          <input className="form-input" placeholder="VD: Cát Lái, Hà Nội, kho ABC..."
            value={q} onChange={e => setQ(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Từ ngày</label>
          <input type="date" className="form-input" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Đến ngày</label>
          <input type="date" className="form-input" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!q.trim()}>🔍 Tìm</button>
      </form>

      {submitted?.q && !busy && !error && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, display: 'flex',
          gap: 18, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <span>Tìm thấy <strong>{totalMatched}</strong> chuyến</span>
          <span style={{ color: 'var(--text-2)' }}>Có giá: <strong style={{ color: 'var(--text)' }}>{agg.count}</strong></span>
          <span>Giá TB: <strong style={{ color: 'var(--info)' }}>{agg.avg_cost != null ? fmtVnd(Math.round(agg.avg_cost)) : '—'}</strong></span>
          <span>Thấp nhất: <strong style={{ color: 'var(--primary)' }}>{fmtVnd(agg.min_cost)}</strong></span>
          <span>Cao nhất: <strong style={{ color: 'var(--danger)' }}>{fmtVnd(agg.max_cost)}</strong></span>
          {totalMatched > rows.length && (
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>(hiển thị {rows.length} mới nhất)</span>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {!submitted?.q ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            Nhập địa điểm rồi bấm <strong>Tìm</strong> để xem lịch sử giá các tuyến.
          </div>
        ) : busy ? (
          <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
        ) : error ? (
          <div style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>
            Lỗi: {error?.error || error?.message || 'Unknown'}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            Không tìm thấy chuyến nào khớp địa điểm này.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                  <th style={rpTh}>Ngày</th>
                  <th style={rpTh}>Nhà xe</th>
                  <th style={rpTh}>Loại cont</th>
                  <th style={rpTh}>Loại xe</th>
                  <th style={rpTh}>Điểm đi → Điểm đến</th>
                  <th style={rpTh}>Số xe</th>
                  <th style={{ ...rpTh, textAlign: 'right' }}>Giá (VND)</th>
                  <th style={{ ...rpTh, textAlign: 'center' }}>Nguồn</th>
                  <th style={rpTh}>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ ...rpTd, whiteSpace: 'nowrap' }}>{fmtDate(r.booked_at)}</td>
                    <td style={{ ...rpTd, fontWeight: 600 }}>{r.carrier || '—'}</td>
                    <td style={{ ...rpTd, whiteSpace: 'nowrap' }}>
                      {r.cont_type ? `${r.cont_type}${r.cont_qty ? ` ×${r.cont_qty}` : ''}` : '—'}
                    </td>
                    <td style={rpTd}>{r.vehicle_type || '—'}</td>
                    <td style={{ ...rpTd, minWidth: 220 }}>
                      <span style={{ color: 'var(--text-2)' }}>{r.pickup_location || '—'}</span>
                      <span style={{ color: 'var(--text-3)', margin: '0 6px' }}>→</span>
                      <span>{r.delivery_location || '—'}</span>
                    </td>
                    <td style={{ ...rpTd, whiteSpace: 'nowrap' }}>{r.vehicle_number || '—'}</td>
                    <td style={{ ...rpTd, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                      {fmtVnd(r.cost)}
                    </td>
                    <td style={{ ...rpTd, textAlign: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 6,
                        background: r.source === 'live' ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)',
                        color: r.source === 'live' ? '#16a34a' : '#3b82f6' }}>
                        {r.source === 'live' ? 'live' : 'import'}
                      </span>
                    </td>
                    <td style={{ ...rpTd, maxWidth: 200, color: 'var(--text-2)' }}>{r.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
