// Truck-booking status enum maps — shared between BookingModal + dashboard.
// Keys mirror the strings returned by the plpgsql function get_truck_booking_status()
// in schema.sql. Do NOT add new keys here without also extending the function.
// See L19 (single-source-of-truth derived status) and L20 (booking pattern).

export const TRUCK_BOOKING_STATUS_LABELS = {
  no_containers:           'Chưa có cont',
  chua_dat_xe:             'Chưa đặt xe',
  dat_xe_1_phan:           'Đặt xe 1 phần',
  da_dat_xe_du_cho_so_xe:  'Đã đặt xe đủ, chờ số xe',
  da_giao_xong:            'Đã giao xong',
};

// Maps each status to a CSS color name. Resolved to design-token values via
// truckBookingPillStyle().
export const TRUCK_BOOKING_STATUS_COLORS = {
  no_containers:           'gray',
  chua_dat_xe:             'red',
  dat_xe_1_phan:           'orange',
  da_dat_xe_du_cho_so_xe:  'blue',
  da_giao_xong:            'green',
};

const PILL_COLOR_TOKENS = {
  gray:   { bg: 'rgba(107,114,128,0.12)', fg: '#6b7280' },
  red:    { bg: 'rgba(239,68,68,0.12)',   fg: '#ef4444' },
  orange: { bg: 'rgba(217,119,6,0.12)',   fg: '#d97706' },
  blue:   { bg: 'rgba(59,130,246,0.12)',  fg: '#3b82f6' },
  green:  { bg: 'rgba(34,197,94,0.12)',   fg: '#16a34a' },
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
export const TRUCK_BOOKING_STATUS_SORT_RANK = {
  chua_dat_xe:             1,
  dat_xe_1_phan:           2,
  da_dat_xe_du_cho_so_xe:  3,
  da_giao_xong:            4,
  no_containers:           5,
};

// Statuses to surface in the "Quản lý đặt xe" management table. The other
// two states (done, no-containers) intentionally drop off because they don't
// need DD intervention.
export const TRUCK_BOOKING_ACTIVE_STATUSES = [
  'chua_dat_xe',
  'dat_xe_1_phan',
  'da_dat_xe_du_cho_so_xe',
];
