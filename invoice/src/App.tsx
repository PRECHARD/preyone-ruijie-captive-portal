import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ApiError,
  NETWORK_ERROR,
  SESSION_EVENT,
  api,
  clearToken,
  download,
  getToken,
  type SessionSignal,
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
import { DocumentSheet, TemplateThumb, type SheetDoc } from './DocumentSheet';
import Sidebar, { type View } from './components/Sidebar';
import SettingsPage from './pages/Settings';
import AccountingPage from './pages/Accounting';
import UpgradeModal from './components/UpgradeModal';
import './document.css';

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
  if (err instanceof ApiError && err.status === 0) return NETWORK_ERROR;
  if (err instanceof Error) {
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) return NETWORK_ERROR;
    return err.message;
  }
  return 'Something went wrong';
}

/* ────────────────────────────── chrome ─────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const key = ['paid', 'unpaid', 'partial', 'draft', 'sent', 'void'].includes(status) ? status : 'sent';
  return <span className={`badge ${key}`}>{status}</span>;
}

/* ────────────────────────────── auth ────────────────────────────────── */

const AUTH_POINTS = [
  {
    title: 'Issue in seconds',
    body: 'Quotes, tax invoices, credit notes and receipts from one numbered ledger.',
  },
  {
    title: 'Get paid faster',
    body: 'Pesepay checkout, part-payments and a live accounts-receivable view.',
  },
  {
    title: 'Built for teams',
    body: 'Role-aware access shared with the Preyone console and point of sale.',
  },
];

function AuthFrame({
  kicker,
  title,
  subtitle,
  children,
}: {
  kicker: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="auth-shell">
      <aside className="auth-hero">
        <div className="auth-hero-brand">
          <span className="auth-logo">
            <img src="/brand/Preyone.svg" alt="Preyone" />
          </span>
          <span className="auth-hero-division">Invoicing &amp; finance</span>
        </div>

        <div className="auth-hero-copy">
          <span className="auth-eyebrow">Business workspace</span>
          <h2>Every quote, invoice and payment — in one calm, auditable ledger.</h2>
          <ul className="auth-points">
            {AUTH_POINTS.map((point) => (
              <li key={point.title}>
                <span className="auth-point-dot" aria-hidden />
                <div>
                  <strong>{point.title}</strong>
                  <span>{point.body}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="auth-hero-foot">
          <span className="auth-secure"><i aria-hidden /> Secure session</span>
          <span>preyone.com</span>
        </div>
      </aside>

      <main className="auth-panel">
        <section className="card auth-card" aria-live="polite">
          <div className="auth-kicker">{kicker}</div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          {children}
        </section>
        <p className="auth-legal">
          Protected by Preyone single sign-on · Need help?{' '}
          <a href="mailto:support@preyone.com">support@preyone.com</a>
        </p>
      </main>
    </div>
  );
}

/** Visible password field with an accessible reveal toggle. */
function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="input-affix">
        <input
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required
        />
        <button
          className="input-affix-btn"
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </span>
      {children}
    </label>
  );
}

function UnlockPanel({
  onUnlocked,
  onSignIn,
}: {
  onUnlocked: () => void;
  onSignIn: (message?: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your password to unlock this workspace.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/unlock', { password });
      onUnlocked();
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'UNLOCK_FAILED') {
        // The 10-hour absolute cap has passed, or the session was revoked:
        // there is nothing left to unlock, so send the user to sign-in.
        onSignIn(err.message);
        return;
      }
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    setSigningOut(true);
    try {
      const token = getToken();
      await fetch('/api/admin/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      /* local token is still cleared below */
    } finally {
      clearToken();
      onSignIn('Sign in with the account you want to use.');
      setSigningOut(false);
    }
  };

  return (
    <AuthFrame
      kicker="Session locked"
      title="Unlock your workspace"
      subtitle="You were away for a while, so the invoice workspace locked itself. Enter your password — no new email code is needed."
    >
      <form className="auth-form" onSubmit={submit}>
        <span className="auth-state-chip">
          <i aria-hidden /> Inactivity lock · session preserved
        </span>
        {error && <div className="banner error">{error}</div>}
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
        />
        <button className="btn primary" disabled={busy || signingOut} type="submit">
          {busy && <span className="spinner" aria-hidden />}
          {busy ? 'Unlocking…' : 'Unlock workspace'}
        </button>
        <div className="auth-actions">
          <button className="btn ghost" type="button" onClick={switchAccount} disabled={busy || signingOut}>
            {signingOut && <span className="spinner" aria-hidden />}
            {signingOut ? 'Signing out…' : 'Use another account'}
          </button>
        </div>
      </form>
    </AuthFrame>
  );
}

function LoginPanel({ onSignedIn, initialNotice }: { onSignedIn: () => void; initialNotice?: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [masked, setMasked] = useState('');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [expired, setExpired] = useState(false);
  const [notVerified, setNotVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const resetToSignIn = (message?: string) => {
    setChallenge(null);
    setCode('');
    setMasked('');
    setExpiresAt(null);
    setExpired(false);
    setNotVerified(false);
    setNotice(null);
    setError(message ?? null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (challenge && !/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setNotVerified(false);
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
      if (!res.ok) {
        // The challenge itself is gone: keeping the form up would only fail on
        // every retry, so send the user back to the password step.
        if (data.code === 'CHALLENGE_EXPIRED' || data.code === 'TOO_MANY_ATTEMPTS') {
          resetToSignIn(data.error || 'Please sign in again.');
          return;
        }
        if (data.code === 'CODE_EXPIRED') setExpired(true);
        if (data.code === 'EMAIL_NOT_VERIFIED') setNotVerified(true);
        throw new Error(data.error || 'Sign-in failed');
      }
      if (data.requires2fa) {
        setChallenge(data.challengeToken);
        setMasked(data.maskedEmail || '');
        setExpiresAt(data.expiresAt || null);
        setCode('');
        setError(null);
        setNotice(null);
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

  const resendVerification = async () => {
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send the verification email');
      setNotice(data.message || 'Check your inbox for a new verification link.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    if (!challenge) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/auth/resend-2fa', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken: challenge }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === 'CHALLENGE_EXPIRED') {
          resetToSignIn(data.error || 'Please sign in again.');
          return;
        }
        throw new Error(data.error || 'Could not resend the code');
      }
      // A resend also refreshes the challenge token, so a code requested near
      // the end of the window is not handed back with a token about to die.
      if (data.challengeToken) setChallenge(data.challengeToken);
      if (data.maskedEmail) setMasked(data.maskedEmail);
      if (data.expiresAt) setExpiresAt(data.expiresAt);
      setCode('');
      setExpired(false);
      setNotice(data.message || 'A new code has been sent.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setResending(false);
    }
  };

  const expiryLabel = expiresAt
    ? new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <AuthFrame
      kicker={challenge ? 'Identity check' : 'Finance workspace'}
      title={challenge ? 'Two-factor code' : 'Sign in to Invoicing'}
      subtitle={
        challenge
          ? `Enter the 6-digit code sent to ${masked || 'your email'}.`
          : 'One Preyone account unlocks invoicing, POS, admin and every business app.'
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        {notice && <div className="banner ok">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        {challenge && expired && !error && (
          <div className="banner error">That code has expired. Request a new one.</div>
        )}
        {notVerified && !challenge && (
          <button className="btn ghost auth-inline-action" type="button" onClick={resendVerification} disabled={verifying}>
            {verifying && <span className="spinner" aria-hidden />}
            {verifying ? 'Sending link…' : 'Resend verification email'}
          </button>
        )}

        {challenge ? (
          <>
            <label className="field">
              <span>6-digit code</span>
              <input
                className="input input-otp"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                required
              />
            </label>
            {expiryLabel && (
              <p className="auth-hint">
                {expired ? 'That code expired at ' : 'Code expires at '}
                {expiryLabel}. Didn&apos;t get it? Resend below.
              </p>
            )}
            <button className="btn primary" disabled={busy || resending} type="submit">
              {busy && <span className="spinner" aria-hidden />}
              {busy ? 'Please wait…' : 'Verify and continue'}
            </button>
            <div className="auth-actions">
              <button className="btn ghost" type="button" onClick={resend} disabled={busy || resending}>
                {resending && <span className="spinner" aria-hidden />}
                {resending ? 'Sending…' : 'Resend code'}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => resetToSignIn()}
                disabled={busy || resending}
              >
                Use another account
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span>Work email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@company.com"
                autoFocus
                required
              />
            </label>
            <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
            <button className="btn primary" disabled={busy} type="submit">
              {busy && <span className="spinner" aria-hidden />}
              {busy ? 'Signing in…' : 'Continue'}
            </button>
            <p className="auth-foot-hint">
              We&apos;ll email a one-time code to confirm it&apos;s you. No password is ever stored in the browser.
            </p>
          </>
        )}
      </form>
    </AuthFrame>
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
  onOpenSettings,
}: {
  catalog: Catalog;
  onClose: () => void;
  onCreated: (id: string) => void;
  onOpenSettings: () => void;
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

  // The document design is a workspace setting, not a per-document choice. The
  // composer only displays the template the company has locked in Settings so
  // every issued document matches the brand; the server also defaults to it.
  const lockedTemplate =
    templates.find((t) => t.id === Number(catalog.company.invoice_template_id)) ?? templates[0];

  const previewDueDate = useMemo(() => {
    if (!issueDate) return null;
    const d = new Date(`${issueDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() + (Number(netDays) || 0));
    return d.toISOString().slice(0, 10);
  }, [issueDate, netDays]);

  // The live A4 proof. It uses the exact same component as the saved document
  // and print view, so what the user sees while typing is what gets issued.
  const previewDoc: SheetDoc = {
    docType,
    number: `${types.find((t) => t.type === docType)?.prefix ?? 'DOC'}-0000`,
    status: 'draft',
    issueDate,
    dueDate: ['invoice', 'tax_invoice', 'sales_receipt', 'proforma'].includes(docType) ? previewDueDate : null,
    customerName: customerName.trim() || 'Customer name',
    customerAddress: customerAddress.trim() || undefined,
    customerEmail: customerEmail.trim() || undefined,
    items: lines.map((l) => ({
      description: l.description.trim() || 'Line item description',
      qty: Number(l.qty) || 0,
      price: Number(l.price) || 0,
    })),
    notes: notes.trim() || undefined,
    poNumber: poNumber.trim() || undefined,
    reference: reference.trim() || undefined,
    subtotal,
    discountPct: Number(discountPct) || 0,
    taxPct: Number(taxPct) || 0,
    total,
    amountPaid: 0,
    currency,
  };

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
        templateId: lockedTemplate?.id,
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

        <div className="composer-layout">
          <div>
            <div className="panel-title" style={{ marginBottom: 6 }}>Document template</div>
            <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
              Locked to your workspace design so every document matches your brand. Change it
              any time in Settings.
            </p>
            <div className="template-locked" aria-label="Document template, configured in Settings">
              <span className="template-locked-thumb" aria-hidden>
                {lockedTemplate && <TemplateThumb template={lockedTemplate} />}
              </span>
              <span className="template-locked-copy">
                <span className="template-locked-top">
                  <span className="template-locked-name">
                    {lockedTemplate ? `${lockedTemplate.id}. ${lockedTemplate.name}` : 'House template'}
                  </span>
                  <span className="template-locked-badge">Locked</span>
                </span>
                <span className="template-locked-desc">
                  {lockedTemplate?.description || 'The design selected in Settings for this workspace.'}
                </span>
                <button type="button" className="template-locked-link" onClick={onOpenSettings}>
                  Configured in Settings — change it there →
                </button>
              </span>
            </div>

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
          </div>

          <aside className="composer-preview no-print">
            <div className="panel-title" style={{ marginBottom: 4 }}>
              Live A4 proof
            </div>
            <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
              {lockedTemplate ? `${lockedTemplate.id}. ${lockedTemplate.name}` : 'House template'} · updates as you type
            </p>
            <div className="a4-preview-shell">
              <DocumentSheet doc={previewDoc} company={catalog.company} template={lockedTemplate} />
            </div>
          </aside>
        </div>
      </form>

      {/* Print the draft exactly as previewed, from a body-level copy so the
          sheet is never clipped by the modal's scroll container. */}
      {createPortal(
        <div className="a4-print-host">
          <DocumentSheet doc={previewDoc} company={catalog.company} template={lockedTemplate} printRoot />
        </div>,
        document.body
      )}
    </div>
  );
}

/* ──────────────────────────── document view ────────────────────────── */

function DocumentDrawer({
  id,
  templates,
  types,
  company,
  onClose,
  onChanged,
}: {
  id: string;
  templates: InvoiceTemplate[];
  types: DocType[];
  company: Company;
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

  const raw = doc as unknown as { discount_pct?: string | number; tax_pct?: string | number } | null;
  const meta = (doc?.doc_meta ?? {}) as Record<string, unknown>;
  const drawerSheet: SheetDoc | null = doc
    ? {
        docType: doc.doc_type,
        number: doc.doc_number,
        status: doc.status,
        issueDate: doc.issue_date,
        dueDate: doc.due_date,
        customerName: doc.customer?.name || doc.customer_name || 'Walk-in customer',
        customerAddress: doc.customer?.address || null,
        customerEmail: doc.customer?.email || null,
        items: doc.items.map((it) => ({
          description: it.description,
          qty: it.qty,
          price: it.price,
          line_total: it.line_total,
        })),
        notes: doc.notes,
        poNumber: (meta.poNumber as string) || (meta.po_number as string) || null,
        reference: (meta.reference as string) || null,
        subtotal: Number(doc.subtotal) || 0,
        discountPct: Number(raw?.discount_pct) || 0,
        taxPct: Number(raw?.tax_pct) || 0,
        total: Number(doc.total) || 0,
        amountPaid: Number(doc.amount_paid) || 0,
        currency: doc.currency || 'USD',
      }
    : null;

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
                <div className="card drawer-doc-card no-print">
                  <div className="a4-preview-shell">
                    {drawerSheet && (
                      <DocumentSheet doc={drawerSheet} company={company} template={template} />
                    )}
                  </div>
                  <div className="drawer-doc-caption">
                    {template ? `Template ${template.id} · ${template.name}` : 'House template'} · A4 ·{' '}
                    {money(balance, doc.currency || 'USD')} balance
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

      {/* The same sheet again, portalled straight to <body>, so Print/PDF is
          never clipped by the drawer's scroll container. */}
      {drawerSheet &&
        createPortal(
          <div className="a4-print-host">
            <DocumentSheet doc={drawerSheet} company={company} template={template} printRoot />
          </div>,
          document.body
        )}
    </>
  );
}

/* ───────────────────────────── settings ────────────────────────────── */

function SettingsPanel({
  catalog,
  onCatalog,
  designOnly = false,
}: {
  catalog: Catalog;
  onCatalog: (next: Catalog) => void;
  /** When embedded in the Settings hub, hide the duplicate brand/tax card. */
  designOnly?: boolean;
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

  const selectedTemplate = catalog.templates.find((t) => t.id === templateId) ?? catalog.templates[0];
  const sampleDue = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  })();

  // Proof for the picker: the same A4 component that renders issued documents
  // and the print view, fed a representative invoice.
  const sampleDoc: SheetDoc = {
    docType: 'invoice',
    number: 'INV-0042',
    status: 'draft',
    issueDate: today(),
    dueDate: sampleDue,
    customerName: 'Acme Trading (Pvt) Ltd',
    customerAddress: '14 Borrowdale Road\nHarare',
    customerEmail: 'accounts@acme.co.zw',
    items: [
      { description: 'Managed Wi-Fi — October', qty: 1, price: 850 },
      { description: 'Additional access point', qty: 2, price: 125 },
      { description: 'On-site installation', qty: 1, price: 150 },
    ],
    notes: 'Payment by bank transfer. Reference the invoice number.',
    subtotal: 1250,
    taxPct: Number(taxPct) || 0,
    total: 1250,
    amountPaid: 0,
    currency,
  };

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

  // Template picks save immediately so the embedded designer needs no second
  // save button (the standalone panel still keeps its own Save defaults).
  const pickTemplate = async (id: number) => {
    setTemplateId(id);
    try {
      const saved = await api.patch<Company>('/api/pos/invoice-settings', { templateId: id });
      onCatalog({ ...catalog, company: { ...catalog.company, ...saved, invoice_template_id: id } });
      setNotice({ kind: 'ok', text: 'Document template saved for every new document.' });
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

      {!designOnly && (
      <div className="card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="panel-head" style={{ padding: 0, border: 'none', marginBottom: 14 }}>
          <div className="panel-title">Brand & defaults</div>
          <button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>
            {busy && <span className="spinner" aria-hidden />}
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
      )}

      <div className="card" style={{ padding: 20, marginBottom: 18 }}>
        <div className="panel-title" style={{ marginBottom: 4 }}>PDF templates</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
          One A4 house design, 20 finishes. Every template keeps the same structure — gradient masthead, ruled item table and footer band — and only the palette, wordmark and density change.
        </p>
        <div className="settings-templates">
          <div className="template-grid">
            {catalog.templates.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`template-card ${templateId === t.id ? 'selected' : ''}`}
                onClick={() => void pickTemplate(t.id)}
                title={t.description}
              >
                <TemplateThumb template={t} />
                <h4>{t.name}</h4>
                <p>{t.description}</p>
              </button>
            ))}
          </div>
          <aside className="settings-preview">
            <div className="settings-preview-head">
              <div>
                <div className="panel-title" style={{ marginBottom: 2 }}>
                  {selectedTemplate ? selectedTemplate.name : 'House template'}
                </div>
                <div className="muted small">A4 proof · updates with the template and terms</div>
              </div>
              <span className="muted small">{selectedTemplate ? `#${selectedTemplate.id}` : ''}</span>
            </div>
            <div className="a4-preview-shell">
              <DocumentSheet
                doc={sampleDoc}
                company={{ ...catalog.company, terms_text: terms || catalog.company.terms_text }}
                template={selectedTemplate}
              />
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Save defaults to make this the template for every new document.
            </div>
          </aside>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div className="panel-title" style={{ marginBottom: 4 }}>Workspace theme</div>
        <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
          One choice, every Preyone surface: POS and invoicing update instantly.
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

const AR_BUCKETS: Array<{ key: keyof ArAging['buckets']; label: string; tone?: string }> = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30 days', tone: 'warn' },
  { key: 'd31_60', label: '31–60 days', tone: 'warn' },
  { key: 'd61_90', label: '61–90 days', tone: 'danger' },
  { key: 'd90plus', label: '90+ days', tone: 'danger' },
];

/** The invoice SPA is served by the Express fallback, so `/settings` is a real URL. */
function viewFromPath(pathname: string): View {
  const clean = pathname.replace(/\/+$/, '').toLowerCase();
  if (clean.endsWith('/settings')) return 'settings';
  if (clean.endsWith('/aging')) return 'aging';
  if (clean.endsWith('/accounting') || clean.endsWith('/financing')) return 'accounting';
  return 'documents';
}

function pathForView(view: View): string {
  if (view === 'settings') return '/settings';
  if (view === 'aging') return '/aging';
  if (view === 'accounting') return '/accounting';
  return '/';
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [planBlocked, setPlanBlocked] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
  const [docs, setDocs] = useState<PosDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [aging, setAging] = useState<ArAging | null>(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [openDocId, setOpenDocId] = useState<string | null>(null);

  const navigate = useCallback((next: View) => {
    setView(next);
    const path = pathForView(next);
    if (window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
  }, []);

  useEffect(() => {
    const onPop = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);


  const types = catalog?.documentTypes.length ? catalog.documentTypes : FALLBACK_TYPES;
  const templates = catalog?.templates ?? [];

  const boot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await api.get<{ subscribed_modules?: string[]; plan_name?: string | null }>('/api/admin/auth/me');
      if (!(me.subscribed_modules ?? []).includes('invoice')) {
        setPlanBlocked(me.plan_name || 'your plan');
        setLoading(false);
        return;
      }
      setPlanBlocked(null);
      // The catalog is the workspace itself; the palette is cosmetic. A theme
      // 500 (or a slow theme read) must never keep a signed-in user out of the
      // ledger — that is what turned a reserved-word bug into "Failed to fetch".
      const cat = await api.get<Catalog>('/api/pos/catalog');
      setCatalog(cat);
      try {
        const theme = await api.get<ThemeResponse>('/api/pos/theme');
        applyCssVars(theme.css);
      } catch {
        /* keep the stylesheet's house palette */
      }
      setAuthError(false);
      setLocked(false);
      setAuthNotice(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 423) {
          // State A: the shared session is inactivity-locked. The password
          // unlock screen keeps the 2FA-free session (no new email code).
          setLocked(true);
          return;
        }
        if (err.status === 401 || err.status === 403) {
          // A bearer that no longer works must not shadow the next sign-in.
          clearToken();
          setAuthNotice(err.status === 401 ? err.message : null);
          setAuthError(true);
          return;
        }
      }
      setError(errorText(err));
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

  // Any 401/423 raised by a nested call (documents, payments, theme edits) is
  // promoted to a first-class auth state instead of a red banner over stale
  // data — the workspace can never look "signed in" while the API refuses it.
  useEffect(() => {
    const onSession = (event: Event) => {
      const state = (event as CustomEvent<SessionSignal>).detail;
      if (state === 'locked') {
        setLocked(true);
        setAuthError(false);
        return;
      }
      clearToken();
      setCatalog(null);
      setLocked(false);
      setAuthNotice('Your session ended. Sign in to pick up where you left off.');
      setAuthError(true);
    };
    window.addEventListener(SESSION_EVENT, onSession);
    return () => window.removeEventListener(SESSION_EVENT, onSession);
  }, []);

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
    const billed = paid + outstanding;
    return { outstanding, paid, count: docs.length, collectionRate: billed > 0 ? Math.round((paid / billed) * 100) : 0 };
  }, [docs]);

  if (locked) {
    return (
      <UnlockPanel
        onUnlocked={() => {
          setLocked(false);
          void boot();
        }}
        onSignIn={(message) => {
          clearToken();
          setLocked(false);
          setAuthNotice(message ?? null);
          setAuthError(true);
        }}
      />
    );
  }

  if (authError) {
    return (
      <LoginPanel
        initialNotice={authNotice}
        onSignedIn={() => {
          setAuthNotice(null);
          void boot();
        }}
      />
    );
  }

  if (planBlocked) {
    return (
      <div className="app-shell" style={{ display: 'block', padding: 32 }}>
        <h1>Invoice is not on your plan</h1>
        <p>{planBlocked} does not include Invoice. Upgrade to PreBiz or higher to create invoices and quotations.</p>
        <UpgradeModal onClose={() => undefined} onUpgraded={() => { setPlanBlocked(null); void boot(); }} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="app-shell">
        <Sidebar
          company={null}
          view="documents"
          typeFilter="all"
          statusFilter="all"
          types={FALLBACK_TYPES}
        />
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

  // A boot that never received its catalog must not fall through to an empty
  // ledger under a red banner. One calm, retryable screen is the entire UX.
  if (!catalog) {
    return (
      <AuthFrame
        kicker="Connection interrupted"
        title="We couldn’t load your ledger"
        subtitle="The workspace is safe. Reconnect and we’ll pick up exactly where you left off."
      >
        <div className="auth-form">
          <div className="banner error">{error ?? NETWORK_ERROR}</div>
          <button className="btn primary" type="button" onClick={() => void boot()} disabled={loading}>
            {loading ? <span className="spinner" aria-hidden /> : null}
            {loading ? 'Reconnecting…' : 'Try again'}
          </button>
        </div>
      </AuthFrame>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        company={catalog.company}
        view={view}
        typeFilter={typeFilter}
        statusFilter={statusFilter}
        types={types}
        onView={navigate}
        onAllDocuments={() => {
          navigate('documents');
          setTypeFilter('all');
          setStatusFilter('all');
        }}
        onType={(type) => {
          navigate('documents');
          setTypeFilter((prev) => (prev === type ? 'all' : type));
        }}
        onStatus={(status) => {
          navigate('documents');
          setStatusFilter((prev) => (prev === status ? 'all' : status));
        }}
        onNewDocument={() => setComposerOpen(true)}
      />

      <main className="main">
        {view !== 'settings' && view !== 'accounting' && (
        <div className="topbar">
          <div>
            <h1 className="page-title">
              {view === 'documents' && 'Documents'}
              {view === 'aging' && 'Accounts receivable'}
            </h1>
            <p className="page-sub">
              {view === 'documents' && 'Every quote, invoice, credit note and receipt for this company.'}
              {view === 'aging' && 'Outstanding balances by days overdue, recalculated from due dates.'}
            </p>
          </div>
          <div className="topbar-actions">
            <span className="status-chip" title="Pesepay USD checkout is available on this workspace">
              <span className="status-dot" aria-hidden />
              {catalog?.company.currency || 'USD'} ledger
            </span>
            <button className="btn ghost" type="button" onClick={refreshAll} disabled={docsLoading}>
              {docsLoading ? <span className="spinner" aria-hidden /> : <span className="btn-glyph" aria-hidden>↻</span>}
              {docsLoading ? 'Syncing…' : 'Refresh'}
            </button>
            <button className="btn primary" type="button" onClick={() => setComposerOpen(true)}>
              <span className="btn-plus" aria-hidden>+</span>
              New document
            </button>
          </div>
        </div>
        )}

        {error && view !== 'accounting' && <div className="banner error">{error}</div>}

        {view !== 'settings' && view !== 'accounting' && (
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
              <div className="stat-meter" aria-hidden>
                <i style={{ width: `${totals.collectionRate}%` }} />
              </div>
              <div className="stat-foot">
                {totals.collectionRate}% of billed · payments applied
              </div>
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

        {view === 'accounting' && <AccountingPage />}

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
                      <tr
                        key={d.id}
                        tabIndex={0}
                        role="button"
                        aria-label={`Open ${d.doc_number}`}
                        onClick={() => setOpenDocId(d.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setOpenDocId(d.id);
                          }
                        }}
                      >
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
                        <tr
                          key={d.id}
                          tabIndex={0}
                          role="button"
                          aria-label={`Open ${d.doc_number}`}
                          onClick={() => setOpenDocId(d.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setOpenDocId(d.id);
                            }
                          }}
                        >
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

        {view === 'settings' && catalog && (
          <SettingsPage
            catalog={catalog}
            onCatalog={setCatalog}
            documentDesign={<SettingsPanel catalog={catalog} onCatalog={setCatalog} designOnly />}
          />
        )}
      </main>

      {composerOpen && catalog && (
        <Composer
          catalog={catalog}
          onClose={() => setComposerOpen(false)}
          onOpenSettings={() => {
            setComposerOpen(false);
            navigate('settings');
          }}
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
          company={catalog.company}
          onClose={() => setOpenDocId(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}
