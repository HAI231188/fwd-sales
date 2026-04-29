import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getJobSettings, updateAssignmentMode, getWaitingAssignments,
  manualAssignJob, getLogStaff, refreshJobSuggestion,
} from '../api';
import { useAuth } from '../App';
import { useModalZIndex } from '../hooks/useModalZIndex';

const MODE_LABEL = { auto: 'Tự động', manual: 'Bán tự động' };
const SVC_LABEL = { tk: 'TK', truck: 'Xe', both: 'TK+Xe' };

function fmtDate(val) { if (!val) return '—'; return new Date(val).toLocaleDateString('vi-VN'); }
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function AssignmentModal({ initialTab = 'cus', onClose }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const zIndex = useModalZIndex();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [manualSelections, setManualSelections] = useState({});
  const [refreshedSuggestions, setRefreshedSuggestions] = useState({});
  const [refreshingJobs, setRefreshingJobs] = useState(new Set());

  async function handleRefresh(jobId) {
    setRefreshingJobs(prev => new Set([...prev, jobId]));
    try {
      const result = await refreshJobSuggestion(jobId, activeTab);
      setRefreshedSuggestions(prev => ({ ...prev, [jobId]: result.suggestion }));
    } catch {
      setRefreshedSuggestions(prev => ({ ...prev, [jobId]: null }));
    } finally {
      setRefreshingJobs(prev => { const next = new Set(prev); next.delete(jobId); return next; });
    }
  }

  const { data: settings } = useQuery({ queryKey: ['jobSettings'], queryFn: getJobSettings });
  const { data: waiting } = useQuery({
    queryKey: ['waitingAssignments'],
    queryFn: getWaitingAssignments,
    refetchInterval: 30000,
  });
  const { data: staffData = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });

  const modeMut = useMutation({
    mutationFn: mode => updateAssignmentMode(mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobSettings', 'jobStats'] }),
  });

  const assignMut = useMutation({
    mutationFn: ({ id, data }) => manualAssignJob(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['waitingAssignments', 'jobStats', 'jobs'] });
    },
  });

  const cusStaff = staffData.filter(s => ['cus', 'cus1', 'cus2', 'cus3'].includes(s.role));
  const opsStaff = staffData.filter(s => s.role === 'ops');
  const waitingCus = waiting?.waiting_cus || [];
  const waitingOps = waiting?.waiting_ops || [];
  const currentJobs = activeTab === 'cus' ? waitingCus : waitingOps;
  const candidates = activeTab === 'cus' ? cusStaff : opsStaff;
  const assignKey = activeTab === 'cus' ? 'cus_id' : 'ops_id';
  const currentMode = settings?.assignment_mode || 'auto';

  function handleAssign(jobId, userId) {
    if (!userId) return;
    assignMut.mutate({ id: jobId, data: { [assignKey]: Number(userId) } });
  }

  return (
    <div className="modal-overlay" style={{ zIndex }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3>Phân công nhân viên</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>Chế độ:</span>
              {['auto', 'manual'].map(m => (
                <button key={m}
                  className={`btn btn-sm ${currentMode === m ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ fontSize: 11, padding: '3px 10px' }}
                  disabled={modeMut.isPending}
                  onClick={() => modeMut.mutate(m)}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={`tab ${activeTab === 'cus' ? 'active' : ''}`}
              onClick={() => setActiveTab('cus')}>
              CUS ({waitingCus.length})
            </button>
            <button className={`tab ${activeTab === 'ops' ? 'active' : ''}`}
              onClick={() => setActiveTab('ops')}>
              OPS ({waitingOps.length})
            </button>
          </div>

          {!waiting ? (
            <div style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /></div>
          ) : currentJobs.length === 0 ? (
            <div className="empty-state">
              <div className="icon">✅</div>
              <p>Không có job nào chờ phân công</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {currentJobs.map(job => {
                const isRefreshing = refreshingJobs.has(job.id);
                const displaySuggestion = refreshedSuggestions[job.id] !== undefined
                  ? refreshedSuggestions[job.id]
                  : job.ai_suggestion;
                const selected = manualSelections[job.id] || '';
                const isTP = user?.role === 'truong_phong_log';

                return (
                  <div key={job.id} className="card" style={{ padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{job.customer_name}</span>
                        {job.job_code && (
                          <span style={{ fontSize: 11, color: 'var(--info)' }}>{job.job_code}</span>
                        )}
                        <span className="badge badge-info" style={{ fontSize: 10 }}>
                          {SVC_LABEL[job.service_type] || job.service_type}
                        </span>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtDate(job.created_at)}</span>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
                      ETD: {fmtDate(job.etd)} · ETA: {fmtDate(job.eta)}
                      {job.deadline && (
                        <span style={{ marginLeft: 8 }}>· Deadline: {fmtDt(job.deadline)}</span>
                      )}
                    </div>

                    {isRefreshing ? (
                      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="spinner" style={{ width: 14, height: 14 }} /> Đang phân tích...
                      </div>
                    ) : displaySuggestion ? (
                      <div style={{
                        background: displaySuggestion.fallback ? 'rgba(107,114,128,0.08)' : 'rgba(34,197,94,0.08)',
                        border: `1px solid ${displaySuggestion.fallback ? 'var(--border)' : 'rgba(34,197,94,0.3)'}`,
                        borderRadius: 8, padding: '8px 12px', marginBottom: 10,
                        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      }}>
                        <div style={{ flex: 1, fontSize: 12 }}>
                          <span style={{ fontWeight: 600, color: displaySuggestion.fallback ? 'var(--text-2)' : 'var(--primary)' }}>
                            {displaySuggestion.fallback ? '🔄' : '🤖'}{' '}
                          </span>
                          <span style={{ fontWeight: 600 }}>
                            {displaySuggestion.user_name || `#${displaySuggestion.user_id}`}
                          </span>
                          {displaySuggestion.reason && (
                            <span style={{ color: 'var(--text-2)', marginLeft: 6, fontSize: 11 }}>
                              — {displaySuggestion.reason}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {isTP && (
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: 11, padding: '3px 10px', whiteSpace: 'nowrap' }}
                              onClick={() => handleRefresh(job.id)}
                            >
                              Làm mới đề xuất
                            </button>
                          )}
                          <button
                            className="btn btn-primary btn-sm"
                            style={{ fontSize: 11, padding: '3px 12px', whiteSpace: 'nowrap' }}
                            disabled={assignMut.isPending}
                            onClick={() => handleAssign(job.id, displaySuggestion.user_id)}
                          >
                            Dùng đề xuất AI
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span>Đang phân tích...</span>
                        {isTP && (
                          <button
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11, padding: '2px 8px', whiteSpace: 'nowrap' }}
                            onClick={() => handleRefresh(job.id)}
                          >
                            Làm mới đề xuất
                          </button>
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        className="form-select"
                        style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
                        value={selected}
                        onChange={e => setManualSelections(p => ({ ...p, [job.id]: e.target.value }))}
                      >
                        <option value="">— Chọn thủ công —</option>
                        {candidates.map(s => (
                          <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
                        ))}
                      </select>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                        disabled={!selected || assignMut.isPending}
                        onClick={() => handleAssign(job.id, selected)}
                      >
                        Phân công
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
