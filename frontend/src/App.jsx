import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { createContext, useContext, useState, useEffect } from 'react';
import Login from './pages/Login';
import LeadDashboard from './pages/LeadDashboard';
import SalesDashboard from './pages/SalesDashboard';
import ReportDetail from './pages/ReportDetail';

export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

function ProtectedRoute({ children, roles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function RootRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'lead' ? '/dashboard' : '/my-dashboard'} replace />;
}

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('fwd_user')); } catch { return null; }
  });

  const login = (userData, token) => {
    localStorage.setItem('fwd_token', token);
    localStorage.setItem('fwd_user', JSON.stringify(userData));
    setUser(userData);
  };

  const logout = () => {
    localStorage.removeItem('fwd_token');
    localStorage.removeItem('fwd_user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RootRedirect />} />
          <Route path="/dashboard" element={
            <ProtectedRoute roles={['lead']}>
              <LeadDashboard />
            </ProtectedRoute>
          } />
          <Route path="/my-dashboard" element={
            <ProtectedRoute roles={['sales']}>
              <SalesDashboard />
            </ProtectedRoute>
          } />
          <Route path="/reports/:id" element={
            <ProtectedRoute>
              <ReportDetail />
            </ProtectedRoute>
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
