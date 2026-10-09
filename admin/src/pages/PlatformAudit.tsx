import { useState, useEffect, useCallback } from 'react';
import { systemApi } from '../api/client';
import { FiSearch, FiAlertTriangle } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface LogRow {
  source: string;
  created_at: string;
  actor: string | null;
  action: string;
  target_type: string;
  entity_id: string;
  detail: string | null;
}

export default function PlatformAudit() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      setError('');
      setRows(await systemApi.get<LogRow[]>('/system-logs'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refresh]);

  const filtered = rows.filter(r => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return [r.action, r.actor, r.entity_id, r.detail, r.target_type].some(v => (v || '').toLowerCase().includes(q));
  });

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Platform Audit Trail</h1>
          <p className="page-desc">Union of admin, transit and security events across the whole platform. Level 0 only.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn-secondary" onClick={() => setRefresh(x => x + 1)}>Refresh</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="tx-toolbar">
        <div className="tx-field" style={{ position: 'relative', minWidth: 260 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search action, actor, entity…" style={{ paddingLeft: 32 }} />
          <FiSearch style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-dim)' }} />
        </div>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="all">All sources</option>
          <option value="admin">Admin</option>
          <option value="transit">Transit</option>
          <option value="security">Security</option>
        </select>
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading audit trail…</div>
        ) : (
          <div className="card-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }} className="tx-muted">{new Date(r.created_at).toLocaleString()}</td>
                    <td>
                      <span className={'status-chip status-chip--' + (r.source === 'security' ? 'severe' : r.source === 'admin' ? 'ok' : 'active')}>
                        {r.source}
                      </span>
                    </td>
                    <td>{r.actor || <span className="tx-muted">—</span>}</td>
                    <td style={{ fontWeight: 700 }}>{r.action}</td>
                    <td className="tx-muted">{r.target_type}{r.entity_id ? ` / ${r.entity_id}` : ''}</td>
                    <td className="tx-muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.detail || '—'}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="table-empty"><FiAlertTriangle style={{ verticalAlign: 'middle' }} /> No events found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}