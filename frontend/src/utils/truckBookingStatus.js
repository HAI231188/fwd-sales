// Truck-booking status enum maps — shared between BookingModal + dashboards.
// Keys mirror the strings returned by the plpgsql function get_truck_booking_status()
// in schema.sql. Do NOT add new keys here without also extending the function.
// See L19 (single-source-of-truth derived status) and L20 (booking pattern).
//
// Phase 5 CP4.5 — expanded to 8 detailed states. The completion signal moved
// from "all vehicles assigned" (was 'da_giao_xong') to "all bookings have
// actual_datetime" ('hoan_thanh'). 'du_xe_cho_giao' is the new pre-completion
// state ("trucks dispatched, awaiting delivery confirmation").

export const TRUCK_BOOKING_STATUS_LABELS = {
  chua_dat_kh:          'Chưa đặt KH',
  dat_kh_1_phan:        'Đặt KH 1 phần',
  du_kh_chua_chot_vt:   'Đủ KH, chưa chốt VT',
  du_kh_chot_vt_1_phan: 'Đủ KH, chốt VT 1 phần',
  du_vt_chua_co_xe:     'Đủ VT, chưa có xe',
  du_vt_co_xe_1_phan:   'Đủ VT, có xe 1 phần',
  du_xe_cho_giao:       'Đủ số xe, chờ giao',
  hoan_thanh:           'Hoàn thành',
};

// Maps each status to a CSS color name. Resolved to design-token values via
// truckBookingPillStyle().
export const TRUCK_BOOKING_STATUS_COLORS = {
  chua_dat_kh:          'orange',
  dat_kh_1_phan:        'yellow',
  du_kh_chua_chot_vt:   'light-blue',
  du_kh_chot_vt_1_phan: 'light-blue',
  du_vt_chua_co_xe:     'purple',
  du_vt_co_xe_1_phan:   'purple',
  du_xe_cho_giao:       'purple-dark',
  hoan_thanh:           'green',
};

const PILL_COLOR_TOKENS = {
  gray:          { bg: 'rgba(107,114,128,0.12)', fg: '#6b7280' },
  red:           { bg: 'rgba(239,68,68,0.12)',   fg: '#ef4444' },
  orange:        { bg: 'rgba(217,119,6,0.12)',   fg: '#d97706' },
  yellow:        { bg: 'rgba(234,179,8,0.14)',   fg: '#a16207' },
  blue:          { bg: 'rgba(59,130,246,0.12)',  fg: '#3b82f6' },
  'light-blue':  { bg: 'rgba(56,189,248,0.14)',  fg: '#0284c7' },
  purple:        { bg: 'rgba(124,58,237,0.12)',  fg: '#7c3aed' },
  'purple-dark': { bg: 'rgba(76,29,149,0.16)',   fg: '#4c1d95' },
  green:         { bg: 'rgba(34,197,94,0.12)',   fg: '#16a34a' },
};

export function truckBookingPillStyle(status) {
  const color = TRUCK_BOOKING_STATUS_COLORS[status] || 'gray';
  const tok = PILL_COLOR_TOKENS[color] || PILL_COLOR_TOKENS.gray;
  return {
    background: tok.bg, color: tok.fg,
    padding: '2px 8px', borderRadius: 6,
    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  };
}

// Sort priority — most-urgent first. Used to sort the "Quản lý đặt xe" table.
// hoan_thanh sinks to the bottom since completed jobs don't need DD action.
export const TRUCK_BOOKING_STATUS_SORT_RANK = {
  chua_dat_kh:          1,
  dat_kh_1_phan:        2,
  du_kh_chua_chot_vt:   3,
  du_kh_chot_vt_1_phan: 4,
  du_vt_chua_co_xe:     5,
  du_vt_co_xe_1_phan:   6,
  du_xe_cho_giao:       7,
  hoan_thanh:           8,
};

// Statuses to surface in the "Quản lý đặt xe" management table — every
// non-completed status. 'hoan_thanh' jobs auto-flip to status='completed'
// and drop off the pending tab anyway, but the explicit exclusion keeps
// this list honest if that auto-complete ever lags behind.
export const TRUCK_BOOKING_ACTIVE_STATUSES = [
  'chua_dat_kh',
  'dat_kh_1_phan',
  'du_kh_chua_chot_vt',
  'du_kh_chot_vt_1_phan',
  'du_vt_chua_co_xe',
  'du_vt_co_xe_1_phan',
  'du_xe_cho_giao',
];
