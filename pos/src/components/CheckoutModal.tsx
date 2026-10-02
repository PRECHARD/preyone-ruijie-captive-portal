import { useMemo, useState } from 'react';

interface PaymentPart {
  amount: number;
  method: string;
  reference?: string;
}

const METHODS = ['cash', 'card', 'ecocash', 'bank', 'pesepay'] as const;

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
  const [parts, setParts] = useState<PaymentPart[]>([]);
  const [busy, setBusy] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [ussdPhone, setUssdPhone] = useState('');
  const [ussdPin, setUssdPin] = useState('');
  const [ussdActive, setUssdActive] = useState(false);
  const [ussdErr, setUssdErr] = useState('');

  const MERCHANT_ECOCASH = '+263771327202';

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

  const addPart = () => {
    const amount = Number(tendered);
    if (!amount || amount <= 0) return;
    const capped = method === 'cash' ? amount : Math.min(amount, remaining);
    if (capped <= 0) return;
    setParts((p) => [
      ...p,
      { amount: Math.round(capped * 100) / 100, method, reference: reference.trim() || undefined },
    ]);
    setTendered('');
    setReference('');
  };

  const openUssd = () => {
    const phone = ussdPhone.replace(/[^\d+]/g, '');
    if (phone.length < 9) {
      setUssdErr('Enter the customer\u2019s EcoCash number (e.g. +263 77 123 4567).');
      return;
    }
    setUssdErr('');
    setUssdPin('');
    setUssdActive(true);
  };

  const confirmUssd = () => {
    if (ussdPin.trim().length < 4) {
      setUssdErr('Customer must approve with their 4-digit EcoCash PIN.');
      return;
    }
    const amount = Math.round(remaining * 100) / 100;
    if (amount <= 0) return;
    setParts((p) => [
      ...p,
      { amount, method: 'ecocash', reference: `USSD ${ussdPhone.trim()} PIN✔` },
    ]);
    setUssdActive(false);
    setUssdPin('');
    setUssdPhone('');
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
                <span className="receipt-muted">{p.method}{p.reference ? ` · ${p.reference}` : ''}</span>
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
              {METHODS.map((m) => (
                <button key={m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>
                  {m === 'ecocash' ? 'EcoCash' : m}
                </button>
              ))}
            </div>

            <label className="field-label">
              {method === 'cash' ? 'Cash tendered ($)' : `${method} amount ($)`}
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
            ) : method === 'ecocash' ? (
              <>
                <label className="field-label">
                  Customer’s EcoCash number (they approve on their phone)
                  <input
                    value={ussdPhone}
                    placeholder="+263 77 123 4567"
                    onChange={(e) => { setUssdPhone(e.target.value); setUssdErr(''); }}
                  />
                </label>
                {ussdErr && <div className="err-msg">{ussdErr}</div>}
                <button className="secondary-btn" style={{ marginTop: '0.5rem' }} onClick={openUssd}>
                  Send USSD payment request · {money(remaining)}
                </button>
              </>
            ) : (
              <label className="field-label">
                Reference (tx ref / approval code)
                <input value={reference} onChange={(e) => setReference(e.target.value)} />
              </label>
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

        {ussdActive && (
          <div className="ussd-overlay" onClick={(e) => { e.stopPropagation(); setUssdActive(false); }}>
            <div className="ussd-phone">
              <div className="ussd-bar">
                <span>Econet</span>
                <span>USSD · *151#</span>
              </div>
              <div className="ussd-screen">
                <div className="ussd-header">Preyone Enterprise</div>
                <p className="ussd-body">
                  Payment request
                  <br />
                  <strong>{money(remaining)}</strong>
                  <br />
                  <span className="ussd-muted">from {ussdPhone.replace(/[^\d+]/g, '')}</span>
                  <br />
                  <span className="ussd-muted">to {MERCHANT_ECOCASH}</span>
                </p>
                <p className="ussd-question">Enter your EcoCash PIN to approve</p>
                <input
                  className="ussd-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="••••"
                  value={ussdPin}
                  autoFocus
                  onChange={(e) => { setUssdPin(e.target.value.replace(/\D/g, '')); setUssdErr(''); }}
                />
                {ussdErr && <div className="ussd-err">{ussdErr}</div>}
                <div className="ussd-actions">
                  <button className="ussd-btn" onClick={confirmUssd}>1 Approve</button>
                  <button className="ussd-btn" onClick={() => setUssdActive(false)}>2 Cancel</button>
                </div>
                <p className="ussd-foot">Reply U to cancel</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
