import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  changePassword as apiChangePassword,
  getGmailSetup, updateGmailSetup, deleteGmailSetup,
} from '../api';
import Navbar from '../components/Navbar';

export default function ChangePassword() {
  const navigate = useNavigate();

  return (
    <>
      <Navbar />
      <div style={{
        minHeight: 'calc(100vh - 60px)',
        background: 'var(--bg)', padding: 24,
      }}>
        <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex',
          flexDirection: 'column', gap: 20 }}>
          <PasswordCard onBack={() => navigate(-1)} />
          <GmailSetupCard />
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Password change (existing card — preserved unchanged from prior layout)
// ─────────────────────────────────────────────────────────────────────────────

function PasswordCard({ onBack }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [show, setShow] = useState({ current: false, next: false, confirm: false });

  const mutation = useMutation({
    mutationFn: () => apiChangePassword(form.current, form.next),
    onSuccess: () => {
      toast.success('Đổi mật khẩu thành công!');
      setForm({ current: '', next: '', confirm: '' });
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
          className="form-input"
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
    <div className="card" style={{ padding: '28px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button type="button" onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-2)', fontSize: 20, padding: 0, lineHeight: 1 }}>←</button>
        <div>
          <h2 style={{ fontSize: 18, fontFamily: 'var(--font-display)', color: 'var(--text)' }}>
            Đổi mật khẩu
          </h2>
          <p style={{ fontSize: 12, color: 'var(--text-2)' }}>Mật khẩu mới phải có ít nhất 6 ký tự</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        {field('current', 'Mật khẩu hiện tại', 'Nhập mật khẩu hiện tại')}
        {field('next', 'Mật khẩu mới', 'Nhập mật khẩu mới')}
        {field('confirm', 'Xác nhận mật khẩu mới', 'Nhập lại mật khẩu mới')}
        <button type="submit" className="btn btn-primary"
          disabled={mutation.isPending}
          style={{ width: '100%', height: 42, fontWeight: 600 }}>
          {mutation.isPending ? 'Đang xử lý...' : 'Xác nhận đổi mật khẩu'}
        </button>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail SMTP setup (Phase 5 Step 3 Part 2 CP2)
// ─────────────────────────────────────────────────────────────────────────────

function GmailSetupCard() {
  const qc = useQueryClient();

  const { data: setup, isLoading } = useQuery({
    queryKey: ['gmail-setup'],
    queryFn: getGmailSetup,
  });

  const [addr, setAddr] = useState('');
  const [display, setDisplay] = useState('');
  const [pwd, setPwd] = useState('');           // empty by default — only sent when typed
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving] = useState(false);

  // Sync local state from server on first load (or after invalidation).
  useEffect(() => {
    if (setup) {
      setAddr(setup.gmail_address || '');
      setDisplay(setup.gmail_display_name || '');
      setPwd('');
    }
  }, [setup]);

  const hasPwd = !!setup?.has_app_password;
  const encOK = !!setup?.encryption_available;

  // Status indicator: green if all three set, orange if partial, red if all empty.
  let status = { label: '❌ Chưa setup', color: 'var(--danger)' };
  if (setup) {
    const a = !!(setup.gmail_address && setup.gmail_address.trim());
    const d = !!(setup.gmail_display_name && setup.gmail_display_name.trim());
    if (a && d && hasPwd) status = { label: '✅ Đã setup', color: 'var(--primary)' };
    else if (a || d || hasPwd) status = { label: '⚠️ Chưa đủ thông tin', color: 'var(--warning)' };
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        gmail_address: addr.trim(),
        gmail_display_name: display.trim(),
      };
      // App password semantics (mirrors backend):
      //   typed non-empty       → send to encrypt+overwrite
      //   empty AND has_app_password → omit (keep existing)
      //   empty AND no password yet → omit (nothing to clear)
      if (pwd !== '') {
        body.gmail_app_password = pwd;
      }
      await updateGmailSetup(body);
      toast.success('Đã lưu cài đặt Gmail');
      setPwd('');
      qc.invalidateQueries({ queryKey: ['gmail-setup'] });
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setSaving(false);
    }
  }

  async function clearPwdOnly() {
    if (!hasPwd) return;
    if (!window.confirm('Xóa app password? Bạn sẽ phải nhập lại để gửi mail.')) return;
    setSaving(true);
    try {
      await updateGmailSetup({ gmail_app_password: '' });
      toast.success('Đã xóa app password');
      qc.invalidateQueries({ queryKey: ['gmail-setup'] });
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi xóa');
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    if (!window.confirm('Xóa cài đặt Gmail? Bạn sẽ không gửi được mail kế hoạch.')) return;
    setSaving(true);
    try {
      await deleteGmailSetup();
      toast.success('Đã xóa cài đặt Gmail');
      setPwd('');
      qc.invalidateQueries({ queryKey: ['gmail-setup'] });
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi xóa');
    } finally {
      setSaving(false);
    }
  }

  const lblStyle = { display: 'block', fontSize: 13, fontWeight: 500,
    color: 'var(--text-2)', marginBottom: 6 };

  return (
    <div className="card" style={{ padding: '28px 32px' }}>
      <h2 style={{ fontSize: 18, fontFamily: 'var(--font-display)',
        color: 'var(--text)', marginBottom: 4 }}>
        Cài đặt Gmail
      </h2>
      <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 14 }}>
        Để gửi mail kế hoạch xe đến nhà xe trực tiếp từ địa chỉ Gmail của bạn.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        padding: '8px 12px', background: 'var(--bg)', borderRadius: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 600 }}>Trạng thái:</span>
        <span style={{ fontSize: 13, color: status.color, fontWeight: 600 }}>
          {isLoading ? 'Đang tải...' : status.label}
        </span>
      </div>

      {!isLoading && !encOK && (
        <div style={{ padding: 10, background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6,
          color: 'var(--danger)', fontSize: 12, marginBottom: 14 }}>
          ⚠️ Server chưa cấu hình mã hóa email (GMAIL_ENCRYPTION_KEY). App
          password sẽ bị từ chối cho đến khi admin cài đặt env var.
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <label style={lblStyle}>Gmail của tôi</label>
        <input className="form-input" type="email"
          placeholder="ten.cua.toi@slbglobal.com"
          value={addr} onChange={e => setAddr(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }} />
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
          Hỗ trợ: @gmail.com, @googlemail.com, @slbglobal.com (Google Workspace)
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={lblStyle}>Tên hiển thị</label>
        <input className="form-input" type="text"
          placeholder="VD: DD1 - SLB Logistics"
          value={display} onChange={e => setDisplay(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box' }} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={lblStyle}>
          App password {hasPwd && (
            <span style={{ fontSize: 11, color: 'var(--primary)', fontWeight: 600 }}>
              (đã có — để trống nếu không đổi)
            </span>
          )}
        </label>
        <div style={{ position: 'relative' }}>
          <input className="form-input"
            type={showPwd ? 'text' : 'password'}
            placeholder={hasPwd ? '(để trống nếu không đổi)' : '16 ký tự từ Google'}
            value={pwd} onChange={e => setPwd(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', paddingRight: 44 }} />
          <button type="button" onClick={() => setShowPwd(s => !s)}
            style={{ position: 'absolute', right: 12, top: '50%',
              transform: 'translateY(-50%)', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--text-3)', fontSize: 16,
              padding: 0, lineHeight: 1 }}>
            {showPwd ? '🙈' : '👁'}
          </button>
        </div>
        {hasPwd && (
          <button type="button" onClick={clearPwdOnly} disabled={saving}
            style={{ background: 'none', border: 'none', color: 'var(--danger)',
              fontSize: 11, padding: '4px 0 0', cursor: 'pointer' }}>
            Xóa app password
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button className="btn btn-primary" onClick={save}
          disabled={saving || isLoading}
          style={{ flex: 2, height: 42, fontWeight: 600 }}>
          {saving ? 'Đang lưu...' : '💾 Lưu'}
        </button>
        <button className="btn btn-ghost" onClick={clearAll}
          disabled={saving || isLoading}
          style={{ flex: 1, height: 42, color: 'var(--danger)' }}>
          🗑 Xóa cài đặt
        </button>
      </div>

      <details style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--info)' }}>
          ℹ️ Hướng dẫn lấy App password Gmail
        </summary>
        <ol style={{ paddingLeft: 18, marginTop: 8 }}>
          <li>Bật xác thực 2 bước (2FA) cho Google Account (cá nhân hoặc Workspace @slbglobal.com).</li>
          <li>Vào <strong>myaccount.google.com</strong> → Security → <strong>App passwords</strong>.</li>
          <li>Tạo password mới cho ứng dụng &quot;FWD Sales&quot; (chọn type là &quot;Mail&quot; nếu được hỏi).</li>
          <li>Copy chuỗi 16 ký tự Google sinh ra và dán vào ô <strong>App password</strong> phía trên.</li>
        </ol>
        <p style={{ marginTop: 8, color: 'var(--text-3)' }}>
          App password được mã hóa AES-256-GCM trước khi lưu vào database.
          Server và admin không bao giờ thấy được dạng plain text.
        </p>
      </details>
    </div>
  );
}
