import { useState } from 'react';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Vouchers from './pages/Vouchers';
import Users from './pages/Users';
import Sessions from './pages/Sessions';
import MySales from './pages/MySales';
import TimeAttendance from './pages/TimeAttendance';
import AccessLog from './pages/AccessLog';
import MacMgmt from './pages/MacMgmt';
import Alerts from './pages/Alerts';
import ApHealth from './pages/ApHealth';
import Bandwidth from './pages/Bandwidth';
import PeakHours from './pages/PeakHours';
import StaffManagement from './pages/StaffManagement';
import Reports from './pages/Reports';
import AdminUsers from './pages/AdminUsers';
import Packages from './pages/Packages';
import ApDevices from './pages/ApDevices';
import Broadcasts from './pages/Broadcasts';
import AuditLog from './pages/AuditLog';
import Backup from './pages/Backup';
import Settings from './pages/Settings';

export default function App() {
  const { user, loading } = useAuth();
  const [section, setSection] = useState('overview');

  if (loading) return null;
  if (!user) return <Login />;

  return (
    <Layout activeSection={section} onNavigate={setSection}>
      {section === 'overview' && <Dashboard onNavigate={setSection} />}
      {section === 'vouchers' && <Vouchers />}
      {section === 'users' && <Users />}
      {section === 'sessions' && <Sessions />}
      {section === 'my-sales' && <MySales />}
      {section === 'time' && <TimeAttendance />}
      {section === 'access-log' && <AccessLog />}
      {section === 'mac-mgmt' && <MacMgmt />}
      {section === 'alerts' && <Alerts />}
      {section === 'ap-health' && <ApHealth />}
      {section === 'bandwidth' && <Bandwidth />}
      {section === 'peak-hours' && <PeakHours />}
      {section === 'staff' && <StaffManagement />}
      {section === 'reports' && <Reports />}
      {section === 'admin-users' && <AdminUsers />}
      {section === 'packages' && <Packages />}
      {section === 'ap-devices' && <ApDevices />}
      {section === 'broadcasts' && <Broadcasts />}
      {section === 'audit-log' && <AuditLog />}
      {section === 'backup' && <Backup />}
      {section === 'settings' && <Settings />}
    </Layout>
  );
}
