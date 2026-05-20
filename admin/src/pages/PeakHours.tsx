import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';

export default function PeakHours() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try { setData(await api.get('/peak-hours')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <Spinner />;
  if (!data) return <EmptyState icon="📈" title="No Peak Hour Data" />;

  const signupHours = data.signupHours || [];
  const accessHours = data.accessHours || [];
  const dailyPeaks = data.dailyPeaks || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Peak Hours Analytics</h2>
          <p className="page-desc">30-day usage analysis</p>
        </div>
      </div>

      <div className="stats-grid stats-grid--compact" style={{ marginBottom: 20 }}>
        <div className="stat-card"><span className="stat-label">Peak Signup Hour</span><span className="stat-number" style={{ color: 'var(--cyan)' }}>
          {signupHours.reduce((a: any, b: any) => (b.count || 0) > (a.count || 0) ? b : a, { count: 0 }).hour || '—'}
        </span></div>
        <div className="stat-card"><span className="stat-label">Peak Access Hour</span><span className="stat-number" style={{ color: 'var(--green)' }}>
          {accessHours.reduce((a: any, b: any) => (b.count || 0) > (a.count || 0) ? b : a, { count: 0 }).hour || '—'}
        </span></div>
        <div className="stat-card"><span className="stat-label">Days Analyzed</span><span className="stat-number" style={{ color: 'var(--pink)' }}>{dailyPeaks.length}</span></div>
      </div>

      {signupHours.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Signups by Hour</div>
          <div style={{ padding: 16 }}>
            <div className="bar-chart">
              {Array.from({ length: 24 }, (_, h) => {
                const found = signupHours.find((s: any) => Number(s.hour) === h);
                const max = Math.max(...signupHours.map((s: any) => s.count || 0), 1);
                const pct = ((found?.count || 0) / max) * 100;
                return (
                  <div key={h} className="bar-col">
                    <div className="bar" style={{ height: `${Math.max(pct, 2)}%` }} title={`Hour ${h}: ${found?.count || 0}`} />
                    <span className="bar-label">{h}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {dailyPeaks.length > 0 && (
        <div className="card">
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: 13 }}>Daily Peaks</div>
          <div className="card-table">
            <table className="data-table">
              <thead><tr><th>Date</th><th>Peak Hour</th><th>Signups</th><th>Access Events</th></tr></thead>
              <tbody>
                {dailyPeaks.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.date || '—'}</td>
                    <td><span className="code-cell">{d.peak_hour || d.hour || '—'}</span></td>
                    <td>{d.signups ?? d.count ?? '—'}</td>
                    <td>{d.access_events ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
