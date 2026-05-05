import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getLogStaff, reassignCus, reassignOps } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

// type: 'cus' | 'ops'
// job: { id, job_code, cus_id, ops_id, cus_name, ops_name }
export default function ReassignModal({ type, job, onClose }) {
  const qc = useQueryClient();
  const zIndex = useModalZIndex();
  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);

  const { data: staff = [], isLoading: staffLoading } = useQuery({
    queryKey: ['logStaff'],
    queryFn: getLogStaff,
  });

  const isCus = type === 'cus';
  const roleLabel = isCus ? 'CUS' : 'OPS';
  const currentId = isCus ? job?.cus_id : job?.ops_id;
  const currentName = (isCus ? job?.cus_name : job?.ops_name) || '(chưa có)';
  const candidates = staff
    .filter(s => isCus ? ['cus', 'cus1', 'cus2', 'cus3'].includes(s.role) : s.role === 'ops')
    .filter(s => s.id !== currentId);

  const selectedUser = candidates.find(s => String(s.id) === String(selected));

  const mut = useMutation({
    mutationFn: ({ jobId, newId }) =>
      isCus ? reassignCus(jobId, newId) : reassignOps(jobId, newId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
      qc.invalidateQueries({ queryKey: ['filteredJobs'] });
      qc.invalidateQueries({ queryKey: ['staffWorkload'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(`Đã đổi ${roleLabel} thành công`);
      onClose();
    },
    onError: (err) => {
      const msg = err?.response?.data?.error || err?.error || err?.message || 'Không thể đổi. Thử lại sau.';
      toast.error(msg);
      setConfirming(false);
    },
  });

  function handleSubmit() {
    if (!selected) return;
    if (!confirming) { setConfirming(true); return; }
    mut.mutate({ jobId: job.id, newId: Number(selected) });
  }

  const jobLabel = job?.job_code || `#${job?.id}`;

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480, width: '95%' }}>
        <div className="modal-header">
          <h3 style={{ margin: 0, fontSize: 16 }}>Đổi {roleLabel} cho job {jobLabel}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ padding: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
            Hiện tại: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{currentName}</span>
          </div>

          <div className="form-group">
            <label className="form-label">Chọn {roleLabel} mới</label>
            <select
              className="form-select"
              value={selected}
              disabled={staffLoading || mut.isPending}
              onChange={e => { setSelected(e.target.value); setConfirming(false); }}
            >
              <option value="">— Chọn nhân viên —</option>
              {candidates.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
              ))}
            </select>
            {!staffLoading && candidates.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
                Không có nhân viên khác để đổi.
              </div>
            )}
          </div>

          {confirming && selectedUser && (
            <div style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8, padding: '10px 12px', marginTop: 12,
              fontSize: 13, color: 'var(--text)',
            }}>
              Bạn chắc chắn đổi {roleLabel} từ <b>{currentName}</b> sang <b>{selectedUser.name}</b>?
            </div>
          )}
        </div>

        <div className="modal-footer" style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: 12, borderTop: '1px solid var(--border)',
        }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            disabled={mut.isPending}
          >
            Hủy
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={handleSubmit}
            disabled={!selected || mut.isPending}
          >
            {mut.isPending ? 'Đang đổi...' : confirming ? 'Xác nhận đổi' : 'Xác nhận'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
