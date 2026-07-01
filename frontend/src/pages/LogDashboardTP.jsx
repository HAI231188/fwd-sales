import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import CreateJobModal from '../components/CreateJobModal';
import AssignmentModal from '../components/AssignmentModal';
import PlanDeliveryModal from '../components/PlanDeliveryModal';
import ReassignModal from '../components/ReassignModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import TP_OverviewSection from '../components/TP_OverviewSection';
import StaffSection, { CUS_COLS, DD_COLS, OPS_COLS } from '../components/StaffSection';
import { useModalZIndex } from '../hooks/useModalZIndex';
import {
  getJobStats, getJobs, getDeadlineRequests, getLogStaff,
  assignJob, setJobDeadline, reviewDeadlineRequest, createJob,
  deleteJob, reviewDeleteRequest, getJobSettings, addDoiLenhTask,
} from '../api';
import toast from 'react-hot-toast';
// 2026-05-25: ddPillInfo shared with DD dashboard — used by tpStatusLines
// to render the DD-line of TP's 3-dept Trạng thái pill.
import { ddPillInfo } from '../utils/truckBookingStatus';
import { fmtDate, fmtDateTime as fmtDt, toDatetimeLocal, vnLocalToIso } from '../utils/dateFmt';

// 2026-05-25 TP dept-level status helper.
// tpStatusLines: returns an array of pending-dept status strings for this job.
// Each line = one dept still has work outstanding. Empty array = all done.
//
//   CUS (if service_type ∈ tk/both):
//     !tk_completed_at                    → "CUS: Chưa làm tờ khai"
//     tk_completed_at && !cost_entered_at → "CUS: Đã làm TK — chưa nhập cost"
//   DD  (if service_type ∈ truck/both):
//     dd_completed_at IS NULL             → "DD: {ddPillInfo(j).label}"
//   OPS (if destination='hai_phong'):
//     tk/both:
//       !terminal                                → "OPS: Chưa thông quan"
//       terminal && !tqCost                      → "OPS: Đã thông quan — chưa nhập cost TQ"
//       terminal && tqCost && !dlCompleted       → "OPS: Chưa đổi lệnh"
//       dlCompleted && !dlCost                   → "OPS: Đã đổi lệnh — chưa nhập cost ĐL"
//     truck:
//       !dlCompleted                             → "OPS: Chưa đổi lệnh"
//       dlCompleted && !dlCost                   → "OPS: Đã đổi lệnh — chưa nhập cost ĐL"
const TP_TK_TERMINAL = ['thong_quan', 'giai_phong', 'bao_quan'];
function tpStatusLines(j) {
  const lines = [];
  const svc = j.service_type;
  const hasTk = svc === 'tk' || svc === 'both';
  const hasTruck = svc === 'truck' || svc === 'both';
  const isHp = j.destination === 'hai_phong';

  // CUS line
  if (hasTk) {
    if (!j.tk_completed_at) {
      lines.push('CUS: Chưa làm tờ khai');
    } else if (!j.cost_entered_at) {
      lines.push('CUS: Đã làm TK — chưa nhập cost');
    }
  }
  // DD line
  if (hasTruck) {
    if (!j.dd_completed_at) {
      lines.push(`DD: ${ddPillInfo(j).label}`);
    }
  }
  // ops_hp line — OPS-only job. Gate on its single ops_hp task (done + cost),
  // independent of destination, so an in-progress ops_hp job keeps emitting a
  // pending line and stays visible in TP's "Đang làm" tab (was falsely empty →
  // "Hoàn thành" before Step 2).
  if (svc === 'ops_hp') {
    const ohTasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
    const oh = ohTasks.find(t => t.task_type === 'ops_hp');
    if (!oh || !oh.completed) lines.push('OPS: chưa hoàn thành');
    else if (!oh.cost_entered_at) lines.push('OPS: chưa nhập cost');
  }
  // OPS line (HP only)
  if (isHp) {
    const tasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
    const tq = tasks.find(t => t.task_type === 'thong_quan');
    const dl = tasks.find(t => t.task_type === 'doi_lenh');
    const terminal = TP_TK_TERMINAL.includes(j.tk_status);
    if (hasTk) {
      if (!terminal) {
        lines.push('OPS: Chưa thông quan');
      } else if (!tq?.cost_entered_at) {
        lines.push('OPS: Đã thông quan — chưa nhập cost TQ');
      } else if (dl && !dl.completed) {
        // P1: only when a doi_lenh task actually exists. tk-only HP jobs no
        // longer get a doi_lenh task, so after TQ cost is in they fall through
        // to "Hoàn thành" instead of the phantom "Chưa đổi lệnh".
        lines.push('OPS: Chưa đổi lệnh');
      } else if (dl && !dl.cost_entered_at) {
        lines.push('OPS: Đã đổi lệnh — chưa nhập cost ĐL');
      }
    } else if (svc === 'truck') {
      if (!dl?.completed) {
        lines.push('OPS: Chưa đổi lệnh');
      } else if (!dl?.cost_entered_at) {
        lines.push('OPS: Đã đổi lệnh — chưa nhập cost ĐL');
      }
    }
  }
  return lines;
}
function TpStatusCell({ job }) {
  const lines = tpStatusLines(job);
  if (!lines.length) {
    return (
      <span style={{ background: 'rgba(34,197,94,0.15)', color: '#16a34a',
        borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
        Hoàn thành
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {lines.map((line, i) => (
        <span key={i} style={{ color: 'var(--warning)', fontSize: 11, fontWeight: 500, lineHeight: 1.3 }}>
          {line}
        </span>
      ))}
    </div>
  );
}

// P3 (2026-06-23): per-task OPS cell helpers. j.ops_tasks[] carries ops_id +
// ops_name + task_type + completed + cost_entered_at (P2 projection).
function opsTaskOf(j, taskType) {
  const tasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
  return tasks.find(t => t.task_type === taskType) || null;
}
function opsTaskShortStatus(task, taskType, j) {
  if (taskType === 'thong_quan') {
    if (task.cost_entered_at) return { label: 'xong', color: '#16a34a' };
    return TP_TK_TERMINAL.includes(j.tk_status)
      ? { label: 'chưa cost', color: '#b45309' }
      : { label: 'chưa làm', color: '#d97706' };
  }
  // doi_lenh + ops_hp: two-tick (done + cost).
  if (!task.completed) return { label: 'chưa làm', color: '#d97706' };
  if (!task.cost_entered_at) return { label: 'chưa cost', color: '#b45309' };
  return { label: 'xong', color: '#16a34a' };
}
// One OPS task cell: assignee + short status, click to reassign THAT task (P3 #2).
// Empty doi_lenh on a tk-only HP job → "+ đổi lệnh" (P3 #3 — rotation picks the
// person, not TP). Only HP jobs render content. Reused by desktop + mobile (L26).
function OpsTaskCell({ j, taskType, taskLabel, onReassign, onAddDoiLenh, adding }) {
  const dash = <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  if (j.destination !== 'hai_phong') return dash;
  const task = opsTaskOf(j, taskType);
  if (task) {
    const st = opsTaskShortStatus(task, taskType, j);
    return (
      <span style={{ cursor: 'pointer', display: 'inline-flex', flexDirection: 'column', lineHeight: 1.2 }}
        title={`Đổi người làm ${taskLabel}`}
        onClick={(e) => { e.stopPropagation(); onReassign({ type: 'ops', taskType, taskLabel, job: j }); }}>
        <span style={{ fontSize: 12, color: 'var(--info)', textDecoration: 'underline dotted' }}>{task.ops_name || '(chưa có)'}</span>
        <span style={{ fontSize: 10, color: st.color, fontWeight: 600 }}>{st.label}</span>
      </span>
    );
  }
  // "+ đổi lệnh" shows on an empty doi_lenh cell when this HP job is eligible to
  // gain a doi_lenh manually: tk-only (never auto-got one) OR LCL truck/both
  // (LCL no longer auto-gets one — 2026-06-24). This cell is already HP-guarded
  // above, and we only reach here when no doi_lenh task exists. Shared by desktop
  // + mobile (one component → L26 parity).
  if (taskType === 'doi_lenh' && (j.service_type === 'tk' || j.cargo_type === 'lcl')) {
    return (
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 6px', whiteSpace: 'nowrap' }}
        disabled={adding}
        onClick={(e) => { e.stopPropagation(); onAddDoiLenh(j.id); }}>
        {adding ? '...' : '+ đổi lệnh'}
      </button>
    );
  }
  return dash;
}

const SVC_LABEL = { tk: 'TK', truck: 'Xe', both: 'TK+Xe', ops_hp: 'OPS HP' };
const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const CONT_TYPES = ['20DC','40DC','40HC','45HC','20RF','40RF'];
const OTHER_SVC_KEYS = ['ktcl','kiem_dich','hun_trung','co','khac'];
const OTHER_SVC_LABEL = { ktcl:'KTCL', kiem_dich:'Kiểm dịch', hun_trung:'Hun trùng', co:'CO', khac:'Khác' };

function fmtCargo(j) {
  if (j.cargo_type === 'lcl') {
    const parts = [];
    if (j.so_kien) parts.push(`${j.so_kien} kiện`);
    if (j.kg) parts.push(`${j.kg}kg`);
    if (j.cbm) parts.push(`${j.cbm}CBM`);
    return 'LCL' + (parts.length ? ' - ' + parts.join('/') : '');
  }
  const conts = Array.isArray(j.containers) ? j.containers : [];
  if (conts.length) {
    const grouped = {};
    conts.forEach(c => { grouped[c.cont_type] = (grouped[c.cont_type] || 0) + 1; });
    return Object.entries(grouped).map(([t, n]) => `${t} x${n}`).join(', ');
  }
  if (j.cont_number) return `${j.cont_number}${j.cont_type ? ' / ' + j.cont_type : ''}`;
  return '—';
}
function deadlineStyle(dl) {
  if (!dl) return {};
  const ms = new Date(dl) - Date.now();
  if (ms < 0) return { color: 'var(--danger)', fontWeight: 600 };
  if (ms < 48 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return { color: 'var(--primary)' };
}

const ALL_COLS = [
  { key: 'stt',          label: '#' },
  { key: 'job_code',     label: 'Số job' },
  { key: 'si_number',    label: 'Mã SI' },
  { key: 'import_export',label: 'Loại' },
  { key: 'created_at',   label: 'Ngày tạo' },
  { key: 'customer',     label: 'Tên khách' },
  { key: 'sales',        label: 'Sales' },
  { key: 'han_lenh',     label: 'Hạn lệnh / Cutoff' },
  { key: 'deadline',     label: 'Deadline' },
  { key: 'tk_flow',      label: 'Luồng TK' },
  { key: 'tk_number',    label: 'Số TK' },
  { key: 'tk_datetime',  label: 'Ngày TK' },
  { key: 'tk_status',    label: 'TT TK' },
  // 2026-05-25: TP dept-level Trạng thái pill — up to 3 lines (CUS/DD/OPS).
  { key: 'tp_status',    label: 'Trạng thái' },
  { key: 'tq_datetime',  label: 'Ngày TQ' },
  { key: 'delivery',     label: 'Ngày đặt KH' },
  { key: 'phan_cong',    label: 'Phân công' },
  { key: 'delivery_loc', label: 'Địa điểm giao' },
  { key: 'cargo',        label: 'Cont-Loại' },
  { key: 'service',      label: 'DV' },
  { key: 'etd_eta',      label: 'ETD-ETA' },
  { key: 'cus',          label: 'CUS' },
  // P3 (2026-06-23): per-task OPS — 3 cells (thong_quan / doi_lenh / ops_hp).
  { key: 'ops_tq',       label: 'OPS Thông quan' },
  { key: 'ops_dl',       label: 'OPS Đổi lệnh' },
  { key: 'ops_vk',       label: 'OPS Việc khác' },
  { key: 'notes',        label: 'Ghi chú' },
];
const FILTER_CONFIG = {
  job_code:  { filterType: 'text' },
  si_number: { filterType: 'text' },
  customer:  { filterType: 'text', accessor: j => j.customer_name || '' },
  sales:     { filterType: 'text', accessor: j => j.sales_name || '' },
  service:   { filterType: 'select', options: [
    { value: 'tk', label: 'TK' }, { value: 'truck', label: 'Xe' }, { value: 'both', label: 'TK+Xe' },
  ]},
  tk_status: { filterType: 'select', options: [
    { value: 'chua_truyen', label: 'Chưa truyền' }, { value: 'dang_lam', label: 'Đang làm' },
    { value: 'thong_quan', label: 'Thông quan' }, { value: 'giai_phong', label: 'Giải phóng' },
    { value: 'bao_quan', label: 'Bảo quan' },
  ]},
  cus: { filterType: 'text', accessor: j => j.cus_name || '' },
  // P3: the 3 OPS task columns are status cells (no text filter).
};

const LS_COL_KEY = 'tp_grid_columns';
function loadVisibleCols() {
  const allKeys = ALL_COLS.map(c => c.key);
  try {
    const s = localStorage.getItem(LS_COL_KEY);
    if (s) {
      const a = JSON.parse(s);
      if (Array.isArray(a)) {
        const valid = a.filter(k => allKeys.includes(k));
        if (valid.length) {
          // Append any newly-added columns not present in the saved list so feature
          // additions (e.g. import_export → "Loại") show up without nuking user order.
          const missing = allKeys.filter(k => !valid.includes(k));
          return [...valid, ...missing];
        }
      }
    }
  } catch {}
  localStorage.removeItem(LS_COL_KEY);
  return allKeys;
}

function StatCard({ label, value, color, onClick, badge, rows }) {
  if (rows) {
    return (
      <div className="card" onClick={onClick}
        style={{ cursor: onClick ? 'pointer' : 'default', padding: '14px 16px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{r.label}</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: r.color || 'var(--text)', fontFamily: 'var(--font-display)' }}>{r.value ?? '—'}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="card" onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', padding: '14px 16px', position: 'relative' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>
        {value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
      {badge && (
        <span style={{ position: 'absolute', top: 10, right: 10, background: color || 'var(--info)', color: '#fff', borderRadius: 20, fontSize: 10, padding: '2px 7px', fontWeight: 600 }}>
          {badge}
        </span>
      )}
    </div>
  );
}

function InlineDeadline({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef();

  function start() { setEditing(true); setTimeout(() => ref.current?.focus(), 0); }
  // UNCONTROLLED + read DOM ref at save (FIX 2 — datetime-local's onChange is
  // unreliable; the deadline is VN-anchored at the setDlMut mutationFn). (FIX 3)
  function save() { setEditing(false); const raw = ref.current?.value ?? ''; if (raw) onSave(raw); }

  if (!editing) return (
    <div>
      <div style={deadlineStyle(value)}>{value ? fmtDt(value) : <span style={{ color: 'var(--text-3)' }}>Chưa có</span>}</div>
      <span onClick={start} style={{ fontSize: 11, color: 'var(--info)', cursor: 'pointer', borderBottom: '1px dashed var(--info)' }}>
        {value ? 'Sửa' : 'Đặt deadline'}
      </span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input ref={ref} type="datetime-local" defaultValue={toDatetimeLocal(value) || ''}
        onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ padding: '2px 6px', border: '1px solid var(--primary)', borderRadius: 4, fontSize: 12 }} />
    </div>
  );
}

// Phase 6 Phase B3 — Mobile card shell. Mirrors OpsCard (LogDashboardOps:L97)
// and CusCard (LogDashboardCus). Pure presentation: header (job_code + Loại
// badge) + Khách line + dashed divider + per-row `body` + optional action
// footer with click-propagation stopped. No closures; caller wires onOpen and
// passes already-bound action buttons.
function TPCard({ job: j, body, actions, onOpen, codeColor }) {
  const imp = j.import_export === 'import';
  // KT5 — KT bounced this job back to LOG. Paint left border + show a chip
  // header so the TP sees it without scrolling into row internals.
  const isReturned = j.returned_to === 'log';
  return (
    <div className="data-card" onClick={onOpen}
      style={isReturned ? { borderLeft: '4px solid #ea580c' } : undefined}>
      {isReturned && (
        <div style={{
          background: 'rgba(249,115,22,0.10)',
          padding: '6px 8px', borderRadius: 4, marginBottom: 8,
          fontSize: 11, color: '#9a3412', fontWeight: 500,
        }}>
          🟠 KT trả về — Lý do: {j.returned_reason || '(không có)'}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: codeColor || 'var(--info)', fontFamily: 'var(--font-display)' }}>
          {j.job_code || `#${j.id}`}
        </div>
        <span style={{
          background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
          color: imp ? '#d97706' : '#16a34a',
          borderRadius: 6, padding: '2px 10px',
          fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
        }}>{imp ? 'Nhập' : 'Xuất'}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
        <span style={{ color: 'var(--text-2)', fontSize: 11 }}>Khách: </span>
        <strong>{j.customer_name || '—'}</strong>
      </div>
      <div style={{ height: 1, background: 'var(--border)', margin: '6px 0 8px' }} />
      {body}
      {actions && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border)', alignItems: 'center' }}
             onClick={e => e.stopPropagation()}>
          {actions}
        </div>
      )}
    </div>
  );
}

// ─── Assign Modal ─────────────────────────────────────────────────────────────
function AssignModal({ job, staff, onClose, onSave }) {
  const zIndex = useModalZIndex();
  const cusStaff = staff.filter(s => ['cus','cus1','cus2','cus3'].includes(s.role));
  const opsStaff = staff.filter(s => s.role === 'ops');
  const [cusId, setCusId] = useState(String(job.cus_id || ''));
  const [opsId, setOpsId] = useState(String(job.ops_id || ''));

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <h3>Phân công — {job.job_code || `#${job.id}`}</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16 }}>{job.customer_name}</div>
          {(job.service_type === 'tk' || job.service_type === 'both') && (
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Phân CUS (tờ khai)</label>
              <select className="form-select" value={cusId} onChange={e => setCusId(e.target.value)}>
                <option value="">-- Chọn CUS --</option>
                {cusStaff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
              </select>
            </div>
          )}
          {(job.service_type === 'tk' || job.service_type === 'both') && (
            <div className="form-group">
              <label className="form-label">Phân OPS (tuỳ chọn)</label>
              <select className="form-select" value={opsId} onChange={e => setOpsId(e.target.value)}>
                <option value="">-- Chọn OPS --</option>
                {opsStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm"
            onClick={() => onSave({ cus_id: cusId ? Number(cusId) : undefined, ops_id: opsId ? Number(opsId) : undefined })}>
            Xác nhận phân công
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

// ─── Deadline Modal ───────────────────────────────────────────────────────────
function DeadlineModal({ data, onClose, onReview, onSetDeadline, onReviewDelete }) {
  const zIndex = useModalZIndex();
  const [activeTab, setActiveTab] = useState('cus_confirm');
  const [overrides, setOverrides] = useState({});
  const [detailJobId, setDetailJobId] = useState(null);
  const { pending_confirmations = [], requests = [], no_deadline = [], delete_requests = [] } = data || {};

  const tabs = [
    { key: 'cus_confirm', label: 'CUS chưa nhận', count: pending_confirmations.length, color: 'var(--warning)' },
    { key: 'deadline_adj', label: 'Điều chỉnh deadline', count: requests.length + delete_requests.length, color: 'var(--danger)' },
    { key: 'no_deadline', label: 'Chưa có deadline', count: no_deadline.length, color: 'var(--text-2)' },
  ];

  const rowStyle = { cursor: 'pointer' };
  function onRowHover(e, enter) { e.currentTarget.style.background = enter ? 'var(--bg)' : ''; }

  return (
    <>
      {createPortal((
      <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="modal modal-lg" style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
          <div className="modal-header">
            <h3>Chờ xác nhận</h3>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
          </div>

          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              {tabs.map(t => (
                <button key={t.key} className={`tab ${activeTab === t.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {t.label}
                  <span style={{
                    background: t.count > 0 ? t.color : 'var(--border)',
                    color: t.count > 0 ? '#fff' : 'var(--text-3)',
                    borderRadius: 10, fontSize: 10, padding: '1px 6px', fontWeight: 600,
                  }}>{t.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="modal-body" style={{ overflowY: 'auto', flex: 1 }}>

            {/* Tab 1: CUS chưa nhận */}
            {activeTab === 'cus_confirm' && (
              pending_confirmations.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Tất cả CUS đã xác nhận</p></div>
                : pending_confirmations.map(j => (
                  <div key={j.job_id} className="card" style={{ marginBottom: 10, padding: 14, ...rowStyle }}
                    onClick={() => setDetailJobId(j.job_id)}
                    onMouseEnter={e => onRowHover(e, true)}
                    onMouseLeave={e => onRowHover(e, false)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <span style={{ fontWeight: 600, color: 'var(--info)' }}>{j.job_code || `#${j.job_id}`}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{fmtDate(j.created_at)}</span>
                    </div>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>{j.customer_name}</div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-2)' }}>
                      <span>CUS: <strong style={{ color: 'var(--warning)' }}>
                        {j.cus_name ? `${j.cus_name}${j.ai_reason ? ` (AI: ${j.ai_reason})` : ''}` : '—'}
                      </strong></span>
                      {j.ops_name && <span>OPS: <strong>{j.ops_name}</strong></span>}
                      <span>Deadline: <strong style={{ color: j.deadline ? 'var(--text)' : 'var(--text-3)' }}>{j.deadline ? fmtDt(j.deadline) : 'Chưa có'}</strong></span>
                    </div>
                  </div>
                ))
            )}

            {/* Tab 2: Điều chỉnh deadline */}
            {activeTab === 'deadline_adj' && (
              requests.length === 0 && delete_requests.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Không có yêu cầu pending</p></div>
                : <>
                  {requests.map(r => (
                    <div key={r.id} className="card" style={{ marginBottom: 12, padding: 14, ...rowStyle }}
                      onClick={() => setDetailJobId(r.job_id)}
                      onMouseEnter={e => onRowHover(e, true)}
                      onMouseLeave={e => onRowHover(e, false)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 6 }}>
                        Deadline hiện tại: <strong>{r.current_deadline ? fmtDt(r.current_deadline) : 'Chưa có'}</strong>
                        {' → '}Đề xuất: <strong style={{ color: 'var(--warning)' }}>{fmtDt(r.proposed_deadline)}</strong>
                      </div>
                      <div style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-2)' }}>Lý do: {r.reason}</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
                        onClick={e => e.stopPropagation()}>
                        <input type="datetime-local"
                          value={overrides[r.id] !== undefined ? overrides[r.id] : toDatetimeLocal(r.proposed_deadline)}
                          onChange={e => setOverrides(p => ({ ...p, [r.id]: e.target.value }))}
                          style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }} />
                        <button className="btn btn-primary btn-sm"
                          onClick={() => onReview(r.id, 'approved', overrides[r.id] || r.proposed_deadline)}>Duyệt</button>
                        <button className="btn btn-danger btn-sm"
                          onClick={() => onReview(r.id, 'rejected', null)}>Từ chối</button>
                      </div>
                    </div>
                  ))}
                  {delete_requests.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', marginTop: 16, marginBottom: 8 }}>
                        Yêu cầu xóa job ({delete_requests.length})
                      </div>
                      {delete_requests.map(r => (
                        <div key={r.id} className="card" style={{ marginBottom: 10, padding: 14, borderLeft: '3px solid var(--danger)', ...rowStyle }}
                          onClick={() => setDetailJobId(r.job_id)}
                          onMouseEnter={e => onRowHover(e, true)}
                          onMouseLeave={e => onRowHover(e, false)}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontWeight: 600 }}>{r.job_code || `#${r.job_id}`} — {r.customer_name}</span>
                            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>by {r.requested_by_name}</span>
                          </div>
                          {r.reason && <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 8 }}>Lý do: {r.reason}</div>}
                          <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                            <button className="btn btn-danger btn-sm" onClick={() => onReviewDelete(r.id, 'approved')}>Duyệt xóa</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => onReviewDelete(r.id, 'rejected')}>Từ chối</button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </>
            )}

            {/* Tab 3: Chưa có deadline */}
            {activeTab === 'no_deadline' && (
              no_deadline.length === 0
                ? <div className="empty-state"><div className="icon">✅</div><p>Tất cả job đã có deadline</p></div>
                : no_deadline.map(j => (
                  <div key={j.job_id} className="card" style={{ marginBottom: 8, padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', ...rowStyle }}
                    onClick={() => setDetailJobId(j.job_id)}
                    onMouseEnter={e => onRowHover(e, true)}
                    onMouseLeave={e => onRowHover(e, false)}>
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <strong>{j.job_code || `#${j.job_id}`}</strong> — {j.customer_name}
                      <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 8 }}>{fmtDate(j.created_at)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                      <input type="datetime-local"
                        value={overrides[`n_${j.job_id}`] || ''}
                        onChange={e => setOverrides(p => ({ ...p, [`n_${j.job_id}`]: e.target.value }))}
                        style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }} />
                      <button className="btn btn-primary btn-sm"
                        disabled={!overrides[`n_${j.job_id}`]}
                        onClick={() => onSetDeadline(j.job_id, overrides[`n_${j.job_id}`])}>
                        Đặt deadline
                      </button>
                    </div>
                  </div>
                ))
            )}

          </div>
        </div>
      </div>
      ), document.body)}

      {detailJobId && (
        <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
      )}
    </>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function LogDashboardTP() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [detailJobId, setDetailJobId] = useState(null);
  // Phase 5 Step 2 — "Đặt kế hoạch xe" target. Button lives next to 🔍 on each row.
  const [planModalJob, setPlanModalJob] = useState(null); // {jobId, jobCode}
  const [showCreate, setShowCreate] = useState(false);
  const [showDeadline, setShowDeadline] = useState(false);
  const [assigningJob, setAssigningJob] = useState(null);
  const [showAssignment, setShowAssignment] = useState(null); // 'cus' | 'ops' | null
  const [reassignTarget, setReassignTarget] = useState(null); // { type: 'cus'|'ops', job }
  const [filterAssignee, setFilterAssignee] = useState('');
  const [isVisible, setIsVisible] = useState(!document.hidden);
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols);
  const [showColMenu, setShowColMenu] = useState(false);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

  function toggleCol(key) {
    setVisibleCols(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      localStorage.setItem(LS_COL_KEY, JSON.stringify(next));
      return next;
    });
  }

  useEffect(() => {
    const handler = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  useEffect(() => {
    const onOpen = e => { if (e.detail?.jobId) setDetailJobId(e.detail.jobId); };
    window.addEventListener('open-job-detail', onOpen);
    return () => window.removeEventListener('open-job-detail', onOpen);
  }, []);

  useEffect(() => { setFilterAssignee(''); }, [tab]);

  const pollInterval = isVisible ? 5000 : 30000;

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: pollInterval });
  const { data: settings } = useQuery({ queryKey: ['jobSettings'], queryFn: getJobSettings, refetchInterval: pollInterval });
  const { data: pendingJobs = [], isLoading: isLoadingPending } = useQuery({
    queryKey: ['jobs', 'pending'], queryFn: () => getJobs({ tab: 'pending' }), refetchInterval: pollInterval,
  });
  const { data: completedJobs = [], isLoading: isLoadingCompleted } = useQuery({
    queryKey: ['jobs', 'completed', completedRange],
    queryFn: () => getJobs({ tab: 'completed', ...completedRange }),
    enabled: tab === 'completed',
    refetchInterval: pollInterval,
  });
  // 2026-05-25 TP-split: partition by tpStatusLines (all-depts done predicate),
  // not by jobs.status. "Đang làm" = at least one dept pending; "Hoàn thành"
  // = all depts done. Race window: a pending job whose CUS+DD+OPS just all
  // ticked but auto-flip hasn't fired surfaces in Hoàn thành too (rare).
  // No service_type filter — TP sees all job types.
  const tpDoneInPending = pendingJobs.filter(j => tpStatusLines(j).length === 0);
  const completedAll    = completedJobs || [];
  const completedById   = new Map();
  for (const j of [...tpDoneInPending, ...completedAll]) {
    if (!completedById.has(j.id)) completedById.set(j.id, j);
  }
  const tpCompletedView = Array.from(completedById.values());
  const tpPendingView   = pendingJobs.filter(j => tpStatusLines(j).length > 0);
  const jobs = tab === 'completed' ? tpCompletedView : tpPendingView;
  const isLoading = tab === 'completed' ? isLoadingCompleted : isLoadingPending;
  const { data: dlData } = useQuery({
    queryKey: ['deadlineRequests'], queryFn: getDeadlineRequests,
    enabled: showDeadline,
  });
  const { data: staff = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });

  const createMut = useMutation({
    mutationFn: data => createJob(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const assignMut = useMutation({
    mutationFn: ({ id, data }) => assignJob(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['jobs'] }); setAssigningJob(null); },
  });
  // P3 #3: "+ đổi lệnh" — backend rotation assigns this week's ĐL person.
  const addDoiLenhMut = useMutation({
    mutationFn: (jobId) => addDoiLenhTask(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
      toast.success('Đã thêm việc đổi lệnh (phân theo lịch tuần)');
    },
    onError: (err) => toast.error(err?.response?.data?.error || 'Không thể thêm việc đổi lệnh'),
  });
  const setDlMut = useMutation({
    // FIX 3 — anchor to Vietnam time at the single send point (handles both
    // InlineDeadline and the DeadlineModal "no deadline" tab).
    mutationFn: ({ id, deadline }) => setJobDeadline(id, vnLocalToIso(deadline)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['deadlineRequests'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const reviewMut = useMutation({
    // FIX 3 — VN-anchor the approved override deadline (vnLocalToIso passes a
    // raw ISO proposed_deadline through unchanged, converts a naive override).
    mutationFn: ({ rid, action, dl }) => reviewDeadlineRequest(rid, action, vnLocalToIso(dl)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['deadlineRequests'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const deleteMut = useMutation({
    mutationFn: id => deleteJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const reviewDeleteMut = useMutation({
    mutationFn: ({ rid, action }) => reviewDeleteRequest(rid, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['deadlineRequests'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });

  const modeLabel = settings?.assignment_mode === 'manual' ? 'Bán tự động' : 'Tự động';
  const logStaff = qc.getQueryData(['logStaff']) || [];
  const cusStaff = logStaff.filter(s => ['cus','cus1','cus2','cus3'].includes(s.role));
  const opsStaff = logStaff.filter(s => s.role === 'ops');
  const dieuDoStaff = logStaff.filter(s => s.role === 'dieu_do');
  const filteredJobs = filterAssignee
    ? jobs.filter(j =>
        String(j.cus_id) === filterAssignee ||
        String(j.ops_id) === filterAssignee ||
        String(j.dieu_do_id) === filterAssignee
      )
    : jobs;

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>Dashboard Trưởng Phòng LOG</h2>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Tạo Job Mới</button>
        </div>

        {/* Stat cards */}
        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <StatCard label="Tổng job pending" color="var(--info)"
            rows={[
              { label: 'Tổng pending',   value: stats?.total_pending, color: 'var(--info)',    onClick: () => setJobListFilter('pending') },
              { label: 'TK pending',     value: stats?.tk_pending,    color: 'var(--warning)', onClick: () => setJobListFilter('tp_tk_pending') },
              { label: 'Đặt xe pending', value: stats?.truck_pending, color: '#7c3aed',        onClick: () => setJobListFilter('tp_truck_pending') },
            ]} />
          <StatCard label="Chờ phân CUS" value={stats?.waiting_cus} color="var(--warning)"
            badge={modeLabel}
            onClick={() => setShowAssignment('cus')} />
          <StatCard label="Chờ phân OPS" value={stats?.waiting_ops} color="var(--purple)"
            badge={modeLabel}
            onClick={() => setShowAssignment('ops')} />
          <StatCard label="Chờ xác nhận"
            badge={stats?.delete_requests > 0 ? `${stats.delete_requests} xóa` : null}
            onClick={() => setShowDeadline(true)}
            rows={[
              { label: 'CUS chưa nhận', value: stats?.cus_confirm_pending, color: 'var(--warning)' },
              { label: 'Điều chỉnh deadline', value: stats?.deadline_adj_requests, color: 'var(--danger)' },
              { label: 'Chưa có deadline', value: stats?.no_deadline, color: 'var(--text-2)' },
            ]} />
          <StatCard label="Quá deadline" value={stats?.overdue} color="var(--danger)"
            onClick={() => setJobListFilter('overdue')} />
          <StatCard label="Sắp hạn (48h)" value={stats?.warn_soon} color="var(--warning)"
            onClick={() => setJobListFilter('warning')} />
          <StatCard label="Thiếu thông tin" value={stats?.missing_info} color="var(--text-2)"
            onClick={() => setJobListFilter('missing')} />
        </div>

        {/* Staff sections — 3 cards by role */}
        <StaffSection
          title="Tình hình CUS"
          rows={stats?.cus_stats || []}
          columns={CUS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />
        <StaffSection
          title="Tình hình Điều Độ"
          rows={stats?.dieu_do_stats || []}
          columns={DD_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />
        <StaffSection
          title="Tình hình OPS"
          rows={stats?.ops_stats || []}
          columns={OPS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />

        <TP_OverviewSection />

        {/* Jobs grid */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="tabs" style={{ marginBottom: 0 }}>
                <button className={`tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
                  CV Pending
                </button>
                <button className={`tab ${tab === 'completed' ? 'active' : ''}`} onClick={() => setTab('completed')}>
                  CV Hoàn thành
                </button>
              </div>
              {tab === 'completed' && (
                <div style={{ paddingBottom: 4 }}>
                  <DateRangeFilter onChange={setCompletedRange} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 4 }}>
              {tab === 'pending' && (
                <select
                  className="form-select"
                  style={{ fontSize: 12, padding: '4px 8px', width: 'auto', minWidth: 140 }}
                  value={filterAssignee}
                  onChange={e => setFilterAssignee(e.target.value)}
                >
                  <option value="">Tất cả nhân viên</option>
                  {cusStaff.length > 0 && <option disabled>── CUS ──</option>}
                  {cusStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {opsStaff.length > 0 && <option disabled>── OPS ──</option>}
                  {opsStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  {dieuDoStaff.length > 0 && <option disabled>── Điều Độ ──</option>}
                  {dieuDoStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
              <div style={{ position: 'relative' }}>
                <button className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => setShowColMenu(v => !v)}>
                  ⚙️ Cột
                </button>
                {showColMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, zIndex: 300,
                    background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 8,
                    minWidth: 170, display: 'flex', flexDirection: 'column', gap: 2,
                  }}>
                    {ALL_COLS.map(c => (
                      <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', padding: '3px 4px', borderRadius: 4 }}>
                        <input type="checkbox" checked={visibleCols.includes(c.key)} onChange={() => toggleCol(c.key)} />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : (() => {
              const ftColumns = ALL_COLS
                .filter(c => visibleCols.includes(c.key))
                .map(c => ({ ...c, ...(FILTER_CONFIG[c.key] || {}) }));
              return (
                <FilteredTable
                  columns={ftColumns}
                  data={filteredJobs}
                  renderMobileCard={(j) => {
                    const isTk = j.service_type === 'tk' || j.service_type === 'both';
                    const waitingAssign = (j.service_type === 'tk' || j.service_type === 'both') && !j.cus_id;
                    const cusEligible = tab === 'pending' && !j.tk_completed_at;
                    return (
                      <TPCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)}
                        codeColor={tab === 'completed' ? 'var(--primary)' : 'var(--info)'}
                        body={
                          <>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', fontSize: 12 }}>
                              <span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span>
                              <span><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</span>
                              <span><span style={{ color: 'var(--text-2)' }}>SI:</span> {j.si_number || '—'}</span>
                            </div>

                            <div style={{ fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: 'var(--text-2)' }}>Hàng hóa:</span> {fmtCargo(j)}
                            </div>

                            <div style={{ fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: 'var(--text-2)' }}>Hạn lệnh / Cutoff:</span>{' '}
                              <span style={deadlineStyle(j.han_lenh)}>
                                {j.han_lenh ? (j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)) : '—'}
                              </span>
                            </div>

                            <div style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                              <span style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', paddingTop: 2 }}>Deadline:</span>
                              <div style={{ flex: 1, minWidth: 0 }} onClick={e => e.stopPropagation()}>
                                <InlineDeadline value={j.deadline}
                                  onSave={v => setDlMut.mutate({ id: j.id, deadline: v })} />
                              </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 8, fontSize: 12 }}>
                              <div><span style={{ color: 'var(--text-2)' }}>ETD:</span> {fmtDate(j.etd)}</div>
                              <div><span style={{ color: 'var(--text-2)' }}>ETA:</span> {fmtDate(j.eta)}</div>
                            </div>

                            {isTk && (
                              <div style={{ padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, marginBottom: 8 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, marginBottom: 6 }}>Tờ khai</div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12 }}>
                                  <div><span style={{ color: 'var(--text-2)' }}>Số TK:</span> {j.tk_number || '—'}</div>
                                  <div><span style={{ color: 'var(--text-2)' }}>Luồng:</span> {j.tk_flow || '—'}</div>
                                </div>
                                <div style={{ fontSize: 12, marginTop: 4 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Trạng thái:</span>{' '}
                                  {j.tk_status
                                    ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500 }}>{TK_STATUS_LABEL[j.tk_status]}</span>
                                    : <span style={{ color: 'var(--text-3)' }}>—</span>}
                                </div>
                                {(j.tk_datetime || j.tq_datetime) && (
                                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-2)' }}>
                                    {j.tk_datetime && <>Ngày TK: {fmtDt(j.tk_datetime)}</>}
                                    {j.tk_datetime && j.tq_datetime && <span style={{ margin: '0 6px' }}>·</span>}
                                    {j.tq_datetime && <>TQ: {fmtDt(j.tq_datetime)}</>}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* 2026-05-25: TP Trạng thái block — same content as the desktop tp_status column. */}
                            <div style={{ padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, marginBottom: 8 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, marginBottom: 6 }}>Trạng thái</div>
                              <TpStatusCell job={j} />
                            </div>

                            <div style={{ padding: '8px 10px', background: 'var(--bg)', borderRadius: 8, marginBottom: 8 }}>
                              <div style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600, marginBottom: 6 }}>Phân công</div>
                              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }} onClick={e => e.stopPropagation()}>
                                <div>
                                  <span style={{ color: 'var(--text-2)' }}>CUS:</span>{' '}
                                  {!j.cus_name
                                    ? (cusEligible
                                        ? <span style={{ color: 'var(--warning)', fontWeight: 600, borderBottom: '1px dotted var(--warning)', cursor: 'pointer' }}
                                            onClick={() => setReassignTarget({ type: 'cus', job: j })}>Chờ phân</span>
                                        : <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>)
                                    : (cusEligible
                                        ? <span style={{ color: 'var(--info)', cursor: 'pointer', borderBottom: '1px dotted var(--info)' }}
                                            onClick={() => setReassignTarget({ type: 'cus', job: j })}>{j.cus_name}</span>
                                        : <span style={{ color: 'var(--text-3)' }}>{j.cus_name}</span>)}
                                </div>
                                <div><span style={{ color: 'var(--text-2)' }}>Sales:</span>{' '}<span style={{ color: 'var(--text-3)' }}>{j.sales_name || '—'}</span></div>
                                {/* P3: 3 per-task OPS cells (mirror of the desktop columns, L26). */}
                                {j.destination === 'hai_phong' ? (
                                  <>
                                    <div><span style={{ color: 'var(--text-2)' }}>TQ:</span>{' '}
                                      <OpsTaskCell j={j} taskType="thong_quan" taskLabel="Thông quan" onReassign={setReassignTarget} /></div>
                                    <div><span style={{ color: 'var(--text-2)' }}>ĐL:</span>{' '}
                                      <OpsTaskCell j={j} taskType="doi_lenh" taskLabel="Đổi lệnh" onReassign={setReassignTarget}
                                        onAddDoiLenh={(id) => addDoiLenhMut.mutate(id)} adding={addDoiLenhMut.isPending} /></div>
                                    <div><span style={{ color: 'var(--text-2)' }}>VK:</span>{' '}
                                      <OpsTaskCell j={j} taskType="ops_hp" taskLabel="Việc khác" onReassign={setReassignTarget} /></div>
                                  </>
                                ) : (
                                  <div><span style={{ color: 'var(--text-2)' }}>OPS:</span>{' '}<span style={{ color: 'var(--text-3)' }}>—</span></div>
                                )}
                              </div>
                            </div>

                            {j.first_booking_id && (
                              <div style={{ padding: '8px 10px', background: 'rgba(124,58,237,0.06)', borderRadius: 8, marginBottom: 8, fontSize: 12 }}>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 3 }}>
                                  <span style={{ color: 'var(--text-2)' }}>Vận tải:</span>
                                  <strong>{j.first_booking_transport || '—'}</strong>
                                  {j.truck_bookings_count > 1 && (
                                    <span style={{ background: 'rgba(124,58,237,0.12)', color: '#7c3aed', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>
                                      +{j.truck_bookings_count - 1} KH khác
                                    </span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                  <span>
                                    <span style={{ color: 'var(--text-2)' }}>Số xe:</span>{' '}
                                    {j.first_booking_vehicle
                                      ? <strong style={{ color: 'var(--primary)' }}>{j.first_booking_vehicle}</strong>
                                      : <span style={{ color: 'var(--warning)' }}>⏳ Chờ</span>}
                                  </span>
                                  <span>
                                    <span style={{ color: 'var(--text-2)' }}>KH:</span>{' '}
                                    {j.first_booking_planned ? fmtDate(j.first_booking_planned) : '—'}
                                  </span>
                                </div>
                              </div>
                            )}

                            {j.delivery_location && (
                              <div style={{ fontSize: 12, marginBottom: 6 }}>
                                <div><span style={{ color: 'var(--text-2)' }}>Địa điểm:</span> {j.delivery_location || '—'}</div>
                              </div>
                            )}

                            {j.tk_notes && (
                              <div style={{ fontSize: 12, color: 'var(--text-2)', padding: '6px 8px', background: 'var(--bg)', borderRadius: 6 }}>
                                {j.tk_notes}
                              </div>
                            )}
                          </>
                        }
                        actions={<>
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm" title={waitingAssign ? 'Phân công' : 'Sửa phân công'}
                              onClick={() => setAssigningJob(j)}>
                              {waitingAssign ? '⚡ Phân công' : '✏️ Phân công'}
                            </button>
                          )}
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm btn-icon" title="Xóa job"
                              style={{ color: 'var(--danger)' }}
                              onClick={() => {
                                if (window.confirm(`Xóa job ${j.job_code || '#' + j.id}?`)) {
                                  deleteMut.mutate(j.id);
                                }
                              }}>🗑</button>
                          )}
                          <button className="btn btn-ghost btn-sm btn-icon" title="Đặt kế hoạch xe"
                            onClick={() => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}>📅</button>
                          <button className="btn btn-ghost btn-sm btn-icon" title="Chi tiết"
                            onClick={() => setDetailJobId(j.id)}>🔍</button>
                        </>}
                      />
                    );
                  }}
                  emptyText="Không có job nào"
                  extraHeaderCells={<th style={{ padding: '10px 8px' }} />}
                  tableStyle={{ fontSize: 13 }}
                  renderRow={(j, i) => {
                    const waitingAssign = (j.service_type === 'tk' || j.service_type === 'both') && !j.cus_id;
                    // KT5 — highest-priority row tint: KT has returned this job
                    // to LOG (returned_to='log' on the job). Overrides tk_flow
                    // and waiting-assign tints because the action item now is
                    // "fix what KT flagged" not "fill in TK info".
                    const ktReturnedBg = j.returned_to === 'log' ? 'rgba(249,115,22,0.10)' : '';
                    const tkBg = j.tk_flow === 'xanh' ? 'rgba(34,197,94,0.06)' :
                                 j.tk_flow === 'vang' ? 'rgba(217,119,6,0.06)' :
                                 j.tk_flow === 'do'   ? 'rgba(239,68,68,0.06)' :
                                 j.tk_status === 'chua_truyen' ? 'rgba(239,68,68,0.04)' : '';
                    const rowBg = ktReturnedBg || tkBg || (waitingAssign ? 'rgba(217,119,6,0.04)'
                      : j.deadline && new Date(j.deadline) < Date.now() ? 'rgba(239,68,68,0.04)' : '');
                    const cs = { padding: '8px 8px' };

                    const cell = (key) => {
                      switch (key) {
                        case 'stt':         return <td key={key} style={{ ...cs, color: 'var(--text-3)' }}>{i + 1}</td>;
                        case 'job_code':    return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12, color: 'var(--info)' }}>
                          {j.returned_to === 'log' && (
                            <span style={{ marginRight: 4, cursor: 'help' }}
                              title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                          )}
                          {j.job_code || '—'}
                        </td>;
                        case 'si_number':   return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</td>;
                        case 'import_export': {
                          const imp = j.import_export === 'import';
                          return <td key={key} style={{ ...cs, whiteSpace: 'nowrap' }}>
                            <span style={{ background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
                              color: imp ? '#d97706' : '#16a34a', borderRadius: 6, padding: '2px 8px',
                              fontSize: 11, fontWeight: 600 }}>{imp ? 'Nhập' : 'Xuất'}</span>
                          </td>;
                        }
                        case 'created_at':  return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</td>;
                        case 'customer':    return <td key={key} style={{ ...cs, maxWidth: 150 }}><div style={{ fontWeight: 500, fontSize: 13 }}>{j.customer_name}</div></td>;
                        case 'sales':       return <td key={key} style={{ ...cs, maxWidth: 140 }}><div style={{ fontSize: 12, color: 'var(--text-2)' }}>{j.sales_name || '—'}</div></td>;
                        case 'han_lenh': {
                          if (!j.han_lenh) return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}><span style={{ color: 'var(--text-3)' }}>—</span></td>;
                          const isImport = j.import_export === 'import';
                          return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>
                            <span style={deadlineStyle(j.han_lenh)}>
                              {isImport ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)}
                            </span>
                          </td>;
                        }
                        case 'deadline':    return <td key={key} style={{ ...cs, minWidth: 130 }}><InlineDeadline value={j.deadline} onSave={v => setDlMut.mutate({ id: j.id, deadline: v })} /></td>;
                        case 'tk_flow':     return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)' }}>{j.tk_flow || '—'}</td>;
                        case 'tk_number':   return <td key={key} style={{ ...cs, fontSize: 12 }}>{j.tk_number || '—'}</td>;
                        case 'tk_datetime': return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.tk_datetime ? fmtDt(j.tk_datetime) : '—'}</td>;
                        case 'tk_status':   return <td key={key} style={cs}>{j.tk_status ? <span style={{ color: TK_STATUS_COLOR[j.tk_status], fontWeight: 500, fontSize: 12 }}>{TK_STATUS_LABEL[j.tk_status]}</span> : <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>}</td>;
                        // 2026-05-25: TP dept-level Trạng thái — stacked CUS/DD/OPS lines or green "Hoàn thành".
                        case 'tp_status':   return <td key={key} style={{ ...cs, minWidth: 180 }}><TpStatusCell job={j} /></td>;
                        case 'tq_datetime': return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.tq_datetime ? fmtDt(j.tq_datetime) : '—'}</td>;
                        case 'delivery':    return <td key={key} style={{ ...cs, fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{j.first_booking_planned ? fmtDate(j.first_booking_planned) : '—'}</td>;
                        case 'phan_cong':   return <td key={key} style={cs}>{tab === 'pending' && <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => setAssigningJob(j)}>{waitingAssign ? '⚡ Phân công' : '✏️ Sửa'}</button>}</td>;
                        case 'delivery_loc':return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)', maxWidth: 120 }}>{j.delivery_location || '—'}</td>;
                        case 'cargo':       return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</td>;
                        case 'service':     return <td key={key} style={cs}><span className="badge badge-info" style={{ fontSize: 10 }}>{SVC_LABEL[j.service_type] || j.service_type}</span></td>;
                        case 'etd_eta':     return <td key={key} style={{ ...cs, whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)}<br />{fmtDate(j.eta)}</td>;
                        case 'cus': {
                          const cusEligible = tab === 'pending' && !j.tk_completed_at;
                          if (!j.cus_name) {
                            return <td key={key} style={cs}>
                              {cusEligible ? (
                                <span
                                  title="Phân CUS"
                                  style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline dotted' }}
                                  onClick={() => setReassignTarget({ type: 'cus', job: j })}
                                >Chờ phân</span>
                              ) : (
                                <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Chờ phân</span>
                              )}
                            </td>;
                          }
                          return <td key={key} style={cs}>
                            {cusEligible ? (
                              <span
                                title="Đổi CUS"
                                style={{ fontSize: 12, cursor: 'pointer', textDecoration: 'underline dotted', color: 'var(--info)' }}
                                onClick={() => setReassignTarget({ type: 'cus', job: j })}
                              >{j.cus_name}</span>
                            ) : (
                              <span
                                title="TK đã hoàn thành, không thể đổi"
                                style={{ fontSize: 12, color: 'var(--text-3)' }}
                              >{j.cus_name}</span>
                            )}
                          </td>;
                        }
                        // P3: 3 per-task OPS cells (thong_quan / doi_lenh / ops_hp).
                        // Click a filled cell → reassign that task; empty doi_lenh on a
                        // tk-only HP job → "+ đổi lệnh" (rotation picks the person).
                        case 'ops_tq':
                          return <td key={key} style={cs}>
                            <OpsTaskCell j={j} taskType="thong_quan" taskLabel="Thông quan"
                              onReassign={setReassignTarget} />
                          </td>;
                        case 'ops_dl':
                          return <td key={key} style={cs}>
                            <OpsTaskCell j={j} taskType="doi_lenh" taskLabel="Đổi lệnh"
                              onReassign={setReassignTarget}
                              onAddDoiLenh={(id) => addDoiLenhMut.mutate(id)}
                              adding={addDoiLenhMut.isPending} />
                          </td>;
                        case 'ops_vk':
                          return <td key={key} style={cs}>
                            <OpsTaskCell j={j} taskType="ops_hp" taskLabel="Việc khác"
                              onReassign={setReassignTarget} />
                          </td>;
                        case 'notes':       return <td key={key} style={{ ...cs, fontSize: 12, color: 'var(--text-2)', maxWidth: 140 }}>{j.tk_notes || '—'}</td>;
                        default: return null;
                      }
                    };

                    return (
                      <tr key={j.id} style={{ borderBottom: '1px solid var(--border)', background: rowBg }}
                        onDoubleClick={() => setDetailJobId(j.id)}>
                        {ftColumns.map(c => cell(c.key))}
                        <td style={{ ...cs, whiteSpace: 'nowrap' }}>
                          {tab === 'pending' && (
                            <button className="btn btn-ghost btn-sm btn-icon"
                              title="Xóa job" style={{ color: 'var(--danger)' }}
                              onClick={() => {
                                if (window.confirm(`Xóa job ${j.job_code || '#' + j.id}?`)) {
                                  deleteMut.mutate(j.id);
                                }
                              }}>🗑</button>
                          )}
                          <button className="btn btn-ghost btn-sm btn-icon" title="Đặt kế hoạch xe"
                            onClick={() => setPlanModalJob({ jobId: j.id, jobCode: j.job_code })}>📅</button>
                          <button className="btn btn-ghost btn-sm btn-icon" title="Chi tiết"
                            onClick={() => setDetailJobId(j.id)}>🔍</button>
                        </td>
                      </tr>
                    );
                  }}
                />
              );
            })()}
          </div>
        </div>
      </div>

      {showCreate && (
        <CreateJobModal onClose={() => setShowCreate(false)}
          onCreated={data => createMut.mutateAsync(data)} />
      )}
      {showDeadline && (
        <DeadlineModal
          data={dlData}
          onClose={() => setShowDeadline(false)}
          onReview={(rid, action, dl) => reviewMut.mutate({ rid, action, dl })}
          onSetDeadline={(id, deadline) => setDlMut.mutate({ id, deadline })}
          onReviewDelete={(rid, action) => reviewDeleteMut.mutate({ rid, action })}
        />
      )}
      {assigningJob && (
        <AssignModal job={assigningJob} staff={staff}
          onClose={() => setAssigningJob(null)}
          onSave={data => assignMut.mutate({ id: assigningJob.id, data })} />
      )}
      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {planModalJob && (
        <PlanDeliveryModal
          jobId={planModalJob.jobId} jobCode={planModalJob.jobCode}
          onClose={() => setPlanModalJob(null)} />
      )}
      {showAssignment && (
        <AssignmentModal
          initialTab={showAssignment}
          onClose={() => setShowAssignment(null)}
        />
      )}
      {jobListFilter && (
        <JobListModal
          filterType={typeof jobListFilter === 'string' ? jobListFilter : jobListFilter.filterType}
          staffId={typeof jobListFilter === 'string' ? null : jobListFilter.staffId}
          staffName={typeof jobListFilter === 'string' ? null : jobListFilter.staffName}
          onClose={() => setJobListFilter(null)}
        />
      )}
      {reassignTarget && (
        <ReassignModal
          type={reassignTarget.type}
          taskType={reassignTarget.taskType}
          taskLabel={reassignTarget.taskLabel}
          job={reassignTarget.job}
          onClose={() => setReassignTarget(null)}
        />
      )}
    </div>
  );
}
