import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Navbar from '../components/Navbar';
import JobDetailModal from '../components/JobDetailModal';
import JobListModal from '../components/JobListModal';
import FilteredTable from '../components/FilteredTable';
import DateRangeFilter from '../components/DateRangeFilter';
import StaffSection, { OPS_COLS as STAFF_OPS_COLS } from '../components/StaffSection';
import {
  getJobStats, getJobs, requestJobDelete, updateJobTk,
  markOpsTaskDone, unmarkOpsTaskDone, tickOpsTaskCost, untickOpsTaskCost,
} from '../api';

// Per-task model helpers (2026-05-23). j.ops_tasks is the JSON array of task
// rows returned by GET /api/jobs (see backend ops_tasks projection).
//   thong_quan done = cost_entered_at set (no separate done — tk_status owns it)
//   doi_lenh   done = completed=TRUE AND cost_entered_at set
function getOpsTask(j, taskType) {
  const tasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
  return tasks.find(t => t.task_type === taskType) || null;
}
function hasTqTask(j) { return !!getOpsTask(j, 'thong_quan'); }
function hasDlTask(j) { return !!getOpsTask(j, 'doi_lenh'); }
function isTqDone(j) {
  const t = getOpsTask(j, 'thong_quan');
  return !!t && !!t.cost_entered_at;
}
function isDlDone(j) {
  const t = getOpsTask(j, 'doi_lenh');
  return !!t && t.completed === true && !!t.cost_entered_at;
}

// 2026-05-25 OPS dept-level status helpers.
// Khu 1 (TQ+ĐL — for tk/both HP): column tracks tk_status + cost TQ.
//   chua_truyen → "Chưa truyền tờ khai"           (orange)
//   dang_lam    → "Đang làm tờ khai"              (yellow)
//   terminal && !cost → "Đã thông quan — chưa nhập cost TQ" (warning)
//   terminal &&  cost → "Xong"                    (green)
const TK_TERMINAL_KHU1 = ['thong_quan', 'giai_phong', 'bao_quan'];
function opsStatusKhu1(j) {
  const tq = getOpsTask(j, 'thong_quan');
  const terminal = TK_TERMINAL_KHU1.includes(j.tk_status);
  if (!terminal) {
    if (j.tk_status === 'chua_truyen' || !j.tk_status) {
      return { label: 'Chưa truyền tờ khai', bg: 'rgba(217,119,6,0.12)', fg: '#d97706' };
    }
    if (j.tk_status === 'dang_lam') {
      return { label: 'Đang làm tờ khai', bg: 'rgba(234,179,8,0.14)', fg: '#a16207' };
    }
    return { label: j.tk_status, bg: 'rgba(107,114,128,0.12)', fg: '#6b7280' };
  }
  if (!tq?.cost_entered_at) {
    return { label: 'Đã thông quan — chưa nhập cost TQ', bg: 'rgba(217,119,6,0.12)', fg: '#b45309' };
  }
  return { label: 'Xong', bg: 'rgba(34,197,94,0.15)', fg: '#16a34a' };
}
// Khu 2 (ĐL — for any HP w/ doi_lenh task): column tracks đổi lệnh + cost ĐL.
function opsStatusKhu2(j) {
  const dl = getOpsTask(j, 'doi_lenh');
  if (!dl?.completed) {
    return { label: 'Chưa đổi lệnh', bg: 'rgba(217,119,6,0.12)', fg: '#d97706' };
  }
  if (!dl?.cost_entered_at) {
    return { label: 'Đã đổi lệnh — chưa nhập cost ĐL', bg: 'rgba(217,119,6,0.12)', fg: '#b45309' };
  }
  return { label: 'Xong', bg: 'rgba(34,197,94,0.15)', fg: '#16a34a' };
}
// Done predicates per the spec.
function opsKhu1Done(j) {
  const tq = getOpsTask(j, 'thong_quan');
  return TK_TERMINAL_KHU1.includes(j.tk_status) && !!tq?.cost_entered_at;
}
function opsKhu2Done(j) {
  const dl = getOpsTask(j, 'doi_lenh');
  return !!dl?.completed && !!dl?.cost_entered_at;
}
// For Hoàn thành tab filter: OPS finished their portion across whichever
// task rows the job has. No task rows ⇒ not required ⇒ trivially done.
function opsAllRequiredDone(j) {
  const tqOk = !hasTqTask(j) || opsKhu1Done(j);
  const dlOk = !hasDlTask(j) || opsKhu2Done(j);
  return tqOk && dlOk;
}
function OpsStatusPill({ info }) {
  if (!info) return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>;
  return (
    <span style={{ background: info.bg, color: info.fg,
      borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {info.label}
    </span>
  );
}
function tqDoneAt(j) { return getOpsTask(j, 'thong_quan')?.cost_entered_at || null; }
function dlDoneAt(j) {
  const t = getOpsTask(j, 'doi_lenh');
  return (t?.completed && t?.cost_entered_at) ? t.cost_entered_at : null;
}
// Latest "OPS done" timestamp = max of available task finish times.
function latestOpsDoneAt(j) {
  const stamps = [tqDoneAt(j), dlDoneAt(j)].filter(Boolean).map(s => new Date(s).getTime());
  if (!stamps.length) return null;
  return new Date(Math.max(...stamps));
}

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền', dang_lam: 'Đang làm',
  thong_quan: 'Thông quan', giai_phong: 'Giải phóng', bao_quan: 'Bảo quan',
};
const TK_STATUS_COLOR = {
  chua_truyen: '#6b7280', dang_lam: '#d97706',
  thong_quan: '#22c55e', giai_phong: '#3b82f6', bao_quan: '#7c3aed',
};
const TK_TERMINAL = ['thong_quan', 'giai_phong', 'bao_quan'];
const TK_STATUS_OPTS = [
  { value: 'chua_truyen', label: 'Chưa truyền' }, { value: 'dang_lam', label: 'Đang làm' },
  { value: 'thong_quan', label: 'Thông quan' }, { value: 'giai_phong', label: 'Giải phóng' },
  { value: 'bao_quan', label: 'Bảo quan' },
];

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}
function fmtDt(val) {
  if (!val) return '—';
  return new Date(val).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
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
  if (ms < 24 * 3600 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function StatCard({ label, value, color, onClick }) {
  return (
    <div className="card" onClick={onClick}
      style={{ textAlign: 'center', padding: '16px 12px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || 'var(--text)', fontFamily: 'var(--font-display)' }}>
        {value ?? '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

const TH = ({ children }) => (
  <th style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
    {children}
  </th>
);
const TD = ({ children, style }) => (
  <td style={{ padding: '8px 8px', borderBottom: '1px solid var(--border)', fontSize: 13, ...style }}>{children}</td>
);

// Loại lô badge (Hàng xuất / Hàng nhập). Inline helper so all 5 OPS tables stay consistent.
function IeCell({ value }) {
  const imp = value === 'import';
  return (
    <TD style={{ whiteSpace: 'nowrap' }}>
      <span style={{ background: imp ? 'rgba(217,119,6,0.12)' : 'rgba(34,197,94,0.12)',
        color: imp ? '#d97706' : '#16a34a', borderRadius: 6, padding: '2px 8px',
        fontSize: 11, fontWeight: 600 }}>{imp ? 'Nhập' : 'Xuất'}</span>
    </TD>
  );
}

// Phase 6 Phase B1 — Mobile card shell shared across all 5 OPS tabs.
// Mirrors the DD pilot at LogDashboardDieuDo:L394: job_code (left) + Loại badge
// (right) + Khách line + dashed divider + per-tab `body` + optional action row.
// The action row stops click propagation so action buttons don't double-fire as
// "open detail". Caller passes onOpen so the whole card (outside actions) opens
// JobDetailModal — same UX as desktop double-click.
function OpsCard({ job: j, body, actions, onOpen, codeColor }) {
  const imp = j.import_export === 'import';
  // KT5 — orange chip + left border when KT bounced job back to LOG.
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

const TQ_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'etd_eta',       label: 'ETD / ETA' },
  { key: 'han_lenh',      label: 'Hạn lệnh / Cutoff' },
  { key: 'tk_flow',       label: 'Luồng TK' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  // 2026-05-25: OPS Khu 1 (TQ+ĐL) dept-level status pill.
  { key: 'ops_status',    label: 'Trạng thái' },
  { key: 'tq_datetime',   label: 'Ngày giờ TQ' },
  { key: 'notes',         label: 'Ghi chú' },
];

const DL_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'han_lenh',      label: 'Hạn lệnh / Cutoff' },
  { key: 'ops_task_info', label: 'Cảng / Loại công việc' },
  // 2026-05-25: OPS Khu 2 (ĐL) dept-level status pill.
  { key: 'ops_status',    label: 'Trạng thái' },
];

const TODAY_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'han_lenh',      label: 'Hạn lệnh / Cutoff' },
  { key: 'planned_dt',    label: 'KH giao xe' },
];

const DONE_COLS = [
  { key: 'latest_done_at', label: 'Ngày xong' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont / Loại' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  { key: 'ops_task_info', label: 'Yêu cầu công việc' },
];

const HT_COLS = [
  { key: 'created_at',    label: 'Ngày' },
  { key: 'job_code',      label: 'Job',           filterType: 'text' },
  { key: 'si_number',     label: 'Mã SI',         filterType: 'text' },
  { key: 'import_export', label: 'Loại' },
  { key: 'customer_name', label: 'Khách hàng',    filterType: 'text', accessor: j => j.customer_name || '' },
  { key: 'cargo',         label: 'Cont' },
  { key: 'etd_eta',       label: 'ETD / ETA' },
  { key: 'tk_status',     label: 'Trạng thái TK', filterType: 'select', options: TK_STATUS_OPTS },
  { key: 'tq_datetime',   label: 'Ngày TQ' },
];

export default function LogDashboardOps() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('tq_doi_lenh');
  const [detailJobId, setDetailJobId] = useState(null);
  const [jobListFilter, setJobListFilter] = useState(null);
  const [completedRange, setCompletedRange] = useState({});

  useEffect(() => {
    const onOpen = e => { if (e.detail?.jobId) setDetailJobId(e.detail.jobId); };
    window.addEventListener('open-job-detail', onOpen);
    return () => window.removeEventListener('open-job-detail', onOpen);
  }, []);

  const { data: stats } = useQuery({ queryKey: ['jobStats'], queryFn: getJobStats, refetchInterval: 30000 });
  const { data: pendingJobs = [], isLoading } = useQuery({
    queryKey: ['jobs', 'pending'],
    queryFn: () => getJobs({ tab: 'pending' }),
    refetchInterval: 30000,
  });
  const { data: completedJobs = [] } = useQuery({
    queryKey: ['jobs', 'completed', completedRange],
    queryFn: () => getJobs({ tab: 'completed', ...completedRange }),
    enabled: tab === 'hoan_thanh',
  });

  // Per-task mutations (2026-05-23). All four invalidate the same queries so
  // counts + lists refresh on every tick.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['jobStats'] });
  };
  const tqCostMut = useMutation({
    mutationFn: ({ id, on }) => on ? tickOpsTaskCost(id, 'thong_quan') : untickOpsTaskCost(id, 'thong_quan'),
    onSuccess: invalidate,
  });
  const dlCostMut = useMutation({
    mutationFn: ({ id, on }) => on ? tickOpsTaskCost(id, 'doi_lenh') : untickOpsTaskCost(id, 'doi_lenh'),
    onSuccess: invalidate,
  });
  const dlDoneMut = useMutation({
    mutationFn: ({ id, on }) => on ? markOpsTaskDone(id, 'doi_lenh') : unmarkOpsTaskDone(id, 'doi_lenh'),
    onSuccess: invalidate,
  });
  const anyTickPending = tqCostMut.isPending || dlCostMut.isPending || dlDoneMut.isPending;
  const tkMut = useMutation({
    mutationFn: ({ id, data }) => updateJobTk(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });
  const deleteReqMut = useMutation({
    mutationFn: ({ id, reason }) => requestJobDelete(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['jobStats'] });
    },
  });

  const tomorrow = localDate(new Date(Date.now() + 86400000));
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);

  // Per-task filters (2026-05-23).
  //   tqJobs: HP + (tk/both) + thong_quan task pending (cost not ticked)
  //   dlJobs: HP + ANY service_type + doi_lenh  task pending (done OR cost not ticked)
  //   todayJobs: tomorrow's planned doi_lenh deliveries
  //   doneJobs: jobs where ALL required OPS tasks just finished within 3 days
  const tqJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    (j.service_type === 'tk' || j.service_type === 'both') &&
    hasTqTask(j) && !isTqDone(j)
  );
  const dlJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    hasDlTask(j) && !isDlDone(j)
  );
  const todayJobs = pendingJobs.filter(j =>
    j.destination === 'hai_phong' &&
    (j.service_type === 'truck' || j.service_type === 'both') &&
    j.planned_datetime &&
    localDate(new Date(j.planned_datetime)) === tomorrow
  );
  const doneJobs = pendingJobs.filter(j => {
    // For each task type the job needs, the task must be done AND its finish
    // timestamp must be within the last 3 days. If the job needs both tasks,
    // require both finished; recency uses the most recent finish.
    const needsTq = hasTqTask(j);
    const needsDl = hasDlTask(j);
    if (!needsTq && !needsDl) return false;
    const tqOk = !needsTq || isTqDone(j);
    const dlOk = !needsDl || isDlDone(j);
    if (!tqOk || !dlOk) return false;
    const finishes = [tqDoneAt(j), dlDoneAt(j)].filter(Boolean).map(s => new Date(s));
    if (!finishes.length) return false;
    const latest = new Date(Math.max(...finishes.map(d => d.getTime())));
    return latest >= threeDaysAgo;
  });

  function rowBg(j) {
    // KT5 — KT-returned-to-log overrides tk_flow + deadline tints.
    if (j.returned_to === 'log') return 'rgba(249,115,22,0.10)';
    if (j.tk_flow === 'xanh') return 'rgba(34,197,94,0.06)';
    if (j.tk_flow === 'vang') return 'rgba(217,119,6,0.06)';
    if (j.tk_flow === 'do') return 'rgba(239,68,68,0.06)';
    if (!j.deadline) return '';
    const ms = new Date(j.deadline) - Date.now();
    if (ms < 0) return 'rgba(239,68,68,0.04)';
    if (ms < 24 * 3600 * 1000) return 'rgba(217,119,6,0.04)';
    return '';
  }

  // tk_status precondition (per-task ticks require terminal when job has TK).
  // Mirrors the backend guard in PATCH /ops-task/:type/{done,cost}.
  function tkPreconditionOk(j) {
    const hasTk = j.service_type === 'tk' || j.service_type === 'both';
    return !hasTk || TK_TERMINAL.includes(j.tk_status);
  }
  function tkPreconditionHint(j) {
    return tkPreconditionOk(j) ? null : 'TK chưa thông quan / giải phóng / bảo quan';
  }

  // Per-task tick buttons (2026-05-23, replaces single opsDoneBtn).
  //   thong_quan tab → one "Cost thông quan" toggle
  //   doi_lenh   tab → two toggles: "Đổi lệnh xong" + "Cost đổi lệnh"
  // Each button shows the ticked state inline; clicking a ticked one un-ticks.
  // Disabled when tk_status precondition fails.
  function TickButton({ label, ticked, disabled, hint, onClick }) {
    return (
      <button
        className={`btn ${ticked ? 'btn-ghost' : 'btn-primary'} btn-sm`}
        style={{ padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap',
          ...(ticked ? { color: 'var(--primary)', borderColor: 'var(--primary)' } : {}) }}
        disabled={disabled}
        title={hint || (ticked ? 'Bỏ tick' : label)}
        onClick={e => { e.stopPropagation(); onClick(); }}
      >
        {ticked ? '✓ ' : ''}{label}
      </button>
    );
  }

  function tqCostBtn(j) {
    const t = getOpsTask(j, 'thong_quan');
    if (!t) return null;
    const ticked = !!t.cost_entered_at;
    const ok = tkPreconditionOk(j);
    return (
      <TickButton
        label="Cost thông quan"
        ticked={ticked}
        disabled={(!ok && !ticked) || anyTickPending}
        hint={!ok && !ticked ? tkPreconditionHint(j) : null}
        onClick={() => tqCostMut.mutate({ id: j.id, on: !ticked })}
      />
    );
  }
  function dlDoneBtn(j) {
    const t = getOpsTask(j, 'doi_lenh');
    if (!t) return null;
    const ticked = t.completed === true;
    const ok = tkPreconditionOk(j);
    return (
      <TickButton
        label="Đổi lệnh xong"
        ticked={ticked}
        disabled={(!ok && !ticked) || anyTickPending}
        hint={!ok && !ticked ? tkPreconditionHint(j) : null}
        onClick={() => dlDoneMut.mutate({ id: j.id, on: !ticked })}
      />
    );
  }
  function dlCostBtn(j) {
    const t = getOpsTask(j, 'doi_lenh');
    if (!t) return null;
    const ticked = !!t.cost_entered_at;
    const ok = tkPreconditionOk(j);
    return (
      <TickButton
        label="Cost đổi lệnh"
        ticked={ticked}
        disabled={(!ok && !ticked) || anyTickPending}
        hint={!ok && !ticked ? tkPreconditionHint(j) : null}
        onClick={() => dlCostMut.mutate({ id: j.id, on: !ticked })}
      />
    );
  }

  function opsTaskInfo(j) {
    const tasks = Array.isArray(j.ops_tasks) ? j.ops_tasks : [];
    if (!tasks.length) return <span style={{ color: 'var(--text-3)' }}>—</span>;
    return tasks.map(t => {
      const label = t.task_type === 'thong_quan' ? 'Thông quan'
                  : t.task_type === 'doi_lenh'   ? 'Đổi lệnh'
                  : t.task_type === 'thong_quan_doi_lenh' ? 'TQ + đổi lệnh (legacy)'
                  : t.task_type || '';
      return (
        <div key={t.id} style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {t.port && <span style={{ fontWeight: 600 }}>{t.port}</span>}
          {label && <span style={{ marginLeft: 4, color: 'var(--info)' }}>[{label}]</span>}
          {t.content && <span style={{ marginLeft: 4 }}>{t.content}</span>}
        </div>
      );
    });
  }

  function deleteBtn(j) {
    return (
      <button className="btn btn-ghost btn-sm btn-icon" title="Yêu cầu xóa job" style={{ color: 'var(--danger)' }}
        onClick={e => { e.stopPropagation(); if (window.confirm(`Gửi yêu cầu xóa job ${j.job_code || '#' + j.id}?`)) deleteReqMut.mutate({ id: j.id, reason: null }); }}>🗑</button>
    );
  }

  function Badge({ n, color }) {
    if (!n) return null;
    return <span style={{ marginLeft: 4, background: color, color: '#fff', borderRadius: 10, padding: '1px 6px', fontSize: 10 }}>{n}</span>;
  }

  return (
    <div className="page">
      <Navbar />
      <div className="container" style={{ padding: '24px 20px' }}>
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 20, margin: 0 }}>Dashboard OPS</h2>
        </div>

        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <StatCard label="Tổng job đang quản lý" value={stats?.total_managing} color="var(--info)" onClick={() => setJobListFilter('ops_total')} />
          <StatCard label="Chờ TQ đổi lệnh" value={stats?.cho_tq_doi_lenh} color="var(--purple)" onClick={() => setJobListFilter('ops_waiting_tq_doilenh')} />
          <StatCard label="Chờ đổi lệnh" value={stats?.cho_doi_lenh} color="var(--warning)" onClick={() => setJobListFilter('ops_waiting_doilenh')} />
          <StatCard label="Sắp hạn (24h)" value={stats?.sap_han} color="var(--warning)" onClick={() => setJobListFilter('ops_near_deadline')} />
          <StatCard label="Quá hạn" value={stats?.qua_han} color="var(--danger)" onClick={() => setJobListFilter('ops_overdue')} />
        </div>

        {/* Staff section — 1 row for current user */}
        <StaffSection
          title="Tình hình OPS"
          rows={stats?.ops_stats || []}
          columns={STAFF_OPS_COLS}
          onCellClick={(s, key) => setJobListFilter({ filterType: key, staffId: s.id, staffName: s.name })}
        />

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div className="tabs" style={{ marginBottom: 0 }}>
              <button className={`tab ${tab === 'tq_doi_lenh' ? 'active' : ''}`} onClick={() => setTab('tq_doi_lenh')}>
                Thông quan đổi lệnh<Badge n={tqJobs.length} color="var(--purple)" />
              </button>
              <button className={`tab ${tab === 'doi_lenh' ? 'active' : ''}`} onClick={() => setTab('doi_lenh')}>
                Đổi lệnh<Badge n={dlJobs.length} color="var(--warning)" />
              </button>
              <button className={`tab ${tab === 'phai_doi_lenh' ? 'active' : ''}`} onClick={() => setTab('phai_doi_lenh')}>
                Phải đổi lệnh hôm nay<Badge n={todayJobs.length} color="var(--danger)" />
              </button>
              <button className={`tab ${tab === 'xong_viec' ? 'active' : ''}`} onClick={() => setTab('xong_viec')}>Xong việc (3 ngày)</button>
              <button className={`tab ${tab === 'hoan_thanh' ? 'active' : ''}`} onClick={() => setTab('hoan_thanh')}>Hoàn thành</button>
            </div>
            {tab === 'hoan_thanh' && (
              <div style={{ paddingBottom: 4 }}>
                <DateRangeFilter onChange={setCompletedRange} />
              </div>
            )}
          </div>

          <div style={{ overflowX: 'auto' }}>
            {isLoading && tab !== 'hoan_thanh' ? (
              <div style={{ padding: 40, textAlign: 'center' }}><span className="spinner" /></div>
            ) : tab === 'tq_doi_lenh' ? (
              <FilteredTable
                columns={TQ_COLS}
                data={tqJobs}
                renderMobileCard={(j) => (
                  <OpsCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)}
                    body={
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8, fontSize: 12 }}>
                          <span><span style={{ color: 'var(--text-2)' }}>Luồng:</span> {j.tk_flow || '—'}</span>
                          <span><span style={{ color: 'var(--text-2)' }}>Ngày TQ:</span> {fmtDt(j.tq_datetime)}</span>
                        </div>
                        <div onClick={e => e.stopPropagation()}>
                          <label style={{ fontSize: 11, color: 'var(--text-2)', display: 'block', marginBottom: 4 }}>Trạng thái TK</label>
                          <select value={j.tk_status || 'chua_truyen'}
                            style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', background: 'transparent', width: '100%' }}
                            onChange={e => tkMut.mutate({ id: j.id, data: { tk_status: e.target.value } })}>
                            {TK_STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                        {/* 2026-05-25: OPS Khu 1 status pill (mobile). */}
                        <div style={{ marginTop: 8, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-2)', marginRight: 6 }}>Trạng thái OPS:</span>
                          <OpsStatusPill info={opsStatusKhu1(j)} />
                        </div>
                        {j.tk_notes && (
                          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6, padding: '6px 8px', background: 'var(--bg)', borderRadius: 6 }}>
                            {j.tk_notes}
                          </div>
                        )}
                      </>
                    }
                    actions={<>
                      {tqCostBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </>}
                  />
                )}
                emptyText="Không có job nào"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: rowBg(j), cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
                      {j.returned_to === 'log' && (
                        <span style={{ marginRight: 4, cursor: 'help' }}
                          title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                      )}
                      {j.job_code || `#${j.id}`}
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <IeCell value={j.import_export} />
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)}<br />{fmtDate(j.eta)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.han_lenh) }}>{j.han_lenh ? (j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)) : '—'}</TD>
                    <TD style={{ color: 'var(--text-2)' }}>{j.tk_flow || '—'}</TD>
                    <TD>
                      <select
                        value={j.tk_status || 'chua_truyen'}
                        style={{ fontSize: 12, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border)', color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', background: 'transparent', cursor: 'pointer' }}
                        onClick={e => e.stopPropagation()}
                        onChange={e => tkMut.mutate({ id: j.id, data: { tk_status: e.target.value } })}
                      >
                        {TK_STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </TD>
                    {/* 2026-05-25: OPS Khu 1 Trạng thái pill. */}
                    <TD><OpsStatusPill info={opsStatusKhu1(j)} /></TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                    <TD style={{ color: 'var(--text-2)', maxWidth: 160, fontSize: 12 }}>{j.tk_notes || '—'}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      {tqCostBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'doi_lenh' ? (
              <FilteredTable
                columns={DL_COLS}
                data={dlJobs}
                renderMobileCard={(j) => (
                  <OpsCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)}
                    body={
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
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
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          <div style={{ color: 'var(--text-2)', marginBottom: 2 }}>Cảng / Loại công việc:</div>
                          {opsTaskInfo(j)}
                        </div>
                        {/* 2026-05-25: OPS Khu 2 status pill (mobile). */}
                        <div style={{ marginTop: 8, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-2)', marginRight: 6 }}>Trạng thái OPS:</span>
                          <OpsStatusPill info={opsStatusKhu2(j)} />
                        </div>
                      </>
                    }
                    actions={<>
                      {dlDoneBtn(j)}
                      {dlCostBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </>}
                  />
                )}
                emptyText="Không có job nào"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: rowBg(j), cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
                      {j.returned_to === 'log' && (
                        <span style={{ marginRight: 4, cursor: 'help' }}
                          title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                      )}
                      {j.job_code || `#${j.id}`}
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <IeCell value={j.import_export} />
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.han_lenh) }}>{j.han_lenh ? (j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)) : '—'}</TD>
                    <TD>{opsTaskInfo(j)}</TD>
                    {/* 2026-05-25: OPS Khu 2 Trạng thái pill. */}
                    <TD><OpsStatusPill info={opsStatusKhu2(j)} /></TD>
                    <TD style={{ whiteSpace: 'nowrap', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {dlDoneBtn(j)}
                      {dlCostBtn(j)}
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'phai_doi_lenh' ? (
              <FilteredTable
                columns={TODAY_COLS}
                data={todayJobs}
                renderMobileCard={(j) => (
                  <OpsCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)}
                    body={
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                          <span style={{ color: 'var(--text-2)' }}>Hàng hóa:</span> {fmtCargo(j)}
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 8 }}>
                          <span style={{ color: 'var(--text-2)' }}>Hạn lệnh / Cutoff:</span>{' '}
                          <span style={deadlineStyle(j.han_lenh)}>
                            {j.han_lenh ? (j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)) : '—'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, padding: '6px 10px', background: 'rgba(217,119,6,0.10)', borderRadius: 6, color: 'var(--warning)', fontWeight: 600 }}>
                          KH giao xe: {fmtDt(j.planned_datetime)}
                        </div>
                      </>
                    }
                    actions={<>
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </>}
                  />
                )}
                emptyText="Không có job nào cần đổi lệnh hôm nay"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ background: 'rgba(239,68,68,0.04)', cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
                      {j.returned_to === 'log' && (
                        <span style={{ marginRight: 4, cursor: 'help' }}
                          title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                      )}
                      {j.job_code || `#${j.id}`}
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <IeCell value={j.import_export} />
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap', ...deadlineStyle(j.han_lenh) }}>{j.han_lenh ? (j.import_export === 'import' ? fmtDate(j.han_lenh) : fmtDt(j.han_lenh)) : '—'}</TD>
                    <TD style={{ whiteSpace: 'nowrap', color: 'var(--warning)', fontWeight: 600 }}>{fmtDt(j.planned_datetime)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      {deleteBtn(j)}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : tab === 'xong_viec' ? (
              <FilteredTable
                columns={DONE_COLS}
                data={doneJobs}
                renderMobileCard={(j) => (
                  <OpsCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)} codeColor="var(--primary)"
                    body={
                      <>
                        <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--primary)', fontWeight: 600 }}>
                          ✓ Xong: {fmtDt(latestOpsDoneAt(j))}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>Hàng:</span> {fmtCargo(j)}</div>
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                          <span style={{ color: 'var(--text-2)' }}>Trạng thái TK:</span>{' '}
                          <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500 }}>
                            {TK_STATUS_LABEL[j.tk_status] || '—'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>
                          <div style={{ color: 'var(--text-2)', marginBottom: 2 }}>Yêu cầu công việc:</div>
                          {opsTaskInfo(j)}
                        </div>
                      </>
                    }
                    actions={<>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </>}
                  />
                )}
                emptyText="Không có job nào xong việc trong 3 ngày"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--primary)' }}>{fmtDt(latestOpsDoneAt(j))}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
                      {j.returned_to === 'log' && (
                        <span style={{ marginRight: 4, cursor: 'help' }}
                          title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                      )}
                      {j.job_code || `#${j.id}`}
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <IeCell value={j.import_export} />
                    <TD style={{ maxWidth: 140 }}>{j.customer_name}</TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD>
                      <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                        {TK_STATUS_LABEL[j.tk_status] || '—'}
                      </span>
                    </TD>
                    <TD>{opsTaskInfo(j)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            ) : (
              <FilteredTable
                columns={HT_COLS}
                /* 2026-05-25 OPS-split: Hoàn thành chỉ hiện job HP + OPS xong phần mình.
                   Khu TQ+ĐL xong = opsKhu1Done (tk terminal + cost TQ).
                   Khu ĐL xong   = opsKhu2Done (đổi lệnh + cost ĐL).
                   Jobs without OPS task rows (non-OPS-assigned) are excluded by the
                   hasTqTask/hasDlTask gates inside opsAllRequiredDone. */
                data={completedJobs.filter(j => j.destination === 'hai_phong' && (hasTqTask(j) || hasDlTask(j)) && opsAllRequiredDone(j))}
                renderMobileCard={(j) => (
                  <OpsCard key={j.id} job={j} onOpen={() => setDetailJobId(j.id)} codeColor="var(--primary)"
                    body={
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>Ngày:</span> {fmtDate(j.created_at)}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>Mã SI:</span> {j.si_number || '—'}</div>
                        </div>
                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                          <span style={{ color: 'var(--text-2)' }}>Hàng hóa:</span> {fmtCargo(j)}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 6, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-2)' }}>ETD:</span> {fmtDate(j.etd)}</div>
                          <div><span style={{ color: 'var(--text-2)' }}>ETA:</span> {fmtDate(j.eta)}</div>
                        </div>
                        <div style={{ fontSize: 12 }}>
                          <span style={{ color: 'var(--text-2)' }}>TK:</span>{' '}
                          <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500 }}>
                            {TK_STATUS_LABEL[j.tk_status] || '—'}
                          </span>
                          <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>· TQ: {fmtDt(j.tq_datetime)}</span>
                        </div>
                      </>
                    }
                    actions={<>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </>}
                  />
                )}
                emptyText="Không có job hoàn thành"
                extraHeaderCells={<TH />}
                tableStyle={{ fontSize: 13 }}
                renderRow={j => (
                  <tr key={j.id} style={{ cursor: 'pointer' }} onDoubleClick={() => setDetailJobId(j.id)}>
                    <TD style={{ fontSize: 12 }}>{fmtDate(j.created_at)}</TD>
                    <TD style={{ fontWeight: 600, color: 'var(--primary)' }}>
                      {j.returned_to === 'log' && (
                        <span style={{ marginRight: 4, cursor: 'help' }}
                          title={`🟠 KT trả về\nLý do: ${j.returned_reason || '(không có)'}`}>🟠</span>
                      )}
                      {j.job_code || `#${j.id}`}
                    </TD>
                    <TD style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text-2)' }}>{j.si_number || '—'}</TD>
                    <IeCell value={j.import_export} />
                    <TD>{j.customer_name}</TD>
                    <TD style={{ fontSize: 12 }}>{fmtCargo(j)}</TD>
                    <TD style={{ color: 'var(--text-2)', fontSize: 12 }}>{fmtDate(j.etd)} / {fmtDate(j.eta)}</TD>
                    <TD>
                      <span style={{ color: TK_STATUS_COLOR[j.tk_status] || 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>
                        {TK_STATUS_LABEL[j.tk_status] || '—'}
                      </span>
                    </TD>
                    <TD style={{ fontSize: 12 }}>{fmtDt(j.tq_datetime)}</TD>
                    <TD style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={e => { e.stopPropagation(); setDetailJobId(j.id); }}>🔍</button>
                    </TD>
                  </tr>
                )}
              />
            )}
          </div>
        </div>
      </div>

      {detailJobId && <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />}
      {jobListFilter && (
        <JobListModal
          filterType={typeof jobListFilter === 'string' ? jobListFilter : jobListFilter.filterType}
          staffId={typeof jobListFilter === 'string' ? null : jobListFilter.staffId}
          staffName={typeof jobListFilter === 'string' ? null : jobListFilter.staffName}
          onClose={() => setJobListFilter(null)}
        />
      )}
    </div>
  );
}
