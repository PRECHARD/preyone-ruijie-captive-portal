import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  type ArAging,
  type Company,
  type LegacyCurrencyTotal,
  type PosDocument,
} from '../api';
import '../dashboard.css';

export type DocumentAction = 'pdf' | 'email' | 'whatsapp';

type RangeKey = 'cycle' | 'mtd' | 'ytd' | 'all';

interface Overview {
  totalGrossRevenue?: number;
  netSales?: number;
  taxCollected?: number;
  outstandingAr?: number;
  mtdRevenue?: number;
  vatRate?: number;
  byRail?: Record<string, number>;
}

interface LedgerRow {
  id: string;
  occurred_at: string;
  entry_type: string;
  rail: string;
  document_id?: string | null;
  doc_number?: string | null;
  doc_type?: string | null;
  description?: string | null;
  gross_amount: number;
  tax_amount: number;
  net_amount: number;
  cogs_amount: number;
  reference?: string | null;
}

interface LedgerResponse {
  rows: LedgerRow[];
  total: number;
}

interface DashboardProps {
  company: Company;
  onNewDocument: (type: string) => void;
  onOpenDocument: (id: string, action?: DocumentAction) => void;
  onView: (view: 'documents' | 'aging' | 'zar' | 'accounting') => void;
}

const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'cycle', label: '3rd–3rd cycle' },
  { key: 'mtd', label: 'MTD' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All-time' },
];

const BILLED_TYPES = new Set([
  'invoice',
  'tax_invoice',
  'proforma',
  'sales_receipt',
  'receipt',
  'cash_receipt',
  'sale',
]);

const COLLECTION_TYPES = new Set(['pos_sale', 'invoice_payment', 'pesepay_collection']);

const MIX_CATEGORIES = [
  {
    key: 'invoices',
    label: 'Invoices',
    types: ['invoice', 'tax_invoice', 'proforma'],
    color: '#00F0FF',
  },
  {
    key: 'quotes',
    label: 'Quotes',
    types: ['quote', 'quotation', 'estimate'],
    color: '#a855f7',
  },
  {
    key: 'receipts',
    label: 'Receipts',
    types: ['receipt', 'sales_receipt', 'cash_receipt', 'sale'],
    color: '#34d399',
  },
  {
    key: 'credits',
    label: 'Credit notes',
    types: ['credit_note', 'credit_memo'],
    color: '#f59e0b',
  },
];

const STATUSES = [
  { key: 'paid', label: 'Paid', color: '#34d399' },
  { key: 'unpaid', label: 'Unpaid', color: '#fbbf24' },
  { key: 'partial', label: 'Partial', color: '#22d3ee' },
  { key: 'overdue', label: 'Overdue', color: '#fb7185' },
  { key: 'void', label: 'Void', color: '#64748b' },
] as const;

type StatusKey = (typeof STATUSES)[number]['key'];

const round2 = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Ledger reads can occasionally queue behind a cold accounting query. A hung
 * fetch must never leave the executive dashboard spinning forever, so each
 * panel gets its own bounded wait and the other panels still render.
 */
function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Dashboard request timed out')), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

const usd = (value: unknown) =>
  `USD ${round2(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const zar = (value: unknown) =>
  `R ${round2(value).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

function shortDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function dateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cycleStart(today: Date): Date {
  const start = new Date(today.getFullYear(), today.getMonth(), 3);
  if (today.getDate() < 3) start.setMonth(start.getMonth() - 1);
  return start;
}

function rangeBounds(range: RangeKey): { from: string; to: string; label: string; hint: string } {
  const now = new Date();
  const to = isoDate(now);
  if (range === 'all') {
    return { from: '', to: '', label: 'All-time', hint: 'Every ledger entry' };
  }
  if (range === 'cycle') {
    const from = isoDate(cycleStart(now));
    return {
      from,
      to,
      label: '3rd–3rd cycle',
      hint: `${shortDate(from)} – ${shortDate(to)}`,
    };
  }
  if (range === 'mtd') {
    const from = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
    return {
      from,
      to,
      label: 'Month to date',
      hint: `${shortDate(from)} – ${shortDate(to)}`,
    };
  }
  const from = isoDate(new Date(now.getFullYear(), 0, 1));
  return {
    from,
    to,
    label: 'Year to date',
    hint: `${shortDate(from)} – ${shortDate(to)}`,
  };
}

function statusOf(doc: PosDocument): StatusKey {
  const total = Number(doc.total) || 0;
  const paid = Number(doc.amount_paid) || 0;
  const balance = Math.max(0, total - paid);
  if (doc.status === 'void') return 'void';
  if (doc.status === 'paid' || (total > 0 && paid >= total - 0.005)) return 'paid';
  if (doc.due_date) {
    const due = new Date(`${String(doc.due_date).slice(0, 10)}T00:00:00`).getTime();
    if (due < Date.now() && balance > 0.005) return 'overdue';
  }
  if (paid > 0.005) return 'partial';
  return 'unpaid';
}

function entryLabel(entry: string): string {
  const labels: Record<string, string> = {
    pos_sale: 'Sale',
    invoice_payment: 'Payment',
    pesepay_collection: 'Pesepay',
    credit_note: 'Credit',
    expense: 'Expense',
    stock_adjustment: 'Stock',
  };
  return labels[entry] || entry.replace(/_/g, ' ');
}

function entryTone(entry: string): string {
  if (entry === 'credit_note') return 'warn';
  if (entry === 'expense') return 'danger';
  if (entry === 'invoice_payment' || entry === 'pesepay_collection') return 'cyan';
  return 'ok';
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    invoice: (
      <>
        <path d="M7 3.8h7.5L18 7.3v12.9H6V3.8Z" />
        <path d="M14.5 3.8v3.5H18M9 11h6M9 14.5h6M9 18h3.5" />
      </>
    ),
    quote: (
      <>
        <path d="M5.5 4.5h13v15h-13Z" />
        <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" />
      </>
    ),
    receipt: (
      <>
        <path d="M5 3.8h14v16.4l-2.3-1.6-2.3 1.6-2.4-1.6-2.3 1.6L7.3 18.6 5 20.2Z" />
        <path d="M8.2 8h7.6M8.2 11.5h7.6M8.2 15h4.5" />
      </>
    ),
    pos: (
      <>
        <path d="M7 8V4.5h10V8" />
        <rect x="4.8" y="8" width="14.4" height="7.4" rx="1.5" />
        <path d="M7 13h10v6.5H7ZM16.5 10.5h.01" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2 5.3" />
        <path d="M20 4.5V11h-6.5" />
      </>
    ),
    pdf: (
      <>
        <path d="M7 3.8h7.5L18 7.3v12.9H6V3.8Z" />
        <path d="M14.5 3.8v3.5H18M8.7 16.5h2.2a1.6 1.6 0 0 0 0-3.2H8.7v5" />
      </>
    ),
    mail: (
      <>
        <rect x="3.5" y="5" width="17" height="14" rx="2" />
        <path d="m4.5 6.5 7.5 6 7.5-6" />
      </>
    ),
    whatsapp: (
      <>
        <path d="M20 11.5a8 8 0 0 1-11.8 7.1L4 20l1.4-4.2A8 8 0 1 1 20 11.5Z" />
        <path d="M8.7 8.4c.4-.1.9.2 1.1.7l.6 1.3c.1.3 0 .6-.2.8l-.7.6c.5 1 1.4 1.9 2.4 2.4l.6-.7c.2-.2.5-.3.8-.2l1.3.6c.5.2.8.7.7 1.1-.1.9-.9 1.6-1.8 1.6-2.8 0-5.2-2.4-5.2-5.2 0-.9.7-1.7 1.6-1.8Z" />
      </>
    ),
    arrow: <path d="M5 12h13M13 7l5 5-5 5" />,
  };
  return (
    <svg
      className="dash-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}

function RevenueChart({ data }: { data: Array<{ key: string; label: string; billed: number; paid: number }> }) {
  if (data.length === 0 || data.every((point) => point.billed <= 0 && point.paid <= 0)) {
    return <div className="dash-empty">No billed or collected movement in this period.</div>;
  }
  const width = 780;
  const height = 260;
  const padL = 48;
  const padR = 18;
  const padT = 18;
  const padB = 38;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const max = Math.max(...data.flatMap((point) => [point.billed, point.paid]), 1);
  const group = innerW / data.length;
  const bar = Math.max(2.4, Math.min(12, group * 0.28));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <svg className="dash-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Billed versus collected revenue">
      <defs>
        <linearGradient id="dashBilledGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#00A7C4" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id="dashPaidGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34D399" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3, 4].map((line) => {
        const gy = padT + (innerH / 4) * line;
        return (
          <line
            key={line}
            x1={padL}
            x2={width - padR}
            y1={gy}
            y2={gy}
            className="dash-chart-grid"
          />
        );
      })}
      {data.map((point, index) => {
        const center = padL + group * index + group / 2;
        const billedH = Math.max(0, (point.billed / max) * innerH);
        const paidH = Math.max(0, (point.paid / max) * innerH);
        return (
          <g key={point.key}>
            <rect
              x={center - bar - 1.2}
              y={padT + innerH - billedH}
              width={bar}
              height={billedH}
              rx={2.5}
              fill="url(#dashBilledGrad)"
            >
              <title>{`${point.label} · Billed ${usd(point.billed)}`}</title>
            </rect>
            <rect
              x={center + 1.2}
              y={padT + innerH - paidH}
              width={bar}
              height={paidH}
              rx={2.5}
              fill="url(#dashPaidGrad)"
            >
              <title>{`${point.label} · Collected ${usd(point.paid)}`}</title>
            </rect>
            {index % labelEvery === 0 && (
              <text x={center} y={height - 12} className="dash-chart-axis" textAnchor="middle">
                {point.label}
              </text>
            )}
          </g>
        );
      })}
      <text x={padL - 10} y={padT + 4} className="dash-chart-y" textAnchor="end">
        {usd(max).replace('USD ', '')}
      </text>
      <text x={padL - 10} y={padT + innerH} className="dash-chart-y" textAnchor="end">
        0
      </text>
    </svg>
  );
}

export default function DashboardPage({
  company,
  onNewDocument,
  onOpenDocument,
  onView,
}: DashboardProps) {
  const [range, setRange] = useState<RangeKey>('cycle');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [docs, setDocs] = useState<PosDocument[]>([]);
  const [aging, setAging] = useState<ArAging | null>(null);
  const [legacy, setLegacy] = useState<LegacyCurrencyTotal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [customerSort, setCustomerSort] = useState<'revenue' | 'outstanding'>('revenue');

  const bounds = useMemo(() => rangeBounds(range), [range]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      const qs = new URLSearchParams();
      if (bounds.from) qs.set('from', bounds.from);
      if (bounds.to) qs.set('to', bounds.to);
      const query = qs.toString() ? `?${qs}` : '';

      const ledgerQs = new URLSearchParams(qs);
      ledgerQs.set('limit', '500');

      try {
        const results = await Promise.allSettled([
          withTimeout(api.get<Overview>(`/api/accounting/overview${query}`)),
          withTimeout(api.get<LedgerResponse>(`/api/accounting/ledger?${ledgerQs}`)),
          withTimeout(api.get<PosDocument[]>('/api/pos/documents?limit=500')),
          withTimeout(api.get<ArAging>('/api/pos/reports/ar-aging')),
          withTimeout(api.get<LegacyCurrencyTotal[]>('/api/pos/legacy-totals')),
        ]);

        const value = <T,>(index: number, fallback: T): T =>
          results[index].status === 'fulfilled' ? (results[index].value as T) : fallback;

        setOverview(value<Overview | null>(0, null));
        const ledgerResult = value<LedgerResponse>(1, { rows: [], total: 0 });
        setLedger(Array.isArray(ledgerResult.rows) ? ledgerResult.rows : []);
        if (results[2].status === 'fulfilled') setDocs(value<PosDocument[]>(2, []));
        setAging(value<ArAging | null>(3, null));
        const legacyRows = value<LegacyCurrencyTotal[]>(4, []);
        setLegacy(
          Array.isArray(legacyRows) ? legacyRows.find((row) => row.currency === 'ZAR') ?? null : null
        );

        const failures = results.filter((result) => result.status === 'rejected').length;
        setError(
          failures > 0
            ? failures === results.length
              ? 'The dashboard could not reach the ledger. Check your connection and retry.'
              : 'Some ledger panels could not refresh. Showing the last available values.'
            : null
        );
      } catch (err) {
        console.error('Dashboard load failed:', err);
        setError(err instanceof Error ? err.message : 'The dashboard could not load.');
      } finally {
        setLastUpdated(new Date());
        setLoading(false);
      }
    },
    [bounds.from, bounds.to]
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const usdDocs = useMemo(
    () => docs.filter((doc) => String(doc.currency || 'USD').toUpperCase() === 'USD'),
    [docs]
  );

  const periodDocs = useMemo(
    () =>
      usdDocs.filter((doc) => {
        const issued = String(doc.issue_date || '').slice(0, 10);
        if (bounds.from && issued < bounds.from) return false;
        if (bounds.to && issued > bounds.to) return false;
        return true;
      }),
    [usdDocs, bounds.from, bounds.to]
  );

  const billedDocs = useMemo(
    () => periodDocs.filter((doc) => BILLED_TYPES.has(doc.doc_type) && doc.status !== 'void'),
    [periodDocs]
  );

  const billed = useMemo(
    () => round2(billedDocs.reduce((sum, doc) => sum + (Number(doc.total) || 0), 0)),
    [billedDocs]
  );
  // Collection rate is measured against the same document cohort: of the
  // invoices issued in this period, how much has been applied. Ledger cash in
  // the period is shown separately because it can include prior-period bills.
  const collected = useMemo(
    () => round2(billedDocs.reduce((sum, doc) => sum + (Number(doc.amount_paid) || 0), 0)),
    [billedDocs]
  );
  const ledgerCollected = round2(overview?.totalGrossRevenue);
  const collectionRate = billed > 0 ? Math.min(100, Math.round((collected / billed) * 100)) : 0;
  const outstanding = round2(overview?.outstandingAr);
  const overdue = round2((aging?.buckets.d61_90 ?? 0) + (aging?.buckets.d90plus ?? 0));

  const mixRows = useMemo(
    () =>
      MIX_CATEGORIES.map((category) => {
        const list = periodDocs.filter((doc) => category.types.includes(doc.doc_type));
        const amount = round2(
          list.reduce(
            (sum, doc) =>
              sum +
              (category.key === 'credits'
                ? Math.abs(Number(doc.total) || 0)
                : doc.status === 'void'
                  ? 0
                  : Number(doc.total) || 0),
            0
          )
        );
        const counts = Object.fromEntries(STATUSES.map((status) => [status.key, 0])) as Record<
          StatusKey,
          number
        >;
        for (const doc of list) counts[statusOf(doc)] += 1;
        return { ...category, list, amount, counts, total: list.length };
      }),
    [periodDocs]
  );

  const statusTotals = useMemo(() => {
    const counts = Object.fromEntries(STATUSES.map((status) => [status.key, 0])) as Record<
      StatusKey,
      number
    >;
    for (const doc of periodDocs) counts[statusOf(doc)] += 1;
    return counts;
  }, [periodDocs]);

  const agingBuckets = useMemo(
    () => [
      {
        label: '0–30 days',
        value: round2((aging?.buckets.current ?? 0) + (aging?.buckets.d1_30 ?? 0)),
        color: '#34D399',
      },
      {
        label: '31–60 days',
        value: round2(aging?.buckets.d31_60),
        color: '#FBBF24',
      },
      {
        label: '60+ days',
        value: overdue,
        color: '#FB7185',
      },
    ],
    [aging, overdue]
  );
  const agingMax = Math.max(...agingBuckets.map((bucket) => bucket.value), 1);

  const customers = useMemo(() => {
    const map = new Map<string, { name: string; billed: number; outstanding: number; count: number }>();
    for (const doc of billedDocs) {
      const name = (doc.customer_name || 'Walk-in customer').trim();
      const entry = map.get(name) || { name, billed: 0, outstanding: 0, count: 0 };
      entry.billed = round2(entry.billed + (Number(doc.total) || 0));
      entry.outstanding = round2(
        entry.outstanding + Math.max(0, (Number(doc.total) || 0) - (Number(doc.amount_paid) || 0))
      );
      entry.count += 1;
      map.set(name, entry);
    }
    return [...map.values()]
      .sort((a, b) =>
        customerSort === 'outstanding' ? b.outstanding - a.outstanding : b.billed - a.billed
      )
      .slice(0, 6);
  }, [billedDocs, customerSort]);

  const chartData = useMemo(() => {
    const monthly = range === 'ytd' || range === 'all';
    const map = new Map<string, { key: string; label: string; billed: number; paid: number }>();

    const ensure = (key: string) => {
      if (!key) return;
      if (!map.has(key)) {
        const label = monthly
          ? new Date(`${key}-01T00:00:00`).toLocaleDateString('en-GB', {
              month: 'short',
              year: '2-digit',
            })
          : new Date(`${key}T00:00:00`).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
            });
        map.set(key, { key, label, billed: 0, paid: 0 });
      }
    };

    const end = bounds.to || isoDate(new Date());
    if (!monthly && bounds.from) {
      const start = new Date(`${bounds.from}T00:00:00`);
      const finish = new Date(`${end}T00:00:00`);
      for (let day = new Date(start); day <= finish; day.setDate(day.getDate() + 1)) {
        ensure(isoDate(day));
      }
    } else if (monthly && bounds.from) {
      const start = new Date(`${bounds.from.slice(0, 7)}-01T00:00:00`);
      const finish = new Date(`${end.slice(0, 7)}-01T00:00:00`);
      for (let month = new Date(start); month <= finish; month.setMonth(month.getMonth() + 1)) {
        ensure(isoDate(month).slice(0, 7));
      }
    }

    for (const doc of billedDocs) {
      const issued = String(doc.issue_date || '').slice(0, 10);
      const key = monthly ? issued.slice(0, 7) : issued;
      ensure(key);
      const entry = map.get(key);
      if (entry) entry.billed = round2(entry.billed + (Number(doc.total) || 0));
    }

    for (const row of ledger) {
      if (!COLLECTION_TYPES.has(row.entry_type)) continue;
      const occurred = String(row.occurred_at || '').slice(0, 10);
      const key = monthly ? occurred.slice(0, 7) : occurred;
      ensure(key);
      const entry = map.get(key);
      if (entry) entry.paid = round2(entry.paid + (Number(row.gross_amount) || 0));
    }

    if (monthly && !bounds.from) {
      // All-time: cap the visual to the most recent 12 active months.
      const active = [...map.values()].filter((entry) => entry.billed || entry.paid);
      return active
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(-12)
        .map((entry) => entry);
    }

    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [range, bounds.from, bounds.to, billedDocs, ledger]);

  const recent = ledger.slice(0, 8);
  const statusTotal = periodDocs.length;
  const currentCycle = rangeBounds('cycle');
  const isCycle = range === 'cycle';
  const initialLoading = loading && !lastUpdated;
  const displayUsd = (value: unknown) => (initialLoading ? '—' : usd(value));

  return (
    <div className="dash-page">
      <header className="dash-header">
        <div>
          <div className="dash-eyebrow">
            <span className="dash-live-dot" aria-hidden />
            {company?.name || 'Preyone'} · Executive workspace
          </div>
          <h1 className="dash-title">Dashboard</h1>
          <p className="dash-sub">
            USD &amp; ZAR ledger intelligence · {bounds.label} · {bounds.hint}
          </p>
        </div>
        <div className="dash-header-tools">
          <div className="dash-range" role="group" aria-label="Reporting period">
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`dash-range-btn${range === option.key ? ' is-active' : ''}`}
                aria-pressed={range === option.key}
                onClick={() => setRange(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="dash-refresh"
            onClick={() => void load(false)}
            disabled={loading}
            title="Refresh all ledger metrics"
          >
            <Icon name="refresh" />
            {loading ? 'Syncing' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="dash-error">{error}</div>}
      <div className={`dash-loading-bar${loading ? ' is-on' : ''}`} aria-hidden />

      <div className="dash-quick">
        <button type="button" className="dash-quick-btn dash-quick-btn--cyan" onClick={() => onNewDocument('invoice')}>
          <span className="dash-quick-plus">+</span>
          <Icon name="invoice" />
          New invoice
        </button>
        <button type="button" className="dash-quick-btn" onClick={() => onNewDocument('quote')}>
          <span className="dash-quick-plus">+</span>
          <Icon name="quote" />
          New quote
        </button>
        <button type="button" className="dash-quick-btn dash-quick-btn--emerald" onClick={() => onNewDocument('receipt')}>
          <span className="dash-quick-plus">+</span>
          <Icon name="receipt" />
          Record receipt
        </button>
        <button
          type="button"
          className="dash-quick-btn dash-quick-btn--ghost"
          onClick={() => window.open('https://pos.preyone.com', '_blank', 'noopener,noreferrer')}
        >
          <Icon name="pos" />
          Open POS
        </button>
        <span className="dash-quick-meta">
          {lastUpdated ? `Updated ${dateTime(lastUpdated.toISOString())}` : 'Connecting to ledger…'}
        </span>
      </div>

      <div className="dash-kpis">
        <article className="dash-kpi dash-kpi--cyan">
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Total billed</span>
            <span className="dash-kpi-chip">USD</span>
          </div>
          <strong className="dash-kpi-value">{displayUsd(billed)}</strong>
          <div className="dash-kpi-foot">
            {billedDocs.length} invoice-class documents · {bounds.label.toLowerCase()}
          </div>
          <span className="dash-kpi-glow" aria-hidden />
        </article>

        <article className="dash-kpi dash-kpi--emerald">
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Collected revenue</span>
            <span className="dash-kpi-chip">USD</span>
          </div>
          <strong className="dash-kpi-value">{displayUsd(collected)}</strong>
          <div className="dash-progress" aria-label={`Collection rate ${collectionRate}%`}>
            <i style={{ width: `${collectionRate}%` }} />
          </div>
          <div className="dash-kpi-foot">
            <strong>{collectionRate}%</strong> of period billings
          </div>
          <div className="dash-kpi-sub">
            Ledger cash in period{' '}
            <strong>{initialLoading ? '—' : usd(ledgerCollected)}</strong>
          </div>
          <span className="dash-kpi-glow" aria-hidden />
        </article>

        <article className="dash-kpi dash-kpi--amber">
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Outstanding balance</span>
            <span className="dash-kpi-chip">USD</span>
          </div>
          <strong className="dash-kpi-value">{displayUsd(outstanding)}</strong>
          <div className="dash-kpi-foot">Current AR · not period-filtered</div>
          <span className="dash-kpi-glow" aria-hidden />
        </article>

        <article className={`dash-kpi dash-kpi--rose${overdue > 0 ? ' has-alert' : ''}`}>
          <div className="dash-kpi-top">
            <span className="dash-kpi-label">Overdue AR · 60+ days</span>
            {overdue > 0 && <span className="dash-alert-dot">Alert</span>}
          </div>
          <strong className="dash-kpi-value">{displayUsd(overdue)}</strong>
          <div className="dash-kpi-foot">Needs follow-up · aging snapshot</div>
          <span className="dash-kpi-glow" aria-hidden />
        </article>
      </div>

      <section className="dash-zar">
        <div className="dash-zar-head">
          <div>
            <span className="dash-eyebrow">Rand ledger · ZAR snapshot</span>
            <strong>
              {initialLoading ? 'Loading snapshot…' : legacy ? zar(legacy.sales_total) : 'No Rand snapshot'}
            </strong>
          </div>
          <span className="dash-zar-chip">Separate ledger</span>
        </div>
        <div className="dash-zar-grid">
          <div>
            <span>Sales</span>
            <strong>{!initialLoading && legacy ? zar(legacy.sales_total) : '—'}</strong>
          </div>
          <div>
            <span>Funds received</span>
            <strong>{!initialLoading && legacy ? zar(legacy.funds_total) : '—'}</strong>
          </div>
          <div>
            <span>Balance</span>
            <strong>{!initialLoading && legacy ? zar(legacy.balance_total) : '—'}</strong>
          </div>
        </div>
        <div className="dash-zar-foot">
          <span>
            {legacy?.as_of ? `As of ${shortDate(legacy.as_of)}` : 'Historical ZIM workbook'} · kept
            outside USD P&amp;L
          </span>
          <button type="button" onClick={() => onView('zar')}>
            Open Rand ledger
            <Icon name="arrow" />
          </button>
        </div>
      </section>

      <section className="dash-card dash-chart-card">
        <div className="dash-card-head">
          <div>
            <div className="dash-card-eyebrow">Revenue pulse</div>
            <h2>Billed vs. collected</h2>
            <p>USD ledger movement across the selected reporting period.</p>
          </div>
          <div className="dash-legend">
            <span><i className="dash-legend-dot dash-legend-dot--billed" /> Billed</span>
            <span><i className="dash-legend-dot dash-legend-dot--paid" /> Collected</span>
          </div>
        </div>
        {initialLoading ? (
          <div className="dash-empty">Loading ledger movement…</div>
        ) : (
          <RevenueChart data={chartData} />
        )}
        <div className="dash-chart-foot">
          <span>Cycle anchor: 3rd → 3rd</span>
          <span>
            Billed {usd(chartData.reduce((sum, point) => sum + point.billed, 0))} · Collected{' '}
            {usd(chartData.reduce((sum, point) => sum + point.paid, 0))}
          </span>
        </div>
      </section>

      <div className="dash-grid dash-grid--two">
        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-eyebrow">Portfolio</div>
              <h2>Document mix &amp; status</h2>
              <p>{statusTotal} documents in the selected period.</p>
            </div>
            <button type="button" className="dash-link" onClick={() => onView('documents')}>
              View documents <Icon name="arrow" />
            </button>
          </div>

          <div className="dash-mix-list">
            {initialLoading && <div className="dash-empty">Loading document mix…</div>}
            {!initialLoading && mixRows.map((row) => (
              <div className="dash-mix-row" key={row.key}>
                <div className="dash-mix-head">
                  <span className="dash-mix-name">
                    <i className="dash-dot" style={{ background: row.color }} />
                    {row.label}
                  </span>
                  <span className="dash-mix-count">{row.total} docs</span>
                  <strong className="dash-mix-amount">{usd(row.amount)}</strong>
                </div>
                <div className="dash-status-track" aria-label={`${row.label} status breakdown`}>
                  {STATUSES.map((status) => {
                    const count = row.counts[status.key];
                    if (!count) return null;
                    return (
                      <span
                        key={status.key}
                        className="dash-status-seg"
                        style={{
                          width: `${(count / Math.max(row.total, 1)) * 100}%`,
                          background: status.color,
                        }}
                        title={`${status.label}: ${count}`}
                      />
                    );
                  })}
                </div>
                <div className="dash-mix-meta">
                  {STATUSES.filter((status) => row.counts[status.key] > 0)
                    .map((status) => `${row.counts[status.key]} ${status.label.toLowerCase()}`)
                    .join(' · ') || 'No documents'}
                </div>
              </div>
            ))}
          </div>
          <div className="dash-status-legend">
            {STATUSES.map((status) => (
              <span key={status.key}>
                <i style={{ background: status.color }} />
                {status.label}
                <strong>{statusTotals[status.key]}</strong>
              </span>
            ))}
          </div>
        </section>

        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-eyebrow">Receivables</div>
              <h2>AR aging</h2>
              <p>Current outstanding, by days overdue.</p>
            </div>
            <button type="button" className="dash-link" onClick={() => onView('aging')}>
              AR aging <Icon name="arrow" />
            </button>
          </div>
          <div className="dash-aging-list">
            {initialLoading && <div className="dash-empty">Loading AR aging…</div>}
            {!initialLoading && agingBuckets.map((bucket) => (
              <div className="dash-aging-row" key={bucket.label}>
                <span>{bucket.label}</span>
                <div className="dash-aging-track">
                  <i
                    style={{
                      width: `${Math.max(2, (bucket.value / agingMax) * 100)}%`,
                      background: bucket.color,
                    }}
                  />
                </div>
                <strong>{usd(bucket.value)}</strong>
              </div>
            ))}
          </div>
          <div className="dash-aging-total">
            <span>Total current AR</span>
            <strong>{usd(aging?.total)}</strong>
          </div>
          <div className="dash-aging-note">
            <span className="dash-alert-bar" aria-hidden />
            60+ day exposure: <strong>{usd(overdue)}</strong>
          </div>
        </section>
      </div>

      <div className="dash-grid dash-grid--two dash-grid--bottom">
        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-eyebrow">Relationships</div>
              <h2>Top customers</h2>
              <p>Billed revenue and outstanding balance in this period.</p>
            </div>
            <div className="dash-sort">
              <button
                type="button"
                className={customerSort === 'revenue' ? 'is-active' : ''}
                onClick={() => setCustomerSort('revenue')}
              >
                Revenue
              </button>
              <button
                type="button"
                className={customerSort === 'outstanding' ? 'is-active' : ''}
                onClick={() => setCustomerSort('outstanding')}
              >
                Outstanding
              </button>
            </div>
          </div>
          <div className="dash-customer-list">
            {initialLoading && <div className="dash-empty">Loading customers…</div>}
            {!initialLoading && customers.length === 0 && (
              <div className="dash-empty">No customer revenue in this period.</div>
            )}
            {!initialLoading && customers.map((customer, index) => {
              const max = Math.max(...customers.map((row) => (customerSort === 'revenue' ? row.billed : row.outstanding)), 1);
              const value = customerSort === 'revenue' ? customer.billed : customer.outstanding;
              return (
                <div className="dash-customer-row" key={customer.name}>
                  <span className="dash-rank">{String(index + 1).padStart(2, '0')}</span>
                  <div className="dash-customer-main">
                    <div className="dash-customer-name">
                      <strong>{customer.name}</strong>
                      <span>{customer.count} docs</span>
                    </div>
                    <div className="dash-customer-track">
                      <i style={{ width: `${Math.max(3, (value / max) * 100)}%` }} />
                    </div>
                  </div>
                  <div className="dash-customer-values">
                    <strong>{usd(customer.billed)}</strong>
                    <span>{usd(customer.outstanding)} owed</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="dash-card">
          <div className="dash-card-head">
            <div>
              <div className="dash-card-eyebrow">Live ledger</div>
              <h2>Recent activity</h2>
              <p>Latest 8 USD ledger transactions.</p>
            </div>
            <button type="button" className="dash-link" onClick={() => onView('accounting')}>
              Accounting <Icon name="arrow" />
            </button>
          </div>
          <div className="dash-activity-list">
            {initialLoading && <div className="dash-empty">Loading recent activity…</div>}
            {!initialLoading && recent.length === 0 && (
              <div className="dash-empty">No ledger entries in this period.</div>
            )}
            {!initialLoading && recent.map((row) => (
              <div className="dash-activity-row" key={row.id}>
                <span className={`dash-entry-badge dash-entry-badge--${entryTone(row.entry_type)}`}>
                  {entryLabel(row.entry_type)}
                </span>
                <div className="dash-activity-main">
                  <strong>{row.doc_number || row.description || 'Ledger entry'}</strong>
                  <span>
                    {dateTime(row.occurred_at)} · {row.rail || 'ledger'}
                  </span>
                </div>
                <strong className="dash-activity-amount">{usd(row.gross_amount)}</strong>
                <div className="dash-activity-actions">
                  {row.document_id && (
                    <>
                      <button type="button" title="Download PDF" onClick={() => onOpenDocument(row.document_id!, 'pdf')}>
                        <Icon name="pdf" />
                      </button>
                      <button type="button" title="Send via WhatsApp" onClick={() => onOpenDocument(row.document_id!, 'whatsapp')}>
                        <Icon name="whatsapp" />
                      </button>
                      <button type="button" title="Send by email" onClick={() => onOpenDocument(row.document_id!, 'email')}>
                        <Icon name="mail" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="dash-foot">
        <span>
          <span className="dash-live-dot" aria-hidden />
          Live ledger · auto-refreshes every 30s
        </span>
        <span>
          Cycle {shortDate(currentCycle.from)} → {shortDate(currentCycle.to)}
          {isCycle ? ' · current' : ''}
        </span>
      </footer>
    </div>
  );
}
