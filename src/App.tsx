import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SignFormPage from './pages/SignFormPage';
import SigningsPage from './pages/SigningsPage';
import SoldiersPage from './pages/SoldiersPage';
import ItemsPage from './pages/ItemsPage';
import LogsPage from './pages/LogsPage';
import UsersPage from './pages/UsersPage';
import ReportsPage from './pages/ReportsPage';
import UnitSignFormPage from './pages/UnitSignFormPage';
import UnitSigningsPage from './pages/UnitSigningsPage';
import UnitStockReportPage from './pages/UnitStockReportPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<DashboardPage />} />
        <Route path="sign" element={<SignFormPage />} />
        <Route path="signings" element={<SigningsPage />} />
        <Route path="soldiers" element={<SoldiersPage />} />
        <Route path="items" element={<ProtectedRoute requireAdmin><ItemsPage /></ProtectedRoute>} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="users" element={<ProtectedRoute requireAdmin><UsersPage /></ProtectedRoute>} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="unit-sign" element={<ProtectedRoute requireAdmin><UnitSignFormPage /></ProtectedRoute>} />
        <Route path="unit-signings" element={<ProtectedRoute requireAdmin><UnitSigningsPage /></ProtectedRoute>} />
        <Route path="unit-stock" element={<ProtectedRoute requireAdmin><UnitStockReportPage /></ProtectedRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
