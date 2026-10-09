import { useMemo, useState } from 'react';

interface PaymentPart {
  amount: number;
  method: string;
  reference?: string;
}

// Only rails Pesepay actually enables for this merchant (verified against
// /v1/payment-methods/for-currency on 2026-10-03). Zimswitch, Visa and
// Mastercard are rejected by the gateway, so they are not offered at the till.
// `phone: true` marks rails that need the payer's MSISDN on the payment prompt.
const PESEPAY_RAILS = [
  { key: 'ecocash', label: 'EcoCash', customerField: 'EcoCash number', prefix: '*151#', phone: true },
  { key: 'innbucks', label: 'InnBucks', customerField: 'InnBucks number', prefix: '*242#', phone: false },
  { key: 'paygo', label: 'PayGo', customerField: 'PayGo number', prefix: '*888#', phone: false },
  { key: 'omari', label: 'Omari', customerField: 'Omari number', prefix: '*100#', phone: true },
];

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  ...Object.fromEntries(PESEPAY_RAILS.map((r) => [r.key, r.label])),
};

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

export default function CheckoutModal({
  total,
  cashierName,
  onCancel,
  onComplete,
}: {
  total: number;
  cashierName: string;
  onCancel: () => void;
  onComplete: (payments: PaymentPart[], customerName?: string) => Promise<void>;
}) {
  const [method, setMethod] = useState<string>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [customerAccount, setCustomerAccount] = useState('');
  const [parts, setParts] = useState<PaymentPart[]>([]);
  const [busy, setBusy] = useState(false);
  const [customerName, setCustomerName] = useState('');

  const rail = PESEPAY_RAILS.find((r) => r.key === method);
  const methods = ['cash', ...PESEPAY_RAILS.map((r) => r.key)];

  const partsSum = useMemo(() => parts.reduce((s, p) => s + p.amount, 0), [parts]);
  const remaining = Math.max(0, Math.round((total - partsSum) * 100) / 100);
  const change = Math.max(0, Math.round(((Number(tendered) || 0) - remaining) * 100) / 100);
  const overpaid = (Number(tendered) || 0) > remaining + 0.005;

  const quickAmounts = useMemo(() => {
    const set = new Set<number>([remaining]);
    for (const step of [1, 5, 10, 20]) {
      const next = Math.ceil(remaining / step) * step;
      if (next > 0) set.add(next);
    }
    return [...set].filter((v) => v > 0 && v !== Infinity).sort((a, b) => a - b).slice(0, 4);
  }, [remaining]);

  const buildReference = (): string | undefined => {
    const approval = reference.trim();
    const account = customerAccount.trim();
    if (!rail) return approval || undefined;
    if (account && approval) return `${rail.label} ${account} · ${approval}`;
    if (account) return `${rail.label} ${account}`;
    return approval || undefined;
  };

  const addPart = () => {
    const amount = Number(tendered);
    if (!amount || amount <= 0) return;
    const capped = method === 'cash' ? amount : Math.min(amount, remaining);
    if (capped <= 0) return;
    setParts((p) => [
      ...p,
      { amount: Math.round(capped * 100) / 100, method, reference: buildReference() },
    ]);
    setTendered('');
    setReference('');
    setCustomerAccount('');
  };

  const canConfirm =
    !busy &&
    total >= 0 &&
    (total === 0 ? true : remaining <= 0.005);

  const confirm = async () => {
    setBusy(true);
    try {
      await onComplete(total === 0 ? [{ amount: 0, method: 'cash' }] : parts, customerName.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
                <span className="receipt-muted">{METHOD_LABELS[p.method] || p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
                <span>
                  <strong>{money(p.amount)}</strong>{' '}
                  <button className="remove-btn" onClick={() => setParts((arr) => arr.filter((_, j) => j !== i))}>✕</button>
                </span>
              </div>
            ))}
            <div className={`change-box ${remaining > 0 ? 'due' : ''}`}>
              <span className="lbl">{remaining > 0 ? 'STILL DUE' : 'FULLY COVERED'}</span>
              <span className="amt">{remaining > 0 ? money(remaining) : '✓'}</span>
            </div>
          </>
        )}

        {remaining > 0 && (
          <>
            <div className="method-tabs">
              {methods.map((m) => (
                <button key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                  {METHOD_LABELS[m] || m}
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
                {overpaid && (
                  <div className="change-box">
                    <span className="lbl">CHANGE</span>
                    <span className="amt">{money(change)}</span>
                  </div>
                )}
                <div className="quick-amts">
                  {quickAmounts.map((v) => (
                    <button key={v} onClick={() => setTendered(String(v.toFixed(2)))}>{money(v)}</button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {rail && rail.prefix && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: '0 0 0.5rem' }}>
                    Customer approves on their phone: {rail.label} {rail.prefix}
                  </p>
                )}
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
                <label className="field-label">
                  Pesepay reference / approval code
                  <input
                    value={reference}
                    placeholder="e.g. 8H3K2M"
                    onChange={(e) => setReference(e.target.value)}
                  />
                </label>
              </>
            )}

            {(Number(tendered) || 0) > 0 && (
              <button className="secondary-btn" onClick={addPart}>
                Add part payment
              </button>
            )}
          </>
        )}

        <button className="primary-btn" disabled={!canConfirm} onClick={confirm}>
          {busy ? 'Processing…' : remaining > 0.005 ? 'Record as unpaid balance' : `Complete sale · ${money(total)}`}
        </button>
        <button className="secondary-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
