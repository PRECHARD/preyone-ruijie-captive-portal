import { useState, useEffect, useCallback } from 'react';
import { transitApi, systemApi } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Table from '../components/Table';
import Modal from '../components/Modal';
import { FiPlus, FiRefreshCw, FiGlobe, FiEdit2, FiEye, FiXCircle, FiAlertTriangle } from 'react-icons/fi';
import '../styles/pages.css';
import '../styles/transit.css';

interface TripRow {
  id: string;
  trip_no: string;
  bus_reg: string;
  route_code: string;
  route_name: string;
  route_from: string;
  route_to: string;
  departure_time: string;
  base_fare_cents: number;
  total_seats: number;
  seats_sold: number;
  driver: string;
  conductor1: string;
  conductor2: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  operator: string;
  ticket_count: number;
  total_cents: number;
  _companyId?: string;
  _driverId?: string;
}

interface ManifestTicket {
  seat_number: string;
  customer_name: string;
  customer_mobile: string;
  total_cents: number;
  client_receipt_no: string;
  payment_method: string;
  status: string;
  sale_time: string;
}

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

interface RouteOption { routeCode: string; routeFrom: string; routeTo: string; routeName: string; }
interface VehicleOption { registration: string; tripCount: number; }
interface StaffOption { id: string; full_name: string; username: string; role: string; status: string; }

const STATUS_FILTERS = ['ALL', 'SCHEDULED', 'ACTIVE', 'OPEN', 'COMPLETED', 'CANCELLED', 'CLOSED'] as const;
const NEW_ROUTE = '__new__';
const NEW_VEHICLE = '__new__';

function fmtMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtPax(seat: string): string {
  return seat ? `S${seat.padStart(2, '0')}` : 'S--';
}

function payLabel(method: string): string {
  const m = (method || 'cash').toLowerCase();
  if (m === 'ecocash') return 'ECO';
  if (m === 'cash') return 'CASH';
  return m.toUpperCase();
}

export default function Trips() {
  const { user } = useAuth();
  const isPlatform = !user?.companyId;

  const [rows, setRows] = useState<TripRow[]>([]);
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [drivers, setDrivers] = useState<StaffOption[]>([]);
  const [showNewRoute, setShowNewRoute] = useState(false);
  const [showNewVehicle, setShowNewVehicle] = useState(false);
  const [editing, setEditing] = useState<TripRow | null>(null);
  const [manifestTarget, setManifestTarget] = useState<TripRow | null>(null);
  const [manifestTickets, setManifestTickets] = useState<ManifestTicket[]>([]);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<TripRow | null>(null);
  const [form, setForm] = useState({
    companyId: '',
    routeKey: '',
    routeCode: '',
    routeFrom: '',
    routeTo: '',
    busReg: '',
    driverId: '',
    departure: '',
    fare: '',
    seats: '',
  });

  useEffect(() => {
    if (!isPlatform) return;
    systemApi.get<CompanyRow[]>('/companies')
      .then(setCompanies)
      .catch(() => {});
  }, [isPlatform]);

  const load = useCallback(async () => {
    try {
      setError('');
      if (isPlatform && !selectedCompany) {
        setRows([]);
        setLoading(false);
        return;
      }
      const qs = isPlatform && selectedCompany ? `?companyId=${selectedCompany}` : '';
      const data = await transitApi.get<{ trips: TripRow[] }>(`/trips${qs}`);
      setRows(data.trips);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isPlatform, selectedCompany]);

  useEffect(() => { load(); }, [load]);

  const loadLookups = useCallback(async (companyId: string) => {
    const qs = companyId ? `?companyId=${companyId}` : '';
    try {
      const [r, v, d] = await Promise.all([
        transitApi.get<{ routes: RouteOption[] }>(`/routes${qs}`),
        transitApi.get<{ vehicles: VehicleOption[] }>(`/fleet${qs}`),
        transitApi.get<{ staff: StaffOption[] }>(`/staff?role=DRIVER${companyId ? `&companyId=${companyId}` : ''}`),
      ]);
      setRoutes(r.routes);
      setVehicles(v.vehicles);
      setDrivers(d.staff);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const openCreate = () => {
    setError('');
    setForm(f => ({
      ...f,
      companyId: f.companyId || selectedCompany || (companies[0]?.id ?? ''),
    }));
    setShowNewRoute(false);
    setShowNewVehicle(false);
    setShowCreate(true);
    const target = form.companyId || selectedCompany || (companies[0]?.id ?? '') || (isPlatform ? '' : user?.companyId ?? '');
    loadLookups(target);
  };

  const selectRoute = (key: string) => {
    if (key === NEW_ROUTE) {
      setShowNewRoute(true);
      setForm(f => ({ ...f, routeKey: key, routeCode: '', routeFrom: '', routeTo: '' }));
      return;
    }
    setShowNewRoute(false);
    const r = routes.find(x => (x.routeName || x.routeCode || `${x.routeFrom} - ${x.routeTo}`) === key);
    if (!r) return;
    setForm(f => ({
      ...f,
      routeKey: key,
      routeCode: r.routeCode,
      routeFrom: r.routeFrom,
      routeTo: r.routeTo,
    }));
  };

  const selectVehicle = (reg: string) => {
    if (reg === NEW_VEHICLE) {
      setShowNewVehicle(true);
      setForm(f => ({ ...f, busReg: '' }));
      return;
    }
    setShowNewVehicle(false);
    setForm(f => ({ ...f, busReg: reg }));
  };

  const createTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const companyId = form.companyId || (isPlatform ? '' : user?.companyId ?? '');
    if (!companyId) { setError('A tenant company is required to schedule a trip.'); return; }
    if (!form.routeFrom.trim() || !form.routeTo.trim()) { setError('Route From and To are required.'); return; }
    if (!form.departure) { setError('Departure date & time are required.'); return; }
    const payload = {
      companyId: isPlatform ? companyId : undefined,
      routeCode: form.routeCode.trim(),
      routeFrom: form.routeFrom.trim(),
      routeTo: form.routeTo.trim(),
      busReg: form.busReg.trim(),
      driverId: form.driverId || undefined,
      departureTime: new Date(form.departure).toISOString(),
      baseFareCents: Math.round((parseFloat(form.fare) || 0) * 100),
      totalSeats: Math.max(0, Math.round(parseInt(form.seats, 10) || 0)),
    };
    setSaving(true);
    try {
      if (editing) {
        await transitApi.patch(`/trips/${editing.id}`, payload);
      } else {
        await transitApi.post('/trips', payload);
      }
      setShowCreate(false);
      setEditing(null);
      setForm({
        companyId: '', routeKey: '', routeCode: '', routeFrom: '', routeTo: '',
        busReg: '', driverId: '', departure: '', fare: '', seats: '',
      });
      setSelectedCompany(c => c || companyId);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (row: TripRow) => {
    setError('');
    setEditing(row);
    setForm({
      companyId: selectedCompany || row._companyId || '',
      routeKey: row.route_name || row.route_code || `${row.route_from} - ${row.route_to}`,
      routeCode: row.route_code || '',
      routeFrom: row.route_from || '',
      routeTo: row.route_to || '',
      busReg: row.bus_reg || '',
      driverId: row._driverId || '',
      departure: row.departure_time ? new Date(row.departure_time).toISOString().slice(0, 16) : '',
      fare: row.base_fare_cents ? (row.base_fare_cents / 100).toString() : '',
      seats: row.total_seats ? String(row.total_seats) : '',
    });
    setShowNewRoute(false);
    setShowNewVehicle(false);
    setShowCreate(true);
    const target = selectedCompany || (isPlatform ? '' : user?.companyId ?? '');
    loadLookups(target);
  };

  const openManifest = async (row: TripRow) => {
    setError('');
    setManifestTarget(row);
    setManifestTickets([]);
    setManifestLoading(true);
    try {
      const data = await transitApi.get<{ trip: any; tickets: ManifestTicket[] }>(`/trips/${row.id}`);
      setManifestTickets(data.tickets || []);
    } catch (err: any) {
      setError(err.message);
      setManifestTarget(null);
    } finally {
      setManifestLoading(false);
    }
  };

  const cancelTrip = async () => {
    if (!cancelTarget) return;
    setSaving(true);
    setError('');
    try {
      await transitApi.post(`/trips/${cancelTarget.id}/cancel`);
      setCancelTarget(null);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const filtered = statusFilter === 'ALL' ? rows : rows.filter(r => r.status === statusFilter);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Trip Schedules</h1>
          <p className="page-desc">Pre-scheduled routes created from the console, plus every trip opened by POS devices — with ticket counts, gross revenue and base fares.</p>
        </div>
        <div className="page-header-extra">
          <button className="btn-primary" onClick={openCreate} disabled={saving || (isPlatform && companies.length === 0)}><FiPlus /> Create Trip Schedule</button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {isPlatform && (
        <div className="card" style={{ marginBottom: 14, padding: 16 }}>
          <div className="tx-field" style={{ marginBottom: 0 }}>
            <label><FiGlobe style={{ verticalAlign: 'middle', marginRight: 6, color: 'var(--cyan)' }} />Tenant Company {companies.length > 0 && '(Level 0 — cross-company)'}</label>
            <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)}>
              <option value="">Select a tenant company…</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
            </select>
            {!selectedCompany && (
              <div className="tx-muted" style={{ marginTop: 6 }}>Choose a company to view or schedule its trips. Level 0 admins are not bound to a single tenant.</div>
            )}
          </div>
        </div>
      )}

      <div className="tx-toolbar">
        <div className="tx-tabs">
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              className={'tx-tab' + (statusFilter === s ? ' active' : '')}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL' ? 'All' : s}
            </button>
          ))}
        </div>
        <button className="btn-secondary" onClick={load}><FiRefreshCw /> Refresh</button>
      </div>

      <div className="card">
        {loading ? (
          <div className="table-empty">Loading trips…</div>
        ) : (
          <Table<TripRow>
            columns={[
              { key: 'trip_no', label: 'Trip No', render: r => <span style={{ fontWeight: 700 }}>{r.trip_no}</span> },
              { key: 'bus_reg', label: 'Bus Reg', render: r => <span>{r.bus_reg || '—'}</span> },
              { key: 'route', label: 'Route', render: r => (
                <span>
                  {r.route_name || r.route_code || '—'}
                  <span className="tx-muted"> · {r.departure_time ? new Date(r.departure_time).toLocaleString() : ''}</span>
                </span>
              )},
              { key: 'fare', label: 'Base Fare', render: r => (
                <span className="tx-num">{r.base_fare_cents ? fmtMoney(r.base_fare_cents) : '—'}</span>
              )},
              { key: 'crew', label: 'Crew', render: r => (
                <span className="tx-muted">{(r.driver && 'Driver: ' + r.driver) + (r.conductor1 ? ` · Cond: ${r.conductor1}` : '')}</span>
              )},
              { key: 'ticket_count', label: 'Tickets', render: r => (
                <span className="tx-num">{r.ticket_count}{r.total_seats ? ` / ${r.total_seats}` : ''}</span>
              )},
              { key: 'total_cents', label: 'Gross', render: r => <span className="tx-num tx-num--green">{fmtMoney(r.total_cents || 0)}</span> },
              { key: 'status', label: 'Status', render: r => <span className={'status-chip status-chip--' + r.status.toLowerCase()}>{r.status}</span> },
              { key: 'opened_at', label: 'Opened', render: r => r.opened_at ? new Date(r.opened_at).toLocaleString() : '—' },
              { key: 'actions', label: 'Actions', render: r => (
                <span className="tx-actions">
                  <button
                    className="btn-secondary"
                    title="View manifest"
                    onClick={() => openManifest(r)}
                  >
                    <FiEye /> Manifest
                  </button>
                  {r.status === 'SCHEDULED' && (
                    <>
                      <button className="btn-secondary" title="Edit schedule" onClick={() => openEdit(r)}>
                        <FiEdit2 /> Edit
                      </button>
                      <button className="tx-btn-danger" title="Cancel schedule" onClick={() => setCancelTarget(r)}>
                        <FiXCircle /> Cancel
                      </button>
                    </>
                  )}
                </span>
              )},
            ]}
            data={filtered}
            emptyMessage={statusFilter === 'SCHEDULED' && !loading ? 'No scheduled trips yet. Tap “Create Trip Schedule” to pre-schedule one for POS crews.' : 'No trips recorded yet.'}
          />
        )}
      </div>

      <Modal open={showCreate} onClose={() => { setShowCreate(false); setEditing(null); }} title={editing ? `Edit Trip ${editing.trip_no}` : 'Create Trip Schedule'}>
        <form onSubmit={createTrip}>
          {isPlatform && (
            <div className="tx-form-row tx-form-row--1">
              <div className="tx-field"><label>Tenant Company *</label>
                <select
                  value={form.companyId}
                  onChange={e => {
                    setForm({ ...form, companyId: e.target.value });
                    if (e.target.value) loadLookups(e.target.value);
                  }}
                >
                  <option value="">Select a tenant company…</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.slug})</option>)}
                </select>
              </div>
            </div>
          )}

          <div className="tx-form-row tx-form-row--1">
            <div className="tx-field">
              <label>Route *</label>
              <select value={form.routeKey} onChange={e => selectRoute(e.target.value)}>
                <option value="">Select a route…</option>
                {routes.map(r => (
                  <option key={r.routeName || r.routeCode || `${r.routeFrom} - ${r.routeTo}`} value={r.routeName || r.routeCode || `${r.routeFrom} - ${r.routeTo}`}>
                    {(r.routeName || `${r.routeFrom} - ${r.routeTo}` || r.routeCode) + (r.routeCode ? `  ·  ${r.routeCode}` : '')}
                  </option>
                ))}
                <option value={NEW_ROUTE}>＋ New route…</option>
              </select>
              {showNewRoute && (
                <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input style={{ flex: '1 1 90px' }} value={form.routeCode} onChange={e => setForm({ ...form, routeCode: e.target.value.toUpperCase() })} placeholder="Route code (e.g. R1)" />
                  <input style={{ flex: '1 1 130px' }} value={form.routeFrom} onChange={e => setForm({ ...form, routeFrom: e.target.value })} placeholder="From (e.g. Harare)" required />
                  <input style={{ flex: '1 1 130px' }} value={form.routeTo} onChange={e => setForm({ ...form, routeTo: e.target.value })} placeholder="To (e.g. Bulawayo)" required />
                </div>
              )}
            </div>
          </div>

          <div className="tx-form-row">
            <div className="tx-field">
              <label>Vehicle</label>
              <select value={form.busReg || ''} onChange={e => selectVehicle(e.target.value)}>
                <option value="">No vehicle yet</option>
                {vehicles.map(v => <option key={v.registration} value={v.registration}>{v.registration}</option>)}
                <option value={NEW_VEHICLE}>＋ Custom registration…</option>
              </select>
              {showNewVehicle && (
                <input
                  style={{ marginTop: 8 }}
                  value={form.busReg}
                  onChange={e => setForm({ ...form, busReg: e.target.value })}
                  placeholder="Bus registration (e.g. AAG-1234)"
                />
              )}
            </div>
            <div className="tx-field">
              <label>Assigned Driver</label>
              <select value={form.driverId} onChange={e => setForm({ ...form, driverId: e.target.value })}>
                <option value="">No driver yet (assign at POS)</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.full_name} (@{d.username})</option>)}
              </select>
            </div>
          </div>

          <div className="tx-form-row">
            <div className="tx-field">
              <label>Departure Date &amp; Time *</label>
              <input type="datetime-local" value={form.departure} onChange={e => setForm({ ...form, departure: e.target.value })} required />
            </div>
            <div className="tx-field">
              <label>Base Ticket Fare</label>
              <input inputMode="decimal" value={form.fare} onChange={e => setForm({ ...form, fare: e.target.value })} placeholder="e.g. 5.00" />
            </div>
            <div className="tx-field">
              <label>Total Seats (optional)</label>
              <input inputMode="numeric" value={form.seats} onChange={e => setForm({ ...form, seats: e.target.value })} placeholder="e.g. 62" />
            </div>
          </div>

          {isPlatform && !form.companyId && (
            <div className="auth-error" style={{ marginBottom: 14 }}>Select a tenant company first — none are available for scheduling.</div>
          )}
          {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn-primary" disabled={saving || (isPlatform && !form.companyId)}>{editing ? 'Save Changes' : <><FiPlus /> Schedule Trip</>}</button>
          </div>
        </form>
      </Modal>

      <Modal open={!!manifestTarget} onClose={() => setManifestTarget(null)} title={manifestTarget ? `Manifest — ${manifestTarget.trip_no} · ${manifestTarget.route_name || manifestTarget.route_code || `${manifestTarget.route_from} → ${manifestTarget.route_to}`}` : 'Manifest'}>
        {manifestLoading ? (
          <div className="table-empty">Loading manifest…</div>
        ) : manifestTickets.length === 0 ? (
          <div className="table-empty">No tickets sold on this trip yet.</div>
        ) : (
          <div className="tx-manifest">
            <div className="tx-manifest-head">
              <span>Bus {manifestTarget?.bus_reg || '—'} · {new Date(manifestTarget!.departure_time).toLocaleString()}</span>
              <span>{manifestTickets.length} passenger{manifestTickets.length === 1 ? '' : 's'} · {fmtMoney(manifestTickets.reduce((s, t) => s + (t.total_cents || 0), 0))}</span>
            </div>
            <div className="card-table"><table className="tx-table">
              <thead>
                <tr>
                  <th>Seat</th><th>Passenger</th><th>Mobile</th><th>Receipt</th><th>Pay</th><th>Fare</th>
                </tr>
              </thead>
              <tbody>
                {manifestTickets.map((t, i) => (
                  <tr key={t.client_receipt_no || i}>
                    <td><span className="tx-seat">{fmtPax(t.seat_number)}</span></td>
                    <td><span className="tx-muted">{t.customer_name || '—'}</span></td>
                    <td><span className="tx-muted">{t.customer_mobile || '—'}</span></td>
                    <td><span className="tx-muted">{t.client_receipt_no || '—'}</span></td>
                    <td><span className="tx-muted">{payLabel(t.payment_method)}</span></td>
                    <td><span className="tx-num">{fmtMoney(t.total_cents || 0)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="tx-muted" style={{ marginTop: 12, marginBottom: 0 }}>Sold at {manifestTickets[0] ? new Date(manifestTickets[0].sale_time).toLocaleString() : ''}</p>
          </div>
        )}
      </Modal>

      <Modal open={!!cancelTarget} onClose={() => setCancelTarget(null)} title="Cancel trip schedule">
        <div className="tx-confirm">
          <FiAlertTriangle size={44} color="var(--red, #d64545)" />
          <p>
            Cancel trip <strong>{cancelTarget?.trip_no}</strong>
            {cancelTarget?.route_name ? ` (${cancelTarget.route_name})` : ''}
            {cancelTarget?.departure_time ? ` scheduled for ${new Date(cancelTarget.departure_time).toLocaleString()}` : ''}?
          </p>
          <p className="tx-muted">Cancelling is soft — the schedule is marked <strong>CANCELLED</strong> and hidden from ticket sales. This cannot be undone from the console (a new trip may be created instead).</p>
          {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-secondary" onClick={() => setCancelTarget(null)} disabled={saving}>Keep schedule</button>
            <button className="tx-btn-danger-solid" onClick={cancelTrip} disabled={saving}>{saving ? 'Cancelling…' : 'Cancel trip'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}