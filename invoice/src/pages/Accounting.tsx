import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download } from '../api';
import '../accounting.css';

type Tab = 'overview' | 'ledger' | 'pesepay' | 'tax';

interface Overview {
  todayTill?: number;
  totalGrossRevenue?: number;
  netSales?: number;
  taxCollected?: number;
  grossProfit?: number;
  outstandingAr?: number;
  mtdRevenue?: number;
  cashTotal?: number;
  pesepayTotal?: number;
  byRail?: Record<string, number>;
  stockValuation?: number;
  vatRate?: number;
  role?: string;
}

interface LedgerRow {
  id: string;
  occurred_at: string;
  entry_type: string;
  rail: string;
  doc_number?: string;
  description?: string;
  gross_amount: number;
  tax_amount: number;
  net_amount: number;
  cogs_amount: number;
  reference?: string;
}

interface PnL {
  grossRevenue: number;
  creditNotes: number;
  adjustedGross: number;
  taxCollected: number;
  netSales: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  operatingProfit: number;
}

interface TaxSummary {
  vatRate: number;
  posReceipts: { gross: number; vat: number; net: number; count: number };
  taxInvoices: { gross: number; vat: number; net: number; count: number };
  totalVatLiability: number;
}

const PESEPAY_RAILS = ['ecocash', 'omari', 'innbucks', 'paygo', 'pesepay'];

const money = (n: number | undefined) =>
  `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CHART_COLORS = ['#00F0FF', '#34D399', '#22D3EE', '#FBBF24', '#FB7185', '#A7F3D0', '#60A5FA', '#FDE68A'];

function DonutChart({
  data,
  centreLabel = 'collected',
}: {
  data: Array<{ label: string; value: number; color: string }>;
  centreLabel?: string;
}) {
  const total = data.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0) {
    return <div className="fin-area-empty">No collections in this period.</div>;
  }
  const centreText = money(total);
  // The amount is the one value that must never touch the ring. Scale it from
  // the character count and, for genuinely long figures, constrain the final
  // advance so the glyphs stay inside the inner plate.
  const centreSize =
    centreText.length >= 15
      ? 7.5
      : centreText.length >= 13
        ? 8.5
        : centreText.length >= 11
          ? 9.5
          : centreText.length >= 9
            ? 11
            : 13;
  const estimatedWidth = centreText.length * centreSize * 0.6;
  const fittedLength = estimatedWidth > 72 ? 72 : undefined;
  let offset = 0;
  return (
    <div className="fin-donut-wrap">
      <div className="fin-donut-stage">
        <svg className="fin-donut" viewBox="0 0 160 160" role="img" aria-label={`Collections by payment rail: ${centreText}`}>
          <defs>
            <radialGradient id="fin-donut-core" cx="50%" cy="38%" r="68%">
              <stop offset="0%" stopColor="#14243c" />
              <stop offset="58%" stopColor="#0a1322" />
              <stop offset="100%" stopColor="#050910" />
            </radialGradient>
            <linearGradient id="fin-donut-rim" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.6" />
              <stop offset="52%" stopColor="#34D399" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#00F0FF" stopOpacity="0.45" />
            </linearGradient>
            <filter id="fin-donut-glow" x="-35%" y="-35%" width="170%" height="170%">
              <feGaussianBlur stdDeviation="2.4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* HUD tick ring + recessed track gives the dial physical depth. */}
          <circle
            cx="80"
            cy="80"
            r="64"
            fill="none"
            stroke="rgba(103,232,249,0.26)"
            strokeWidth="0.8"
            strokeDasharray="1 4.6"
          />
          <circle cx="80" cy="80" r="54" fill="none" stroke="rgba(148,178,214,0.12)" strokeWidth="16" />

          {data.map((item) => {
            const pct = (Math.max(0, item.value) / total) * 100;
            const visible = Math.max(pct - 1.1, 0.4);
            const segment = (
              <circle
                key={item.label}
                className="segment"
                cx="80"
                cy="80"
                r="54"
                fill="none"
                stroke={item.color}
                strokeWidth="16"
                pathLength={100}
                strokeDasharray={`${visible} ${100 - visible}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
                filter="url(#fin-donut-glow)"
              >
                <title>{`${item.label}: ${money(item.value)} (${pct.toFixed(1)}%)`}</title>
              </circle>
            );
            offset += pct;
            return segment;
          })}

          <circle cx="80" cy="80" r="54" fill="none" stroke="url(#fin-donut-rim)" strokeWidth="1.2" />
          <circle cx="80" cy="80" r="43.5" fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
          <circle cx="80" cy="80" r="41.5" fill="url(#fin-donut-core)" stroke="rgba(0,240,255,0.2)" strokeWidth="1" />
          <text
            x="80"
            y="78"
            className="fin-donut-centre"
            style={{ fontSize: centreSize }}
            textLength={fittedLength}
            lengthAdjust="spacingAndGlyphs"
          >
            {centreText}
          </text>
          <text x="80" y="91" className="fin-donut-centre-label">
            {centreLabel}
          </text>
        </svg>
        <span className="fin-donut-scan" aria-hidden />
      </div>
      <div className="fin-legend">
        {data.map((item) => (
          <div className="fin-legend-row" key={item.label}>
            <span className="fin-legend-dot" style={{ background: item.color }} />
            <span style={{ textTransform: 'capitalize' }}>{item.label}</span>
            <span className="fin-legend-amount">{money(item.value)}</span>
            <span className="fin-legend-pct">{((item.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RevenuePulse({ points }: { points: Array<{ label: string; value: number }> }) {
  if (points.length === 0) {
    return <div className="fin-area-empty">No ledger movement in this period.</div>;
  }
  const width = 640;
  const height = 190;
  const padX = 26;
  const padTop = 16;
  const padBottom = 26;
  const max = Math.max(...points.map((point) => point.value), 1);
  const step = points.length > 1 ? (width - padX * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = padX + index * step;
    const y = height - padBottom - (point.value / max) * (height - padTop - padBottom);
    return [x, y] as const;
  });
  const line = coords
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${(width - padX).toFixed(1)},${height - padBottom} L${padX},${height - padBottom} Z`;
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <svg className="fin-area" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Revenue pulse by day">
      <defs>
        <linearGradient id="fin-line-grad" x1="0" x2="1">
          <stop offset="0%" stopColor="#00F0FF" />
          <stop offset="55%" stopColor="#34D399" />
          <stop offset="100%" stopColor="#22D3EE" />
        </linearGradient>
        <linearGradient id="fin-area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.28" />
          <stop offset="55%" stopColor="#34D399" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#00F0FF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="fin-area-floor" x1="0" x2="1">
          <stop offset="0%" stopColor="#00F0FF" stopOpacity="0" />
          <stop offset="50%" stopColor="#34D399" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#00F0FF" stopOpacity="0" />
        </linearGradient>
        <filter id="fin-line-glow" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="3.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* HUD grid: dashed horizontals, faint vertical beats, glowing floor. */}
      {[0, 1, 2, 3].map((lineIndex) => {
        const y = padTop + ((height - padTop - padBottom) / 3) * lineIndex;
        return (
          <line
            key={`h-${lineIndex}`}
            className="grid"
            x1={padX}
            x2={width - padX}
            y1={y}
            y2={y}
            strokeDasharray="3 5"
          />
        );
      })}
      {coords.map(([x], index) =>
        index % Math.max(1, Math.ceil(points.length / 8)) === 0 ? (
          <line
            key={`v-${index}`}
            className="grid-v"
            x1={x}
            x2={x}
            y1={padTop}
            y2={height - padBottom}
          />
        ) : null
      )}
      <line
        x1={padX}
        x2={width - padX}
        y1={height - padBottom}
        y2={height - padBottom}
        stroke="url(#fin-area-floor)"
        strokeWidth="1"
      />
      <path d={area} fill="url(#fin-area-fill)" />
      <path d={line} className="line-glow" filter="url(#fin-line-glow)" />
      <path d={line} className="line" />
      {coords.map(([x, y], index) => (
        <circle className="dot" key={points[index].label} cx={x} cy={y} r="3.1">
          <title>{`${points[index].label}: ${money(points[index].value)}`}</title>
        </circle>
      ))}
      <circle className="dot-halo" cx={lastX} cy={lastY} r="7.5" />
      <circle className="dot dot-last" cx={lastX} cy={lastY} r="3.6">
        <title>{`${points[points.length - 1].label}: ${money(points[points.length - 1].value)}`}</title>
      </circle>
      <text className="axis" x={padX} y={height - 6}>
        {points[0].label}
      </text>
      <text className="axis" x={width - padX} y={height - 6} textAnchor="end">
        {points[points.length - 1].label}
      </text>
    </svg>
  );
}

function PnlLadder({ rows }: { rows: Array<{ label: string; value: number; tone?: 'neg' | 'total' }> }) {
  const max = Math.max(...rows.map((row) => Math.abs(row.value)), 1);
  return (
    <div className="fin-ladder">
      {rows.map((row) => (
        <div className="fin-bar-row" key={row.label}>
          <span className="fin-bar-label">{row.label}</span>
          <span className="fin-bar-track">
            <i
              className={`fin-bar-fill${row.tone === 'neg' ? ' neg' : ''}${row.tone === 'total' ? ' total' : ''}`}
              style={{ width: `${Math.max(2, (Math.abs(row.value) / max) * 100)}%` }}
            />
          </span>
          <span className="fin-bar-value">{money(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Accounting & Financing dashboard — same /api/accounting surface as the
 * admin POS Accounting page, styled with the invoice workspace chrome.
 */
export default function AccountingPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rangePreset, setRangePreset] = useState<'all' | 'month' | '30' | 'year' | 'custom'>('all');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pnl, setPnl] = useState<PnL | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [tax, setTax] = useState<TaxSummary | null>(null);
  const [railFilter, setRailFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString() ? `?${p}` : '';
  }, [from, to]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const o = await api.get<Overview>(`/api/accounting/overview${qs()}`);
      setOverview(o);
      if (o.role !== 'Cashier') {
        const ledgerQs = new URLSearchParams();
        if (from) ledgerQs.set('from', from);
        if (to) ledgerQs.set('to', to);
        ledgerQs.set('limit', '200');
        if (railFilter) ledgerQs.set('rail', railFilter);
        if (typeFilter) ledgerQs.set('type', typeFilter);
        const [p, l, t] = await Promise.all([
          api.get<PnL>(`/api/accounting/pnl${qs()}`),
          api.get<{ rows: LedgerRow[] }>(`/api/accounting/ledger?${ledgerQs}`),
          api.get<TaxSummary>(`/api/accounting/tax-summary${qs()}`),
        ]);
        setPnl(p);
        setLedger(l.rows || []);
        setTax(t);
      }
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : 'Failed to load accounting');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [qs, from, to, railFilter, typeFilter]);

  useEffect(() => {
    void load(false);
    const id = window.setInterval(() => {
      void load(true);
    }, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  const stamp = new Date().toISOString().slice(0, 10);
  const exportWorkbook = () => {
    void download(
      `/api/accounting/export.xlsx${qs()}`,
      `preyone-client-account-${stamp}.xlsx`
    ).catch((e) => setError(e instanceof Error ? e.message : 'Excel export failed'));
  };
  const exportCsv = () => {
    void download(
      `/api/accounting/export.csv${qs()}`,
      `preyone-client-account-${stamp}.csv`
    ).catch((e) => setError(e instanceof Error ? e.message : 'CSV export failed'));
  };
  const exportLedgerCsv = () => {
    void download(
      `/api/accounting/export-ledger.csv${qs()}`,
      `preyone-ledger-${stamp}.csv`
    ).catch((e) => setError(e instanceof Error ? e.message : 'Ledger export failed'));
  };

  const applyRange = (preset: 'all' | 'month' | '30' | 'year') => {
    setRangePreset(preset);
    if (preset === 'all') {
      setFrom('');
      setTo('');
      return;
    }
    const now = new Date();
    const local = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (preset === 'month') {
      setFrom(local(new Date(now.getFullYear(), now.getMonth(), 1)));
      setTo(local(now));
    } else if (preset === '30') {
      const start = new Date(now);
      start.setDate(start.getDate() - 29);
      setFrom(local(start));
      setTo(local(now));
    } else {
      setFrom(local(new Date(now.getFullYear(), 0, 1)));
      setTo(local(now));
    }
  };

  const cashier = overview?.role === 'Cashier';

  const railData = useMemo(
    () =>
      Object.entries(overview?.byRail || {})
        .map(([label, value]) => ({ label, value: Number(value) || 0 }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((row, index) => ({ ...row, color: CHART_COLORS[index % CHART_COLORS.length] })),
    [overview]
  );

  const dailyPoints = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const row of ledger) {
      const day = String(row.occurred_at || '').slice(0, 10);
      if (!day) continue;
      byDay.set(day, (byDay.get(day) || 0) + (Number(row.gross_amount) || 0));
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-40)
      .map(([label, value]) => ({ label: label.slice(5), value }));
  }, [ledger]);

  const pnlRows = useMemo(
    () =>
      pnl
        ? [
            { label: 'Gross revenue', value: pnl.grossRevenue },
            { label: 'VAT collected', value: pnl.taxCollected },
            { label: 'Net sales', value: pnl.netSales, tone: 'total' as const },
            { label: 'COGS', value: pnl.cogs, tone: 'neg' as const },
            { label: 'Expenses', value: pnl.expenses, tone: 'neg' as const },
            { label: 'Operating profit', value: pnl.operatingProfit, tone: 'total' as const },
          ]
        : [],
    [pnl]
  );

  const maxRail = Math.max(...railData.map((row) => row.value), 1);

  return (
    <div className="acct-view">
      <div className="fin-hero">
        <div className="fin-hero-copy">
          <div className="fin-kicker">Financial intelligence</div>
          <h1>Accounting &amp; Financing</h1>
          <p>
            Live revenue, P&amp;L, cash mix, ledger, Preyone Payment rails and VAT — a complete financial
            cockpit for Preyone Enterprises.
          </p>
          <div className="fin-range">
            <button type="button" className={rangePreset === 'all' ? 'on' : ''} onClick={() => applyRange('all')}>All time</button>
            <button type="button" className={rangePreset === 'month' ? 'on' : ''} onClick={() => applyRange('month')}>This month</button>
            <button type="button" className={rangePreset === '30' ? 'on' : ''} onClick={() => applyRange('30')}>Last 30 days</button>
            <button type="button" className={rangePreset === 'year' ? 'on' : ''} onClick={() => applyRange('year')}>This year</button>
          </div>
        </div>
        <div className="fin-hero-side">
          <div className="fin-date-inputs">
            <input className="input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setRangePreset('custom'); }} aria-label="From date" />
            <input className="input" type="date" value={to} onChange={(e) => { setTo(e.target.value); setRangePreset('custom'); }} aria-label="To date" />
            <button className="btn ghost" type="button" onClick={() => void load()} disabled={loading}>
              {loading ? <span className="spinner" aria-hidden /> : null}
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {!cashier && (
            <div className="fin-export-actions">
              <button className="btn xls" type="button" onClick={exportWorkbook}>
                Export Excel
              </button>
              <button className="btn csv" type="button" onClick={exportCsv}>
                Export CSV
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="stats fin-kpis">
        <div className="stat">
          <div className="stat-label">Today&apos;s till</div>
          <div className="stat-value">{money(overview?.todayTill)}</div>
          <div className="stat-foot">cash drawer today</div>
        </div>
        {!cashier && (
          <>
            <div className="stat">
              <div className="stat-label">Gross profit</div>
              <div className="stat-value">{money(overview?.grossProfit)}</div>
              <div className="stat-foot">after COGS</div>
            </div>
            <div className="stat">
              <div className="stat-label">MTD revenue</div>
              <div className="stat-value">{money(overview?.mtdRevenue)}</div>
              <div className="stat-foot">month to date</div>
            </div>
            <div className="stat">
              <div className="stat-label">Outstanding AR</div>
              <div className={`stat-value ${(overview?.outstandingAr ?? 0) > 0 ? 'warn' : ''}`}>
                {money(overview?.outstandingAr)}
              </div>
              <div className="stat-foot">unpaid invoices</div>
            </div>
          </>
        )}
        {cashier && (
          <>
            <div className="stat">
              <div className="stat-label">Cash</div>
              <div className="stat-value">{money(overview?.cashTotal)}</div>
              <div className="stat-foot">cash / card / bank</div>
            </div>
            <div className="stat">
              <div className="stat-label">Preyone Payment</div>
              <div className="stat-value">{money(overview?.pesepayTotal)}</div>
              <div className="stat-foot">mobile rails</div>
            </div>
          </>
        )}
      </div>

      {!cashier && (
        <>
          <div className="fin-chart-grid">
            <section className="fin-card">
              <div className="fin-chart-head">
                <div>
                  <div className="fin-chart-title">Revenue pulse</div>
                  <div className="fin-chart-sub">Daily gross collections from the general ledger</div>
                </div>
                <span className="fin-chart-badge">{dailyPoints.length} days</span>
              </div>
              <RevenuePulse points={dailyPoints} />
            </section>
            <section className="fin-card">
              <div className="fin-chart-head">
                <div>
                  <div className="fin-chart-title">Money mix</div>
                  <div className="fin-chart-sub">Collections by payment rail</div>
                </div>
              </div>
              <DonutChart data={railData} />
            </section>
          </div>

          <div className="fin-chart-grid">
            <section className="fin-card">
              <div className="fin-chart-head">
                <div>
                  <div className="fin-chart-title">P&amp;L ladder</div>
                  <div className="fin-chart-sub">Revenue to operating profit, 3rd-to-3rd cycle</div>
                </div>
                <span className="fin-chart-badge">VAT {overview?.vatRate ?? 15.5}%</span>
              </div>
              {pnl ? <PnlLadder rows={pnlRows} /> : <div className="fin-area-empty">Loading P&amp;L…</div>}
            </section>
            <section className="fin-card">
              <div className="fin-chart-head">
                <div>
                  <div className="fin-chart-title">Rail leaderboard</div>
                  <div className="fin-chart-sub">Where the money came from</div>
                </div>
              </div>
              <div className="fin-rail-list">
                {railData.length === 0 ? (
                  <div className="fin-area-empty">No rail collections yet.</div>
                ) : (
                  railData.slice(0, 7).map((rail) => (
                    <div className="fin-rail-row" key={rail.label}>
                      <span className="fin-rail-name">{rail.label}</span>
                      <span className="fin-rail-track">
                        <i
                          className="fin-rail-fill"
                          style={{ width: `${Math.max(3, (rail.value / maxRail) * 100)}%` }}
                        />
                      </span>
                      <span className="fin-rail-value">{money(rail.value)}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {cashier ? (
        <p className="muted">Cashier view — till drawer totals only. Ask a Manager or CEO for the full ledger.</p>
      ) : (
        <>
          <div className="acct-tabs fin-tabs" role="tablist" aria-label="Accounting reports">
            {(
              [
                ['overview', 'Overview & P&L'],
                ['ledger', 'General Ledger'],
                ['pesepay', 'Preyone Payment Rail'],
                ['tax', 'Tax & VAT'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`acct-tab${tab === id ? ' on' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {loading && <div className="empty">Loading accounting…</div>}

          {!loading && tab === 'overview' && pnl && (
            <div className="card panel">
              <div className="panel-head">
                <div className="panel-title">Profit &amp; loss (3rd-to-3rd)</div>
                <span className="muted small">VAT {overview?.vatRate ?? 15.5}%</span>
              </div>
              <div className="acct-pnl">
                {(
                  [
                    ['Gross Revenue', pnl.grossRevenue],
                    ['Credit Notes', pnl.creditNotes],
                    ['Adjusted Gross', pnl.adjustedGross],
                    [`VAT (${overview?.vatRate ?? 15.5}%)`, pnl.taxCollected],
                    ['Net Sales', pnl.netSales],
                    ['COGS', pnl.cogs],
                    ['Gross Profit', pnl.grossProfit],
                    ['Expenses', pnl.expenses],
                    ['Operating Profit', pnl.operatingProfit],
                  ] as Array<[string, number]>
                ).map(([label, val]) => (
                  <div className="acct-pnl-row" key={label}>
                    <span>{label}</span>
                    <strong className="mono">{money(val)}</strong>
                  </div>
                ))}
              </div>
              <div className="acct-rail-strip">
                <div>
                  <span className="muted small">Cash / Card / Bank</span>
                  <strong className="mono">{money(overview?.cashTotal)}</strong>
                </div>
                <div>
                  <span className="muted small">Preyone Payment Rails</span>
                  <strong className="mono">{money(overview?.pesepayTotal)}</strong>
                </div>
                <div>
                  <span className="muted small">Stock Valuation</span>
                  <strong className="mono">{money(overview?.stockValuation)}</strong>
                </div>
              </div>
            </div>
          )}

          {!loading && tab === 'ledger' && (
            <div className="card panel">
              <div className="panel-head">
                <div className="panel-title">General ledger</div>
                <div className="panel-tools">
                  <select className="select" value={railFilter} onChange={(e) => setRailFilter(e.target.value)}>
                    <option value="">All rails</option>
                    {['cash', 'card', 'bank', ...PESEPAY_RAILS, 'other'].map((r) => (
                      <option key={r} value={r}>
                        {r === 'pesepay' ? 'Preyone Payment' : r}
                      </option>
                    ))}
                  </select>
                  <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">All types</option>
                    {['pos_sale', 'invoice_payment', 'pesepay_collection', 'credit_note', 'expense'].map((t) => (
                      <option key={t} value={t}>
                        {t === 'pesepay_collection' ? 'Preyone Payment collection' : t}
                      </option>
                    ))}
                  </select>
                  <button className="btn ghost" type="button" onClick={exportLedgerCsv}>
                    Ledger CSV
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Type</th>
                      <th>Rail</th>
                      <th>Doc</th>
                      <th className="num">Gross</th>
                      <th className="num">VAT</th>
                      <th className="num">Net</th>
                      <th className="num">COGS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="empty">
                          No ledger entries
                        </td>
                      </tr>
                    ) : (
                      ledger.map((r) => (
                        <tr key={r.id}>
                          <td>{new Date(r.occurred_at).toLocaleString()}</td>
                          <td>{r.entry_type}</td>
                          <td>{r.rail}</td>
                          <td className="mono">{r.doc_number || '—'}</td>
                          <td className="num mono">{money(r.gross_amount)}</td>
                          <td className="num mono">{money(r.tax_amount)}</td>
                          <td className="num mono">{money(r.net_amount)}</td>
                          <td className="num mono">{money(r.cogs_amount)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && tab === 'pesepay' && (
            <>
              <div className="stats">
                {PESEPAY_RAILS.map((rail) => (
                  <div className="stat" key={rail}>
                    <div className="stat-label">{rail.toUpperCase()}</div>
                    <div className="stat-value">{money(overview?.byRail?.[rail])}</div>
                    <div className="stat-foot">rail collections</div>
                  </div>
                ))}
              </div>
              <div className="card panel">
                <div className="panel-head">
                  <div className="panel-title">Preyone Payment rail reconciliation</div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Rail</th>
                        <th>Doc</th>
                        <th>Reference</th>
                        <th className="num">Gross</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.filter((r) => PESEPAY_RAILS.includes(r.rail)).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="empty">
                            No Preyone Payment rail entries in this period
                          </td>
                        </tr>
                      ) : (
                        ledger
                          .filter((r) => PESEPAY_RAILS.includes(r.rail))
                          .map((r) => (
                            <tr key={r.id}>
                              <td>{new Date(r.occurred_at).toLocaleString()}</td>
                              <td>{r.rail}</td>
                              <td className="mono">{r.doc_number || '—'}</td>
                              <td>{r.reference || '—'}</td>
                              <td className="num mono">{money(r.gross_amount)}</td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {!loading && tab === 'tax' && tax && (
            <div className="stats">
              <div className="stat">
                <div className="stat-label">POS receipts VAT</div>
                <div className="stat-value">{money(tax.posReceipts.vat)}</div>
                <div className="stat-foot">
                  {tax.posReceipts.count} docs · gross {money(tax.posReceipts.gross)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Tax invoice VAT</div>
                <div className="stat-value">{money(tax.taxInvoices.vat)}</div>
                <div className="stat-foot">
                  {tax.taxInvoices.count} docs · gross {money(tax.taxInvoices.gross)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Total VAT liability</div>
                <div className="stat-value warn">{money(tax.totalVatLiability)}</div>
                <div className="stat-foot">rate {tax.vatRate}%</div>
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}
