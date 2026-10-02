import { useState, useRef } from 'react';
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
import PosSales from './pages/PosSales';
import PosInventory from './pages/PosInventory';
import PosCustomers from './pages/PosCustomers';
import PosReports from './pages/PosReports';
import CompanyProfile from './pages/CompanyProfile';
import Devices from './pages/Devices';

const sectionRoles: Record<string, string[]> = {
  overview: ['Staff', 'Manager', 'CEO'],
  'pos-sales': ['Staff', 'Manager', 'CEO'],
  'pos-inventory': ['Staff', 'Manager', 'CEO'],
  'pos-customers': ['Staff', 'Manager', 'CEO'],
  'pos-reports': ['Manager', 'CEO'],
  devices: ['Manager', 'CEO'],
  'company-profile': ['CEO'],
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
  const [product, setProduct] = useState<'pos' | 'wifi'>('pos');
  const [section, setSection] = useState('pos-sales');
  const productSection = useRef<Record<'pos' | 'wifi', string>>({ pos: 'pos-sales', wifi: 'overview' });

  if (loading) return null;
  if (!user) return <Login />;

  const PRODUCT_DEFAULT: Record<'pos' | 'wifi', string> = { pos: 'pos-sales', wifi: 'overview' };
  const SECTION_PRODUCT: Record<string, 'pos' | 'wifi'> = {
    'pos-sales': 'pos', 'pos-inventory': 'pos', 'pos-customers': 'pos', 'pos-reports': 'pos',
    devices: 'pos', 'company-profile': 'pos',
    overview: 'wifi', vouchers: 'wifi', users: 'wifi', sessions: 'wifi', 'my-sales': 'wifi',
    time: 'wifi', 'access-log': 'wifi', 'mac-mgmt': 'wifi', alerts: 'wifi', 'ap-health': 'wifi',
    bandwidth: 'wifi', broadcasts: 'wifi', 'peak-hours': 'wifi', staff: 'wifi', reports: 'wifi',
    'admin-users': 'wifi', packages: 'wifi', 'ap-devices': 'wifi', 'audit-log': 'wifi',
    backup: 'wifi', settings: 'wifi',
  };

  const handleNavigate = (s: string) => {
    const p = SECTION_PRODUCT[s];
    if (p && p !== product) {
      productSection.current[product] = s;
      setProduct(p);
      setSection(s);
      return;
    }
    const a = sectionRoles[s];
    setSection(a?.includes(user.role) ? s : PRODUCT_DEFAULT[product]);
  };

  const switchProduct = (p: 'pos' | 'wifi') => {
    if (p === product) return;
    productSection.current[product] = section;
    setProduct(p);
    const target = productSection.current[p];
    setSection(sectionRoles[target]?.includes(user.role) ? target : PRODUCT_DEFAULT[p]);
  };

  // Route guard: redirect if user lacks role
  const allowed = sectionRoles[section];
  const safeSection = allowed?.includes(user.role) ? section : PRODUCT_DEFAULT[product];
  if (safeSection !== section) setSection(safeSection);

  return (
    <Layout
      activeSection={safeSection}
      onNavigate={handleNavigate}
      activeProduct={product}
      onProductChange={switchProduct}
    >
      {safeSection === 'overview' && <Dashboard onNavigate={setSection} />}
      {safeSection === 'pos-sales' && <PosSales />}
      {safeSection === 'pos-inventory' && <PosInventory />}
      {safeSection === 'pos-customers' && <PosCustomers />}
      {safeSection === 'pos-reports' && <PosReports />}
      {safeSection === 'devices' && <Devices />}
      {safeSection === 'company-profile' && <CompanyProfile />}
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
