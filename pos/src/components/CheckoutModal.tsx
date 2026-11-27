import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type CheckoutResult, type PosPaymentStatus } from '../api';
import { cashChange, cashQuickAmounts } from '../utils/cashAmounts';

interface PaymentPart {
  amount: number;
  method: string;
  reference?: string;
  /** Present only for provider-confirmed mobile-money parts. */
  intentId?: string;
  /** Cash handed over, which can be larger than `amount` when change is due. */
  cashTendered?: number;
  change?: number;
}

// Only rails Pesepay actually enables for this merchant (verified against
// /v1/payment-methods/for-currency on 2026-10-03). Zimswitch, Visa and
// Mastercard are rejected by the gateway, so they are not offered at the till.
// PayGo is intentionally absent: it is ZiG-only and not offered in the POS.
// `phone: true` marks rails that need the payer's MSISDN on the payment prompt.
const PESEPAY_RAILS = [
  { key: 'ecocash', label: 'EcoCash', customerField: 'EcoCash number', prefix: '*151#', phone: true },
  { key: 'innbucks', label: 'InnBucks', customerField: 'InnBucks number', prefix: '*242#', phone: false },
  { key: 'omari', label: 'O’mari', customerField: 'O’mari number', prefix: '*100#', phone: true },
];

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  ...Object.fromEntries(PESEPAY_RAILS.map((r) => [r.key, r.label])),
};

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

// Real rail logos, shared with the Invoice checkout card. The tiles render the
// logo alone (no text label) with object-fit: contain.
const METHOD_LOGOS: Record<string, string> = {
  ecocash: '/images/pay/ecocash.png',
  innbucks: '/images/pay/innbucks.png',
  omari: '/images/pay/omari.webp',
};

const STATE_LABEL: Record<string, string> = {
  PENDING: 'Request sent',
  PROCESSING: 'Awaiting approval',
  SUCCESS: 'Payment confirmed',
  FAILED: 'Not completed',
};

export default function CheckoutModal({
  total,
  cashierName,
  shiftId,
  allowUnpaid = false,
  onCancel,
  onComplete,
}: {
  total: number;
  cashierName: string;
  shiftId?: string | null;
  allowUnpaid?: boolean;
  onCancel: () => void;
  onComplete: (payments: PaymentPart[], customerName?: string) => Promise<CheckoutResult>;
}) {
  const [method, setMethod] = useState<string>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [customerAccount, setCustomerAccount] = useState('');
  const [parts, setParts] = useState<PaymentPart[]>([]);
  const [busy, setBusy] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [manualMode, setManualMode] = useState(false);

  // Live mobile-money request state.
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<{
    intentId: string;
    statusToken: string;
    referenceNumber: string;
    amount: number;
    method: string;
    phone: string;
  } | null>(null);
  const [status, setStatus] = useState<PosPaymentStatus | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pollBusy = useRef(false);

  const rail = PESEPAY_RAILS.find((r) => r.key === method);
  const methods = ['cash', ...PESEPAY_RAILS.map((r) => r.key)];

  const partsSum = useMemo(() => parts.reduce((s, p) => s + p.amount, 0), [parts]);
  const remaining = Math.max(0, Math.round((total - partsSum) * 100) / 100);
  const cashTenderedNow = Number(tendered) || 0;
  const change = cashChange(cashTenderedNow, remaining);

  // Exact balance first, then the next USD bills up to $100. The buttons are
  // rendered in one nowrap flex row so every option is visible at once.
  const quickAmounts = useMemo(() => cashQuickAmounts(remaining), [remaining]);

  const buildReference = (): string | undefined => {
    const approval = reference.trim();
    const account = customerAccount.trim();
    if (!rail) return approval || undefined;
    if (account && approval) return `${rail.label} ${account} · ${approval}`;
    if (account) return `${rail.label} ${account}`;
    return approval || undefined;
  };

  const addManualPart = () => {
    const handed = Math.round((Number(tendered) || 0) * 100) / 100;
    if (handed <= 0) return;
    const applied = Math.round(Math.min(handed, remaining) * 100) / 100;
    if (applied <= 0) return;
    const cashFields =
      method === 'cash'
        ? { cashTendered: handed, change: cashChange(handed, applied) }
        : {};
    setParts((p) => [
      ...p,
      { amount: applied, method, reference: buildReference(), ...cashFields },
    ]);
    setTendered('');
    setReference('');
    setCustomerAccount('');
    setIntentError(null);
  };

  // ── Live request lifecycle ────────────────────────────────────────────
  const applyStatus = (s: PosPaymentStatus) => {
    setStatus(s);
    if (s.state === 'SUCCESS' && pending) {
      const confirmed: PaymentPart = {
        amount: pending.amount,
        method: pending.method,
        reference: s.referenceNumber || pending.referenceNumber,
        intentId: pending.intentId,
      };
      setParts((p) => [...p, confirmed]);
      setPending(null);
      setStatus(null);
      setTendered('');
      setReference('');
      setCustomerAccount('');
      setIntentError(null);
    } else if (s.state === 'FAILED') {
      setIntentError(s.failureReason || 'The payment was not completed. You can retry.');
      setPending(null);
    }
  };

  const checkStatus = async (intentId: string) => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    try {
      const s = await api.posPaymentStatus(intentId);
      applyStatus(s);
    } catch (e) {
      setIntentError(e instanceof Error ? e.message : 'Could not check the payment status');
    } finally {
      pollBusy.current = false;
    }
  };

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const poll = window.setInterval(() => {
      void checkStatus(pending.intentId);
    }, 3000);
    void checkStatus(pending.intentId);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.intentId]);

  const startRequest = async () => {
    if (!rail) return;
    const amount = Math.min(Number(tendered) || remaining, remaining);
    if (!amount || amount <= 0) {
      setIntentError('Enter the amount to request.');
      return;
    }
    if (rail.phone && !/^\+?\d{9,15}$/.test(customerAccount.replace(/[\s-]/g, ''))) {
      setIntentError(`Enter the customer's ${rail.label} number.`);
      return;
    }
    setStarting(true);
    setIntentError(null);
    setStatus(null);
    try {
      const created = await api.posPaymentIntent({
        amount: Math.round(amount * 100) / 100,
        method: rail.key,
        phone: customerAccount.trim() || undefined,
        shiftId: shiftId || undefined,
        customerName: customerName.trim() || undefined,
      });
      setPending({
        intentId: created.intentId,
        statusToken: created.statusToken,
        referenceNumber: created.referenceNumber,
        amount: created.amount,
        method: created.method,
        phone: customerAccount.trim(),
      });
    } catch (e) {
      // A duplicate-charge refusal carries the live intent: adopt it instead of
      // pushing a second prompt to the payer.
      const apiErr = e instanceof ApiError ? e : null;
      const liveIntentId = apiErr?.payload?.intentId;
      if (apiErr?.code === 'PAYMENT_PENDING' && typeof liveIntentId === 'string') {
        setPending({
          intentId: liveIntentId,
          statusToken: typeof apiErr.payload?.statusToken === 'string' ? apiErr.payload.statusToken : '',
          referenceNumber:
            typeof apiErr.payload?.referenceNumber === 'string' ? apiErr.payload.referenceNumber : '',
          amount: Math.round(amount * 100) / 100,
          method: rail.key,
          phone: customerAccount.trim(),
        });
      } else {
        setIntentError(e instanceof Error ? e.message : 'Could not start the payment request');
      }
    } finally {
      setStarting(false);
    }
  };

  const cancelRequest = async () => {
    if (!pending) return;
    const id = pending.intentId;
    setPending(null);
    setStatus(null);
    try {
      await api.posPaymentCancel(id);
    } catch {
      /* the provider may already have settled it; the sweep will reconcile */
    }
  };

  const canConfirm =
    !busy &&
    !starting &&
    !pending &&
    (total === 0 || remaining <= 0.005 || parts.length > 0 || allowUnpaid);

  const confirm = async () => {
    setBusy(true);
    try {
      await onComplete(total === 0 ? [{ amount: 0, method: 'cash' }] : parts, customerName.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  const stateClass = status?.state === 'SUCCESS'
    ? 'ok'
    : status?.state === 'FAILED'
      ? 'bad'
      : status?.state === 'PROCESSING'
        ? 'live'
        : 'warn';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card up-card checkout-glass" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Take payment</h3>
        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.6rem' }}>
          Cashier: {cashierName}
        </div>

        <label className="field-label">
          Customer Name (optional)
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Walk-in customer" />
        </label>

        <div className="pay-total-line">
          <span className="lbl">TOTAL DUE</span>
          <span className="amt">{money(total)}</span>
        </div>

        {parts.length > 0 && (
          <>
            {parts.map((p, i) => (
              <div className="x-report-row" key={i}>
                <span className="receipt-muted">
                  {METHOD_LABELS[p.method] || p.method}
                  {p.intentId ? <span className="pay-chip ok">confirmed</span> : null}
                  {p.reference ? ` · ${p.reference}` : ''}
                </span>
                <span>
                  <strong>{money(p.amount)}</strong>{' '}
                  <button
                    className="remove-btn"
                    onClick={() => setParts((arr) => arr.filter((_, j) => j !== i))}
                    aria-label="Remove payment"
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
            <div className={`change-box ${remaining > 0 ? 'due' : ''}`}>
              <span className="lbl">{remaining > 0 ? 'STILL DUE' : 'FULLY COVERED'}</span>
              <span className="amt">{remaining > 0 ? money(remaining) : '✓'}</span>
            </div>
          </>
        )}

        {remaining > 0 && !pending && (
          <>
            <div className="method-tabs" role="tablist" aria-label="Payment method">
              {methods.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={method === m}
                  aria-label={METHOD_LABELS[m] || m}
                  title={METHOD_LABELS[m] || m}
                  className={method === m ? 'on' : ''}
                  onClick={() => {
                    setMethod(m);
                    setIntentError(null);
                    setManualMode(false);
                  }}
                >
                  {METHOD_LOGOS[m] ? (
                    <img className="method-logo" src={METHOD_LOGOS[m]} alt="" />
                  ) : (
                    <span className="method-cash" aria-hidden>
                      💵
                    </span>
                  )}
                </button>
              ))}
            </div>

            <label className="field-label">
              {method === 'cash' ? 'Cash tendered ($)' : `${METHOD_LABELS[method]} amount ($)`}
              <input
                type="number"
                min="0"
                step="0.01"
                value={tendered}
                autoFocus
                onChange={(e) => setTendered(e.target.value)}
              />
            </label>

            {method === 'cash' ? (
              <>
                {change > 0 && (
                  <div className="change-box">
                    <span className="lbl">CHANGE</span>
                    <span className="amt">{money(change)}</span>
                  </div>
                )}
                {remaining > 0 && (
                  <div className="quick-amts">
                    {quickAmounts.map((v) => (
                      <button key={v} type="button" onClick={() => setTendered(v.toFixed(2))}>
                        {money(v)}
                      </button>
                    ))}
                  </div>
                )}
                <button className="secondary-btn" disabled={!(Number(tendered) > 0)} onClick={addManualPart}>
                  Add cash payment
                </button>
              </>
            ) : (
              <>
                {rail && (
                  <label className="field-label">
                    {rail.customerField}
                    <input
                      value={customerAccount}
                      placeholder={rail.phone ? '+263 77 123 4567' : 'Mobile money number'}
                      onChange={(e) => setCustomerAccount(e.target.value)}
                    />
                  </label>
                )}

                {!manualMode ? (
                  <>
                    <div className="pay-rail-hint">
                      A payment prompt is pushed to the customer's phone. The sale is only marked paid
                      once the provider confirms.
                    </div>
                    <button className="primary-btn" disabled={starting} onClick={() => void startRequest()}>
                      {starting ? 'Sending request…' : `Send ${METHOD_LABELS[method]} request`}
                    </button>
                    <button className="link-btn" type="button" onClick={() => setManualMode(true)}>
                      Record an approval code manually
                    </button>
                  </>
                ) : (
                  <>
                    <label className="field-label">
                      Preyone Payment reference / approval code
                      <input
                        value={reference}
                        placeholder="e.g. 8H3K2M"
                        onChange={(e) => setReference(e.target.value)}
                      />
                    </label>
                    <button className="secondary-btn" onClick={addManualPart}>
                      Add payment part
                    </button>
                    <button className="link-btn" type="button" onClick={() => setManualMode(false)}>
                      Back to live payment request
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}

        {pending && (
          <div className={`pay-track ${stateClass}`} aria-live="polite">
            <div className="pay-track-head">
              <span className={`pay-chip ${stateClass}`}>
                {status ? STATE_LABEL[status.state] : 'Sending…'}
              </span>
              <span className="pay-track-amount">{money(pending.amount)}</span>
            </div>
            <div className="pay-track-ref">
              Reference <span className="mono">{status?.referenceNumber || pending.referenceNumber}</span>
            </div>
            <div className="pay-track-hint">
              {status?.state === 'PROCESSING'
                ? `Waiting for the customer to approve on ${METHOD_LABELS[pending.method]}.`
                : status?.state === 'FAILED'
                  ? status.failureReason || 'The payment was not completed.'
                  : `Prompt sent. Ask the customer to approve on ${METHOD_LABELS[pending.method]}.`}
            </div>
            <div className="pay-track-meta">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed
            </div>
            <div className="pay-track-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void checkStatus(pending.intentId)}
              >
                Check status now
              </button>
              <button type="button" className="ghost-btn" onClick={() => void cancelRequest()}>
                Cancel request
              </button>
            </div>
          </div>
        )}

        {intentError && <div className="err-msg">{intentError}</div>}

        <button className="primary-btn" disabled={!canConfirm} onClick={confirm}>
          {busy
            ? 'Processing…'
            : remaining > 0.005 && parts.length > 0
              ? `Record ${money(partsSum)} · ${money(remaining)} unpaid`
              : remaining > 0.005 && allowUnpaid
                ? 'Create unpaid document'
                : `Complete sale · ${money(total)}`}
        </button>
        <button className="secondary-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
