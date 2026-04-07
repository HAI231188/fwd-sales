import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { login as apiLogin } from '../api';
import { useAuth } from '../App';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (user) navigate(user.role === 'lead' ? '/dashboard' : '/my-dashboard');
  }, [user, navigate]);

  const mutation = useMutation({
    mutationFn: () => apiLogin(username.trim(), password),
    onSuccess: ({ user: u, token }) => {
      login(u, token);
      navigate(u.role === 'lead' ? '/dashboard' : '/my-dashboard');
    },
    onError: (err) => {
      toast.error(err?.error || 'Đăng nhập thất bại');
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!username.trim()) { toast.error('Vui lòng nhập tên đăng nhập'); return; }
    if (!password) { toast.error('Vui lòng nhập mật khẩu'); return; }
    mutation.mutate();
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
      backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(34,197,94,0.1), transparent)',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <div style={{
          width: 72, height: 72,
          background: 'linear-gradient(135deg, #22c55e, #16a34a)',
          borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, margin: '0 auto 20px',
          boxShadow: '0 8px 32px rgba(34,197,94,0.35)',
        }}>🌐</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, color: 'var(--text)', marginBottom: 4 }}>
          SLB Global Logistics
        </h1>
        <p style={{ color: 'var(--primary)', fontSize: 13, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
          Sales Management System
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
          Hệ thống Quản lý Kinh doanh Nội bộ
        </p>
      </div>

      {/* Login card */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 20, padding: '36px 40px', width: '100%', maxWidth: 420,
        boxShadow: 'var(--shadow)',
      }}>
        <h2 style={{ fontSize: 20, fontFamily: 'var(--font-display)', marginBottom: 6, color: 'var(--text)' }}>
          Đăng nhập
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 28 }}>
          Nhập thông tin tài khoản để tiếp tục
        </p>

        <form onSubmit={handleSubmit}>
          {/* Username */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
              Tên đăng nhập
            </label>
            <input
              type="text"
              className="input"
              placeholder="Nhập tên đăng nhập"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
              Mật khẩu
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                className="input"
                placeholder="Nhập mật khẩu"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                style={{ width: '100%', boxSizing: 'border-box', paddingRight: 44 }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                style={{
                  position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-3)', fontSize: 16, padding: 0, lineHeight: 1,
                }}
              >
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={mutation.isPending}
            style={{ width: '100%', height: 44, fontSize: 15, fontWeight: 600 }}
          >
            {mutation.isPending
              ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, margin: '0 auto' }} />
              : 'Đăng nhập'}
          </button>
        </form>
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: 'var(--text-3)' }}>
        © 2026 SLB Global Logistics · Hệ thống nội bộ
      </p>
    </div>
  );
}
