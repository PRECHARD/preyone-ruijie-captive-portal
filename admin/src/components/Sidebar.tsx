import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  FiGrid, FiCreditCard, FiUsers, FiMonitor, FiDollarSign, FiClock,
  FiFileText, FiShield, FiBell, FiWifi, FiActivity, FiBarChart2,
  FiUserCheck, FiPieChart, FiUserPlus, FiPackage, FiServer,
  FiMessageSquare, FiAlertTriangle, FiDownload, FiSettings,
  FiChevronLeft, FiChevronRight,
  FiShoppingCart, FiBox, FiBookOpen, FiTrendingUp,
  FiExternalLink, FiFileText as FiInvoice,
  FiBriefcase, FiSmartphone,
} from 'react-icons/fi';

const POS_URL = import.meta.env.VITE_POS_URL || 'https://pos.preyone.com';
const INVOICE_URL = import.meta.env.VITE_INVOICE_URL || 'https://invoices.preyone.com';

interface SidebarLink {
  label: string;
  section: string;
  roles: string[];
  icon: React.ReactNode;
  badgeKey?: string;
}

interface LinkGroup {
  label: string;
  links: SidebarLink[];
}

const POS_GROUPS: LinkGroup[] = [
  {
    label: 'Preyone POS',
    links: [
      { label: 'POS Sales', section: 'pos-sales', roles: ['Staff', 'Manager', 'CEO'], icon: <FiShoppingCart /> },
      { label: 'Inventory', section: 'pos-inventory', roles: ['Staff', 'Manager', 'CEO'], icon: <FiBox /> },
      { label: 'Customers', section: 'pos-customers', roles: ['Staff', 'Manager', 'CEO'], icon: <FiBookOpen /> },
      { label: 'Devices & Endpoints', section: 'devices', roles: ['Manager', 'CEO'], icon: <FiSmartphone /> },
      { label: 'Company Profile', section: 'company-profile', roles: ['CEO'], icon: <FiBriefcase /> },
      { label: 'POS Reports', section: 'pos-reports', roles: ['Manager', 'CEO'], icon: <FiTrendingUp /> },
    ],
  },
];

const WIFI_GROUPS: LinkGroup[] = [
  {
    label: 'Overview',
    links: [
      { label: 'Dashboard', section: 'overview', roles: ['Staff', 'Manager', 'CEO'], icon: <FiGrid /> },
      { label: 'Vouchers', section: 'vouchers', roles: ['Staff', 'Manager', 'CEO'], icon: <FiCreditCard />, badgeKey: 'pendingApprovals' },
      { label: 'My Sales', section: 'my-sales', roles: ['Staff', 'Manager', 'CEO'], icon: <FiDollarSign /> },
      { label: 'Time & Attendance', section: 'time', roles: ['Staff', 'Manager', 'CEO'], icon: <FiClock /> },
    ],
  },
  {
    label: 'Network',
    links: [
      { label: 'Active Sessions', section: 'sessions', roles: ['Staff', 'Manager', 'CEO'], icon: <FiMonitor /> },
      { label: 'AP Health', section: 'ap-health', roles: ['Staff', 'Manager', 'CEO'], icon: <FiWifi /> },
      { label: 'Bandwidth', section: 'bandwidth', roles: ['Staff', 'Manager', 'CEO'], icon: <FiActivity /> },
      { label: 'Peak Hours', section: 'peak-hours', roles: ['Manager', 'CEO'], icon: <FiBarChart2 /> },
      { label: 'AP Devices', section: 'ap-devices', roles: ['CEO'], icon: <FiServer /> },
      { label: 'MAC Mgmt', section: 'mac-mgmt', roles: ['Staff', 'Manager', 'CEO'], icon: <FiShield /> },
    ],
  },
  {
    label: 'Management',
    links: [
      { label: 'Staff Management', section: 'staff', roles: ['Manager', 'CEO'], icon: <FiUserCheck />, badgeKey: 'pendingStaff' },
      { label: 'Reports', section: 'reports', roles: ['Manager', 'CEO'], icon: <FiPieChart />, badgeKey: 'pendingHandovers' },
      { label: 'Users', section: 'users', roles: ['Staff', 'Manager', 'CEO'], icon: <FiUsers /> },
      { label: 'Admin Users', section: 'admin-users', roles: ['Manager', 'CEO'], icon: <FiUserPlus /> },
      { label: 'Packages', section: 'packages', roles: ['CEO'], icon: <FiPackage /> },
    ],
  },
  {
    label: 'System',
    links: [
      { label: 'Alerts', section: 'alerts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiBell /> },
      { label: 'Broadcasts', section: 'broadcasts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiMessageSquare />, badgeKey: 'unreadBroadcasts' },
      { label: 'Access Log', section: 'access-log', roles: ['Staff', 'Manager', 'CEO'], icon: <FiFileText /> },
      { label: 'Audit Log', section: 'audit-log', roles: ['CEO'], icon: <FiAlertTriangle /> },
      { label: 'Backup', section: 'backup', roles: ['CEO'], icon: <FiDownload /> },
      { label: 'Settings', section: 'settings', roles: ['CEO'], icon: <FiSettings /> },
    ],
  },
];

export default function Sidebar({ activeSection, onNavigate, notifCounts, alertsUnack, activeProduct }: { activeSection: string; onNavigate: (s: string) => void; notifCounts?: { unreadBroadcasts: number; pendingApprovals: number; pendingHandovers: number; pendingStaff: number; total: number }; alertsUnack?: number; activeProduct: 'pos' | 'wifi' }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const [collapsed, setCollapsed] = useState(false);

  const groups = activeProduct === 'pos' ? POS_GROUPS : WIFI_GROUPS;

  const badgeFor = (link: SidebarLink): number | null => {
    if (link.section === 'alerts' && alertsUnack && alertsUnack > 0) return alertsUnack;
    if (!notifCounts || !link.badgeKey) return null;
    const v = (notifCounts as any)[link.badgeKey];
    return typeof v === 'number' && v > 0 ? v : null;
  };

  return (
    <aside className={'sidebar' + (role === 'CEO' ? ' role-ceo' : '') + (collapsed ? ' sidebar--collapsed' : '')}>
      <nav className="sidebar-links">
        {groups.map(group => {
          const visible = group.links.filter(l => l.roles.includes(role));
          if (visible.length === 0) return null;
          return (
            <div key={group.label} className="sidebar-group">
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
      <div className="sidebar-group sidebar-openapps" style={{ marginTop: 'auto', paddingTop: 4 }}>
        {!collapsed && <span className="sidebar-group-label">Open Apps</span>}
        <button className="sidebar-link" onClick={() => window.open(POS_URL, '_blank')} title={collapsed ? 'Open POS Terminal' : undefined}>
          <span className="sidebar-link-ic"><FiExternalLink /></span>
          {!collapsed && <span>POS Terminal</span>}
        </button>
        <button className="sidebar-link" onClick={() => window.open(INVOICE_URL, '_blank')} title={collapsed ? 'Open Invoice System' : undefined}>
          <span className="sidebar-link-ic"><FiInvoice /></span>
          {!collapsed && <span>Invoice System</span>}
        </button>
      </div>
      <button className="sidebar-collapse-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <FiChevronRight /> : <FiChevronLeft />}
      </button>
    </aside>
  );
}
