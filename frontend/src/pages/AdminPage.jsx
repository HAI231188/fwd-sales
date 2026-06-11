import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Navbar from '../components/Navbar';
import {
  getAdminUsers, createAdminUser, updateAdminUser, changeUserRole,
  disableUser, enableUser, resetUserPassword,
  getJobSettings, updateAssignmentMode,
} from '../api';
import { useAuth } from '../App';

// "Quản trị" — admin-only user management (role 'admin'). Backend enforces the
// gate (/api/admin/*); the route is also ProtectedRoute roles={['admin']}.
// Per the frontend convention, the display role map lives locally in this file.

const ROLE_OPTIONS = [
  { value: 'admin',            label: '🛡️ Quản trị viên' },
  { value: 'lead',             label: '👑 Trưởng Phòng Sales' },
  { value: 'sales',            label: '💼 Sales' },
  { value: 'truong_phong_log', label: '🏢 Trưởng Phòng LOG' },
  { value: 'dieu_do',          label: '🚛 Điều Độ' },
  { value: 'cus',              label: '📋 Giám Sát CUS' },
  { value: 'cus1',             label: '📋 CUS 1' },
  { value: 'cus2',             label: '📋 CUS 2' },
  { value: 'cus3',             label: '📋 CUS 3' },
  { value: 'ops',              label: '⚙️ OPS' },
  { value: 'ke_toan',          label: '💼 Kế Toán' },
];
const ROLE_LABEL = Object.fromEntries(ROLE_OPTIONS.map(o => [o.value, o.label]));

const th = { padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em' };
const td = { padding: '10px 12px', color: 'var(--text)', verticalAlign: 'middle' };

export default function AdminPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [tempInfo, setTempInfo] = useState(null); // { username, temp_password }

  const { data: users = [], isLoading, error } = useQuery({
    queryKey: ['adminUsers'],
    queryFn: getAdminUsers,
  });
  const { data: settings } = useQuery({ queryKey: ['jobSettings'], queryFn: getJobSettings });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['adminUsers'] });

  const roleMut = useMutation({
    mutationFn: ({ id, role }) => changeUserRole(id, role),
    onSuccess: () => { invalidate(); toast.success('Đã đổi vai trò'); },
    onError: (e) => toast.error(e?.error || 'Lỗi đổi vai trò'),
  });
  const disableMut = useMutation({
    mutationFn: (id) => disableUser(id),
    onSuccess: () => { invalidate(); toast.success('Đã khóa tài khoản'); },
    onError: (e) => toast.error(e?.error || 'Lỗi khóa tài khoản'),
  });
  const enableMut = useMutation({
    mutationFn: (id) => enableUser(id),
    onSuccess: () => { invalidate(); toast.success('Đã mở khóa tài khoản'); },
    onError: (e) => toast.error(e?.error || 'Lỗi mở khóa'),
  });
  const resetMut = useMutation({
    mutationFn: (id) => resetUserPassword(id),
    onSuccess: (res) => { invalidate(); setTempInfo({ username: res.user.username, temp_password: res.temp_password }); },
    onError: (e) => toast.error(e?.error || 'Lỗi reset mật khẩu'),
  });
  const modeMut = useMutation({
    mutationFn: (m) => updateAssignmentMode(m),
    onSuccess: (_d, m) => { qc.invalidateQueries({ queryKey: ['jobSettings'] }); toast.success(m === 'auto' ? 'Đã bật phân job tự động' : 'Đã chuyển phân job thủ công'); },
    onError: (e) => toast.error(e?.error || 'Lỗi cập nhật chế độ'),
  });

  function handleRoleChange(u, newRole) {
    if (newRole === u.role) return;
    if (!window.confirm(`Đổi vai trò của ${u.name} thành "${ROLE_LABEL[newRole] || newRole}"?`)) return;
    roleMut.mutate({ id: u.id, role: newRole });
  }
  function handleToggleDisable(u) {
    if (u.disabled) { enableMut.mutate(u.id); return; }
    if (!window.confirm(`Khóa tài khoản ${u.name}? Họ sẽ không đăng nhập được cho tới khi mở lại.`)) return;
    disableMut.mutate(u.id);
  }
  function handleReset(u) {
    if (!window.confirm(`Reset mật khẩu cho ${u.name}? Mật khẩu cũ sẽ không dùng được nữa.`)) return;
    resetMut.mutate(u.id);
  }

  const mode = settings?.assignment_mode || 'auto';

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>🛡️ Quản trị người dùng</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>+ Thêm người dùng</button>
        </div>

        {/* Auto-assign toggle — reuses GET/PATCH /api/jobs/settings (no rebuild). */}
        <div className="card" style={{ padding: 14, marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Phân job tự động (LOG)</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {mode === 'auto'
                ? 'Đang BẬT — job mới tự gán cho nhân viên ít việc nhất.'
                : 'Đang TẮT — Trưởng phòng LOG gán job thủ công.'}
            </div>
          </div>
          <button
            className="btn btn-sm"
            disabled={modeMut.isPending}
            onClick={() => modeMut.mutate(mode === 'auto' ? 'manual' : 'auto')}
            style={mode === 'auto'
              ? { background: 'var(--danger-dim)', color: 'var(--danger)' }
              : { background: 'var(--primary)', color: '#fff' }}
          >
            {mode === 'auto' ? '🔌 Chuyển sang thủ công' : '⚡ Bật tự động'}
          </button>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {isLoading && <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>}
          {error && <div style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>Lỗi tải: {error?.error || error?.message || 'Unknown'}</div>}
          {!isLoading && !error && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
                    <th style={th}>Tên</th>
                    <th style={th}>Mã</th>
                    <th style={th}>Username</th>
                    <th style={th}>Vai trò</th>
                    <th style={{ ...th, textAlign: 'center' }}>Trạng thái</th>
                    <th style={{ ...th, textAlign: 'right' }}>Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)' }}>Chưa có người dùng</td></tr>
                  )}
                  {users.map(u => {
                    const isSelf = u.id === user?.id;
                    return (
                      <tr key={u.id} style={{ borderBottom: '1px solid var(--border)', opacity: u.disabled ? 0.6 : 1 }}>
                        <td style={{ ...td, fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div className="avatar avatar-sm" style={{ background: u.avatar_color || '#6b7280' }}>{u.code}</div>
                            <span>{u.name}{isSelf && <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 4 }}>(bạn)</span>}</span>
                          </div>
                        </td>
                        <td style={td}>{u.code}</td>
                        <td style={td}>{u.username || <span style={{ color: 'var(--text-3)' }}>—</span>}</td>
                        <td style={td}>
                          <select
                            className="form-select"
                            value={u.role}
                            disabled={isSelf || roleMut.isPending}
                            title={isSelf ? 'Không thể đổi vai trò của chính mình' : 'Đổi vai trò'}
                            onChange={(e) => handleRoleChange(u, e.target.value)}
                            style={{ fontSize: 12, padding: '4px 6px', width: 'auto', minWidth: 160 }}
                          >
                            {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          {u.disabled
                            ? <span style={{ background: 'var(--danger-dim)', color: 'var(--danger)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Đã khóa</span>
                            : <span style={{ background: 'var(--primary-dim)', color: 'var(--primary)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Đang dùng</span>}
                        </td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginRight: 4 }} onClick={() => setEditing(u)}>✏️ Sửa</button>
                          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, marginRight: 4 }} disabled={resetMut.isPending} onClick={() => handleReset(u)}>🔑 Reset MK</button>
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11, color: isSelf ? 'var(--text-3)' : (u.disabled ? 'var(--primary)' : 'var(--danger)'), cursor: isSelf ? 'not-allowed' : 'pointer', opacity: isSelf ? 0.5 : 1 }}
                            disabled={isSelf || disableMut.isPending || enableMut.isPending}
                            title={isSelf ? 'Không thể tự khóa tài khoản của mình' : (u.disabled ? 'Mở khóa' : 'Khóa')}
                            onClick={() => { if (!isSelf) handleToggleDisable(u); }}
                          >
                            {u.disabled ? '🔓 Mở' : '🔒 Khóa'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {creating && <UserFormModal onClose={() => setCreating(false)} onTemp={(info) => { setCreating(false); setTempInfo(info); invalidate(); }} />}
      {editing && <UserFormModal user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
      {tempInfo && <TempPasswordModal info={tempInfo} onClose={() => setTempInfo(null)} />}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="form-label" style={{ fontSize: 12 }}>{label}</label>
      {children}
    </div>
  );
}

function UserFormModal({ user, onClose, onTemp, onSaved }) {
  const isEdit = !!user;
  const [name, setName]     = useState(user?.name || '');
  const [code, setCode]     = useState(user?.code || '');
  const [username, setUser] = useState(user?.username || '');
  const [role, setRole]     = useState(user?.role || 'sales');
  const [avatar, setAvatar] = useState(user?.avatar_color || '#00d4aa');
  const [busy, setBusy]     = useState(false);

  async function submit() {
    if (!name.trim() || !code.trim() || !username.trim() || (!isEdit && !role)) {
      toast.error('Vui lòng nhập đủ tên, mã, username' + (isEdit ? '' : ', vai trò'));
      return;
    }
    setBusy(true);
    try {
      if (isEdit) {
        await updateAdminUser(user.id, { name: name.trim(), code: code.trim(), username: username.trim(), avatar_color: avatar });
        toast.success('Đã lưu thay đổi');
        onSaved?.();
      } else {
        const res = await createAdminUser({ name: name.trim(), code: code.trim(), username: username.trim(), role, avatar_color: avatar });
        onTemp?.({ username: res.user.username, temp_password: res.temp_password });
      }
    } catch (e) {
      toast.error(e?.error || e?.message || 'Lỗi khi lưu');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 460, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>{isEdit ? 'Sửa người dùng' : 'Thêm người dùng'}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Tên"><input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Nguyễn Văn A" /></Field>
          <Field label="Mã (hiện trên avatar, tối đa 10 ký tự)"><input className="form-input" value={code} onChange={e => setCode(e.target.value)} maxLength={10} placeholder="NVA" /></Field>
          <Field label="Username (dùng để đăng nhập)"><input className="form-input" value={username} onChange={e => setUser(e.target.value)} placeholder="nguyenvana" /></Field>
          {!isEdit && (
            <Field label="Vai trò">
              <select className="form-select" value={role} onChange={e => setRole(e.target.value)}>
                {ROLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          )}
          {isEdit && (
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Đổi vai trò ở cột "Vai trò" trong bảng; đặt lại mật khẩu bằng nút "Reset MK".</div>
          )}
          <Field label="Màu avatar">
            <input type="color" value={avatar} onChange={e => setAvatar(e.target.value)} style={{ width: 48, height: 34, padding: 0, border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }} />
          </Field>
          {!isEdit && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Mật khẩu tạm sẽ được tạo tự động và hiển thị 1 lần sau khi tạo.</div>}
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Hủy</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>{busy ? 'Đang lưu...' : (isEdit ? 'Lưu' : 'Tạo')}</button>
        </div>
      </div>
    </div>
  );
}

function TempPasswordModal({ info, onClose }) {
  const copy = () => {
    navigator.clipboard?.writeText(info.temp_password);
    toast.success('Đã copy mật khẩu');
  };
  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 440, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>🔑 Mật khẩu tạm</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ padding: 16, fontSize: 13 }}>
          <p>Mật khẩu tạm cho <strong>{info.username}</strong> — chỉ hiển thị <strong>một lần</strong>, hãy copy ngay:</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <code style={{ flex: 1, background: 'var(--bg)', padding: '10px 12px', borderRadius: 8, fontSize: 15, fontWeight: 600, letterSpacing: '0.05em', userSelect: 'all', wordBreak: 'break-all' }}>{info.temp_password}</code>
            <button className="btn btn-primary btn-sm" onClick={copy}>📋 Copy</button>
          </div>
          <p style={{ color: 'var(--text-2)', marginTop: 10, fontSize: 12 }}>
            Đưa mật khẩu này cho nhân viên. Họ nên đổi mật khẩu ngay sau khi đăng nhập lần đầu (mục "Đổi mật khẩu").
          </p>
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: 12, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </div>
  );
}
