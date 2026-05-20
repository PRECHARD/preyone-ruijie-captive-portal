import { useAuth } from '../context/AuthContext';
import {
  FiGrid, FiCreditCard, FiUsers, FiMonitor, FiDollarSign, FiClock,
  FiFileText, FiShield, FiBell, FiWifi, FiActivity, FiBarChart2,
  FiUserCheck, FiPieChart, FiUserPlus, FiPackage, FiServer,
  FiMessageSquare, FiAlertTriangle, FiDownload, FiSettings,
} from 'react-icons/fi';

interface SidebarLink {
  label: string;
  section: string;
  roles: string[];
  icon: React.ReactNode;
}

const links: SidebarLink[] = [
  { label: 'Dashboard', section: 'overview', roles: ['Staff', 'Manager', 'CEO'], icon: <FiGrid /> },
  { label: 'Vouchers', section: 'vouchers', roles: ['Staff', 'Manager', 'CEO'], icon: <FiCreditCard /> },
  { label: 'Users', section: 'users', roles: ['Staff', 'Manager', 'CEO'], icon: <FiUsers /> },
  { label: 'Active Sessions', section: 'sessions', roles: ['Staff', 'Manager', 'CEO'], icon: <FiMonitor /> },
  { label: 'My Sales', section: 'my-sales', roles: ['Staff', 'Manager', 'CEO'], icon: <FiDollarSign /> },
  { label: 'Time & Attendance', section: 'time', roles: ['Staff', 'Manager', 'CEO'], icon: <FiClock /> },
  { label: 'Access Log', section: 'access-log', roles: ['Staff', 'Manager', 'CEO'], icon: <FiFileText /> },
  { label: 'MAC Mgmt', section: 'mac-mgmt', roles: ['Staff', 'Manager', 'CEO'], icon: <FiShield /> },
  { label: 'Alerts', section: 'alerts', roles: ['Staff', 'Manager', 'CEO'], icon: <FiBell /> },
  { label: 'AP Health', section: 'ap-health', roles: ['Staff', 'Manager', 'CEO'], icon: <FiWifi /> },
  { label: 'Bandwidth', section: 'bandwidth', roles: ['Staff', 'Manager', 'CEO'], icon: <FiActivity /> },
  { label: 'Peak Hours', section: 'peak-hours', roles: ['Manager', 'CEO'], icon: <FiBarChart2 /> },
  { label: 'Staff Management', section: 'staff', roles: ['Manager', 'CEO'], icon: <FiUserCheck /> },
  { label: 'Reports', section: 'reports', roles: ['Manager', 'CEO'], icon: <FiPieChart /> },
  { label: 'Admin Users', section: 'admin-users', roles: ['Manager', 'CEO'], icon: <FiUserPlus /> },
  { label: 'Packages', section: 'packages', roles: ['CEO'], icon: <FiPackage /> },
  { label: 'AP Devices', section: 'ap-devices', roles: ['CEO'], icon: <FiServer /> },
  { label: 'Broadcasts', section: 'broadcasts', roles: ['CEO'], icon: <FiMessageSquare /> },
  { label: 'Audit Log', section: 'audit-log', roles: ['CEO'], icon: <FiAlertTriangle /> },
  { label: 'Backup', section: 'backup', roles: ['CEO'], icon: <FiDownload /> },
  { label: 'Settings', section: 'settings', roles: ['CEO'], icon: <FiSettings /> },
];

export default function Sidebar({ activeSection, onNavigate }: { activeSection: string; onNavigate: (s: string) => void }) {
  const { user } = useAuth();
  const role = user?.role || 'Staff';
  const visible = links.filter(l => l.roles.includes(role));

  return (
    <aside className={'sidebar' + (role === 'CEO' ? ' role-ceo' : '')}>
      <nav className="sidebar-links">
        {visible.map(l => (
          <button
            key={l.section}
            className={'sidebar-link' + (activeSection === l.section ? ' active' : '')}
            onClick={() => onNavigate(l.section)}
          >
            {l.icon}
            <span>{l.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
