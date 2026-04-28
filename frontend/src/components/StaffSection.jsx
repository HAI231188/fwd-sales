// Shared staff section table — used by TP/CUS/DieuDo/OPS dashboards.
// TP shows all staff in a role; CUS/DieuDo/OPS show only the current user.
// Each non-zero count cell is clickable → opens JobListModal scoped by staff_id.

export const CUS_COLS = [
  { key: 'pending_tk',       label: 'Job pending TK',     filter: 'staff_cus_pending_tk',       color: 'var(--info)'    },
  { key: 'awaiting_confirm', label: 'Job chờ xác nhận',   filter: 'staff_cus_awaiting_confirm', color: 'var(--warning)' },
  { key: 'chua_truyen',      label: 'Chưa truyền TK',     filter: 'staff_cus_chua_truyen',      color: '#6b7280'        },
  { key: 'dang_tq',          label: 'Đang chờ thông quan',filter: 'staff_cus_dang_tq',          color: '#d97706'        },
  { key: 'overdue',          label: 'Quá deadline',       filter: 'staff_cus_overdue',          color: 'var(--danger)'  },
  { key: 'near_deadline',    label: 'Sắp hạn (24h)',      filter: 'staff_cus_near_deadline',    color: 'var(--warning)' },
  { key: 'missing_info',     label: 'Thiếu thông tin',    filter: 'staff_cus_missing_info',     color: 'var(--purple)'  },
];

export const DD_COLS = [
  { key: 'pending_dd',       label: 'Job pending Điều Độ',     filter: 'staff_dd_pending',          color: 'var(--info)'    },
  { key: 'no_plan',          label: 'Chưa có kế hoạch',        filter: 'staff_dd_no_plan',          color: 'var(--warning)' },
  { key: 'has_plan',         label: 'Đã có kế hoạch',          filter: 'staff_dd_has_plan',         color: 'var(--primary)' },
  { key: 'booked',           label: 'Đã đặt xe',               filter: 'staff_dd_booked',           color: 'var(--info)'    },
  { key: 'plan_no_truck',    label: 'Đã có KH chưa đặt xe',    filter: 'staff_dd_plan_no_truck',    color: 'var(--warning)' },
  { key: 'urgent_no_truck',  label: 'Sắp giao chưa đặt xe',    filter: 'staff_dd_urgent_no_truck',  color: 'var(--danger)'  },
  { key: 'overdue_delivery', label: 'Giao rồi chưa hoàn thành',filter: 'staff_dd_overdue_delivery', color: 'var(--danger)'  },
];

export const OPS_COLS = [
  { key: 'managing',      label: 'Job quản lý',          filter: 'staff_ops_managing',      color: 'var(--info)'   },
  { key: 'tq_doi_lenh',   label: 'Chờ TQ + đổi lệnh',    filter: 'staff_ops_tq_doi_lenh',   color: '#d97706'       },
  { key: 'doi_lenh',      label: 'Chờ đổi lệnh',         filter: 'staff_ops_doi_lenh',      color: 'var(--purple)' },
  { key: 'near_deadline', label: 'Sắp quá deadline TQ', filter: 'staff_ops_near_deadline', color: 'var(--danger)' },
];

export default function StaffSection({ title, rows, columns, onCellClick }) {
  return (
    <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 14 }}>
        {title}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap' }}>Nhân viên</th>
              {columns.map(c => (
                <th key={c.key} style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>Không có nhân viên</td></tr>
            ) : rows.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="avatar avatar-sm" style={{ background: s.avatar_color || '#6b7280' }}>{s.code}</div>
                    <span style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{s.name}</span>
                  </div>
                </td>
                {columns.map(c => {
                  const n = Number(s[c.key]) || 0;
                  const clickable = n > 0;
                  return (
                    <td key={c.key} style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <span
                        onClick={clickable ? () => onCellClick(s, c.filter) : undefined}
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          fontFamily: 'var(--font-display)',
                          color: clickable ? c.color : 'var(--text-3)',
                          cursor: clickable ? 'pointer' : 'default',
                          textDecoration: clickable ? 'underline' : 'none',
                          textDecorationStyle: 'dotted',
                          textUnderlineOffset: 3,
                        }}
                      >
                        {n}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
