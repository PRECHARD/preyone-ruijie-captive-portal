import { useState, useEffect, useCallback } from 'react';
import { api, ruijieApi } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';
import Badge from '../components/Badge';
import { showToast } from '../utils/toast';

interface RgSession {
  mac: string; ip: string | null; username: string | null;
  usedMb: number | null; onlineTimeSec: number | null;
  ssid: string | null; band: string | null; rssi: number | null;
  upRate: number | null; downRate: number | null;
  code: string | null; holderName: string | null; holderPhone: string | null;
}

function fmtRate(r?: number | null): string {
  if (r == null) return '—';
  if (r >= 1000) return (r / 1000).toFixed(1) + ' Mbps';
  return Math.round(r) + ' kbps';
}

function fmtMb(mb?: number | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(1) + ' MB';
}

function fmtOnline(s?: number | null): string {
  if (s == null || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export default function Sessions() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [rg, setRg] = useState<{ users: RgSession[]; skipped: boolean; reason?: string } | null>(null);
  const [kicking, setKicking] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/active-sessions')); } catch { /* ignore */ }
    try {
      const r = await ruijieApi.get<{ skipped: boolean; reason?: string; users?: RgSession[] }>('/sessions');
      setRg({ users: r?.skipped ? [] : (r.users || []), skipped: !!r?.skipped, reason: r?.reason });
    } catch { setRg({ users: [], skipped: true, reason: 'cloud_error' }); }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  // Kick: backend returns {skipped:true} when Ruijie exposes no disconnect API —
  // surface that honestly instead of faking a success.
  const kickClient = async (s: RgSession) => {
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

  const sessions = data?.activeUsers || [];
  const cloud = rg?.users || [];
  const useCloud = cloud.length > 0;

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

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Active Sessions</span><span className="stat-number" style={{ color: 'var(--green)' }}>{data?.totalActive || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Cloud Clients</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{cloud.length}</span></div>
        <div className="stat-card"><span className="stat-label">Total Redeemed</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{data?.totalRedeemed || 0}</span></div>
      </div>

      {useCloud ? (
        <div className="card">
          <Table
            columns={[
              { key: 'holderName', label: 'Holder', render: (r: any) => (
                <span>
                  {r.holderName || '—'}
                  {r.holderPhone && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{r.holderPhone}</span>}
                </span>
              ) },
              { key: 'pin', label: 'Voucher', width: '120px', render: (r: any) => r.pin ? <span className="code-cell">{r.pin}</span> : '—' },
              { key: 'mac', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac}</code> },
              { key: 'ip', label: 'IP', width: '120px', render: (r: any) => r.ip || '—' },
              { key: 'ssid', label: 'SSID · Band', width: '140px', render: (r: any) => (
                <span style={{ fontSize: 12 }}>{r.ssid || '—'}{r.band ? <span className="muted"> · {r.band}</span> : ''}</span>
              ) },
              { key: 'rssi', label: 'Signal', width: '90px', render: (r: any) => r.rssi != null ? <span style={{ fontSize: 12 }}>{r.rssi} dBm</span> : '—' },
              { key: 'speed', label: 'Speed ↓/↑', width: '120px', render: (r: any) => (
                <span className="muted" style={{ fontSize: 11 }}>{fmtRate(r.downRate)} ↓<br />{fmtRate(r.upRate)} ↑</span>
              ) },
              { key: 'usedMb', label: 'Data Used', width: '100px', render: (r: any) => <span style={{ fontSize: 12 }}>{fmtMb(r.usedMb)}</span> },
              { key: 'onlineTimeSec', label: 'Online', width: '90px', render: (r: any) => <span className="muted" style={{ fontSize: 12 }}>{fmtOnline(r.onlineTimeSec)}</span> },
              { key: 'actions', label: 'Actions', width: '90px', render: (r: any) => (
                <button
                  className="btn-sm"
                  disabled={kicking === r.mac}
                  onClick={() => kickClient(r as any)}
                  aria-label={`Disconnect client ${r.mac}`}
                >
                  {kicking === r.mac ? '…' : 'Kick'}
                </button>
              ) },
            ]}
            data={cloud.map((s) => ({
              ...s,
              pin: s.code || s.username || null,
            }))}
          />
        </div>
      ) : (
        <>
          {rg?.skipped && (
            <div className="card" style={{ marginBottom: 16, padding: 12 }}>
              <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                Ruijie Cloud telemetry unavailable{rg.reason ? ` (${rg.reason})` : ''} — showing portal sessions.
              </p>
            </div>
          )}
          {sessions.length === 0 ? (
            <EmptyState icon="🌙" title="No Active Sessions" message="No users are currently connected." />
          ) : (
            <div className="card">
              <Table
                columns={[
                  { key: 'full_name', label: 'User' },
                  { key: 'voucher_code', label: 'Voucher', width: '120px', render: (r: any) => <span className="code-cell">{r.voucher_code}</span> },
                  { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
                  { key: 'ip_address', label: 'IP', width: '130px' },
                  { key: 'data_used_bytes', label: 'Data Used', width: '120px', render: (r: any) => {
                    const b = r.data_used_bytes || 0;
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
                data={sessions}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
