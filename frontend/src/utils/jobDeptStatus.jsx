// Per-department job status — SINGLE source of truth shared by the TP dashboard
// ("Trạng thái" column + Đang làm/Hoàn thành tab partition) and the Sales
// "Quản lý công việc" pending table. Extracted verbatim from LogDashboardTP
// (formerly tpStatusLines / TpStatusCell) so the two screens can never drift (L30).
// Depends on the shared ddPillInfo util for the DD line.
import { ddPillInfo } from './truckBookingStatus';

// deptStatusLines: returns an array of pending-dept status strings for this job.
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
export const TK_TERMINAL = ['thong_quan', 'giai_phong', 'bao_quan'];
export function deptStatusLines(j) {
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
    const terminal = TK_TERMINAL.includes(j.tk_status);
    if (hasTk) {
      // Skip-thông-quan (2026-07-20): only emit thong_quan lines when a
      // thong_quan task actually EXISTS. A Hải Phòng tk/both job with the task
      // skipped (PATH A manual / PATH B luồng=xanh) has no tq row → fall straight
      // through to the đổi lệnh checks (mirrors the P1 dl-presence guard) so it
      // never shows a phantom "Chưa thông quan" and can reach "Hoàn thành" on
      // đổi lệnh alone (or "Hoàn thành" outright for a tk-only skipped job).
      if (tq && !terminal) {
        lines.push('OPS: Chưa thông quan');
      } else if (tq && !tq.cost_entered_at) {
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
export function DeptStatusCell({ job }) {
  const lines = deptStatusLines(job);
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
