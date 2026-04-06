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
      background: 'rgba(13,21,38,0.95)',
      borderBottom: '1px solid var(--border)',
      backdropFilter: 'blur(12px)',
      position: 'sticky', top: 0, zIndex: 50,
    }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60 }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
             onClick={() => navigate(user?.role === 'lead' ? '/dashboard' : '/my-dashboard')}>
          <div style={{
            width: 36, height: 36, background: 'linear-gradient(135deg, #00d4aa, #0099cc)',
            borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18,
          }}>🚢</div>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--text)', lineHeight: 1 }}>
              FWD Sales
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.2 }}>
              Quản lý Kinh doanh
            </div>
          </div>
        </div>

        {/* Role badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {user && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  className="avatar"
                  style={{ background: user.avatar_color }}
                >
                  {user.code}
                </div>
                <div style={{ lineHeight: 1.3, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{user.name}</span>
                  <span style={{ fontSize: 11, color: user.role === 'lead' ? '#ff6b35' : 'var(--primary)' }}>
                    {user.role === 'lead' ? '👑 Trưởng Phòng' : '💼 Sales'}
                  </span>
                </div>
              </div>

              <button className="btn btn-ghost btn-sm" onClick={handleLogout}>
                Đăng xuất
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
