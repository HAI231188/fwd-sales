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
export const getPipelineHistory = (id) => api.get(`/pipeline/${id}/history`);
export const getPipelineDetail = (id) => api.get(`/pipeline/${id}/detail`);
export const updatePipelineInfo = (id, data) => api.put(`/pipeline/${id}/info`, data);
export const addInteractionUpdate = (customerId, data) => api.post(`/pipeline/customers/${customerId}/updates`, data);
export const markUpdateComplete = (updateId, completionNote) => api.patch(`/pipeline/customers/updates/${updateId}/complete`, { completion_note: completionNote });
export const undoUpdateComplete = (updateId) => api.patch(`/pipeline/customers/updates/${updateId}/uncomplete`, {});
export const markCustomerFollowUpComplete = (customerId, completed, resultNote) => api.patch(`/pipeline/customers/${customerId}/follow-up-complete`, { completed, result_note: resultNote });

export default api;
