import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { FiDownload, FiSearch, FiX } from 'react-icons/fi';
import { api, getToken } from '../api/client';
import Spinner from '../components/Spinner';
import Table from '../components/Table';
import './StarlinkAdmin.css';

type Tab = 'overview' | 'customers' | 'applications' | 'transactions' | 'kits' | 'plans';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'customers', label: 'Customers' },
  { id: 'applications', label: 'Applications' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'kits', label: 'Kits' },
  { id: 'plans', label: 'Plans & Capacity' },
];

type Overview = {
  totalCustomers: number;
  verifiedCustomers: number;
  customersWithPlan: number;
  activeKits: number;
  pendingApplications: number;
  paidThisMonthUsd: number;
  pendingInvoices: { count: number; usd: number };
  monthlyRecurringUsd: number;
  byPlan: Array<{ code: string; name: string; priceUsd: number; subscribers: number }>;
};

type Customer = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  planCode: string | null;
  planName: string | null;
  emailVerifiedAt: string | null;
  walletBalance: number;
  kitCount: number;
  createdAt: string;
};

type Kit = {
  id: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  kitNumber: string;
  nickname: string;
  status: string;
  dataUsageGb: number;
  dataCreditGb: number;
  createdAt: string;
};

type Invoice = {
  id: string;
  invoiceNumber: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  amount: number;
  currency: string;
  description: string;
  kind: string;
  status: string;
  paymentReference: string | null;
  issuedDate: string | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
};

type Application = {
  id: string;
  customerId?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  fromPlanCode: string | null;
  fromPlanName: string | null;
  toPlanCode: string;
  toPlanName: string;
  requestedStart: string;
  status: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
};

type PlanRow = {
  code: string;
  name: string;
  priceUsd: number;
  cadence: string;
  rank: number;
  perks: string[];
  capacity: number;
  active: number;
  seatsLeft: number;
};

type CustomerDetail = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  planCode: string | null;
  planName: string | null;
  planRenewsAt: string | null;
  emailVerifiedAt: string | null;
  walletBalance: number;
  createdAt: string;
  kits: Kit[];
  invoices: Invoice[];
  applications: Application[];
};

const KIND_LABELS: Record<string, string> = {
  wallet_topup: 'Wallet top-up',
  data_topup: 'Data top-up',
  kit_purchase: 'Kit purchase',
  service: 'Service',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  APPROVED: 'Approved',
  REJECTED: 'Declined',
  active: 'Active',
  paused: 'Paused',
};

const STATUS_TONE: Record<string, string> = {
  PENDING: 'warn',
  PAID: 'ok',
  FAILED: 'bad',
  APPROVED: 'ok',
  REJECTED: 'bad',
  active: 'ok',
  paused: 'warn',
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function usd(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDay(v: string | null | undefined): string {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
}

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

function fmtGb(n: number | null | undefined): string {
  return `${Number(n ?? 0).toFixed(1)} GB`;
}

function useApi<T>(path: string) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get<T>(path)
      .then((data) => {
        if (live) setState({ data, error: null, loading: false });
      })
      .catch((e) => {
        if (live) setState({ data: null, error: errMsg(e), loading: false });
      });
    return () => {
      live = false;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

function useDebounced(value: string, delay = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`sla-badge sla-badge--${tone}`}>{children}</span>;
}

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'muted'}>{STATUS_LABELS[status] ?? status}</Badge>;
}

function Notice({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  return (
    <div className={`sla-alert sla-alert--${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      {text}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="sla-search">
      <FiSearch aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  );
}

export default function StarlinkAdmin() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="page sla">
      <div className="page-header">
        <div>
          <h2 className="page-title">Starlink</h2>
          <p className="page-desc">Customers, kits, plan applications, payments and package capacity for Starlink service.</p>
        </div>
      </div>

      <div className="sla-tabs" role="tablist" aria-label="Starlink sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={'sla-tab' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab onOpen={setTab} />}
      {tab === 'customers' && <CustomersTab />}
      {tab === 'applications' && <ApplicationsTab />}
      {tab === 'transactions' && <TransactionsTab />}
      {tab === 'kits' && <KitsTab />}
      {tab === 'plans' && <PlansTab />}
    </div>
  );
}

function OverviewTab({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const { data, error, loading } = useApi<Overview>('/starlink/overview');

  if (loading && !data) return <Spinner />;
  if (error && !data) return <Notice kind="err" text={error} />;
  if (!data) return null;

  const cards = [
    { label: 'Customers', value: data.totalCustomers.toLocaleString(), sub: `${data.verifiedCustomers} verified`, color: 'cyan', tab: 'customers' as Tab },
    { label: 'Subscribers', value: data.customersWithPlan.toLocaleString(), sub: 'With a package', color: 'violet', tab: 'customers' as Tab },
    { label: 'Active kits', value: data.activeKits.toLocaleString(), sub: 'Kits in service', color: 'green', tab: 'kits' as Tab },
    { label: 'Pending applications', value: data.pendingApplications.toLocaleString(), sub: 'Awaiting a decision', color: 'orange', tab: 'applications' as Tab },
    { label: 'Paid this month', value: usd(data.paidThisMonthUsd), sub: 'USD collected', color: 'green', tab: 'transactions' as Tab },
    { label: 'Pending invoices', value: usd(data.pendingInvoices.usd), sub: `${data.pendingInvoices.count} open`, color: 'gold', tab: 'transactions' as Tab },
    { label: 'Monthly recurring', value: usd(data.monthlyRecurringUsd), sub: 'From package prices', color: 'blue', tab: 'plans' as Tab },
  ];

  return (
    <>
      <div className="stats-grid sla-kpis">
        {cards.map((c) => (
          <button key={c.label} type="button" className={`stat-card stat-${c.color} clickable sla-kpi`} onClick={() => onOpen(c.tab)}>
            <span className="stat-label">{c.label}</span>
            <span className="stat-number">{c.value}</span>
            <span className="stat-sub">{c.sub}</span>
          </button>
        ))}
      </div>

      <div className="card sla-card">
        <div className="sla-card-head">
          <h3>Subscribers by package</h3>
        </div>
        <div className="card-table sla-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Package</th>
                <th>Price / month</th>
                <th>Subscribers</th>
                <th>Monthly value</th>
              </tr>
            </thead>
            <tbody>
              {data.byPlan.map((p) => (
                <tr key={p.code}>
                  <td>{p.name}</td>
                  <td>{usd(p.priceUsd)}</td>
                  <td>{p.subscribers}</td>
                  <td>{usd(p.priceUsd * p.subscribers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function CustomersTab() {
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const debounced = useDebounced(search.trim());
  const plans = useApi<PlanRow[]>('/starlink/plans');

  const params = new URLSearchParams();
  if (debounced) params.set('search', debounced);
  if (plan) params.set('plan', plan);
  const list = useApi<Customer[]>(withQuery('/starlink/customers', params));

  const closeDrawer = useCallback(() => setSelected(null), []);

  return (
    <>
      <div className="card sla-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search name, email or phone" />
        <select className="sla-select" value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Filter by package">
          <option value="">All packages</option>
          <option value="none">No package yet</option>
          {(plans.data ?? []).map((p) => (
            <option key={p.code} value={p.code}>{p.name}</option>
          ))}
        </select>
      </div>

      {list.error && <Notice kind="err" text={list.error} />}
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card">
          <Table<Customer>
            columns={[
              { key: 'fullName', label: 'Name', render: (r) => <span className="sla-strong">{r.fullName}</span> },
              { key: 'email', label: 'Email' },
              { key: 'phone', label: 'Phone', width: '140px' },
              {
                key: 'planName',
                label: 'Package',
                render: (r) => (r.planName ? <Badge tone="cyan">{r.planName}</Badge> : <span className="sla-muted">No package</span>),
              },
              {
                key: 'emailVerifiedAt',
                label: 'Email',
                width: '110px',
                render: (r) => (r.emailVerifiedAt ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Unverified</Badge>),
              },
              { key: 'kitCount', label: 'Kits', width: '70px' },
              { key: 'walletBalance', label: 'Wallet', width: '110px', render: (r) => usd(r.walletBalance) },
              { key: 'createdAt', label: 'Joined', width: '120px', render: (r) => fmtDay(r.createdAt) },
            ]}
            data={list.data ?? []}
            onRowClick={(r) => setSelected(r.id)}
            emptyMessage="No Starlink customers match these filters."
          />
        </div>
      )}

      {selected && <CustomerDrawer customerId={selected} onClose={closeDrawer} />}
    </>
  );
}

function CustomerDrawer({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const detail = useApi<CustomerDetail>(`/starlink/customers/${customerId}`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const c = detail.data;

  return (
    <div className="sla-drawer-backdrop" onClick={onClose} role="presentation">
      <aside className="sla-drawer" role="dialog" aria-modal="true" aria-label="Customer details" onClick={(e) => e.stopPropagation()}>
        <div className="sla-drawer-head">
          <div>
            <h3>{c?.fullName ?? 'Customer'}</h3>
            <p className="sla-muted">{c?.email}</p>
          </div>
          <button type="button" className="sla-icon-btn" onClick={onClose} aria-label="Close customer details">
            <FiX />
          </button>
        </div>

        {detail.loading && !c && <Spinner />}
        {detail.error && <Notice kind="err" text={detail.error} />}

        {c && (
          <>
            <dl className="sla-dl">
              <div><dt>Phone</dt><dd>{c.phone || '—'}</dd></div>
              <div><dt>Package</dt><dd>{c.planName ?? 'No package yet'}</dd></div>
              <div><dt>Renews</dt><dd>{fmtDay(c.planRenewsAt)}</dd></div>
              <div><dt>Email</dt><dd>{c.emailVerifiedAt ? 'Verified' : 'Unverified'}</dd></div>
              <div><dt>Wallet</dt><dd>{usd(c.walletBalance)}</dd></div>
              <div><dt>Joined</dt><dd>{fmtDay(c.createdAt)}</dd></div>
            </dl>

            <h4 className="sla-section-title">Kits ({c.kits.length})</h4>
            <Table<Kit>
              columns={[
                { key: 'kitNumber', label: 'Kit' },
                { key: 'nickname', label: 'Nickname', render: (r) => r.nickname || '—' },
                { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'dataUsageGb', label: 'Used', render: (r) => fmtGb(r.dataUsageGb) },
              ]}
              data={c.kits}
              emptyMessage="No kits registered."
            />

            <h4 className="sla-section-title">Recent invoices</h4>
            <Table<Invoice>
              columns={[
                { key: 'invoiceNumber', label: 'Invoice', render: (r) => <span className="sla-mono">{r.invoiceNumber}</span> },
                { key: 'description', label: 'Description', render: (r) => r.description || KIND_LABELS[r.kind] || r.kind },
                { key: 'amount', label: 'Amount', render: (r) => usd(r.amount) },
                { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'createdAt', label: 'Date', render: (r) => fmtDay(r.createdAt) },
              ]}
              data={c.invoices}
              emptyMessage="No invoices yet."
            />

            <h4 className="sla-section-title">Plan applications</h4>
            <Table<Application>
              columns={[
                { key: 'toPlanName', label: 'Requested', render: (r) => `${r.fromPlanName ?? 'No package'} → ${r.toPlanName}` },
                { key: 'requestedStart', label: 'Start', render: (r) => fmtDay(r.requestedStart) },
                { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
                { key: 'createdAt', label: 'Submitted', render: (r) => fmtDay(r.createdAt) },
              ]}
              data={c.applications}
              emptyMessage="No plan applications."
            />
          </>
        )}
      </aside>
    </div>
  );
}

function ApplicationsTab() {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const list = useApi<Application[]>(`/starlink/applications?status=${status}`);

  const approve = async (app: Application) => {
    if (!window.confirm(`Approve ${app.customerName ?? 'this customer'} for ${app.toPlanName}?`)) return;
    setBusyId(app.id);
    setNotice(null);
    try {
      await api.post(`/starlink/applications/${app.id}/approve`);
      setNotice({ kind: 'ok', text: `Approved ${app.customerName ?? 'the application'} for ${app.toPlanName}.` });
      list.reload();
    } catch (e) {
      setNotice({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  const decline = async (app: Application) => {
    const note = window.prompt(`Reason for declining ${app.customerName ?? 'this customer'}'s move to ${app.toPlanName}? The customer will receive this note.`, '');
    if (note === null) return;
    const trimmed = note.trim();
    if (trimmed.length < 3) {
      setNotice({ kind: 'err', text: 'Enter a reason of at least 3 characters.' });
      return;
    }
    setBusyId(app.id);
    setNotice(null);
    try {
      await api.post(`/starlink/applications/${app.id}/reject`, { note: trimmed });
      setNotice({ kind: 'ok', text: `Declined ${app.customerName ?? 'the application'}.` });
      list.reload();
    } catch (e) {
      setNotice({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  const filters: Array<{ id: typeof status; label: string }> = [
    { id: 'PENDING', label: 'Pending' },
    { id: 'APPROVED', label: 'Approved' },
    { id: 'REJECTED', label: 'Declined' },
    { id: 'ALL', label: 'All' },
  ];

  return (
    <>
      <div className="sla-chips" role="group" aria-label="Application status">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className={'sla-chip' + (status === f.id ? ' active' : '')}
            aria-pressed={status === f.id}
            onClick={() => setStatus(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {notice && <Notice kind={notice.kind} text={notice.text} />}
      {list.error && <Notice kind="err" text={list.error} />}

      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card">
          <Table<Application>
            columns={[
              { key: 'createdAt', label: 'Submitted', width: '150px', render: (r) => fmtDateTime(r.createdAt) },
              {
                key: 'customerName',
                label: 'Customer',
                render: (r) => (
                  <div>
                    <div className="sla-strong">{r.customerName}</div>
                    <div className="sla-muted sla-small">{r.customerEmail}</div>
                    {r.customerPhone && <div className="sla-muted sla-small">{r.customerPhone}</div>}
                  </div>
                ),
              },
              {
                key: 'toPlanName',
                label: 'Move',
                render: (r) => `${r.fromPlanName ?? 'No package'} → ${r.toPlanName}`,
              },
              { key: 'requestedStart', label: 'Start', width: '110px', render: (r) => fmtDay(r.requestedStart) },
              { key: 'status', label: 'Status', width: '110px', render: (r) => <StatusBadge status={r.status} /> },
              {
                key: 'decidedBy',
                label: 'Decision',
                render: (r) =>
                  r.decidedAt ? (
                    <div>
                      <div>{r.decidedBy || '—'}</div>
                      <div className="sla-muted sla-small">{fmtDateTime(r.decidedAt)}</div>
                      {r.decisionNote && <div className="sla-muted sla-small">“{r.decisionNote}”</div>}
                    </div>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'actions',
                label: 'Actions',
                width: '200px',
                render: (r) =>
                  r.status === 'PENDING' ? (
                    <div className="sla-actions">
                      <button type="button" className="sla-btn sla-btn--primary" disabled={busyId === r.id} onClick={() => approve(r)}>
                        Approve
                      </button>
                      <button type="button" className="sla-btn sla-btn--danger" disabled={busyId === r.id} onClick={() => decline(r)}>
                        Decline
                      </button>
                    </div>
                  ) : (
                    <span className="sla-muted">—</span>
                  ),
              },
            ]}
            data={list.data ?? []}
            emptyMessage="No applications in this view."
          />
        </div>
      )}
    </>
  );
}

function TransactionsTab() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  const list = useApi<Invoice[]>(withQuery('/starlink/transactions', params));

  const rows = list.data ?? [];
  const paidTotal = rows.filter((r) => r.status === 'PAID').reduce((sum, r) => sum + Number(r.amount), 0);
  const pendingTotal = rows.filter((r) => r.status === 'PENDING').reduce((sum, r) => sum + Number(r.amount), 0);

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const token = getToken();
      const res = await fetch(`/api/admin/starlink/transactions.csv${query ? `?${query}` : ''}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `starlink-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setExportError(errMsg(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <div className="card sla-toolbar sla-toolbar--wrap">
        <select className="sla-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select className="sla-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="PAID">Paid</option>
          <option value="PENDING">Pending</option>
          <option value="FAILED">Failed</option>
        </select>
        <label className="sla-date">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="sla-date">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="sla-btn sla-btn--ghost sla-toolbar__end" onClick={exportCsv} disabled={exporting}>
          <FiDownload aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      <div className="sla-summary">
        <span><strong>{rows.length}</strong> transactions</span>
        <span>Paid <strong>{usd(paidTotal)}</strong></span>
        <span>Pending <strong>{usd(pendingTotal)}</strong></span>
      </div>

      {exportError && <Notice kind="err" text={exportError} />}
      {list.error && <Notice kind="err" text={list.error} />}

      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card">
          <Table<Invoice>
            columns={[
              { key: 'invoiceNumber', label: 'Invoice', width: '150px', render: (r) => <span className="sla-mono">{r.invoiceNumber}</span> },
              { key: 'issuedDate', label: 'Issued', width: '110px', render: (r) => fmtDay(r.issuedDate) },
              { key: 'paidAt', label: 'Paid', width: '150px', render: (r) => fmtDateTime(r.paidAt) },
              {
                key: 'customerName',
                label: 'Customer',
                render: (r) => (
                  <div>
                    <div className="sla-strong">{r.customerName}</div>
                    <div className="sla-muted sla-small">{r.customerEmail}</div>
                  </div>
                ),
              },
              { key: 'kind', label: 'Kind', render: (r) => KIND_LABELS[r.kind] ?? r.kind },
              { key: 'description', label: 'Description', render: (r) => r.description || '—' },
              { key: 'amount', label: 'Amount', width: '110px', render: (r) => usd(r.amount) },
              { key: 'status', label: 'Status', width: '100px', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'paymentReference', label: 'Payment ref', width: '160px', render: (r) => <span className="sla-mono sla-small">{r.paymentReference || '—'}</span> },
            ]}
            data={rows}
            emptyMessage="No Starlink transactions match these filters."
          />
        </div>
      )}
    </>
  );
}

function KitsTab() {
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const debounced = useDebounced(search.trim());
  const params = new URLSearchParams();
  if (debounced) params.set('search', debounced);
  const list = useApi<Kit[]>(withQuery('/starlink/kits', params));

  const toggle = async (kit: Kit) => {
    const next = kit.status === 'active' ? 'paused' : 'active';
    const verb = next === 'paused' ? 'Pause' : 'Activate';
    if (!window.confirm(`${verb} kit ${kit.kitNumber}${kit.customerName ? ` for ${kit.customerName}` : ''}?`)) return;
    setBusyId(kit.id);
    setNotice(null);
    try {
      await api.patch(`/starlink/kits/${kit.id}`, { status: next });
      setNotice({ kind: 'ok', text: `Kit ${kit.kitNumber} is now ${next}.` });
      list.reload();
    } catch (e) {
      setNotice({ kind: 'err', text: errMsg(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="card sla-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search kit serial, nickname, customer or email" />
      </div>

      {notice && <Notice kind={notice.kind} text={notice.text} />}
      {list.error && <Notice kind="err" text={list.error} />}

      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card">
          <Table<Kit>
            columns={[
              { key: 'kitNumber', label: 'Kit serial', render: (r) => <span className="sla-mono">{r.kitNumber}</span> },
              { key: 'nickname', label: 'Nickname', render: (r) => r.nickname || '—' },
              {
                key: 'customerName',
                label: 'Customer',
                render: (r) => (
                  <div>
                    <div className="sla-strong">{r.customerName}</div>
                    <div className="sla-muted sla-small">{r.customerEmail}</div>
                  </div>
                ),
              },
              { key: 'status', label: 'Status', width: '110px', render: (r) => <StatusBadge status={r.status} /> },
              { key: 'dataUsageGb', label: 'Used', width: '100px', render: (r) => fmtGb(r.dataUsageGb) },
              { key: 'dataCreditGb', label: 'Credit', width: '100px', render: (r) => fmtGb(r.dataCreditGb) },
              {
                key: 'actions',
                label: '',
                width: '120px',
                render: (r) => (
                  <button
                    type="button"
                    className={'sla-btn ' + (r.status === 'active' ? 'sla-btn--danger' : 'sla-btn--primary')}
                    disabled={busyId === r.id}
                    onClick={() => toggle(r)}
                  >
                    {r.status === 'active' ? 'Pause' : 'Activate'}
                  </button>
                ),
              },
            ]}
            data={list.data ?? []}
            emptyMessage="No kits match this search."
          />
        </div>
      )}
    </>
  );
}

function PlansTab() {
  const list = useApi<PlanRow[]>('/starlink/plans');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  return (
    <>
      <p className="sla-hint">
        Capacity is the number of customers allowed on each package. Seats left is capacity minus current subscribers.
        Capacity cannot be set below the current subscriber count.
      </p>
      {notice && <Notice kind={notice.kind} text={notice.text} />}
      {list.error && <Notice kind="err" text={list.error} />}

      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card">
          <div className="card-table sla-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Price</th>
                  <th>Subscribers</th>
                  <th>Capacity</th>
                  <th>Seats left</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(list.data ?? []).map((p) => (
                  <PlanCapacityRow
                    key={p.code}
                    plan={p}
                    onSaved={() => {
                      setNotice({ kind: 'ok', text: `${p.name} capacity saved.` });
                      list.reload();
                    }}
                    onError={(text) => setNotice({ kind: 'err', text })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function PlanCapacityRow({ plan, onSaved, onError }: { plan: PlanRow; onSaved: () => void; onError: (text: string) => void }) {
  const [value, setValue] = useState(String(plan.capacity));
  const [saving, setSaving] = useState(false);
  const dirty = value.trim() !== String(plan.capacity);

  const save = async () => {
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 0) {
      onError('Capacity must be a whole number.');
      return;
    }
    if (n < plan.active) {
      onError(`Capacity cannot be below the ${plan.active} active subscriber(s) on ${plan.name}.`);
      return;
    }
    setSaving(true);
    try {
      await api.put(`/starlink/plans/${plan.code}/capacity`, { capacity: n });
      onSaved();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr>
      <td>
        <div className="sla-strong">{plan.name}</div>
        <div className="sla-muted sla-small">{plan.perks.slice(0, 2).join(' · ')}</div>
      </td>
      <td>{usd(plan.priceUsd)} / mo</td>
      <td>{plan.active}</td>
      <td>
        <input
          className="sla-capacity-input"
          type="number"
          inputMode="numeric"
          min={plan.active}
          max={100000}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Capacity for ${plan.name}`}
        />
      </td>
      <td>
        <Badge tone={plan.seatsLeft > 0 ? 'ok' : 'bad'}>{plan.seatsLeft} left</Badge>
      </td>
      <td>
        <button type="button" className="sla-btn sla-btn--primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  );
}
