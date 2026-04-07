import { useAuth } from '../App';
import { useNavigate } from 'react-router-dom';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav style={{
      background: '#ffffff',
      borderBottom: '1px solid #e5e7eb',
      position: 'sticky', top: 0, zIndex: 50,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
             onClick={() => navigate(user?.role === 'lead' ? '/dashboard' : '/my-dashboard')}>
          <div style={{
            width: 36, height: 36,
            background: 'linear-gradient(135deg, #22c55e, #16a34a)',
            borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>🌐</div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: '#1f2937', lineHeight: 1 }}>
              SLB Global Logistics
            </div>
            <div style={{ fontSize: 11, color: '#22c55e', lineHeight: 1.3, fontWeight: 600, letterSpacing: '0.03em' }}>
              Sales Management
            </div>
          </div>
        </div>

        {/* User info + actions */}
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="avatar" style={{ background: user.avatar_color }}>
                {user.code}
              </div>
              <div style={{ lineHeight: 1.3, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{user.name}</span>
                <span style={{ fontSize: 11, color: user.role === 'lead' ? '#d97706' : '#22c55e', fontWeight: 500 }}>
                  {user.role === 'lead' ? '👑 Trưởng Phòng' : '💼 Sales'}
                </span>
              </div>
            </div>

            <button
              className="btn btn-ghost btn-sm"
              onClick={() => navigate('/change-password')}
              title="Đổi mật khẩu"
              style={{ marginLeft: 4, color: '#6b7280' }}
            >
              🔑
            </button>

            <button
              className="btn btn-ghost btn-sm"
              onClick={handleLogout}
              style={{ color: '#6b7280' }}
            >
              Đăng xuất
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
