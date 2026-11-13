import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type DocumentDetail } from './api';

/**
 * Customer-facing payment surfaces for the invoicing workspace.
 *
 * `OnlinePaymentModal` drives the three Pesepay rails the merchant has enabled
 * (EcoCash, O'mari and InnBucks USD) through one flow: initiate → (O'mari OTP)
 * → poll → success. The backend settles the invoice on the webhook or on the
 * poll itself, so this component only reads state — it never writes payments
 * client-side.
 *
 * `ReceiptPreview` is the crisp, print-ready proof of payment. Printing is
 * scoped with `@media print` in styles.css so the browser prints the receipt,
 * not the console behind it.
 */

export type PesepayRail = 'ecocash' | 'omari' | 'innbucks' | 'paygo';

interface RailOption {
  rail: PesepayRail;
  label: string;
  blurb: string;
  min: number;
  max: number;
  requiresPhone: boolean;
  /** Two-letter mark used in the rail tile. */
  mark: string;
}

// Mirrors PESEPAY_RAILS in src/services/pesepayService.ts. Kept as data (not a
// fetch) so the modal paints instantly and cannot offer a rail the gateway has
// not enabled for this merchant.
const RAILS: Record<'USD' | 'ZiG', RailOption[]> = {
  USD: [
    {
      rail: 'ecocash',
      label: 'EcoCash',
      blurb: 'Push prompt to your Econet line',
      min: 1,
      max: 500,
      requiresPhone: true,
      mark: 'EC',
    },
    {
      rail: 'omari',
      label: "O'mari",
      blurb: 'Approve with the OTP sent to your phone',
      min: 0.5,
      max: 500,
      requiresPhone: true,
      mark: 'OM',
    },
    {
      rail: 'innbucks',
      label: 'InnBucks',
      blurb: 'USD wallet code, pay online or in-app',
      min: 1,
      max: 1000,
      requiresPhone: false,
      mark: 'IB',
    },
  ],
  ZiG: [
    {
      rail: 'ecocash',
      label: 'EcoCash',
      blurb: 'Push prompt to your EconCash line',
      min: 2,
      max: 8000,
      requiresPhone: true,
      mark: 'EC',
    },
    {
      rail: 'paygo',
      label: 'PayGo',
      blurb: 'ZiG wallet transfer',
      min: 1,
      max: 2400,
      requiresPhone: false,
      mark: 'PG',
    },
  ],
};

interface InitiateResult {
  success: boolean;
  intentId: string | null;
  statusToken: string | null;
  referenceNumber: string;
  redirectUrl?: string;
  instructions?: string;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
}

function railCurrency(value?: string | null): 'USD' | 'ZiG' {
  const raw = String(value ?? 'USD').toUpperCase();
  return raw === 'ZIG' || raw === 'ZWG' || raw === 'ZWD' ? 'ZiG' : 'USD';
}

function money(value: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0)}`;
}

function dateLabel(value?: string | null): string {
  if (!value) return new Date().toLocaleDateString();
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

/* ─────────────────────────── online payment ─────────────────────────── */

export function OnlinePaymentModal({
  doc,
  onClose,
  onPaid,
  onReceipt,
}: {
  doc: DocumentDetail;
  onClose: () => void;
  onPaid: () => void;
  onReceipt: () => void;
}) {
  const currency = railCurrency(doc.currency);
  const balance = Math.max(0, Number(doc.total) - Number(doc.amount_paid));
  const options = RAILS[currency];

  const [rail, setRail] = useState<PesepayRail>(options[0].rail);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [intent, setIntent] = useState<InitiateResult | null>(null);
  const [phase, setPhase] = useState<'form' | 'authorize' | 'waiting' | 'success' | 'failed'>('form');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const pollTimer = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, []);

  const option = options.find((o) => o.rail === rail) ?? options[0];
  const numericAmount = Number(amount) || 0;
  const amountError =
    numericAmount <= 0
      ? 'Enter an amount'
      : numericAmount < option.min
        ? `Minimum for ${option.label} is ${money(option.min, currency)}`
        : numericAmount > option.max
          ? `Maximum for ${option.label} is ${money(option.max, currency)}`
          : numericAmount - balance > 0.01
            ? `Only ${money(balance, currency)} is outstanding`
            : '';

  const stopPolling = () => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };

  const checkStatus = useCallback(
    async (id: string, token: string) => {
      try {
        const res = await fetch(
          `/api/payments/pesepay/status/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`,
          { headers: { accept: 'application/json' } }
        );
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = (await res.json()) as { status?: string };
        if (!alive.current) return;
        if (data.status === 'SUCCESS') {
          stopPolling();
          setPhase('success');
          setMessage('Payment received. The invoice and the ledger are up to date.');
          onPaid();
          return;
        }
        if (data.status === 'FAILED') {
          stopPolling();
          setPhase('failed');
          setError('The payment was not completed. You can try again with another rail.');
          return;
        }
        setAttempts((n) => {
          const next = n + 1;
          if (next >= 100) {
            stopPolling();
            setPhase('failed');
            setError('We have not received confirmation yet. If you were charged, it will still settle automatically.');
            return next;
          }
          pollTimer.current = window.setTimeout(() => void checkStatus(id, token), 3000);
          return next;
        });
      } catch (err) {
        if (!alive.current) return;
        setAttempts((n) => {
          const next = n + 1;
          if (next >= 100) {
            stopPolling();
            setPhase('failed');
            setError(errorText(err));
            return next;
          }
          pollTimer.current = window.setTimeout(() => void checkStatus(id, token), 4000);
          return next;
        });
      }
    },
    [onPaid]
  );

  const startPayment = async () => {
    if (amountError) return;
    setBusy(true);
    setError('');
    setMessage('');
    stopPolling();
    try {
      const result = await api.post<InitiateResult>('/api/payments/pesepay/initiate', {
        amount: numericAmount,
        currencyCode: currency,
        paymentMethod: rail,
        targetType: 'invoice',
        targetId: doc.id,
        reasonForPayment: `Invoice ${doc.doc_number}`,
        phone: option.requiresPhone ? phone.trim() : undefined,
      });
      setIntent(result);
      if (rail === 'omari') {
        setPhase('authorize');
        setMessage('Approve the payment with the OTP Pesepay sent to your phone.');
      } else {
        setPhase('waiting');
        setMessage(
          rail === 'ecocash'
            ? 'A prompt is on its way to your phone. Approve it to complete the payment.'
            : 'Complete the payment in InnBucks, then keep this window open while we confirm it.'
        );
        if (result.intentId && result.statusToken) void checkStatus(result.intentId, result.statusToken);
      }
      setAttempts(0);
    } catch (err) {
      setPhase('failed');
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const authorize = async () => {
    if (!intent?.intentId) return;
    if (!/^\d{4,8}$/.test(otp.trim())) {
      setError('Enter the numeric code sent to your phone.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/payments/pesepay/authorize', { intentId: intent.intentId, otp: otp.trim() });
      setPhase('waiting');
      setMessage('Code accepted. Waiting for the payment to clear…');
      setAttempts(0);
      if (intent.statusToken) void checkStatus(intent.intentId, intent.statusToken);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    stopPolling();
    setPhase('form');
    setIntent(null);
    setOtp('');
    setError('');
    setMessage('');
    setAttempts(0);
  };

  return (
    <div className="overlay pay-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet pay-sheet" role="dialog" aria-modal="true" aria-label="Take online payment">
        <div className="sheet-head">
          <div>
            <h2 className="sheet-title">Take payment</h2>
            <p className="sheet-sub">
              {doc.doc_number} · {money(balance, currency)} outstanding
            </p>
            <span className="pay-chip">
              Pesepay · {currency}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}

        {phase === 'form' && (
          <>
            <div className="pay-balance">
              <span className="pay-balance__label">Amount to collect</span>
              <span className="pay-balance__value mono">{money(balance, currency)}</span>
            </div>

            <div className="rail-grid" role="radiogroup" aria-label="Payment rail">
              {options.map((o) => (
                <button
                  key={o.rail}
                  type="button"
                  role="radio"
                  aria-checked={rail === o.rail}
                  className={`rail-tile ${rail === o.rail ? 'selected' : ''}`}
                  onClick={() => setRail(o.rail)}
                >
                  <span className="rail-mark">{o.mark}</span>
                  <span className="rail-copy">
                    <strong>{o.label}</strong>
                    <small>{o.blurb}</small>
                  </span>
                </button>
              ))}
            </div>

            <div className="form-grid" style={{ marginTop: 18 }}>
              <label className="field">
                <span>Amount ({currency})</span>
                <input
                  className="input"
                  type="number"
                  min={option.min}
                  max={option.max}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{option.requiresPhone ? 'Mobile number' : 'Reference (optional)'}</span>
                <input
                  className="input"
                  inputMode={option.requiresPhone ? 'tel' : 'text'}
                  placeholder={option.requiresPhone ? '077 123 4567' : doc.doc_number}
                  value={option.requiresPhone ? phone : ''}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={!option.requiresPhone}
                />
              </label>
            </div>

            {amountError && <p className="pay-hint">{amountError}</p>}
            {option.requiresPhone && (
              <p className="pay-hint">Use the number registered with {option.label} for this payment.</p>
            )}

            <button
              type="button"
              className="btn primary pay-submit"
              disabled={busy || Boolean(amountError) || (option.requiresPhone && phone.trim().length < 9)}
              onClick={() => void startPayment()}
            >
              {busy ? <span className="spinner" aria-hidden /> : null}
              {busy ? 'Starting…' : `Pay ${money(numericAmount, currency)} with ${option.label}`}
            </button>
          </>
        )}

        {phase === 'authorize' && (
          <div className="pay-stage">
            <span className="rail-mark large">{option.mark}</span>
            <h3>Confirm with O’mari</h3>
            <p className="pay-hint">{message}</p>
            <input
              className="input otp-input mono"
              inputMode="numeric"
              maxLength={8}
              placeholder="OTP"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
            <div className="pay-actions">
              <button type="button" className="btn ghost" onClick={reset} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn primary" onClick={() => void authorize()} disabled={busy}>
                {busy ? 'Checking…' : 'Authorize payment'}
              </button>
            </div>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="pay-stage">
            <span className="pay-radar" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <h3>Waiting for confirmation</h3>
            <p className="pay-hint">{message}</p>
            {intent?.redirectUrl && (
              <a className="btn" href={intent.redirectUrl} target="_blank" rel="noreferrer">
                Open {option.label} payment page
              </a>
            )}
            <p className="pay-hint small">
              Reference <span className="mono">{intent?.referenceNumber}</span>
              {attempts > 0 ? ` · checking (${attempts})` : ''}
            </p>
            <div className="pay-actions">
              <button type="button" className="btn ghost" onClick={reset}>
                Use another rail
              </button>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <div className="pay-stage pay-success">
            <svg className="checkmark" viewBox="0 0 52 52" aria-hidden>
              <circle cx="26" cy="26" r="24" />
              <path d="M14 27l8 8 16-16" />
            </svg>
            <h3>Payment received</h3>
            <p className="pay-hint">{message}</p>
            <div className="pay-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Done
              </button>
              <button type="button" className="btn primary" onClick={onReceipt}>
                View receipt
              </button>
            </div>
          </div>
        )}

        {phase === 'failed' && (
          <div className="pay-stage">
            <span className="pay-fail" aria-hidden>
              !
            </span>
            <h3>Payment not completed</h3>
            <p className="pay-hint">{error || 'The payment could not be confirmed.'}</p>
            <div className="pay-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn primary" onClick={reset}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────── receipt ────────────────────────────── */

export function ReceiptPreview({
  doc,
  onClose,
}: {
  doc: DocumentDetail;
  onClose: () => void;
}) {
  const paid = Number(doc.amount_paid) || 0;
  const balance = Math.max(0, Number(doc.total) - paid);
  const currency = doc.currency || 'USD';

  return (
    <div className="overlay receipt-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="receipt-shell">
        <div className="receipt-toolbar no-print">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary" onClick={() => window.print()}>
            Print receipt
          </button>
        </div>

        <div className="receipt-paper" id="print-receipt">
          <div className="receipt-head">
            <div>
              <div className="receipt-brand">PREYONE</div>
              <div className="receipt-muted">Connecting People. Powering Business.</div>
            </div>
            <div className="receipt-stamp">{balance <= 0 ? 'PAID' : 'PART PAID'}</div>
          </div>

          <div className="receipt-meta">
            <div>
              <span>Receipt</span>
              <strong className="mono">{doc.doc_number}</strong>
            </div>
            <div>
              <span>Issued</span>
              <strong>{dateLabel(doc.issue_date)}</strong>
            </div>
            <div>
              <span>Customer</span>
              <strong>{doc.customer?.name || doc.customer_name || 'Walk-in customer'}</strong>
            </div>
          </div>

          <table className="receipt-table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {doc.items.map((item, i) => (
                <tr key={item.id ?? i}>
                  <td>{item.description}</td>
                  <td className="num">{Number(item.qty) || 0}</td>
                  <td className="num">
                    {money(Number(item.line_total ?? Number(item.qty) * Number(item.price)), currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="receipt-totals">
            <div>
              <span>Total</span>
              <strong className="mono">{money(Number(doc.total), currency)}</strong>
            </div>
            <div>
              <span>Paid</span>
              <strong className="mono">{money(paid, currency)}</strong>
            </div>
            <div className="grand">
              <span>Balance</span>
              <strong className="mono">{money(balance, currency)}</strong>
            </div>
          </div>

          {doc.payments.length > 0 && (
            <div className="receipt-payments">
              {doc.payments.map((p) => (
                <div key={p.id}>
                  <span>
                    {p.method} · {dateLabel(p.paid_at)}
                  </span>
                  <strong className="mono">{money(Number(p.amount), currency)}</strong>
                </div>
              ))}
            </div>
          )}

          <p className="receipt-foot">Thank you for your business — preyone.com</p>
        </div>
      </div>
    </div>
  );
}
