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
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f8f9fa',
      padding: 24,
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{
          width: 72, height: 72,
          background: 'linear-gradient(135deg, #22c55e, #16a34a)',
          borderRadius: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, margin: '0 auto 20px',
          boxShadow: '0 8px 24px rgba(34,197,94,0.25)',
        }}>🌐</div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 28,
          color: '#111827', marginBottom: 4, fontWeight: 700,
        }}>
          SLB Global Logistics
        </h1>
        <p style={{
          color: '#22c55e', fontSize: 12, fontWeight: 600,
          letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 4,
        }}>
          Sales Management System
        </p>
        <p style={{ color: '#6b7280', fontSize: 13 }}>
          Hệ thống Quản lý Kinh doanh Nội bộ
        </p>
      </div>

      {/* Login card */}
      <div style={{
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 20,
        padding: '36px 40px',
        width: '100%', maxWidth: 420,
        boxShadow: '0 4px 24px rgba(0,0,0,0.07)',
      }}>
        <h2 style={{
          fontSize: 20, fontFamily: 'var(--font-display)',
          marginBottom: 6, color: '#111827', fontWeight: 600,
        }}>
          Đăng nhập
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 28 }}>
          Nhập thông tin tài khoản để tiếp tục
        </p>

        <form onSubmit={handleSubmit}>
          {/* Username */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block', fontSize: 13, fontWeight: 500,
              color: '#374151', marginBottom: 6,
            }}>
              Tên đăng nhập
            </label>
            <input
              type="text"
              placeholder="Nhập tên đăng nhập"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '10px 14px',
                border: '1px solid #d1d5db',
                borderRadius: 8,
                fontSize: 14, color: '#111827',
                background: '#fff',
                outline: 'none',
                transition: 'border-color 0.2s, box-shadow 0.2s',
                fontFamily: 'var(--font)',
              }}
              onFocus={e => {
                e.target.style.borderColor = '#22c55e';
                e.target.style.boxShadow = '0 0 0 3px rgba(34,197,94,0.12)';
              }}
              onBlur={e => {
                e.target.style.borderColor = '#d1d5db';
                e.target.style.boxShadow = 'none';
              }}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: 28 }}>
            <label style={{
              display: 'block', fontSize: 13, fontWeight: 500,
              color: '#374151', marginBottom: 6,
            }}>
              Mật khẩu
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Nhập mật khẩu"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 44px 10px 14px',
                  border: '1px solid #d1d5db',
                  borderRadius: 8,
                  fontSize: 14, color: '#111827',
                  background: '#fff',
                  outline: 'none',
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                  fontFamily: 'var(--font)',
                }}
                onFocus={e => {
                  e.target.style.borderColor = '#22c55e';
                  e.target.style.boxShadow = '0 0 0 3px rgba(34,197,94,0.12)';
                }}
                onBlur={e => {
                  e.target.style.borderColor = '#d1d5db';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                style={{
                  position: 'absolute', right: 12, top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#9ca3af', fontSize: 16, padding: 0, lineHeight: 1,
                }}
              >
                {showPassword ? '🙈' : '👁'}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={mutation.isPending}
            style={{
              width: '100%', height: 44, fontSize: 15, fontWeight: 600,
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              color: '#fff', border: 'none', borderRadius: 8,
              cursor: mutation.isPending ? 'not-allowed' : 'pointer',
              opacity: mutation.isPending ? 0.7 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font)',
              boxShadow: '0 2px 12px rgba(34,197,94,0.3)',
              transition: 'opacity 0.2s, transform 0.2s',
            }}
          >
            {mutation.isPending
              ? <span style={{
                  width: 18, height: 18, borderRadius: '50%',
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: '#fff',
                  display: 'inline-block',
                  animation: 'spin 0.7s linear infinite',
                }} />
              : 'Đăng nhập'}
          </button>
        </form>
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: '#9ca3af' }}>
        © 2026 SLB Global Logistics · Hệ thống nội bộ
      </p>
    </div>
  );
}
