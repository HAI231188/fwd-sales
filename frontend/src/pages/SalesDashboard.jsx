import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import Navbar from '../components/Navbar';
import StatCard from '../components/StatCard';
import DateFilter, { useDateFilter } from '../components/DateFilter';
import DrilldownModal from '../components/DrilldownModal';
import PipelineView from '../components/PipelineView';
import { getStats, getReports } from '../api';
import { useAuth } from '../App';

const TYPE_LABEL = { saved: 'Lưu liên hệ', contacted: 'Đã liên hệ', quoted: 'Đã báo giá' };
const TYPE_CLASS = { saved: 'type-saved', contacted: 'type-contacted', quoted: 'type-quoted' };

export default function SalesDashboard() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');
  const [drilldown, setDrilldown] = useState(null);
  const dateFilter = useDateFilter();
  const dateRange = dateFilter.getRange();

  const statsQ = useQuery({
    queryKey: ['stats', 'my', dateRange],
    queryFn: () => getStats(dateRange),
  });

  const reportsQ = useQuery({
    queryKey: ['reports', 'my', dateRange],
    queryFn: () => getReports({ ...dateRange, limit: 50 }),
    enabled: activeTab === 'overview',
  });

  const stats = statsQ.data || {};
  const reports = reportsQ.data?.reports || [];

  return (
    <div className="page">
      <Navbar />

      <main style={{ padding: '24px 0 60px' }}>
        <div className="container">
          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 4 }}>
              Xin chào, {user?.name.split(' ').pop()} 👋
            </h1>
            <p style={{ color: 'var(--text-2)', fontSize: 14 }}>
              Báo cáo kinh doanh cá nhân · {format(new Date(), 'EEEE, dd/MM/yyyy')}
            </p>
          </div>

          {/* Date filter */}
          <DateFilter {...dateFilter} />

          {/* Stats */}
          <div className="grid-6" style={{ marginBottom: 32 }}>
            <StatCard label="Đã Booking" value={stats.booked} icon="✅" color="var(--primary)" loading={statsQ.isLoading} onClick={() => setDrilldown('booked')} />
            <StatCard label="Báo giá follow" value={stats.follow_up} icon="🔄" color="var(--warning)" loading={statsQ.isLoading} onClick={() => setDrilldown('follow_up')} />
            <StatCard label="Sắp Chốt" value={stats.closing_soon} icon="⚡" color="#ff6b35" loading={statsQ.isLoading} onClick={() => setDrilldown('closing_soon')} />
            <StatCard label="Tiếp Cận" value={stats.total_contacts} icon="👥" color="var(--info)" loading={statsQ.isLoading} onClick={() => setDrilldown('contacts')} />
            <StatCard label="Báo Giá" value={stats.total_quotes} icon="📋" color="var(--purple)" loading={statsQ.isLoading} onClick={() => setDrilldown('total_quotes')} />
            <StatCard label="Chờ Follow" value={stats.waiting_follow_up} icon="⏰" color="var(--danger)" loading={statsQ.isLoading} onClick={() => setDrilldown('waiting_follow_up')} />
          </div>

          {/* Tabs */}
          <div className="tabs">
            {[
              { key: 'overview',  label: '📋 Báo cáo của tôi' },
              { key: 'pipeline',  label: '📊 Danh sách hoạt động' },
            ].map(t => (
              <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* My Reports */}
          {activeTab === 'overview' && (
            <div>
              {reportsQ.isLoading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
              ) : reports.length === 0 ? (
                <div className="empty-state">
                  <div className="icon">📭</div>
                  <p style={{ marginBottom: 16 }}>Chưa có báo cáo nào. Thêm khách hàng để bắt đầu!</p>
                  <button className="btn btn-primary" onClick={() => setActiveTab('pipeline')}>
                    📊 Mở Danh sách hoạt động
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {reports.map(r => (
                    <Link key={r.id} to={`/reports/${r.id}`} style={{ textDecoration: 'none' }}>
                      <div
                        className="card"
                        style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', transition: 'all 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.transform = 'translateX(2px)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.transform = ''; }}
                      >
                        <div style={{
                          width: 48, height: 48, borderRadius: 12,
                          background: 'var(--primary-dim)', border: '1px solid var(--border)',
                          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--primary)', lineHeight: 1 }}>
                            {new Date(r.report_date).getDate()}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-2)' }}>
                            Th{new Date(r.report_date).getMonth() + 1}
                          </div>
                        </div>

                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                            Báo cáo {format(new Date(r.report_date), 'dd/MM/yyyy')}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                            <span>👥 {r.total_contacts} lượt tiếp cận</span>
                            <span>🆕 {r.new_customers} KH mới</span>
                            <span>📋 {r.customer_count} KH · {r.quote_count} báo giá</span>
                          </div>
                          {r.issues && (
                            <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 4 }}>
                              ⚠️ {r.issues.substring(0, 100)}{r.issues.length > 100 ? '...' : ''}
                            </div>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                          {r.issues && <span className="badge badge-warning">Cần hỗ trợ</span>}
                          <span style={{ color: 'var(--text-3)', fontSize: 18 }}>→</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pipeline */}
          {activeTab === 'pipeline' && <PipelineView />}


        </div>
      </main>

      {drilldown && (
        <DrilldownModal
          type={drilldown}
          dateParams={dateRange}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}
