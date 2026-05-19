import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../App';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';

const LOG_ROLES = ['truong_phong_log', 'dieu_do', 'cus', 'cus1', 'cus2', 'cus3', 'ops'];

const ROLE_LABEL = {
  lead: { icon: '👑', text: 'Trưởng Phòng Sales', color: '#d97706' },
  sales: { icon: '💼', text: 'Sales', color: '#22c55e' },
  truong_phong_log: { icon: '🏢', text: 'Trưởng Phòng LOG', color: '#7c3aed' },
  dieu_do: { icon: '🚛', text: 'Điều Độ', color: '#3b82f6' },
  cus: { icon: '📋', text: 'Giám Sát CUS', color: '#0891b2' },
  cus1: { icon: '📋', text: 'Nhân Viên CUS', color: '#0891b2' },
  cus2: { icon: '📋', text: 'Nhân Viên CUS', color: '#0891b2' },
  cus3: { icon: '📋', text: 'Nhân Viên CUS', color: '#0891b2' },
  ops: { icon: '⚙️', text: 'Nhân Viên OPS', color: '#16a34a' },
  // KT3 — Accounting role pill. Teal #0891b2 matches the seed_ke_toan
  // default avatar color. '💼' (briefcase) signals back-office finance role.
  ke_toan: { icon: '💼', text: 'Kế Toán', color: '#0891b2' },
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [menuOpen, setMenuOpen] = useState(false);
  const mobileMenuRef = useRef(null);
  const hamburgerRef = useRef(null);

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate('/login');
  };

  // Close mobile menu on route change
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Close mobile menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (mobileMenuRef.current?.contains(e.target)) return;
      if (hamburgerRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const goLogoHome = () => {
    setMenuOpen(false);
    if (user?.role === 'lead') navigate('/dashboard');
    // KT3 — 'ke_toan' is its own role family (not LOG_ROLES). Check before
    // the LOG fallback so the logo link sends KT to /accounting-dashboard.
    else if (user?.role === 'ke_toan') navigate('/accounting-dashboard');
    else if (LOG_ROLES.includes(user?.role)) navigate('/log-dashboard');
    else navigate('/my-dashboard');
  };

  const showVansaiPill = user && (user.role === 'truong_phong_log' || user.role === 'dieu_do');
  const showCustomersPill = user && (user.role === 'truong_phong_log' || user.role === 'lead');
  const showAnyPill = showVansaiPill || showCustomersPill;
  const showGlobalSearch = user && LOG_ROLES.includes(user.role);
  const role = user && (ROLE_LABEL[user.role] || null);

  return (
    <nav style={{
      background: '#ffffff',
      borderBottom: '1px solid #e5e7eb',
      position: 'sticky', top: 0, zIndex: 50,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      <div className="container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 60, gap: 12 }}>
        {/* Logo — always visible */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexShrink: 0 }}
             onClick={goLogoHome}>
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

        {/* Desktop items — hidden on mobile via .navbar-desktop-items */}
        {user && (
          <div className="navbar-desktop-items" style={{ flex: 1, justifyContent: 'flex-end' }}>
            {/* Menu pills */}
            {showAnyPill && (
              <div style={{ display: 'flex', gap: 4 }}>
                {showVansaiPill && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate('/transport-companies')}
                    style={{ fontSize: 12, padding: '5px 10px', color: '#6b7280' }}
                    title="Quản lý vận tải"
                  >
                    🚚 Tên vận tải
                  </button>
                )}
                {showCustomersPill && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate('/customers')}
                    style={{ fontSize: 12, padding: '5px 10px', color: '#6b7280' }}
                    title="Data khách hàng"
                  >
                    👥 Data khách hàng
                  </button>
                )}
              </div>
            )}

            {/* Global search — LOG team only */}
            {showGlobalSearch && <GlobalSearch />}

            {/* User info + actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <NotificationBell />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="avatar" style={{ background: user.avatar_color }}>
                  {user.code}
                </div>
                <div style={{ lineHeight: 1.3, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{user.name}</span>
                  <span style={{ fontSize: 11, color: role?.color || '#22c55e', fontWeight: 500 }}>
                    {role ? `${role.icon} ${role.text}` : user.role}
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
          </div>
        )}

        {/* Mobile right — Bell + Hamburger (only visible on mobile via CSS) */}
        {user && (
          <div className="navbar-mobile-right">
            <NotificationBell />
            <button
              ref={hamburgerRef}
              className="navbar-hamburger"
              onClick={() => setMenuOpen(v => !v)}
              aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'}
              aria-expanded={menuOpen}
            >
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        )}
      </div>

      {/* Mobile dropdown menu — only on mobile, only when open */}
      {user && menuOpen && (
        <div ref={mobileMenuRef} className="navbar-mobile-menu">
          {/* User identity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            <div className="avatar" style={{ background: user.avatar_color }}>{user.code}</div>
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{user.name}</div>
              <div style={{ fontSize: 11, color: role?.color || 'var(--primary)', fontWeight: 500 }}>
                {role ? `${role.icon} ${role.text}` : user.role}
              </div>
            </div>
          </div>

          {/* GlobalSearch — LOG roles */}
          {showGlobalSearch && (
            <div style={{ width: '100%' }}>
              <GlobalSearch />
            </div>
          )}

          {/* Menu pills — stacked */}
          {showAnyPill && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {showVansaiPill && (
                <button
                  className="btn btn-ghost"
                  onClick={() => { setMenuOpen(false); navigate('/transport-companies'); }}
                  style={{ fontSize: 13, justifyContent: 'flex-start', width: '100%' }}
                >
                  🚚 Tên vận tải
                </button>
              )}
              {showCustomersPill && (
                <button
                  className="btn btn-ghost"
                  onClick={() => { setMenuOpen(false); navigate('/customers'); }}
                  style={{ fontSize: 13, justifyContent: 'flex-start', width: '100%' }}
                >
                  👥 Data khách hàng
                </button>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4, borderTop: '1px solid var(--border)' }}>
            <button
              className="btn btn-ghost"
              onClick={() => { setMenuOpen(false); navigate('/change-password'); }}
              style={{ fontSize: 13, justifyContent: 'flex-start', width: '100%' }}
            >
              🔑 Đổi mật khẩu
            </button>
            <button
              className="btn btn-ghost"
              onClick={handleLogout}
              style={{ fontSize: 13, justifyContent: 'flex-start', width: '100%', color: 'var(--danger)' }}
            >
              ↪ Đăng xuất
            </button>
          </div>
        </div>
      )}
    </nav>
  );
}
