import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  download,
  type ArAging,
  type Catalog,
  type Company,
  type DocType,
  type DocumentDetail,
  type DocumentEvent,
  type InvoiceTemplate,
  type PosDocument,
  type ThemeResponse,
  type ThemeTokens,
} from './api';
import { applyCssVars } from './theme';
import { OnlinePaymentModal, ReceiptPreview } from './payments';

/* ────────────────────────────── helpers ────────────────────────────── */

const CURRENCIES = ['USD', 'ZWG', 'ZiG', 'ZAR', 'GBP', 'EUR'];

const FALLBACK_TYPES: DocType[] = [
  ['invoice', 'Invoice', 'INV', true, false],
  ['tax_invoice', 'Tax Invoice', 'TIN', true, false],
  ['proforma', 'Proforma', 'PRO', true, false],
  ['quote', 'Quote', 'QUO', false, false],
  ['estimate', 'Estimate', 'EST', false, false],
  ['receipt', 'Receipt', 'RCT', false, false],
  ['sales_receipt', 'Sales Receipt', 'SRC', true, false],
  ['cash_receipt', 'Cash Receipt', 'CRC', false, false],
  ['credit_memo', 'Credit Memo', 'CRM', false, true],
  ['credit_note', 'Credit Note', 'CRN', false, true],
  ['purchase_order', 'Purchase Order', 'PO', false, false],
  ['delivery_note', 'Delivery Note', 'DN', false, false],
].map(([type, label, prefix, ar, credit]) => ({
  type: type as string,
  label: label as string,
  prefix: prefix as string,
  ar: ar as boolean,
  credit: credit as boolean,
}));

function money(value: unknown, currency = 'USD'): string {
  const n = Number(value) || 0;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${currency} ${formatted}`;
}

function qty(value: unknown): string {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function dateLabel(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function typeLabel(types: DocType[], type: string): string {
  return types.find((t) => t.type === type)?.label ?? type.replace(/_/g, ' ');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/* ────────────────────────────── chrome ─────────────────────────────── */

function Brand({ company }: { company?: Company | null }) {
  const logo = company?.logo_url || (company?.logo_path ? `/images/${company.logo_path}` : null);
  return (
    <div className="brand">
      {logo ? (
        <img className="brand-logo" src={logo} alt={`${company?.name ?? 'Preyone'} logo`} />
      ) : (
        <div className="brand-mark">P</div>
      )}
      <div>
        <div className="brand-name">{company?.name || 'Preyone'}</div>
        <div className="brand-sub">Invoicing</div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const key = ['paid', 'unpaid', 'partial', 'draft', 'sent', 'void'].includes(status) ? status : 'sent';
  return <span className={`badge ${key}`}>{status}</span>;
}

/* ────────────────────────────── login ──────────────────────────────── */

function LoginPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [masked, setMasked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = challenge ? '/api/admin/auth/verify-2fa' : '/api/admin/auth/login';
      const body = challenge ? { challengeToken: challenge, code } : { email, password };
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      if (data.requires2fa) {
        setChallenge(data.challengeToken);
        setMasked(data.maskedEmail || '');
        return;
      }
      if (data.token) localStorage.setItem('gateway_token', data.token);
      onSignedIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>{challenge ? 'Two-factor code' : 'Sign in to Invoicing'}</h1>
        <p>
          {challenge
            ? `Enter the code sent to ${masked || 'your email'}.`
            : 'Your Preyone session is shared across every workspace.'}
        </p>
        {error && <div className="banner error">{error}</div>}
        {challenge ? (
          <label className="field">
            <span>6-digit code</span>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoFocus
              required
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
          </>
        )}
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? 'Please wait…' : challenge ? 'Verify' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/* ───────────────────────────── composer ────────────────────────────── */

interface DraftLine {
  key: number;
  description: string;
  qty: string;
  price: string;
}

function Composer({
  catalog,
  onClose,
  onCreated,
}: {
  catalog: Catalog;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const types = catalog.documentTypes.length ? catalog.documentTypes : FALLBACK_TYPES;
  const templates = catalog.templates;
  const [docType, setDocType] = useState(types[0]?.type ?? 'invoice');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [netDays, setNetDays] = useState('30');
  const [currency, setCurrency] = useState(catalog.company.currency || 'USD');
  const [exchangeRate, setExchangeRate] = useState('1');
  const [taxPct, setTaxPct] = useState(String(Number(catalog.company.tax_pct) || 0));
  const [discountPct, setDiscountPct] = useState('0');
  const [templateId, setTemplateId] = useState(String(catalog.company.invoice_template_id || templates[0]?.id || 1));
  const [poNumber, setPoNumber] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ key: 1, description: '', qty: '1', price: '0' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKey = useRef(2);

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.price) || 0), 0),
    [lines]
  );
  const discount = (subtotal * (Number(discountPct) || 0)) / 100;
  const total = subtotal - discount;
  const taxPortion = total - total / (1 + (Number(taxPct) || 0) / 100);

  const setLine = (key: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = lines.filter((l) => l.description.trim());
    if (clean.length === 0) {
      setError('Add at least one line item with a description.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<PosDocument>('/api/pos/documents', {
        docType,
        customer: customerName.trim()
          ? { name: customerName.trim(), email: customerEmail.trim() || undefined, address: customerAddress.trim() || undefined }
          : undefined,
        issueDate,
        netDays: Number(netDays) || 0,
        currency,
        exchangeRate: Number(exchangeRate) || 1,
        taxPct: Number(taxPct) || 0,
        discountPct: Number(discountPct) || 0,
        templateId: Number(templateId) || undefined,
        poNumber: poNumber || undefined,
        reference: reference || undefined,
        notes: notes || undefined,
        status: 'draft',
        items: clean.map((l) => ({
          description: l.description.trim(),
          qty: Number(l.qty) || 1,
          price: Number(l.price) || 0,
        })),
      });
      onCreated(created.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="sheet wide" onSubmit={submit}>
        <div className="sheet-head">
          <div>
            <h2 className="sheet-title">New {typeLabel(types, docType)}</h2>
            <p className="sheet-sub">Drafts never touch stock — issue them from here, send, then take payment.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}

        <div className="form-grid">
          <label className="field">
            <span>Document type</span>
            <select className="select" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label} ({t.prefix})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Template</span>
            <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}. {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field span-2">
            <span>Bill to — customer</span>
            <input
              className="input"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Acme Trading (Pvt) Ltd"
            />
          </label>
          <label className="field">
            <span>Customer email</span>
            <input className="input" type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Customer address</span>
            <input className="input" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} />
          </label>
          <label className="field">
            <span>Issue date</span>
            <input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Payment terms (days)</span>
            <input className="input" type="number" min={0} max={365} value={netDays} onChange={(e) => setNetDays(e.target.value)} />
          </label>
          <label className="field">
            <span>Currency</span>
            <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Exchange rate → USD</span>
            <input className="input" type="number" step="0.000001" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} />
          </label>
          <label className="field">
            <span>Tax % (inclusive)</span>
            <input className="input" type="number" step="0.01" min={0} value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
          </label>
          <label className="field">
            <span>Discount %</span>
            <input className="input" type="number" step="0.01" min={0} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
          </label>
          <label className="field">
            <span>PO number</span>
            <input className="input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
          </label>
          <label className="field">
            <span>Your reference</span>
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        </div>

        <div style={{ marginTop: 22 }}>
          <div className="panel-title" style={{ marginBottom: 10 }}>Line items</div>
          {lines.map((line) => (
            <div className="line-row" key={line.key}>
              <label className="field">
                <span>Description</span>
                <input
                  className="input"
                  value={line.description}
                  onChange={(e) => setLine(line.key, { description: e.target.value })}
                  placeholder="Consulting — October"
                />
              </label>
              <label className="field">
                <span>Qty</span>
                <input className="input" type="number" min={0} step="0.01" value={line.qty} onChange={(e) => setLine(line.key, { qty: e.target.value })} />
              </label>
              <label className="field">
                <span>Price</span>
                <input className="input" type="number" min={0} step="0.01" value={line.price} onChange={(e) => setLine(line.key, { price: e.target.value })} />
              </label>
              <div className="line-total">{money((Number(line.qty) || 0) * (Number(line.price) || 0), currency)}</div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove line"
                onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== line.key) : prev))}
              >
                −
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              const key = nextKey.current++;
              setLines((prev) => [...prev, { key, description: '', qty: '1', price: '0' }]);
            }}
          >
            + Add line
          </button>

          <div className="calc-pills" aria-live="polite">
            <span className="calc-pill">
              {lines.filter((l) => l.description.trim()).length} line
              {lines.filter((l) => l.description.trim()).length === 1 ? '' : 's'}
            </span>
            <span className="calc-pill">
              Discount {Number(discountPct) || 0}% · {money(discount, currency)}
            </span>
            <span className="calc-pill">Tax included {money(taxPortion, currency)}</span>
            <span className="calc-pill strong">{money(total, currency)} due</span>
          </div>

          <div className="summary-box">
            <div className="summary-row">
              <span>Subtotal</span>
              <span className="mono">{money(subtotal, currency)}</span>
            </div>
            <div className="summary-row">
              <span>Discount</span>
              <span className="mono">− {money(discount, currency)}</span>
            </div>
            <div className="summary-row">
              <span>Included tax</span>
              <span className="mono">{money(taxPortion, currency)}</span>
            </div>
            <div className="summary-row total">
              <span>Total</span>
              <span className="mono">{money(total, currency)}</span>
            </div>
            {currency !== 'USD' && (
              <div className="summary-row small">
                <span>USD equivalent</span>
                <span className="mono">{money(total / (Number(exchangeRate) || 1), 'USD')}</span>
              </div>
            )}
          </div>
        </div>

        <label className="field" style={{ marginTop: 18 }}>
          <span>Notes / payment instructions</span>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ──────────────────────────── document view ────────────────────────── */

function DocumentDrawer({
  id,
  templates,
  types,
  onClose,
  onChanged,
}: {
  id: string;
  templates: InvoiceTemplate[];
  types: DocType[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [events, setEvents] = useState<DocumentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [payRef, setPayRef] = useState('');
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, timeline] = await Promise.all([
        api.get<DocumentDetail>(`/api/pos/documents/${id}`),
        api.get<DocumentEvent[]>(`/api/pos/documents/${id}/events`).catch(() => []),
      ]);
      setDoc(detail);
      setEvents(timeline);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance = doc ? Number(doc.total) - Number(doc.amount_paid) : 0;
  const template = templates.find((t) => t.id === Number(doc?.template_id)) ?? templates[0];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const recordPayment = () =>
    act(async () => {
      await api.post(`/api/pos/documents/${id}/payments`, {
        amount: Number(payAmount),
        method: payMethod,
        reference: payRef || undefined,
      });
      setPayAmount('');
      setPayRef('');
    });

  return (
    <>
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="sheet wide">
        <div className="sheet-head">
          <div>
            <h2 className="sheet-title">
              {doc ? doc.doc_number : 'Loading…'}{' '}
              {doc && <StatusBadge status={doc.status} />}
            </h2>
            <p className="sheet-sub">
              {doc ? `${typeLabel(types, doc.doc_type)} · ${dateLabel(doc.issue_date)}` : ''}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}
        {!doc && !error && <div className="skeleton" style={{ height: 120 }} />}

        {doc && (
          <>
            <div className="topbar-actions" style={{ marginBottom: 18 }}>
              {balance > 0.005 && doc.status !== 'void' && (
                <button className="btn primary" type="button" onClick={() => setOnlineOpen(true)}>
                  Take payment
                </button>
              )}
              {Number(doc.amount_paid) > 0 && (
                <button className="btn" type="button" onClick={() => setReceiptOpen(true)}>
                  Receipt
                </button>
              )}
              <button className="btn" onClick={() => window.print()} type="button">
                Print / PDF
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => download(`/api/pos/documents/${doc.id}/ubl`, `${doc.doc_number}.xml`).catch((e) => setError(errorText(e)))}
              >
                UBL / Peppol XML
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || doc.status === 'void'}
                onClick={() => act(() => api.post(`/api/pos/documents/${doc.id}/send`, {}))}
              >
                Mark sent
              </button>
              <button
                className="btn danger"
                type="button"
                disabled={busy || doc.status === 'void'}
                onClick={() => {
                  const reason = window.prompt('Reason for voiding this document?') || '';
                  if (reason.trim()) void act(() => api.post(`/api/pos/documents/${doc.id}/void`, { reason }));
                }}
              >
                Void
              </button>
            </div>

            <div className="split">
              <div>
                <div className="card" style={{ padding: 20, background: '#fff', color: '#0f172a' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18 }}>
                    <div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: template?.accentColor || '#0f172a' }}>
                        {typeLabel(types, doc.doc_type).toUpperCase()}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b' }}>{doc.doc_number}</div>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 12, color: '#475569' }}>
                      <div>Issued {dateLabel(doc.issue_date)}</div>
                      <div>Due {dateLabel(doc.due_date)}</div>
                    </div>
                  </div>
                  <div style={{ margin: '18px 0', fontSize: 12, color: '#334155' }}>
                    <strong>Bill to</strong>
                    <div>{doc.customer?.name || doc.customer_name || 'Walk-in customer'}</div>
                    {doc.customer?.address && <div>{doc.customer.address}</div>}
                    {doc.customer?.email && <div>{doc.customer.email}</div>}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Description</th>
                        <th className="num" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Qty</th>
                        <th className="num" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Price</th>
                        <th className="num" style={{ color: '#64748b', borderColor: '#e2e8f0' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {doc.items.map((item, i) => (
                        <tr key={item.id ?? i} style={{ cursor: 'default' }}>
                          <td style={{ borderColor: '#eef2f7', color: '#0f172a' }}>{item.description}</td>
                          <td className="num" style={{ borderColor: '#eef2f7', color: '#0f172a' }}>{qty(item.qty)}</td>
                          <td className="num" style={{ borderColor: '#eef2f7', color: '#0f172a' }}>{money(item.price, doc.currency || 'USD')}</td>
                          <td className="num" style={{ borderColor: '#eef2f7', color: '#0f172a' }}>
                            {money(item.line_total ?? Number(item.qty) * Number(item.price), doc.currency || 'USD')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="summary-box" style={{ color: '#334155' }}>
                    <div className="summary-row">
                      <span>Subtotal</span>
                      <span className="mono">{money(doc.subtotal, doc.currency || 'USD')}</span>
                    </div>
                    <div className="summary-row">
                      <span>Paid</span>
                      <span className="mono">{money(doc.amount_paid, doc.currency || 'USD')}</span>
                    </div>
                    <div className="summary-row total" style={{ color: '#0f172a', borderColor: '#e2e8f0' }}>
                      <span>Balance due</span>
                      <span className="mono">{money(balance, doc.currency || 'USD')}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="card" style={{ padding: 16, marginBottom: 16 }}>
                  <div className="panel-title" style={{ marginBottom: 10 }}>Record payment</div>
                  <div className="form-grid">
                    <label className="field">
                      <span>Amount</span>
                      <input className="input" type="number" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                    </label>
                    <label className="field">
                      <span>Method</span>
                      <select className="select" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                        {['cash', 'card', 'ecocash', 'innbucks', 'bank', 'pesepay', 'other'].map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field span-2">
                      <span>Reference</span>
                      <input className="input" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
                    </label>
                  </div>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !(Number(payAmount) > 0) || doc.status === 'void'}
                    onClick={() => void recordPayment()}
                    style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
                  >
                    Apply payment
                  </button>
                </div>

                <div className="card" style={{ padding: 16, marginBottom: 16 }}>
                  <div className="panel-title" style={{ marginBottom: 10 }}>Timeline</div>
                  {events.length === 0 ? (
                    <div className="muted small">No events recorded yet.</div>
                  ) : (
                    <div className="timeline">
                      {events.map((event) => (
                        <div className="timeline-item" key={event.id}>
                          <span className="timeline-dot" />
                          <div>
                            <div style={{ fontWeight: 600 }}>{event.event.replace(/_/g, ' ')}</div>
                            <div className="muted small">
                              {dateLabel(event.created_at)}
                              {event.actor_name ? ` · ${event.actor_name}` : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {doc.payments.length > 0 && (
                  <div className="card" style={{ padding: 16 }}>
                    <div className="panel-title" style={{ marginBottom: 10 }}>Payments</div>
                    <div className="drawer-list">
                      {doc.payments.map((p) => (
                        <div className="drawer-item" key={p.id}>
                          <span>{p.method}</span>
                          <span className="mono">{money(p.amount, doc.currency || 'USD')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        </div>
      </div>

      {onlineOpen && doc && (
        <OnlinePaymentModal
          doc={doc}
          onClose={() => setOnlineOpen(false)}
          onPaid={() => {
            void load();
            onChanged();
          }}
          onReceipt={() => {
            setOnlineOpen(false);
            void load().then(() => setReceiptOpen(true));
          }}
        />
      )}

      {receiptOpen && doc && <ReceiptPreview doc={doc} onClose={() => setReceiptOpen(false)} />}
    </>
  );
}

/* ───────────────────────────── settings ────────────────────────────── */

function SettingsPanel({
  catalog,
  onCatalog,
}: {
  catalog: Catalog;
  onCatalog: (next: Catalog) => void;
}) {
  const [templateId, setTemplateId] = useState(Number(catalog.company.invoice_template_id) || 1);
  const [themeId, setThemeId] = useState(Number(catalog.company.pos_theme_id) || 1);
  const [currency, setCurrency] = useState(catalog.company.currency || 'USD');
  const [taxPct, setTaxPct] = useState(String(Number(catalog.company.tax_pct) || 0));
  const [terms, setTerms] = useState(catalog.company.terms_text || '');
  const [footer, setFooter] = useState(catalog.company.receipt_footer || '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api.patch<Company>('/api/pos/invoice-settings', {
        templateId,
        currency,
        taxPct: Number(taxPct) || 0,
        termsText: terms,
        footer,
      });
      onCatalog({ ...catalog, company: { ...catalog.company, ...saved, invoice_template_id: templateId } });
      setNotice({ kind: 'ok', text: 'Invoicing defaults saved.' });
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const pickTheme = async (id: number) => {
    setThemeId(id);
    try {
      const res = await api.patch<ThemeResponse>('/api/pos/theme', { themeId: id });
      applyCssVars(res.css);
      onCatalog({ ...catalog, company: { ...catalog.company, pos_theme_id: id } });
      setNotice({ kind: 'ok', text: `Theme “${res.theme.name}” applied to every workspace.` });
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    }
  };

  const uploadLogo = (file: File) => {
    setNotice(null);
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setNotice({ kind: 'error', text: 'Logo must be a PNG, JPEG or WebP image.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setNotice({ kind: 'error', text: 'Logo must be 2 MB or smaller.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await api.post<{ logoUrl: string }>('/api/admin/company/logo', { dataUrl: String(reader.result) });
        onCatalog({ ...catalog, company: { ...catalog.company, logo_url: res.logoUrl } });
        setNotice({ kind: 'ok', text: 'Logo updated across invoices and receipts.' });
      } catch (err) {
        setNotice({ kind: 'error', text: errorText(err) });
      }
    };
    reader.onerror = () => setNotice({ kind: 'error', text: 'Could not read that file.' });
    reader.readAsDataURL(file);
  };

  return (
    <div>
      {notice && <div className={`banner ${notice.kind === 'ok' ? 'ok' : 'error'}`}>{notice.text}</div>}

      <div className="card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="panel-head" style={{ padding: 0, border: 'none', marginBottom: 14 }}>
          <div className="panel-title">Brand & defaults</div>
          <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save defaults'}
          </button>
        </div>
        <div className="split">
          <div className="form-grid">
            <label className="field">
              <span>Default currency</span>
              <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Default tax %</span>
              <input className="input" type="number" step="0.01" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />
            </label>
            <label className="field span-2">
              <span>Terms & conditions</span>
              <textarea className="textarea" value={terms} onChange={(e) => setTerms(e.target.value)} />
            </label>
            <label className="field span-2">
              <span>Footer note</span>
              <input className="input" value={footer} onChange={(e) => setFooter(e.target.value)} />
            </label>
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 8 }}>Company logo</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {catalog.company.logo_url ? (
                <img src={catalog.company.logo_url} alt="Company logo" style={{ width: 64, height: 64, objectFit: 'contain', background: '#fff', borderRadius: 10, padding: 6 }} />
              ) : (
                <div className="brand-mark" style={{ width: 64, height: 64, fontSize: 26 }}>P</div>
              )}
              <div>
                <button className="btn" type="button" onClick={() => fileRef.current?.click()}>
                  Upload logo
                </button>
                <div className="muted small" style={{ marginTop: 6 }}>PNG, JPEG or WebP · max 2 MB</div>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogo(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="panel-title" style={{ marginBottom: 4 }}>PDF templates</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
          20 professional layouts. The selected template is the default for every new document.
        </p>
        <div className="template-grid">
          {catalog.templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`template-card ${templateId === t.id ? 'selected' : ''}`}
              onClick={() => setTemplateId(t.id)}
            >
              <div
                className={`tpl-preview ${t.layout}`}
                style={{ color: t.accentColor }}
              >
                <div className="bar" style={{ background: t.accentColor, width: t.showLogo ? '34%' : '52%' }} />
                <div className="line" style={{ width: '78%' }} />
                <div className="line" style={{ width: '62%' }} />
                <div className="line" style={{ width: '70%' }} />
                <div className="line" style={{ width: '45%' }} />
              </div>
              <h4>{t.id}. {t.name}</h4>
              <p>{t.description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div className="panel-title" style={{ marginBottom: 4 }}>Workspace theme</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
          One choice, every Preyone surface: POS, invoicing and home automation update instantly.
        </p>
        <div className="theme-grid">
          {catalog.themes.map((t: ThemeTokens) => (
            <button
              key={t.id}
              type="button"
              className={`theme-chip ${themeId === t.id ? 'selected' : ''}`}
              onClick={() => void pickTheme(Number(t.id))}
            >
              <span className="theme-swatch">
                <i style={{ background: t.bg }} />
                <i style={{ background: t.primary }} />
                <i style={{ background: t.accent }} />
                <i style={{ background: t.secondary }} />
              </span>
              <span>{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── app ───────────────────────────────── */

type View = 'documents' | 'aging' | 'settings';

const AR_BUCKETS: Array<{ key: keyof ArAging['buckets']; label: string; tone?: string }> = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30 days', tone: 'warn' },
  { key: 'd31_60', label: '31–60 days', tone: 'warn' },
  { key: 'd61_90', label: '61–90 days', tone: 'danger' },
  { key: 'd90plus', label: '90+ days', tone: 'danger' },
];

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('documents');
  const [docs, setDocs] = useState<PosDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [aging, setAging] = useState<ArAging | null>(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [openDocId, setOpenDocId] = useState<string | null>(null);

  const types = catalog?.documentTypes.length ? catalog.documentTypes : FALLBACK_TYPES;
  const templates = catalog?.templates ?? [];

  const boot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cat, theme] = await Promise.all([
        api.get<Catalog>('/api/pos/catalog'),
        api.get<ThemeResponse>('/api/pos/theme'),
      ]);
      setCatalog(cat);
      applyCssVars(theme.css);
      setAuthError(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setAuthError(true);
      } else {
        setError(errorText(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (query.trim()) params.set('q', query.trim());
      params.set('limit', '200');
      setDocs(await api.get<PosDocument[]>(`/api/pos/documents?${params.toString()}`));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDocsLoading(false);
    }
  }, [typeFilter, statusFilter, query]);

  const loadAging = useCallback(async () => {
    try {
      setAging(await api.get<ArAging>('/api/pos/reports/ar-aging'));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!catalog) return;
    void loadDocs();
  }, [catalog, loadDocs]);

  useEffect(() => {
    if (!catalog) return;
    void loadAging();
  }, [catalog, loadAging]);

  const refreshAll = useCallback(() => {
    void loadDocs();
    void loadAging();
  }, [loadDocs, loadAging]);

  const totals = useMemo(() => {
    const outstanding = docs.reduce((sum, d) => sum + Math.max(0, Number(d.total) - Number(d.amount_paid)), 0);
    const paid = docs.reduce((sum, d) => sum + Number(d.amount_paid), 0);
    return { outstanding, paid, count: docs.length };
  }, [docs]);

  if (authError) return <LoginPanel onSignedIn={() => void boot()} />;

  if (loading) {
    return (
      <div className="app-shell">
        <aside className="sidebar">
          <Brand company={null} />
        </aside>
        <main className="main">
          <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 18 }} />
          <div className="stats">
            {[0, 1, 2, 3].map((i) => (
              <div className="stat" key={i}>
                <div className="skeleton" style={{ width: '55%' }} />
                <div className="skeleton" style={{ width: '75%', height: 24, marginTop: 12 }} />
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand company={catalog?.company} />

        <div className="nav-section">
          <div className="nav-label">Workspace</div>
          <button className={`nav-item ${view === 'documents' ? 'active' : ''}`} onClick={() => setView('documents')} type="button">
            <span className="nav-dot" /> All documents
          </button>
          <button className={`nav-item ${view === 'aging' ? 'active' : ''}`} onClick={() => setView('aging')} type="button">
            <span className="nav-dot" /> AR aging
          </button>
          <button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')} type="button">
            <span className="nav-dot" /> Templates & theme
          </button>
        </div>

        <div className="nav-section">
          <div className="nav-label">Document types</div>
          {types.map((t) => (
            <button
              key={t.type}
              type="button"
              className={`nav-item ${view === 'documents' && typeFilter === t.type ? 'active' : ''}`}
              onClick={() => {
                setView('documents');
                setTypeFilter((prev) => (prev === t.type ? 'all' : t.type));
              }}
            >
              <span className="muted mono" style={{ fontSize: 10 }}>{t.prefix}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          Preyone Invoicing v3.2
          <br />
          UBL / Peppol ready
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1 className="page-title">
              {view === 'documents' && 'Documents'}
              {view === 'aging' && 'Accounts receivable'}
              {view === 'settings' && 'Invoicing setup'}
            </h1>
            <p className="page-sub">
              {view === 'documents' && 'Every quote, invoice, credit note and receipt for this company.'}
              {view === 'aging' && 'Outstanding balances by days overdue, recalculated from due dates.'}
              {view === 'settings' && 'Branding, the 20 PDF layouts and the palette shared by every module.'}
            </p>
          </div>
          <div className="topbar-actions">
            <button className="btn ghost" type="button" onClick={refreshAll}>
              Refresh
            </button>
            <button className="btn primary" type="button" onClick={() => setComposerOpen(true)}>
              + New document
            </button>
          </div>
        </div>

        {error && <div className="banner error">{error}</div>}

        {view !== 'settings' && (
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Documents</div>
              <div className="stat-value">{totals.count}</div>
              <div className="stat-foot">in the current view</div>
            </div>
            <div className="stat">
              <div className="stat-label">Outstanding</div>
              <div className={`stat-value ${totals.outstanding > 0 ? 'warn' : ''}`}>{money(totals.outstanding, catalog?.company.currency)}</div>
              <div className="stat-foot">unpaid balance</div>
            </div>
            <div className="stat">
              <div className="stat-label">Collected</div>
              <div className="stat-value">{money(totals.paid, catalog?.company.currency)}</div>
              <div className="stat-foot">payments applied</div>
            </div>
            <div className="stat">
              <div className="stat-label">AR over 60 days</div>
              <div className={`stat-value ${aging && aging.buckets.d61_90 + aging.buckets.d90plus > 0 ? 'danger' : ''}`}>
                {money((aging?.buckets.d61_90 ?? 0) + (aging?.buckets.d90plus ?? 0), catalog?.company.currency)}
              </div>
              <div className="stat-foot">needs follow-up</div>
            </div>
          </div>
        )}

        {view === 'documents' && (
          <div className="card panel">
            <div className="panel-head">
              <div className="panel-title">
                {typeFilter === 'all' ? 'All documents' : typeLabel(types, typeFilter)}
              </div>
              <div className="panel-tools">
                <input
                  className="input"
                  placeholder="Search number or customer…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  {['all', 'draft', 'sent', 'unpaid', 'partial', 'paid', 'void'].map((s) => (
                    <option key={s} value={s}>
                      {s === 'all' ? 'Any status' : s}
                    </option>
                  ))}
                </select>
                <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="all">All types</option>
                  {types.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {docsLoading && docs.length === 0 ? (
              <div className="empty">Loading documents…</div>
            ) : docs.length === 0 ? (
              <div className="empty">
                No documents yet. <button className="btn" type="button" onClick={() => setComposerOpen(true)}>Create the first one</button>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Type</th>
                      <th>Customer</th>
                      <th>Issued</th>
                      <th>Due</th>
                      <th className="num">Total</th>
                      <th className="num">Balance</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => (
                      <tr key={d.id} onClick={() => setOpenDocId(d.id)}>
                        <td className="mono">{d.doc_number}</td>
                        <td>{typeLabel(types, d.doc_type)}</td>
                        <td>{d.customer_name || 'Walk-in'}</td>
                        <td>{dateLabel(d.issue_date)}</td>
                        <td>{dateLabel(d.due_date)}</td>
                        <td className="num mono">{money(d.total, d.currency || 'USD')}</td>
                        <td className="num mono">{money(Number(d.total) - Number(d.amount_paid), d.currency || 'USD')}</td>
                        <td><StatusBadge status={d.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {view === 'aging' && (
          <>
            <div className="stats">
              {AR_BUCKETS.map((bucket) => (
                <div className="stat" key={bucket.key}>
                  <div className="stat-label">{bucket.label}</div>
                  <div className={`stat-value ${bucket.tone ?? ''}`}>{money(aging?.buckets[bucket.key] ?? 0, catalog?.company.currency)}</div>
                  <div className="stat-foot">{bucket.key === 'current' ? 'not yet due' : 'overdue'}</div>
                </div>
              ))}
            </div>
            <div className="card panel">
              <div className="panel-head">
                <div className="panel-title">Outstanding invoices</div>
                <div className="panel-tools">
                  <span className="muted small">Total {money(aging?.total ?? 0, catalog?.company.currency)}</span>
                </div>
              </div>
              {!aging || aging.detail.length === 0 ? (
                <div className="empty">Nothing outstanding — every invoice is settled.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Invoice</th>
                        <th>Customer</th>
                        <th>Due</th>
                        <th className="num">Days overdue</th>
                        <th className="num">Balance</th>
                        <th>Bucket</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aging.detail.map((d) => (
                        <tr key={d.id} onClick={() => setOpenDocId(d.id)}>
                          <td className="mono">{d.doc_number}</td>
                          <td>{d.customer_name || 'Walk-in'}</td>
                          <td>{dateLabel(d.due_date || d.issue_date)}</td>
                          <td className="num">{d.daysOverdue}</td>
                          <td className="num mono">{money(d.balance, d.currency || 'USD')}</td>
                          <td>{AR_BUCKETS.find((b) => b.key === d.bucket)?.label ?? d.bucket}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {view === 'settings' && catalog && <SettingsPanel catalog={catalog} onCatalog={setCatalog} />}
      </main>

      {composerOpen && catalog && (
        <Composer
          catalog={catalog}
          onClose={() => setComposerOpen(false)}
          onCreated={(id) => {
            setComposerOpen(false);
            refreshAll();
            setOpenDocId(id);
          }}
        />
      )}

      {openDocId && catalog && (
        <DocumentDrawer
          id={openDocId}
          templates={templates}
          types={types}
          onClose={() => setOpenDocId(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}
