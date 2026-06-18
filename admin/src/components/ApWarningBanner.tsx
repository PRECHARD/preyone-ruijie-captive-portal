import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { playApWarningSound } from '../utils/sound';
import { FiAlertTriangle, FiX } from 'react-icons/fi';

interface ApDevice {
  id: number;
  name: string;
  status: string;
  ip_address?: string;
  clients_count?: number;
}

interface ApHealthData {
  total: number;
  online: number;
  offline: number;
  warning: number;
  devices: ApDevice[];
}

export default function ApWarningBanner({ onNavigate }: { onNavigate?: (s: string) => void }) {
  const [health, setHealth] = useState<ApHealthData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const prevWasHealthy = useRef(true);

  useEffect(() => {
    const check = async () => {
      try {
        const data = await api.get<ApHealthData>('/ap-health');
        setHealth(data);
        const nowUnhealthy = data.offline > 0;
        if (nowUnhealthy && prevWasHealthy.current) {
          playApWarningSound();
        }
        prevWasHealthy.current = !nowUnhealthy;
        if (nowUnhealthy) setDismissed(false);
      } catch { /* ignore */ }
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  if (!health || dismissed || health.offline === 0) return null;

  const offlineDevices = health.devices.filter(d => d.status === 'offline');
  const warningDevices = health.devices.filter(d => d.status === 'warning');

  return (
    <div className="ap-warning-banner" onClick={() => onNavigate?.('ap-health')}>
      <div className="ap-warning-icon"><FiAlertTriangle size={18} /></div>
      <div className="ap-warning-body">
        <span className="ap-warning-title">
          {health.offline} AP{health.offline !== 1 ? 's' : ''} Offline
        </span>
        <span className="ap-warning-desc">
          {offlineDevices.map(d => d.name).join(', ')}
          {warningDevices.length > 0 && ` · ${warningDevices.length} warning`}
        </span>
      </div>
      <button className="ap-warning-dismiss" onClick={e => { e.stopPropagation(); setDismissed(true); }}>
        <FiX size={16} />
      </button>
    </div>
  );
}
