import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CompanyDashboard from './pages/CompanyDashboard';
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
import SystemHealth from './pages/SystemHealth';
import Tenants from './pages/Tenants';
import GlobalRevenue from './pages/GlobalRevenue';
import GatewaySettings from './pages/GatewaySettings';
import PlatformAudit from './pages/PlatformAudit';
import Fleet from './pages/Fleet';
import Trips from './pages/Trips';
import Tickets from './pages/Tickets';
import Financials from './pages/Financials';
import TransitDevices from './pages/TransitDevices';
import CompanyProfile from './pages/CompanyProfile';
import LiveShifts from './pages/LiveShifts';
import PosSales from './pages/PosSales';
import PosInventory from './pages/PosInventory';
import PosCustomers from './pages/PosCustomers';
import PosReports from './pages/PosReports';
import PosDevices from './pages/PosDevices';
import PosCompanyProfile from './pages/PosCompanyProfile';
import type { AuthUser } from './context/AuthContext';
import { FiAlertOctagon } from 'react-icons/fi';
import { WORKSPACE_KEY, type Workspace, loadWorkspace, persistWorkspace, workspaceForSection } from './workspace';

const sectionRoles: Record<string, string[]> = {
  overview: ['Staff', 'Manager', 'CEO'],
  vouchers: ['Staff', 'Manager', 'CEO'],
  users: ['Staff', 'Manager', 'CEO'],
  sessions: ['Staff', 'Manager', 'CEO'],
  'my-sales': ['Staff', 'Manager', 'CEO'],
  time: ['Staff', 'Manager', 'CEO'],
  'access-log': ['Staff', 'Manager', 'CEO'],
  'mac-mgmt': ['CEO'],
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
  'pos-sales': ['Staff', 'Manager', 'CEO', 'Cashier'],
  'pos-inventory': ['Staff', 'Manager', 'CEO', 'Cashier'],
  'pos-customers': ['Staff', 'Manager', 'CEO', 'Cashier'],
  'pos-reports': ['Manager', 'CEO'],
  'pos-devices': ['Manager', 'CEO'],
  'pos-company': ['CEO'],
};

/** Platform (Level 0) sections — CEO operators with no company binding only. */
const LEVEL0_SECTIONS = ['system-health', 'tenants', 'global-revenue', 'gateway-settings', 'platform-audit'];

/** Company (Level 1-3) sections and the permissions that unlock them. */
const TRANSIT_SECTIONS: Record<string, string[]> = {
  'fleet': ['company.admin', 'operations.manage'],
  'trips': ['company.admin', 'operations.manage'],
  'tickets': ['company.admin', 'operations.manage', 'finance.view'],
  'financials': ['company.admin', 'finance.view'],
  'transit-devices': ['company.admin', 'operations.manage'],
  'company-profile': ['company.admin', 'operations.manage'],
  'live-shifts': ['company.admin', 'operations.manage', 'finance.view'],
};

const FIELD_STAFF_ROLES = ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'];

function sectionAllowed(user: AuthUser, section: string): boolean {
  const userPerms = user.permissions || [];
  if (user.companyId) {
    if (section === 'overview') return true;
    const transitPerms = TRANSIT_SECTIONS[section];
    const transitOk = !!transitPerms && userPerms.some(p => transitPerms.includes(p));
    if (transitOk) return true;
    // system.developer (platform super-admin) also retains access to all
    // platform WiFi sections even when bound to a transit company.
    if (userPerms.includes('system.developer')) {
      if (LEVEL0_SECTIONS.includes(section)) return user.role === 'CEO';
      return (sectionRoles[section] || []).includes(user.role);
    }
    return false;
  }
  // Level 0 platform operators may manage any tenant company's transit sections
  // (same permission gate as company admins), then fall back to platform sections.
  const transitPerms = TRANSIT_SECTIONS[section];
  if (transitPerms && userPerms.some(p => transitPerms.includes(p))) return true;
  if (LEVEL0_SECTIONS.includes(section)) return user.role === 'CEO';
  return (sectionRoles[section] || []).includes(user.role);
}

function FieldStaffGate({ onLogout }: { onLogout: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div className="tx-gate">
        <div className="tx-gate-icon"><FiAlertOctagon /></div>
        <div className="tx-gate-title">Access Denied</div>
        <p className="tx-gate-desc">Drivers and Conductors must use the Preyone Transit Mobile App.</p>
        <button className="tx-gate-btn" onClick={onLogout}>Back to Sign In</button>
      </div>
    </div>
  );
}

export default function App() {
  const { user, loading, logout } = useAuth();
  const [section, setSection] = useState('overview');
  const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);

  // Brand each workspace's document title accordingly.
  useEffect(() => {
    document.title =
      workspace === 'transit' ? 'Preyone Transit Operations | Admin Console'
      : workspace === 'pos' ? 'Preyone POS | Admin Console'
      : 'Preyone UltraNet WiFi | Admin Console';
  }, [workspace]);

  // Company-bound admins only have Transit sections; default them there on
  // first login (afterwards their persisted choice is respected).
  useEffect(() => {
    if (user?.companyId && !localStorage.getItem(WORKSPACE_KEY)) {
      persistWorkspace('transit');
      setWorkspace('transit');
    }
  }, [user]);

  // Navigate to a section, switching the workspace automatically when the
  // section lives in a specific domain (e.g. Vouchers → UltraNet WiFi).
  const go = useCallback((s: string) => {
    if (!user) return;
    const target = sectionAllowed(user, s) ? s : 'overview';
    setSection(target);
    const scope = workspaceForSection(target);
    if (scope === 'ultranet' || scope === 'transit' || scope === 'pos') {
      persistWorkspace(scope);
      setWorkspace(scope);
    }
  }, [user]);

  // Let pages (e.g. Tenants after provisioning) navigate to a section.
  useEffect(() => {
    const handler = (e: Event) => {
      if (!user) return;
      const target = (e as CustomEvent<string>).detail;
      if (target) go(target);
    };
    window.addEventListener('app-navigate', handler);
    return () => window.removeEventListener('app-navigate', handler);
  }, [user, go]);

  const changeWorkspace = (next: Workspace) => {
    const currentScope = workspaceForSection(section);
    persistWorkspace(next);
    setWorkspace(next);
    if (currentScope !== 'both' && currentScope !== next) {
      setSection('overview');
    }
  };

  if (loading) return null;
  if (!user) return <Login />;

  // Defensive: field staff can never hold a web-portal session.
  if (FIELD_STAFF_ROLES.includes(user.role)) {
    return <FieldStaffGate onLogout={logout} />;
  }

  const safeSection = sectionAllowed(user, section) ? section : 'overview';
  if (safeSection !== section) setSection('overview');
  const isCompany = !!user.companyId;

  return (
    <Layout activeSection={safeSection} onNavigate={go} workspace={workspace} onWorkspaceChange={changeWorkspace}>
      {safeSection === 'overview' && (isCompany ? <CompanyDashboard onNavigate={setSection} /> : <Dashboard onNavigate={setSection} />)}
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
      {safeSection === 'system-health' && <SystemHealth />}
      {safeSection === 'tenants' && <Tenants />}
      {safeSection === 'global-revenue' && <GlobalRevenue />}
      {safeSection === 'gateway-settings' && <GatewaySettings />}
      {safeSection === 'platform-audit' && <PlatformAudit />}
      {safeSection === 'fleet' && <Fleet />}
      {safeSection === 'trips' && <Trips />}
      {safeSection === 'tickets' && <Tickets />}
      {safeSection === 'financials' && <Financials />}
      {safeSection === 'transit-devices' && <TransitDevices />}
      {safeSection === 'company-profile' && <CompanyProfile />}
      {safeSection === 'live-shifts' && <LiveShifts />}
      {safeSection === 'pos-sales' && <PosSales />}
      {safeSection === 'pos-inventory' && <PosInventory />}
      {safeSection === 'pos-customers' && <PosCustomers />}
      {safeSection === 'pos-reports' && <PosReports />}
      {safeSection === 'pos-devices' && <PosDevices />}
      {safeSection === 'pos-company' && <PosCompanyProfile />}
    </Layout>
  );
}