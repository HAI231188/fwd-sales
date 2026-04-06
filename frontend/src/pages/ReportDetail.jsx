import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import CustomerCard from '../components/CustomerCard';
import { getReport, deleteReport } from '../api';
import { useAuth } from '../App';

const SOURCE_LABEL = {
  cold_call: '📞 Cold Call', zalo_facebook: '💬 Zalo/Facebook',
  referral: '🤝 Referral', email: '📧 Email',
  direct: '🤝 Gặp trực tiếp', other: '💡 Khác',
};

export default function ReportDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: report, isLoading, error } = useQuery({
    queryKey: ['report', id],
    queryFn: () => getReport(id),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReport(id),
    onSuccess: () => {
      toast.success('Đã xóa báo cáo');
      qc.invalidateQueries({ queryKey: ['reports'] });
      navigate(user?.role === 'lead' ? '/dashboard' : '/my-dashboard');
    },
    onError: () => toast.error('Xóa thất bại'),
  });

  const handleDelete = () => {
    if (window.confirm('Bạn có chắc muốn xóa báo cáo này không?')) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return (
      <div className="page">
        <Navbar />
        <div className="loading-screen"><div className="spinner" /><span style={{ color: 'var(--text-2)' }}>Đang tải...</span></div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="page">
        <Navbar />
        <div className="container" style={{ paddingTop: 60, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>😕</div>
          <h2 style={{ marginBottom: 12 }}>Không tìm thấy báo cáo</h2>
          <Link to={user?.role === 'lead' ? '/dashboard' : '/my-dashboard'} className="btn btn-ghost">
            ← Quay lại
          </Link>
        </div>
      </div>
    );
  }

  const customers = report.customers || [];
  const allQuotes = customers.flatMap(c => c.quotes || []);
  const isOwner = report.user_id === user?.id || user?.role === 'lead';

  const stats = {
    total: customers.length,
    saved: customers.filter(c => c.interaction_type === 'saved').length,
    contacted: customers.filter(c => c.interaction_type === 'contacted').length,
    quoted: customers.filter(c => c.interaction_type === 'quoted').length,
    booked: allQuotes.filter(q => q.status === 'booked').length,
    closingSoon: allQuotes.filter(q => q.closing_soon).length,
  };

  return (
    <div className="page">
      <Navbar />

      <main style={{ padding: '24px 0 60px' }}>
        <div className="container">
          {/* Breadcrumb */}
          <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-2)' }}>
            <Link to={user?.role === 'lead' ? '/dashboard' : '/my-dashboard'} style={{ color: 'var(--text-2)' }}>
              {user?.role === 'lead' ? 'Dashboard' : 'Báo cáo của tôi'}
            </Link>
            <span>›</span>
            <span style={{ color: 'var(--text)' }}>
              Báo cáo {report.report_date ? format(new Date(report.report_date), 'dd/MM/yyyy') : ''}
            </span>
          </div>

          {/* Header */}
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '24px 28px', marginBottom: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div className="avatar avatar-lg" style={{ background: report.avatar_color }}>
                  {report.user_code}
                </div>
                <div>
                  <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 4 }}>
                    Báo cáo {report.report_date ? format(new Date(report.report_date), 'dd/MM/yyyy') : ''}
                  </h1>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 14 }}>
                    <span>👤 {report.user_name}</span>
                    <span>·</span>
                    <span>⏱ {report.created_at ? format(new Date(report.created_at), 'HH:mm') : ''}</span>
                  </div>
                </div>
              </div>

              {isOwner && report.user_id === user?.id && (
                <button className="btn btn-danger btn-sm" onClick={handleDelete} disabled={deleteMutation.isPending}>
                  🗑 Xóa báo cáo
                </button>
              )}
            </div>

            {/* Summary stats */}
            <div style={{ display: 'flex', gap: 24, marginTop: 24, flexWrap: 'wrap' }}>
              {[
                { label: 'Tổng tiếp cận', value: report.total_contacts, color: 'var(--info)' },
                { label: 'KH mới', value: report.new_customers, color: 'var(--primary)' },
                { label: 'KH trong BC', value: stats.total, color: 'var(--text)' },
                { label: 'Báo giá', value: allQuotes.length, color: 'var(--purple)' },
                { label: 'Đã Booking', value: stats.booked, color: 'var(--primary)' },
                { label: 'Sắp chốt', value: stats.closingSoon, color: 'var(--warning)' },
              ].map(s => (
                <div key={s.label} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--font-display)', color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Interaction type summary pills */}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              {stats.saved > 0 && <span className="pill type-saved">📌 Lưu: {stats.saved}</span>}
              {stats.contacted > 0 && <span className="pill type-contacted">📞 Liên hệ: {stats.contacted}</span>}
              {stats.quoted > 0 && <span className="pill type-quoted">📋 Báo giá: {stats.quoted}</span>}
            </div>

            {/* Issues */}
            {report.issues && (
              <div style={{
                marginTop: 20, padding: '14px 18px',
                background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.2)',
                borderRadius: 10, borderLeft: '3px solid var(--warning)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warning)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  ⚠️ Vấn đề cần hỗ trợ từ trưởng phòng
                </div>
                <div style={{ fontSize: 14, color: 'var(--text)' }}>{report.issues}</div>
              </div>
            )}
          </div>

          {/* Customer list */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>
                👥 Khách hàng ({customers.length})
              </h2>
            </div>

            {customers.length === 0 ? (
              <div className="empty-state">
                <div className="icon">👥</div>
                <p>Báo cáo này chưa có khách hàng nào</p>
              </div>
            ) : (
              customers.map((c, i) => (
                <CustomerCard key={c.id || i} customer={c} readOnly />
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
