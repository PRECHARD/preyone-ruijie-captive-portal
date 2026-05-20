import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Table from '../components/Table';

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  const gb = b / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = b / 1e6;
  return `${mb.toFixed(1)} MB`;
}

export default function Bandwidth() {
  const [bw, setBw] = useState<any>(null);
  const [top, setTop] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setBw(await api.get('/bandwidth')); } catch { /* ignore */ }
    try { setTop(await api.get('/bandwidth/top-users')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  if (loading) return <Spinner />;
  if (!bw) return <EmptyState icon="📊" title="No Bandwidth Data" message="No bandwidth data available yet." />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Bandwidth Monitor</h2>
          <p className="page-desc">{bw.activeNow || 0} active now · {bw.totalProfiles || 0} total profiles</p>
        </div>
      </div>

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Total Used</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>{fmtBytes(bw.totalBytesUsed)}</span></div>
        <div className="stat-card"><span className="stat-label">Total Quota</span><span className="stat-number" style={{ color: 'var(--green)' }}>{fmtBytes(bw.totalQuota)}</span></div>
        <div className="stat-card"><span className="stat-label">Active Now</span><span className="stat-number" style={{ color: 'var(--orange)' }}>{bw.activeNow || 0}</span></div>
        <div className="stat-card"><span className="stat-label">Total Profiles</span><span className="stat-number" style={{ color: 'var(--pink)' }}>{bw.totalProfiles || 0}</span></div>
      </div>

      {bw.hourly?.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
            Hourly Bandwidth (24h)
          </div>
          <div style={{ padding: 16, display: 'flex', gap: 2, alignItems: 'flex-end', height: 120 }}>
            {bw.hourly.map((h: any, i: number) => {
              const max = Math.max(...bw.hourly.map((x: any) => x.bytes_total || 0), 1);
              const pct = ((h.bytes_total || 0) / max) * 100;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ width: '100%', background: 'linear-gradient(to top, var(--purple), var(--cyan))', borderRadius: '3px 3px 0 0', height: `${Math.max(pct, 2)}%`, minHeight: 4, transition: 'height 0.3s' }} title={`${fmtBytes(h.bytes_total)}`} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {top.length > 0 && (
        <div className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>
            Top Bandwidth Consumers
          </div>
          <Table
            columns={[
              { key: 'full_name', label: 'User' },
              { key: 'voucher_code', label: 'Voucher', width: '120px', render: (r: any) => <span className="code-cell">{r.voucher_code}</span> },
              { key: 'mac_address', label: 'MAC', width: '150px', render: (r: any) => <code style={{ fontSize: 11 }}>{r.mac_address || '—'}</code> },
              { key: 'bytes_used', label: 'Data Used', width: '100px', render: (r: any) => fmtBytes(r.bytes_used) },
              { key: 'package_tier', label: 'Package', width: '100px' },
            ]}
            data={top}
          />
        </div>
      )}
    </div>
  );
}
