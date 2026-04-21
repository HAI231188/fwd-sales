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
export const updateJobTruck = (jobId, data) => api.patch(`/jobs/${jobId}/truck`, data);
export const completeJobTruck = (jobId) => api.patch(`/jobs/${jobId}/truck/complete`, {});
export const createOpsTask = (jobId, data) => api.post(`/jobs/${jobId}/ops-task`, data);
export const completeOpsTask = (tid, notes) => api.patch(`/jobs/ops-task/${tid}/complete`, { notes });
export const completeJob = (id) => api.patch(`/jobs/${id}/complete`, {});
export const getLogStaff = () => api.get('/jobs/users/log-staff');
export const getStaffWorkload = () => api.get('/jobs/staff-workload');
export const deleteJob = (id) => api.delete(`/jobs/${id}`);
export const requestJobDelete = (id, reason) => api.post(`/jobs/${id}/delete-request`, { reason });
export const reviewDeleteRequest = (rid, action) => api.patch(`/jobs/delete-requests/${rid}/review`, { action });

export default api;
