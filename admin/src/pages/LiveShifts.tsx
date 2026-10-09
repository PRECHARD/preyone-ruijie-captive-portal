import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import Table from '../components/Table';
import { FiRefreshCw, FiRadio } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface ShiftRow {
  id: string;
  driverId: string;
  driverName: string;
  vehicleReg: string;
  status: 'OPEN' | 'CLOSED';
  notes: string;
  startedAt: string | null;
  closedAt: string | null;
  conductorName: string;
  conductorUsername: string;
  deviceUuid: string;
  companyName: string;
  currency: string;
  ticketCount: number;
  totalCents: number;
}

function fmtMoney(cents: number, currency: string) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function fmtStart(d: string | null) {
  if (!d) return '—';
  const start = new Date(d);
  const diff = Date.now() - start.getTime();
  const mins = Math.round(diff / 60000);
  const when = start.toLocaleString();
  if (mins < 1) return `${when} (just now)`;
  if (mins < 60) return `${when} (${mins}m)`;
  const hrs = Math.floor(mins / 60);
  return `${when} (${hrs}h ${mins % 60}m)`;
}

export default function LiveShifts() {
  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState<string>('');

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setError('');
      const data = await transitApi.get<{ shifts: ShiftRow[] }>('/shifts');
      setRows(data.shifts);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  const open = rows.filter(r => r.status === 'OPEN');
  const openTickets = open.reduce((n, r) => n + (r.ticketCount || 0), 0);
  const openCents = open.reduce((n, r) => n + (r.totalCents || 0), 0);
  const openCurrency = open[0]?.currency || rows[0]?.currency || 'USD';

  const summary = [
    { label: 'Open Shifts', value: String(open.length), cls: 'tx-num--green' },
    { label: 'Tickets Issued (Open)', value: String(openTickets), cls: 'tx-num' },
    { label: 'Live Revenue (Open)', value: fmtMoney(openCents, openCurrency), cls: 'tx-num--gold' },
    { label: 'All Shifts', value: String(rows.length), cls: 'tx-num' },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Live Shift Monitoring</h1>
          <p className="page-desc">
            Real-time shifts across every POS terminal. Ticket counts and revenue are computed
            live from confirmed sales on each shift.
          </p>
        </div>
        <div className="tx-actions">
          <button className="btn-secondary" onClick={() => load()}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="tx-summary">
        {summary.map(s => (
          <div key={s.label} className="tx-card">
            <span className="tx-card-label">{s.label}</span>
            <span className={`tx-num ${s.cls}`}>{s.value}</span>
          </div>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading shifts…</div>
        ) : (
          <Table<ShiftRow>
            columns={[
              { key: 'driverName', label: 'Driver', render: r => (
                <span>
                  <b style={{ color: 'var(--text)' }}>{r.driverName}</b>
                  {r.driverId && <div className="tx-muted">#{r.driverId.slice(0, 8)}</div>}
                </span>
              )},
              { key: 'conductorName', label: 'Conductor', render: r => (
                <span>
                  {r.conductorName}
                  {r.conductorUsername && r.conductorUsername !== r.conductorName && <div className="tx-muted">@{r.conductorUsername}</div>}
                </span>
              )},
              { key: 'vehicleReg', label: 'Vehicle Reg', render: r => <span style={{ fontFamily: 'var(--font-display)', letterSpacing: 1 }}>{r.vehicleReg}</span> },
              { key: 'startedAt', label: 'Shift Start', render: r => <span className="tx-muted">{fmtStart(r.startedAt)}</span> },
              { key: 'status', label: 'Status', render: r => (
                <span className={'status-chip status-chip--' + r.status.toLowerCase()}>{r.status}</span>
              )},
              { key: 'ticketCount', label: 'Tickets', render: r => (
                <span className="tx-num">{r.ticketCount}</span>
              )},
              { key: 'totalCents', label: 'Revenue', render: r => (
                <span className="tx-num tx-num--gold">{fmtMoney(r.totalCents, r.currency)}</span>
              )},
              { key: 'deviceUuid', label: 'Terminal', render: r => (r.deviceUuid ? <span className="tx-muted">{r.deviceUuid}</span> : <span className="tx-muted">—</span>) },
            ]}
            data={rows}
            emptyMessage="No shifts recorded yet."
          />
        )}
        <div className="tx-muted" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <FiRadio /> Auto-refreshes every 30s{lastUpdate ? ` · last updated ${lastUpdate}` : ''}
        </div>
      </div>
    </div>
  );
}