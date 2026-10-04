import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import type { Workspace } from '../workspace';
import {
  FiGrid, FiCreditCard, FiUsers, FiMonitor, FiDollarSign, FiClock,
  FiFileText, FiShield, FiBell, FiWifi, FiActivity, FiBarChart2,
  FiUserCheck, FiPieChart, FiUserPlus, FiPackage, FiServer,
  FiMessageSquare, FiAlertTriangle, FiDownload, FiSettings,
  FiChevronLeft, FiChevronRight,
  FiCalendar, FiSmartphone, FiGlobe, FiTrendingUp, FiRadio, FiImage,
  FiShoppingCart, FiBox, FiBookOpen, FiBriefcase,
  FiExternalLink,
} from 'react-icons/fi';

const POS_URL = import.meta.env.VITE_POS_URL || 'https://pos.preyone.com';
const INVOICE_URL = import.meta.env.VITE_INVOICE_URL || 'https://invoices.preyone.com';

interface SidebarLink {
  label: string;
  section: string;
  roles: string[];
  icon: React.ReactNode;
  badgeKey?: string;
  /** 'platform' = WiFi/Level 0 section, 'company' = transit company section, 'both' = shared. */
  mode?: 'platform' | 'company' | 'both';
  /** ANY of these permission codes unlocks the link (for company sections). */
  permissions?: string[];
}

interface LinkGroup {
  label: string;
  /** Workspace this group belongs to; 'both' groups are shown in every workspace. */
  workspace: Workspace | 'both';
  /** Renders the group as part of the global "System" cluster at the bottom. */
  system?: boolean;
  links: SidebarLink[];
}

const groups: LinkGroup[] = [
  {
    label: 'Overview',
    workspace: 'both',
    links: [
      { label: 'Dashboard', section: 'overview', roles: ['Staff', 'Manager', 'CEO'], icon: <FiGrid />, mode: 'both' },
    ],
  },
  // ── Preyone UltraNet WiFi workspace ───────────────────────────────
  {
    label: 'WiFi Vouchers',
    workspace: 'ultranet',
    links: [
      { label: 'Vouchers', section: 'vouchers', roles: ['Staff', 'Manager', 'CEO'], icon: <FiCreditCard />, badgeKey: 'pendingApprovals' },
    ],
  },
  {
    label: 'Captive Portal',
    workspace: 'ultranet',
    links: [
      { label: 'Active Sessions', section: 'sessions', roles: ['Staff', 'Manager', 'CEO'], icon: <FiMonitor /> },
      { label: 'Access Log', section: 'access-log', roles: ['Staff', 'Manager', 'CEO'], icon: <FiFileText /> },
    ],
  },
  {
    label: 'Access Points & Gateways',
    workspace: 'ultranet',
    links: [
      { label: 'AP Health', section: 'ap-health', roles: ['Staff', 'Manager', 'CEO'], icon: <FiWifi /> },
      { label: 'Bandwidth', section: 'bandwidth', roles: ['Staff', 'Manager', 'CEO'], icon: <FiActivity /> },
      { label: 'Peak Hours', section: 'peak-hours', roles: ['Manager', 'CEO'], icon: <FiBarChart2 /> },
      { label: 'AP Devices', section: 'ap-devices', roles: ['CEO'], icon: <FiServer /> },
      { label: 'MAC Mgmt', section: 'mac-mgmt', roles: ['CEO'], icon: <FiShield /> },
      { label: 'Gateway & RADIUS', section: 'gateway-settings', roles: ['CEO'], icon: <FiRadio /> },
    ],
  },
  {
    label: 'Payment Logs',
    workspace: 'ultranet',
    links: [
      { label: 'My Sales', section: 'my-sales', roles: ['Staff', 'Manager', 'CEO'], icon: <FiDollarSign /> },
      { label: 'Reports', section: 'reports', roles: ['Manager', 'CEO'], icon: <FiPieChart />, badgeKey: 'pendingHandovers' },
    ],
  },
  {
    label: 'WiFi Users & Packages',
    workspace: 'ultranet',
    links: [
      { label: 'Users', section: 'users', roles: ['Staff', 'Manager', 'CEO'], icon: <FiUsers /> },
      { label: 'Packages', section: 'packages', roles: ['CEO'], icon: <FiPackage /> },
    ],
  },
  // ── Preyone Transit Operations workspace ──────────────────────────
  {
    label: 'Tenants & Operators',
    workspace: 'transit',
    links: [
      { label: 'Tenant Companies (Mupota)', section: 'tenants', roles: ['CEO'], icon: <FiGlobe /> },
      { label: 'Global Revenue', section: 'global-revenue', roles: ['CEO'], icon: <FiTrendingUp /> },
    ],
  },
  {
    label: 'Fleet Staff',
    workspace: 'transit',
    links: [
      { label: 'Crew & Staff', section: 'fleet', roles: ['Staff', 'Manager', 'CEO'], icon: <FiUsers />, mode: 'company', permissions: ['company.admin', 'operations.manage'] },
      { label: 'Live Shift Monitoring', section: 'live-shifts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiRadio />, mode: 'company', permissions: ['company.admin', 'operations.manage', 'finance.view'] },
    ],
  },
  {
    label: 'Routes & Schedules',
    workspace: 'transit',
    links: [
      { label: 'Trip Schedules', section: 'trips', roles: ['Staff', 'Manager', 'CEO'], icon: <FiCalendar />, mode: 'company', permissions: ['company.admin', 'operations.manage'] },
    ],
  },
  {
    label: 'Tickets & Luggage',
    workspace: 'transit',
    links: [
      { label: 'Ticket Manifest', section: 'tickets', roles: ['Staff', 'Manager', 'CEO'], icon: <FiFileText />, mode: 'company', permissions: ['company.admin', 'operations.manage', 'finance.view'] },
    ],
  },
  {
    label: 'Company',
    workspace: 'transit',
    links: [
      { label: 'Company Profile', section: 'company-profile', roles: ['Staff', 'Manager', 'CEO'], icon: <FiImage />, mode: 'company', permissions: ['company.admin', 'operations.manage'] },
      { label: 'Financial Reports', section: 'financials', roles: ['Staff', 'Manager', 'CEO'], icon: <FiPieChart />, mode: 'company', permissions: ['company.admin', 'finance.view'] },
      { label: 'Device Controls', section: 'transit-devices', roles: ['Staff', 'Manager', 'CEO'], icon: <FiSmartphone />, mode: 'company', permissions: ['company.admin', 'operations.manage'] },
    ],
  },
  // ── Preyone POS workspace ─────────────────────────────────────────
  {
    label: 'POS Sales',
    workspace: 'pos',
    links: [
      { label: 'Sales & Invoices', section: 'pos-sales', roles: ['Staff', 'Manager', 'CEO', 'Cashier'], icon: <FiShoppingCart /> },
      { label: 'POS Reports', section: 'pos-reports', roles: ['Manager', 'CEO'], icon: <FiTrendingUp /> },
    ],
  },
  {
    label: 'Catalogue',
    workspace: 'pos',
    links: [
      { label: 'Inventory', section: 'pos-inventory', roles: ['Staff', 'Manager', 'CEO', 'Cashier'], icon: <FiBox /> },
      { label: 'Customers', section: 'pos-customers', roles: ['Staff', 'Manager', 'CEO', 'Cashier'], icon: <FiBookOpen /> },
    ],
  },
  {
    label: 'POS Setup',
    workspace: 'pos',
    links: [
      { label: 'Devices & Endpoints', section: 'pos-devices', roles: ['Manager', 'CEO'], icon: <FiSmartphone /> },
      { label: 'Company Profile', section: 'pos-company', roles: ['CEO'], icon: <FiBriefcase /> },
    ],
  },
  // ── Global system settings (Preyone UltraNet WiFi workspace only) ──
  {
    label: 'System Settings',
    workspace: 'ultranet',
    system: true,
    links: [
      { label: 'Settings (API Keys & Email)', section: 'settings', roles: ['CEO'], icon: <FiSettings /> },
      { label: 'Admin Users', section: 'admin-users', roles: ['Manager', 'CEO'], icon: <FiUserPlus /> },
      { label: 'Staff Management', section: 'staff', roles: ['Manager', 'CEO'], icon: <FiUserCheck />, badgeKey: 'pendingStaff' },
      { label: 'Time & Attendance', section: 'time', roles: ['Staff', 'Manager', 'CEO'], icon: <FiClock /> },
    ],
  },
  {
    label: 'Notifications & Platform',
    workspace: 'ultranet',
    system: true,
    links: [
      { label: 'Alerts', section: 'alerts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiBell /> },
      { label: 'Broadcasts', section: 'broadcasts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiMessageSquare />, badgeKey: 'unreadBroadcasts' },
      { label: 'System Health', section: 'system-health', roles: ['CEO'], icon: <FiActivity /> },
      { label: 'Platform Audit', section: 'platform-audit', roles: ['CEO'], icon: <FiAlertTriangle /> },
      { label: 'Audit Log', section: 'audit-log', roles: ['CEO'], icon: <FiFileText /> },
      { label: 'Backup', section: 'backup', roles: ['CEO'], icon: <FiDownload /> },
    ],
  },
];

export default function Sidebar({ activeSection, onNavigate, workspace, notifCounts, alertsUnack }: { activeSection: string; onNavigate: (s: string) => void; workspace: Workspace; notifCounts?: { unreadBroadcasts: number; pendingApprovals: number; pendingHandovers: number; pendingStaff: number; total: number }; alertsUnack?: number }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const isCompany = !!user?.companyId;
  const userPerms = user?.permissions || [];
  const [collapsed, setCollapsed] = useState(false);

  const badgeFor = (link: SidebarLink): number | null => {
    if (link.section === 'alerts' && alertsUnack && alertsUnack > 0) return alertsUnack;
    if (!notifCounts || !link.badgeKey) return null;
    const v = (notifCounts as any)[link.badgeKey];
    return typeof v === 'number' && v > 0 ? v : null;
  };

  const canView = (link: SidebarLink): boolean => {
    const mode = link.mode || 'platform';
    // system.developer (platform super-admin) sees both the WiFi and Transit realms
    const isSysDev = userPerms.includes('system.developer');
    const modeOk = isSysDev
      ? true
      : mode === 'both'
        ? true
        : mode === 'company'
          ? isCompany
          : !isCompany;
    if (!modeOk) return false;
    if (!(link.roles || []).includes(role)) return false;
    if (link.permissions && link.permissions.length > 0) {
      return link.permissions.some(p => userPerms.includes(p));
    }
    return true;
  };

  return (
    <aside className={'sidebar' + (role === 'CEO' ? ' role-ceo' : '') + (collapsed ? ' sidebar--collapsed' : '')}>
      <nav className="sidebar-links">
        {groups
          .filter(group => (group.workspace === workspace || group.workspace === 'both') && group.links.some(canView))
          .map(group => {
            const visible = group.links.filter(canView);
            if (visible.length === 0) return null;
            return (
              <div key={group.label} className={'sidebar-group' + (group.system ? ' sidebar-group--system' : '')}>
                {!collapsed && <span className="sidebar-group-label">{group.label}</span>}
                {visible.map(l => {
                  const badge = badgeFor(l);
                  return (
                    <button
                      key={l.section}
                      className={'sidebar-link' + (activeSection === l.section ? ' active' : '')}
                      onClick={() => onNavigate(l.section)}
                      title={collapsed ? l.label : undefined}
                    >
                      <span className="sidebar-link-ic">{l.icon}</span>
                      {!collapsed && <span>{l.label}</span>}
                      {!collapsed && badge !== null && <span className="sidebar-badge">{badge > 99 ? '99+' : badge}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
      </nav>
      {workspace === 'pos' && (
        <div className="sidebar-group sidebar-openapps" style={{ marginTop: 'auto', paddingTop: 4 }}>
          {!collapsed && <span className="sidebar-group-label">Open Apps</span>}
          <button className="sidebar-link" onClick={() => window.open(POS_URL, '_blank')} title={collapsed ? 'Open POS Terminal' : undefined}>
            <span className="sidebar-link-ic"><FiExternalLink /></span>
            {!collapsed && <span>POS Terminal</span>}
          </button>
          <button className="sidebar-link" onClick={() => window.open(INVOICE_URL, '_blank')} title={collapsed ? 'Open Invoice System' : undefined}>
            <span className="sidebar-link-ic"><FiExternalLink /></span>
            {!collapsed && <span>Invoice System</span>}
          </button>
        </div>
      )}
      <button className="sidebar-collapse-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <FiChevronRight /> : <FiChevronLeft />}
      </button>
    </aside>
  );
}