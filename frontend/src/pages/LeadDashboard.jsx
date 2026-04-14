import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import Navbar from '../components/Navbar';
import StatCard from '../components/StatCard';
import DateFilter, { useDateFilter } from '../components/DateFilter';
import DrilldownModal from '../components/DrilldownModal';
import CustomerDetailModal from '../components/CustomerDetailModal';
import { getStats, getReports, getCustomers } from '../api';

const SOURCE_LABEL = {
  cold_call: 'Cold Call', zalo_facebook: 'Zalo/FB',
  referral: 'Referral', email: 'Email', direct: 'Gặp trực tiếp', other: 'Khác',
};
const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

export default function LeadDashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const [drilldown, setDrilldown] = useState(null);
  const [filterUser, setFilterUser] = useState('');
  const [filterType, setFilterType] = useState('');
  const [detailPipelineId, setDetailPipelineId] = useState(null);
  const dateFilter = useDateFilter();
  const dateRange = dateFilter.getRange();

  const statsQ = useQuery({
    queryKey: ['stats', dateRange, filterUser],
    queryFn: () => getStats({ ...dateRange, userId: filterUser || undefined }),
  });

  const reportsQ = useQuery({
    queryKey: ['reports', dateRange, filterUser],
    queryFn: () => getReports({ ...dateRange, userId: filterUser || undefined, limit: 50 }),
    enabled: activeTab === 'reports' || activeTab === 'overview',
  });

  const customersQ = useQuery({
    queryKey: ['customers', dateRange, filterUser],
    queryFn: () => getCustomers({ ...dateRange, userId: filterUser || undefined }),
    enabled: activeTab === 'customers',
  });

  const stats = statsQ.data || {};
  const reports = reportsQ.data?.reports || [];
  const allCustomers = customersQ.data || [];
  const customers = filterType ? allCustomers.filter(c => c.interaction_type === filterType) : allCustomers;

  return (
    <div className="page">
      <Navbar />

      <main style={{ padding: '24px 0 60px' }}>
        <div className="container">
          {/* Page header */}
          <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 4 }}>
                📊 Dashboard Trưởng Phòng
              </h1>
              <p style={{ color: 'var(--text-2)', fontSize: 14 }}>
                Tổng quan hoạt động kinh doanh toàn phòng
              </p>
            </div>
          </div>

          {/* Date filter */}
          <DateFilter {...dateFilter} />

          {/* Sales filter */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>👤 Nhân viên:</span>
              <button
                className={`btn btn-sm ${!filterUser ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setFilterUser('')}
              >Tất cả</button>
              {(stats.per_sales || []).map(s => (
                <button
                  key={s.id}
                  className={`btn btn-sm ${filterUser == s.id ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setFilterUser(filterUser == s.id ? '' : s.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <div className="avatar avatar-sm" style={{ background: s.avatar_color }}>{s.code}</div>
                  {s.name.split(' ').pop()}
                </button>
              ))}
            </div>
          </div>

          {/* Stat cards */}
          <div className="grid-6" style={{ marginBottom: 32 }}>
            <StatCard
              label="Đã Booking" value={stats.booked}
              icon="✅" color="var(--primary)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('booked')}
            />
            <StatCard
              label="Báo giá follow" value={stats.follow_up}
              icon="🔄" color="var(--warning)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('follow_up')}
            />
            <StatCard
              label="Sắp Chốt" value={stats.closing_soon}
              icon="⚡" color="#ff6b35"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('closing_soon')}
            />
            <StatCard
              label="Lượt Tiếp Cận" value={stats.total_contacts}
              icon="👥" color="var(--info)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('contacts')}
            />
            <StatCard
              label="Tổng Báo Giá" value={stats.total_quotes}
              icon="📋" color="var(--purple)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('total_quotes')}
            />
            <StatCard
              label="KH Chờ Follow"
              icon="⏰" color="var(--danger)"
              loading={statsQ.isLoading}
              onClick={() => setDrilldown('waiting_follow_up')}
              rows={[
                { label: 'Hôm nay',  value: stats.follow_today,    color: '#d97706' },
                { label: 'Sắp tới',  value: stats.follow_upcoming, color: '#3b82f6' },
                { label: 'Quá hạn',  value: stats.overdue,         color: '#ef4444' },
              ]}
            />
          </div>

          {/* Per sales breakdown */}
          {!filterUser && (stats.per_sales || []).length > 0 && (
            <div className="card" style={{ marginBottom: 28 }}>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 15, marginBottom: 16 }}>
                📈 Hiệu suất theo nhân viên
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Nhân viên', 'Tiếp cận', 'Báo giá', 'Booked', 'Sắp chốt'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.per_sales.map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="avatar avatar-sm" style={{ background: s.avatar_color }}>{s.code}</div>
                            <span style={{ fontWeight: 500 }}>{s.name}</span>
                          </div>
                        </td>
                        <td style={{ padding: '10px 12px', color: 'var(--info)' }}>{s.contacts}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--purple)' }}>{s.quotes}</td>
                        <td style={{ padding: '10px 12px', color: 'var(--primary)' }}>{s.booked}</td>
                        <td style={{ padding: '10px 12px' }}>
                          {s.closing_soon > 0 && (
                            <span className="badge badge-warning">⚡ {s.closing_soon}</span>
                          )}
                          {s.closing_soon == 0 && <span style={{ color: 'var(--text-3)' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="tabs">
            {[
              { key: 'overview', label: '📋 Báo cáo gần đây' },
              { key: 'reports', label: '📁 Tất cả báo cáo' },
              { key: 'customers', label: '👥 Khách hàng' },
            ].map(t => (
              <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          {(activeTab === 'overview' || activeTab === 'reports') && (
            <div>
              {reportsQ.isLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : reports.length === 0 ? (
                <div className="empty-state"><div className="icon">📭</div><p>Không có báo cáo nào</p></div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {(activeTab === 'overview' ? reports.slice(0, 10) : reports).map(r => (
                    <ReportRow key={r.id} report={r} />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'customers' && (
            <div>
              {/* Filter tabs with count badges */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { key: '', label: 'Tất cả' },
                  { key: 'saved', label: 'Lưu liên hệ' },
                  { key: 'contacted', label: 'Đã liên hệ' },
                  { key: 'quoted', label: 'Đã báo giá' },
                ].map(({ key, label }) => {
                  const count = key === '' ? allCustomers.length : allCustomers.filter(c => c.interaction_type === key).length;
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
                {allCustomers.filter(c => c.has_closing_soon).length > 0 && (
                  <span className="badge badge-warning" style={{ alignSelf: 'center', marginLeft: 4 }}>
                    ⚡ Sắp chốt: {allCustomers.filter(c => c.has_closing_soon).length}
                  </span>
                )}
              </div>

              {customersQ.isLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : customers.length === 0 ? (
                <div className="empty-state"><div className="icon">👥</div><p>Không có khách hàng nào</p></div>
              ) : (
                <div>
                  {customers.map(c => <CustomerRow key={c.id} customer={c} onCompanyClick={setDetailPipelineId} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Drilldown modal */}
      {drilldown && (
        <DrilldownModal
          type={drilldown}
          dateParams={dateRange}
          userId={filterUser || undefined}
          onClose={() => setDrilldown(null)}
        />
      )}
      {detailPipelineId && (
        <CustomerDetailModal pipelineId={detailPipelineId} onClose={() => setDetailPipelineId(null)} />
      )}
    </div>
  );
}

function ReportRow({ report: r }) {
  return (
    <Link to={`/reports/${r.id}`} style={{ textDecoration: 'none' }}>
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}
           onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.transform = 'translateX(2px)'; }}
           onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.transform = ''; }}>
        <div className="avatar" style={{ background: r.avatar_color }}>{r.user_code}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{r.user_name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {format(new Date(r.report_date), 'EEEE, dd/MM/yyyy', { locale: undefined })} · {r.report_date}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 13, color: 'var(--text-2)' }}>
          <span>👥 {r.customer_count} KH</span>
          <span>📋 {r.quote_count} BG</span>
          {r.new_customers > 0 && <span className="badge badge-primary">+{r.new_customers} mới</span>}
          {r.issues && <span className="badge badge-warning">⚠️ Cần hỗ trợ</span>}
        </div>
        <span style={{ color: 'var(--text-3)', fontSize: 18 }}>→</span>
      </div>
    </Link>
  );
}

function CustomerRow({ customer: c, onCompanyClick }) {
  return (
    <div
      style={{
        background: '#f8f9fa', border: '1px solid var(--border)',
        borderRadius: 10, padding: '14px 16px', marginBottom: 2,
        cursor: c.pipeline_id ? 'pointer' : 'default', transition: 'all 0.15s',
      }}
      onClick={() => c.pipeline_id && onCompanyClick(c.pipeline_id)}
      onMouseEnter={e => { if (c.pipeline_id) { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = 'rgba(34,197,94,0.04)'; } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = '#f8f9fa'; }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{c.company_name}</span>
            <span className={`badge ${TYPE_CLASS[c.interaction_type]}`}>{TYPE_LABEL[c.interaction_type]}</span>
            {c.has_closing_soon && <span className="badge badge-warning">⚡ Sắp chốt</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
            {c.contact_person && <>👤 {c.contact_person}</>}
            {c.phone && <> · 📞 {c.phone}</>}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="avatar avatar-sm" style={{ background: c.avatar_color }}>{c.user_code}</div>
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{c.user_name}</span>
          </div>
          {c.report_date && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{format(new Date(c.report_date), 'dd/MM/yyyy')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
