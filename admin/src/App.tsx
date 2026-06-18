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

const sectionRoles: Record<string, string[]> = {
  overview: ['Staff', 'Manager', 'CEO'],
  vouchers: ['Staff', 'Manager', 'CEO'],
  users: ['Staff', 'Manager', 'CEO'],
  sessions: ['Staff', 'Manager', 'CEO'],
  'my-sales': ['Staff', 'Manager', 'CEO'],
  time: ['Staff', 'Manager', 'CEO'],
  'access-log': ['Staff', 'Manager', 'CEO'],
  'mac-mgmt': ['Staff', 'Manager', 'CEO'],
  alerts: ['Staff', 'Manager', 'CEO'],
  'ap-health': ['Staff', 'Manager', 'CEO'],
  bandwidth: ['Staff', 'Manager', 'CEO'],
  broadcasts: ['Staff', 'Manager', 'CEO'],
  'peak-hours': ['Manager', 'CEO'],
  staff: ['Manager', 'CEO'],
  reports: ['Manager', 'CEO'],
  'admin-users': ['Manager', 'CEO'],
  packages: ['CEO'],
  'ap-devices': ['CEO'],
  'audit-log': ['CEO'],
  backup: ['CEO'],
  settings: ['CEO'],
};

export default function App() {
  const { user, loading } = useAuth();
  const [section, setSection] = useState('overview');

  if (loading) return null;
  if (!user) return <Login />;

  // Route guard: redirect if user lacks role
  const allowed = sectionRoles[section];
  const safeSection = allowed?.includes(user.role) ? section : 'overview';
  if (safeSection !== section) setSection('overview');

  return (
    <Layout activeSection={safeSection} onNavigate={(s) => { const a = sectionRoles[s]; setSection(a?.includes(user.role) ? s : 'overview'); }}>
      {safeSection === 'overview' && <Dashboard onNavigate={setSection} />}
      {safeSection === 'vouchers' && <Vouchers />}
      {safeSection === 'users' && <Users />}
      {safeSection === 'sessions' && <Sessions />}
      {safeSection === 'my-sales' && <MySales />}
      {safeSection === 'time' && <TimeAttendance />}
      {safeSection === 'access-log' && <AccessLog />}
      {safeSection === 'mac-mgmt' && <MacMgmt />}
      {safeSection === 'alerts' && <Alerts />}
      {safeSection === 'ap-health' && <ApHealth />}
      {safeSection === 'bandwidth' && <Bandwidth />}
      {safeSection === 'peak-hours' && <PeakHours />}
      {safeSection === 'staff' && <StaffManagement />}
      {safeSection === 'reports' && <Reports />}
      {safeSection === 'admin-users' && <AdminUsers />}
      {safeSection === 'packages' && <Packages />}
      {safeSection === 'ap-devices' && <ApDevices />}
      {safeSection === 'broadcasts' && <Broadcasts />}
      {safeSection === 'audit-log' && <AuditLog />}
      {safeSection === 'backup' && <Backup />}
      {safeSection === 'settings' && <Settings />}
    </Layout>
  );
}
