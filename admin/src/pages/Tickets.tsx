import { useState, useEffect, useCallback } from 'react';
import { transitApi } from '../api/client';
import Table from '../components/Table';
import { FiRefreshCw } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface TicketRow {
  id: string;
  tx_id: string;
  client_receipt_no: string;
  trip_no: string;
  route_code: string;
  route_name: string;
  seat_number: string;
  customer_name: string;
  customer_mobile: string;
  total_cents: number;
  cash_cents: number;
  change_cents: number;
  status: string;
  sale_time: string;
  synced_at: string;
  conductor1: string;
  driver: string;
  operator: string;
  currency: string;
}

const fmt = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;

export default function Tickets() {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tripFilter, setTripFilter] = useState('ALL');
  const [limit, setLimit] = useState('200');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await transitApi.get<{ tickets: TicketRow[] }>(`/tickets?limit=${limit}`);
      setRows(data.tickets);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { load(); }, [load]);

  const tripNos = Array.from(new Set(rows.map(r => r.trip_no).filter(Boolean))).sort();
  const filtered = tripFilter === 'ALL' ? rows : rows.filter(r => r.trip_no === tripFilter);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Ticket Manifest</h1>
          <p className="page-desc">All signed ticket sales synced from POS devices, newest first.</p>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="tx-toolbar">
        <select value={tripFilter} onChange={e => setTripFilter(e.target.value)}>
          <option value="ALL">All trips</option>
          {tripNos.map(t => <option key={t} value={t}>Trip {t}</option>)}
        </select>
        <select value={limit} onChange={e => setLimit(e.target.value)}>
          <option value="100">100 rows</option>
          <option value="200">200 rows</option>
          <option value="500">500 rows</option>
        </select>
        <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading manifest…</div>
        ) : (
          <Table<TicketRow>
            columns={[
              { key: 'client_receipt_no', label: 'Receipt', render: r => (
                <span>
                  <span style={{ fontWeight: 700 }}>{r.client_receipt_no}</span>
                  <div className="tx-muted">{r.sale_time}</div>
                </span>
              )},
              { key: 'trip', label: 'Trip', render: r => <span>{r.trip_no ? `#${r.trip_no}` : '—'} <span className="tx-muted">{r.route_code}</span></span> },
              { key: 'route_name', label: 'Route' },
              { key: 'seat_number', label: 'Seat', render: r => <span className="tx-muted">{r.seat_number || '—'}</span> },
              { key: 'customer', label: 'Customer', render: r => (
                <span>
                  {r.customer_name || 'Cash'}
                  {r.customer_mobile && <div className="tx-muted">{r.customer_mobile}</div>}
                </span>
              )},
              { key: 'amounts', label: 'Amounts', render: r => (
                <span>
                  <span className="tx-num tx-num--green">{fmt(r.total_cents, r.currency)}</span>
                  {r.cash_cents > 0 && <div className="tx-muted">cash {fmt(r.cash_cents, r.currency)}{r.change_cents > 0 ? ` / chg ${fmt(r.change_cents, r.currency)}` : ''}</div>}
                </span>
              )},
              { key: 'conductor1', label: 'Conductor' },
              { key: 'status', label: 'Status', render: r => (
                <span className={'status-chip status-chip--' + (r.status === 'SYNCED' ? 'ok' : r.status === 'CANCELLED' ? 'cancelled' : 'conflict')}>{r.status}</span>
              )},
              { key: 'synced_at', label: 'Synced', render: r => <span className="tx-muted">{new Date(r.synced_at).toLocaleString()}</span> },
            ]}
            data={filtered}
            emptyMessage="No tickets synced yet."
          />
        )}
      </div>
    </div>
  );
}