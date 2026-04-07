import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { changePassword as apiChangePassword } from '../api';
import Navbar from '../components/Navbar';

export default function ChangePassword() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [show, setShow] = useState({ current: false, next: false, confirm: false });

  const mutation = useMutation({
    mutationFn: () => apiChangePassword(form.current, form.next),
    onSuccess: () => {
      toast.success('Đổi mật khẩu thành công!');
      navigate(-1);
    },
    onError: (err) => {
      toast.error(err?.error || 'Đổi mật khẩu thất bại');
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.current) { toast.error('Vui lòng nhập mật khẩu hiện tại'); return; }
    if (form.next.length < 6) { toast.error('Mật khẩu mới phải có ít nhất 6 ký tự'); return; }
    if (form.next !== form.confirm) { toast.error('Xác nhận mật khẩu không khớp'); return; }
    mutation.mutate();
  };

  const field = (key, label, placeholder) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={show[key] ? 'text' : 'password'}
          className="input"
          placeholder={placeholder}
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
          style={{ width: '100%', boxSizing: 'border-box', paddingRight: 44 }}
        />
        <button
          type="button"
          onClick={() => setShow(s => ({ ...s, [key]: !s[key] }))}
          style={{
            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-3)', fontSize: 16, padding: 0, lineHeight: 1,
          }}
        >
          {show[key] ? '🙈' : '👁'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <Navbar />
      <div style={{
        minHeight: 'calc(100vh - 60px)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg)', padding: 24,
      }}>
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 20, padding: '36px 40px', width: '100%', maxWidth: 420,
          boxShadow: 'var(--shadow)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
            <button
              type="button"
              onClick={() => navigate(-1)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-2)', fontSize: 20, padding: 0, lineHeight: 1,
              }}
            >←</button>
            <div>
              <h2 style={{ fontSize: 20, fontFamily: 'var(--font-display)', color: 'var(--text)', marginBottom: 2 }}>
                Đổi mật khẩu
              </h2>
              <p style={{ fontSize: 13, color: 'var(--text-2)' }}>Mật khẩu mới phải có ít nhất 6 ký tự</p>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            {field('current', 'Mật khẩu hiện tại', 'Nhập mật khẩu hiện tại')}
            {field('next', 'Mật khẩu mới', 'Nhập mật khẩu mới')}
            {field('confirm', 'Xác nhận mật khẩu mới', 'Nhập lại mật khẩu mới')}

            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => navigate(-1)}
                style={{ flex: 1, height: 44 }}
              >
                Hủy
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={mutation.isPending}
                style={{ flex: 2, height: 44, fontWeight: 600 }}
              >
                {mutation.isPending
                  ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2, margin: '0 auto' }} />
                  : 'Xác nhận đổi mật khẩu'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
