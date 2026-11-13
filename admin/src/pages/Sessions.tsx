import { useState, useEffect, useCallback } from 'react';
import { api, ruijieApi } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';
import { showToast } from '../utils/toast';
import type { DeviceClass, HistoricalClient, PrimaryFilter, ViewMode, WifiSession } from '../types/wifi';
import { applyFilters, historicalToSession } from '../components/wifi/sessionMeta';
import SessionSummaryCards from '../components/wifi/SessionSummaryCards';
import SessionMetricCards from '../components/wifi/SessionMetricCards';
import SessionFilterHeader from '../components/wifi/SessionFilterHeader';
import SessionTable from '../components/wifi/SessionTable';

export default function Sessions() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [rg, setRg] = useState<{ users: WifiSession[]; skipped: boolean; reason?: string } | null>(null);
  const [kicking, setKicking] = useState<string | null>(null);
  const [primary, setPrimary] = useState<PrimaryFilter>('All');
  const [deviceClass, setDeviceClass] = useState<DeviceClass | 'All'>('All');
  const [view, setView] = useState<ViewMode>('online');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<HistoricalClient[]>([]);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/active-sessions')); } catch { /* ignore */ }
    try {
      const r = await ruijieApi.get<{ skipped: boolean; reason?: string; users?: WifiSession[] }>('/sessions');
      setRg({ users: r?.skipped ? [] : (r.users || []), skipped: !!r?.skipped, reason: r?.reason });
    } catch { setRg({ users: [], skipped: true, reason: 'cloud_error' }); }
    // Local audit trail (not a cloud round-trip) — same cadence as the cloud
    // feed so the Historical Clients counter is never stale.
    try {
      const h = await ruijieApi.get<{ users?: HistoricalClient[] }>('/history');
      setHistory(h?.users || []);
    } catch { /* keep the last good audit snapshot */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  // Kick: backend returns {skipped:true} when Ruijie exposes no disconnect API —
  // surface that honestly instead of faking a success.
  const kickClient = async (s: WifiSession) => {
    setKicking(s.mac);
    try {
      const r = await ruijieApi.post<{ skipped?: boolean }>('/kick', { mac: s.mac });
      if (r?.skipped) {
        showToast({
          title: 'Disconnect Unavailable',
          message: 'Ruijie Cloud exposes no disconnect API — use the Ruijie app or console CLI.',
          type: 'warning',
        });
      } else {
        showToast({ title: 'Client Disconnected', message: `${s.mac} was kicked`, type: 'success' });
        fetch();
      }
    } catch (err: any) {
      showToast({ title: 'Disconnect Failed', message: err.message || 'Could not kick the client', type: 'error' });
    } finally {
      setKicking(null);
    }
  };

  if (loading) return <Spinner />;

  const portalSessions = data?.activeUsers || [];
  const cloud = rg?.users || [];
  const useCloud = cloud.length > 0;
  const source = view === 'historical' ? history.map(historicalToSession) : cloud;
  const visible = applyFilters(source, primary, deviceClass, query);
  const metrics = {
    activeSessions: data?.totalActive ?? null,
    cloudClients: cloud.length,
    totalRedeemed: data?.totalRedeemed ?? null,
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Active Sessions</h2>
          <p className="page-desc">
            {useCloud
              ? `${cloud.length} live on Ruijie Cloud · ${data?.totalActive || 0} portal active · ${data?.totalRedeemed || 0} total redeemed`
              : `${data?.totalActive || 0} active · ${data?.totalRedeemed || 0} total redeemed`}
          </p>
        </div>
      </div>

      <SessionMetricCards metrics={metrics} loading={!data} />

      {view === 'historical' || useCloud ? (
        <>
          <SessionSummaryCards sessions={source} />

          <div className="card">
            <SessionFilterHeader
              sessions={cloud}
              primary={primary}
              onPrimary={setPrimary}
              deviceClass={deviceClass}
              onDeviceClass={setDeviceClass}
              view={view}
              onView={setView}
              query={query}
              onQuery={setQuery}
              historyCount={history.length}
            />
            <SessionTable
              sessions={visible}
              kickingMac={kicking}
              onKick={kickClient}
              mode={view}
              emptyHint={
                query
                  ? `No clients match “${query}”.`
                  : view === 'historical'
                    ? 'No devices recorded in the audit trail yet.'
                    : rg?.skipped
                      ? `Ruijie Cloud telemetry unavailable (${rg.reason}).`
                      : 'No clients match the current filters.'
              }
            />
          </div>
        </>
      ) : (
        <>
          {rg?.skipped && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Ruijie Cloud telemetry unavailable{rg.reason ? ` (${rg.reason})` : ''} — showing portal sessions.
              </p>
            </div>
          )}
          {portalSessions.length === 0 ? (
            <EmptyState icon="🌙" title="No Active Sessions" message="No users are currently connected." />
          ) : (
            <div className="card">
              <Table
                columns={[
                  { key: 'full_name', label: 'User' },
                  { key: 'voucher_code', label: 'Voucher', width: '120px', render: (r: any) => <span className="code-cell">{r.voucher_code}</span> },
                  { key: 'auth_method', label: 'Auth', width: '100px', render: (r: any) => (
                    <Badge variant={r.auth_method === 'VOUCHER' ? 'active' : 'inactive'}>
                      {r.auth_method ?? (r.voucher_code ? 'VOUCHER' : 'MAC_AUTO')}
                    </Badge>
                  )},
                  { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
                  { key: 'ip_address', label: 'IP', width: '130px' },
                  { key: 'data_used_bytes', label: 'Data Used', width: '120px', render: (r: any) => {
                    const b = r.data_used_bytes || 0;
                    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
                    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
                    return '0 MB';
                  }},
                  { key: 'data_left_bytes', label: 'Data Left', width: '120px', render: (r: any) => {
                    if (r.is_uncapped) return 'Unlimited';
                    const b = r.data_left_bytes;
                    if (b == null) return '—';
                    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
                    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
                    return '0 MB';
                  }},
                  { key: 'status', label: 'Status', width: '90px', render: (r: any) => <Badge variant={r.active !== false ? 'active' : 'inactive'}>{r.active !== false ? 'Active' : 'Expired'}</Badge> },
                  { key: 'session_expires_at', label: 'Expires', width: '160px', render: (r: any) => {
                    if (!r.session_expires_at) return '—';
                    const expiringSoon = new Date(r.session_expires_at).getTime() - Date.now() < 1800000 && r.active !== false;
                    return <span style={expiringSoon ? { color: 'var(--orange)' } : {}}>{new Date(r.session_expires_at).toLocaleString()}{expiringSoon ? ' ⚠' : ''}</span>;
                  }},
                ]}
                data={portalSessions}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
