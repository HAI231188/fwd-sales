import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getUsers, login as apiLogin } from '../api';
import { useAuth } from '../App';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate(user.role === 'lead' ? '/dashboard' : '/my-dashboard');
  }, [user, navigate]);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: getUsers,
  });

  const mutation = useMutation({
    mutationFn: (userId) => apiLogin(userId),
    onSuccess: ({ user: u, token }) => {
      login(u, token);
      navigate(u.role === 'lead' ? '/dashboard' : '/my-dashboard');
    },
    onError: () => toast.error('Đăng nhập thất bại'),
  });

  const leads = users.filter(u => u.role === 'lead');
  const sales = users.filter(u => u.role === 'sales');

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
      backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,212,170,0.12), transparent)',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div style={{
          width: 72, height: 72,
          background: 'linear-gradient(135deg, #00d4aa, #0099cc)',
          borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36, margin: '0 auto 20px',
          boxShadow: '0 8px 32px rgba(0,212,170,0.3)',
        }}>🚢</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, color: 'var(--text)', marginBottom: 8 }}>
          FWD Sales
        </h1>
        <p style={{ color: 'var(--text-2)', fontSize: 15 }}>
          Hệ thống Quản lý Kinh doanh · Freight Forwarding
        </p>
      </div>

      {/* Login card */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 20, padding: 36, width: '100%', maxWidth: 520,
        boxShadow: 'var(--shadow)',
      }}>
        <h2 style={{ fontSize: 18, fontFamily: 'var(--font-display)', marginBottom: 8, color: 'var(--text)' }}>
          Chọn người dùng để đăng nhập
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 28 }}>
          Phiên bản demo — không cần mật khẩu
        </p>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
          </div>
        ) : (
          <>
            {/* Lead */}
            {leads.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: '#ff6b35',
                  textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  👑 Trưởng phòng
                </div>
                {leads.map(u => (
                  <UserButton key={u.id} user={u} loading={mutation.isPending && mutation.variables === u.id} onClick={() => mutation.mutate(u.id)} />
                ))}
              </div>
            )}

            {/* Sales */}
            {sales.length > 0 && (
              <div>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--primary)',
                  textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  💼 Nhân viên Kinh doanh
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {sales.map(u => (
                    <UserButton key={u.id} user={u} loading={mutation.isPending && mutation.variables === u.id} onClick={() => mutation.mutate(u.id)} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: 'var(--text-3)' }}>
        © 2026 FWD Sales Management System
      </p>
    </div>
  );
}

function UserButton({ user, onClick, loading }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '12px 16px', cursor: 'pointer',
        transition: 'all 0.2s', width: '100%', textAlign: 'left',
        marginBottom: 4,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = user.avatar_color;
        e.currentTarget.style.background = `${user.avatar_color}12`;
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--border)';
        e.currentTarget.style.background = 'var(--bg)';
        e.currentTarget.style.transform = '';
      }}
    >
      <div className="avatar" style={{ background: user.avatar_color }}>
        {loading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : user.code}
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{user.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
          {user.role === 'lead' ? 'Trưởng Phòng' : 'Nhân viên KD'}
        </div>
      </div>
      <div style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--text-3)' }}>→</div>
    </button>
  );
}
