import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getLogStaff, reassignCus, assignOpsTask } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

// type: 'cus' (job-level CUS reassign) | 'ops' (P3: PER-TASK OPS reassign).
// For 'ops', pass taskType ('thong_quan'|'doi_lenh'|'ops_hp') + taskLabel; the
// current owner is read from job.ops_tasks[taskType] and only THAT task is moved.
// job: { id, job_code, cus_id, cus_name, ops_name, ops_tasks }
export default function ReassignModal({ type, taskType, taskLabel, job, onClose }) {
  const qc = useQueryClient();
  const zIndex = useModalZIndex();
  const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);

  const { data: staff = [], isLoading: staffLoading } = useQuery({
    queryKey: ['logStaff'],
    queryFn: getLogStaff,
  });

  const isCus = type === 'cus';
  // P3: per-task OPS — current owner comes from the specific task row.
  const task = (!isCus && taskType && Array.isArray(job?.ops_tasks))
    ? job.ops_tasks.find(t => t.task_type === taskType) : null;
  const roleLabel = isCus ? 'CUS' : (taskLabel ? `OPS — ${taskLabel}` : 'OPS');
  const currentId = isCus ? job?.cus_id : (task ? task.ops_id : job?.ops_id);
  const currentName = (isCus ? job?.cus_name : (task ? task.ops_name : job?.ops_name)) || '(chưa có)';
  const candidates = staff
    .filter(s => isCus ? ['cus', 'cus1', 'cus2', 'cus3'].includes(s.role) : s.role === 'ops')
    .filter(s => s.id !== currentId);

  const selectedUser = candidates.find(s => String(s.id) === String(selected));
  // OPS thong_quan/doi_lenh only: "— Không cần —" DROPS the task (job completes
  // without it). NOT offered for CUS (this is an OPS-only feature).
  const canDrop = type === 'ops' && (taskType === 'thong_quan' || taskType === 'doi_lenh');
  const isDrop = selected === '__drop__';

  const mut = useMutation({
    mutationFn: ({ jobId, newId }) =>
      isCus ? reassignCus(jobId, newId) : assignOpsTask(jobId, taskType, newId),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
      qc.invalidateQueries({ queryKey: ['filteredJobs'] });
      qc.invalidateQueries({ queryKey: ['staffWorkload'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast.success(variables?.newId == null ? `Đã bỏ việc ${taskLabel || roleLabel}` : `Đã đổi ${roleLabel} thành công`);
      onClose();
    },
    onError: (err) => {
      const msg = err?.response?.data?.error || err?.error || err?.message || 'Không thể đổi. Thử lại sau.';
      toast.error(msg);
      setConfirming(false);
    },
  });

  function handleSubmit() {
    if (!selected) return;   // placeholder no-op; '__drop__' (Không cần) is allowed
    if (!confirming) { setConfirming(true); return; }
    mut.mutate({ jobId: job.id, newId: isDrop ? null : Number(selected) });
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
              {/* OPS-only (thong_quan/doi_lenh): drop this task so the job
                  completes without it. Re-assign a person later to bring it back. */}
              {canDrop && <option value="__drop__">— Không cần (bỏ việc này) —</option>}
            </select>
            {!staffLoading && candidates.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>
                Không có nhân viên khác để đổi.
              </div>
            )}
          </div>

          {confirming && isDrop && (
            <div style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8, padding: '10px 12px', marginTop: 12,
              fontSize: 13, color: 'var(--text)',
            }}>
              Bỏ việc <b>{taskLabel}</b>? Job sẽ <b>hoàn thành mà không cần</b> việc này (không tính là chưa làm/quá hạn). Có thể phân lại người sau để làm lại.
            </div>
          )}
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
            {mut.isPending ? 'Đang lưu...' : confirming ? (isDrop ? 'Xác nhận bỏ' : 'Xác nhận đổi') : 'Xác nhận'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
