import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('fwd_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('fwd_token');
      localStorage.removeItem('fwd_user');
      window.location.href = '/login';
    }
    return Promise.reject(err.response?.data || err);
  }
);

// Auth
export const login = (username, password) => api.post('/auth/login', { username, password });
export const getMe = () => api.get('/auth/me');
export const changePassword = (currentPassword, newPassword) =>
  api.post('/auth/change-password', { currentPassword, newPassword });

// Reports
export const getReports = (params) => api.get('/reports', { params });
export const getReport = (id) => api.get(`/reports/${id}`);
export const createReport = (data) => api.post('/reports', data);
export const updateReport = (id, data) => api.put(`/reports/${id}`, data);
export const deleteReport = (id) => api.delete(`/reports/${id}`);
export const quickAddCustomer = (data) => api.post('/reports/quick-customer', data);

// Customers
export const getCustomers = (params) => api.get('/customers', { params });
export const updateCustomer = (id, data) => api.put(`/customers/${id}`, data);
export const getCustomerJobs = (pipelineId, from, to) =>
  api.get(`/customers/${pipelineId}/jobs`, { params: { from, to } });

// Quotes
export const createQuote = (data) => api.post('/quotes', data);
export const updateQuote = (id, data) => api.put(`/quotes/${id}`, data);
export const deleteQuote = (id) => api.delete(`/quotes/${id}`);

// Stats
export const getStats = (params) => api.get('/stats', { params });
export const getDrilldown = (type, params) => api.get(`/stats/drilldown/${type}`, { params });

// Pipeline
export const getPipeline = (params = {}) => api.get('/pipeline', { params });
export const getLeadPipeline = (params) => api.get('/pipeline/lead-all', { params });
export const searchPipeline = (q) => api.get('/pipeline/search', { params: q ? { q } : {} });
export const updatePipelineStage = (id, stage) => api.put(`/pipeline/${id}`, { stage });
export const requestPipelineDelete = (id) => api.post(`/pipeline/${id}/request-delete`);
export const getDeleteRequests = () => api.get('/pipeline/delete-requests');
export const approvePipelineDelete = (requestId) => api.post(`/pipeline/delete-requests/${requestId}/approve`);
export const rejectPipelineDelete = (requestId) => api.post(`/pipeline/delete-requests/${requestId}/reject`);
export const getPipelineHistory = (id) => api.get(`/pipeline/${id}/history`);
export const getPipelineDetail = (id) => api.get(`/pipeline/${id}/detail`);
export const updatePipelineInfo = (id, data) => api.put(`/pipeline/${id}/info`, data);
export const addInteractionUpdate = (customerId, data) => api.post(`/pipeline/customers/${customerId}/updates`, data);
export const markUpdateComplete = (updateId, completionNote) => api.patch(`/pipeline/customers/updates/${updateId}/complete`, { completion_note: completionNote });
export const undoUpdateComplete = (updateId) => api.patch(`/pipeline/customers/updates/${updateId}/uncomplete`, {});
export const markCustomerFollowUpComplete = (customerId, completed, resultNote) => api.patch(`/pipeline/customers/${customerId}/follow-up-complete`, { completed, result_note: resultNote });

// LOG — Jobs
export const getJobStats = () => api.get('/jobs/stats');
export const getJobs = (params) => api.get('/jobs', { params });
export const createJob = (data) => api.post('/jobs', data);
// M4 — Sales revenue-tick: mark a LOG-completed job as "đã nhập thu" / un-mark.
export const tickJobRevenue   = (id) => api.patch(`/jobs/${id}/revenue-tick`);
export const untickJobRevenue = (id) => api.delete(`/jobs/${id}/revenue-tick`);

// 2026-05-21 — CUS "Nhập cost" tick on job_tk. Independent of tk_status order.
// PATCH stamps + triggers checkAndCompleteJob; DELETE un-ticks (does NOT auto-uncomplete).
export const tickJobTkCost   = (id) => api.patch(`/jobs/${id}/tk-cost-tick`);
export const untickJobTkCost = (id) => api.delete(`/jobs/${id}/tk-cost-tick`);

// KT3 — Accounting dashboard data (role 'ke_toan' only — backend enforces).
export const getAccountingStats = () => api.get('/accounting/stats');
export const getAccountingJobs  = (params) => api.get('/accounting/jobs', { params });

// KT5 — 5 KT mutation endpoints. Backend lives in routes/accounting.js
// (jobActionsRouter), mounted at /api/jobs. PATCH for the 3 lifecycle
// transitions; POST for the 2 return-back paths (set returned_to +
// returned_reason on the job rather than transitioning a status).
export const accountingCheck           = (id)         => api.patch(`/jobs/${id}/accounting-check`);
export const accountingDebitSent       = (id, sentAt) => api.patch(`/jobs/${id}/debit-sent`,       { sent_at: sentAt });
export const accountingPaymentReceived = (id, recvAt) => api.patch(`/jobs/${id}/payment-received`, { received_at: recvAt });
export const accountingReturnToLog     = (id, reason) => api.post (`/jobs/${id}/return-to-log`,    { reason });
export const accountingReturnToSales   = (id, reason) => api.post (`/jobs/${id}/return-to-sales`,  { reason });
export const getJob = (id) => api.get(`/jobs/${id}`);
export const updateJob = (id, data) => api.put(`/jobs/${id}`, data);
export const assignJob = (id, data) => api.post(`/jobs/${id}/assign`, data);
export const confirmJob = (id) => api.patch(`/jobs/${id}/confirm`, {});
export const requestDeadline = (id, data) => api.patch(`/jobs/${id}/request-deadline`, data);
export const setJobDeadline = (id, deadline) => api.patch(`/jobs/${id}/set-deadline`, { deadline });
export const reviewDeadlineRequest = (rid, action, new_deadline) =>
  api.patch(`/jobs/deadline-requests/${rid}/review`, { action, new_deadline });
export const getDeadlineRequests = () => api.get('/jobs/deadline-requests');
export const updateJobTk = (jobId, data) => api.patch(`/jobs/${jobId}/tk`, data);
// Phase 4: updateJobTruck removed — use createTruckBooking / updateTruckBooking instead.
export const completeJobTruck = (jobId) => api.patch(`/jobs/${jobId}/truck/complete`, {});
// P3 (2026-06-23): "+ đổi lệnh" — add a doi_lenh task to a tk-only HP job,
// auto-assigned to this week's ĐL person by the backend rotation (no picker).
export const addDoiLenhTask = (jobId) => api.post(`/jobs/${jobId}/ops-task`, { task_type: 'doi_lenh' });
export const completeOpsTask = (tid, notes) => api.patch(`/jobs/ops-task/${tid}/complete`, { notes });
export const completeJob = (id) => api.patch(`/jobs/${id}/complete`, {});
export const getLogStaff = () => api.get('/jobs/users/log-staff');
export const searchJobCustomers = (q) => api.get('/jobs/customer-search', { params: { q } });
export const getStaffWorkload = () => api.get('/jobs/staff-workload');
export const deleteJob = (id) => api.delete(`/jobs/${id}`);
export const requestJobDelete = (id, reason) => api.post(`/jobs/${id}/delete-request`, { reason });
export const reviewDeleteRequest = (rid, action) => api.patch(`/jobs/delete-requests/${rid}/review`, { action });
export const getJobSettings = () => api.get('/jobs/settings');
export const updateAssignmentMode = (assignment_mode) => api.patch('/jobs/settings/assignment-mode', { assignment_mode });
export const getWaitingAssignments = () => api.get('/jobs/waiting-assignments');
export const getFilteredJobs = (type, staffId) =>
  api.get('/jobs/filtered', { params: staffId ? { type, staff_id: staffId } : { type } });
export const manualAssignJob = (id, data) => api.post(`/jobs/${id}/manual-assign`, data);
export const reassignCus = (id, newCusId) => api.patch(`/jobs/${id}/reassign-cus`, { new_cus_id: newCusId });
// reassignOps removed in P3 — job-level OPS reassign retired. Per-task override:
export const assignOpsTask = (id, taskType, opsId) => api.patch(`/jobs/${id}/ops-task/${taskType}/assign`, { ops_id: opsId });
export const refreshJobSuggestion = (id, type) => api.post(`/jobs/${id}/refresh-suggestion`, { type });
// OPS per-task ticks (2026-05-23, replaces markOpsDone). taskType ∈
// {'thong_quan','doi_lenh'}. /done is only valid for 'doi_lenh' (đổi lệnh xong);
// /cost works for both task types. All ticks require tk_status terminal when
// the job has TK.
export const markOpsTaskDone   = (id, taskType) => api.patch(`/jobs/${id}/ops-task/${taskType}/done`, {});
export const unmarkOpsTaskDone = (id, taskType) => api.delete(`/jobs/${id}/ops-task/${taskType}/done`);
export const tickOpsTaskCost   = (id, taskType) => api.patch(`/jobs/${id}/ops-task/${taskType}/cost`, {});
export const untickOpsTaskCost = (id, taskType) => api.delete(`/jobs/${id}/ops-task/${taskType}/cost`);
export const getJobOverview = (params) => api.get('/jobs/overview', { params });
export const getBbbgData = (id, bookingId) =>
  api.get(`/jobs/${id}/bbbg-data`, { params: bookingId ? { booking_id: bookingId } : {} });
// Returns a Blob (PDF bytes). The response interceptor unwraps `.data`,
// so the resolved value here is the Blob itself.
export const generateBbbgPdf = (id, payload) =>
  api.post(`/jobs/${id}/bbbg-pdf`, payload, { responseType: 'blob' });

// C3 (2026-05-26) — sea-quote v2 PDF export. Quote must have quote_data set.
// Returns Blob (binary). Caller is responsible for URL.createObjectURL + download.
export const generateSeaQuotePdf = (quoteId) =>
  api.post(`/quotes/${quoteId}/pdf`, {}, { responseType: 'blob' });

// 2026-05-27 — preview PDF from in-memory form state (no save, no DB lookup).
// body: { quote_data, customer_name, valid_until, exchange_rate, grand_total_currency }
export const generateSeaQuotePreviewPdf = (body) =>
  api.post('/quotes/preview-pdf', body, { responseType: 'blob' });

// Global search (LOG team only)
export const searchGlobal = (params) => api.get('/search', { params });

// Truck bookings (Phase 2 — multi-truck booking system; replaces job_truck workflow)
export const getTruckBookings = (jobId) =>
  api.get('/truck-bookings', { params: { job_id: jobId } });
export const createTruckBooking = (body) =>
  api.post('/truck-bookings', body);
// Phase 5 Step 2 — bulk create carrier-less bookings. Accepts array of
// {job_id, container_id, planned_datetime, delivery_location, note}.
// Server accepts {items: [...]} OR a bare array; we send {items: [...]}.
export const createTruckBookingsBatch = (items) =>
  api.post('/truck-bookings/batch', { items });
export const updateTruckBooking = (id, body) =>
  api.patch(`/truck-bookings/${id}`, body);
export const deleteTruckBooking = (id) =>
  api.delete(`/truck-bookings/${id}`);
export const getTruckBookingStatus = (jobId) =>
  api.get(`/jobs/${jobId}/truck-booking-status`);
export const getAvailableContainers = (jobId) =>
  api.get(`/jobs/${jobId}/available-containers`);
export const getPastDeliveryLocations = (jobId) =>
  api.get(`/jobs/${jobId}/past-delivery-locations`);
export const getPastReceivers = (jobId) =>
  api.get(`/jobs/${jobId}/past-receivers`);

// Customer pipeline (Data khách hàng — TP + lead management page)
export const getCustomerPipelines = (search = '') =>
  api.get('/customer-pipeline', { params: search ? { search } : {} });
export const updateCustomerPipeline = (id, data) =>
  api.patch(`/customer-pipeline/${id}`, data);
export const deleteCustomerPipeline = (id) =>
  api.delete(`/customer-pipeline/${id}`);

// Transport companies (Quản lý tên vận tải)
export const getTransportCompanies = (search = '') =>
  api.get('/transport-companies', { params: search ? { search } : {} });
export const getTransportCompany = (id) => api.get(`/transport-companies/${id}`);
export const createTransportCompany = (data) => api.post('/transport-companies', data);
export const updateTransportCompany = (id, data) => api.patch(`/transport-companies/${id}`, data);
export const deleteTransportCompany = (id) => api.delete(`/transport-companies/${id}`);
// Đợt 1 — route price-history lookup. params: { q, from?, to? }.
// Returns { rows: [...], aggregates: { count, avg_cost, min_cost, max_cost }, total_matched }.
export const getRoutePriceHistory = (params) =>
  api.get('/transport-companies/route-price-history', { params });

// Gmail setup (per-user, encrypted at rest — Phase 5 Step 3 Part 2 CP2)
export const getGmailSetup = () => api.get('/users/me/gmail-setup');
export const updateGmailSetup = (data) => api.put('/users/me/gmail-setup', data);
export const deleteGmailSetup = () => api.delete('/users/me/gmail-setup');

// Planning email (Phase 5 Step 3 Part 2 CP3 + CP3.5b)
// body: { job_id, transport_company_id, booking_ids: int[], mail_type: 'new'|'cancel',
//         invoice_info: {type, company, tax, address}, is_replacement?: bool }
export const sendPlanningEmail = (body) => api.post('/email/send-planning', body);
export const getEmailHistory = (jobId) =>
  api.get('/email/history', { params: { job_id: jobId } });
// SLB legal info — used by the invoice modal "SLB Logistics" pre-fill so the
// strings aren't hard-coded in two places. CP3.5b — DD + TPL + lead.
export const getSlbInvoiceInfo = () => api.get('/email/slb-invoice-info');
// CP3.5c — Preview rendering: same body shape as send, but server skips
// SMTP + email_history insert. invoice_info OPTIONAL. Returns
// { subject, body, recipient_email, cc, transport_name, has_invoice_info }.
export const previewPlanningEmail = (body) => api.post('/email/preview-planning', body);

// CP4.2 — BBBG PDF preview. Response is binary application/pdf, NOT JSON, so
// we pass responseType: 'blob' to keep the axios pipeline from trying to
// JSON.parse it. The response interceptor unwraps .data, so the resolved
// value is the Blob itself.
export const previewBBBGPdf = (body) =>
  api.post('/email/preview-bbbg', body, { responseType: 'blob' });

// CP5.2 — per-transport mail status (drives Vùng 2 pills + buttons).
// Returns { groups: [{transport_company_id, transport_name, booking_ids,
//   status, last_sent_at, last_sent_email_id, last_sent_booking_ids, diff,
//   last_sent_snapshot}], job_code }.
export const getMailStatus = (jobId) => api.get(`/email/mail-status/${jobId}`);

// CP5.2 — send HỦY mail for one (job, transport). Body: {job_id,
// transport_company_id, last_sent_email_id?, reason?}. Server pulls the
// bookings_snapshot from the source 'new' row and replays it as a cancel.
export const sendCancelPlanningEmail = (body) =>
  api.post('/email/send-cancel-planning', body);

// Notifications
export const getNotifications = () => api.get('/notifications');
export const getUnreadCount = () => api.get('/notifications/unread-count');
export const markNotificationsRead = (payload) => api.post('/notifications/mark-read', payload);

// Admin — user management (role 'admin' only; backend enforces). create +
// resetUserPassword return { user, temp_password } (temp shown once).
export const getAdminUsers     = ()        => api.get('/admin/users');
export const createAdminUser   = (data)    => api.post('/admin/users', data);
export const updateAdminUser   = (id, data) => api.patch(`/admin/users/${id}`, data);
export const changeUserRole    = (id, role) => api.patch(`/admin/users/${id}/role`, { role });
export const disableUser       = (id)      => api.patch(`/admin/users/${id}/disable`);
export const enableUser        = (id)      => api.patch(`/admin/users/${id}/enable`);
export const resetUserPassword = (id)      => api.post(`/admin/users/${id}/reset-password`);

export default api;
