import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  FiGrid, FiCreditCard, FiUsers, FiMonitor, FiDollarSign, FiClock,
  FiFileText, FiShield, FiBell, FiWifi, FiActivity, FiBarChart2,
  FiUserCheck, FiPieChart, FiUserPlus, FiPackage, FiServer,
  FiMessageSquare, FiAlertTriangle, FiDownload, FiSettings,
  FiChevronLeft, FiChevronRight,
} from 'react-icons/fi';

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

const groups: LinkGroup[] = [
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

export default function Sidebar({ activeSection, onNavigate, notifCounts, alertsUnack }: { activeSection: string; onNavigate: (s: string) => void; notifCounts?: { unreadBroadcasts: number; pendingApprovals: number; pendingHandovers: number; pendingStaff: number; total: number }; alertsUnack?: number }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const [collapsed, setCollapsed] = useState(false);

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
                    {l.icon}
                    {!collapsed && <span>{l.label}</span>}
                    {!collapsed && badge !== null && <span className="sidebar-badge">{badge > 99 ? '99+' : badge}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <button className="sidebar-collapse-btn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <FiChevronRight /> : <FiChevronLeft />}
      </button>
    </aside>
  );
}
