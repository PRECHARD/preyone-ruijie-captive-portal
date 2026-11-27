import { useEffect, useRef, useState } from 'react';
import { api, type PosDocument } from '../api';

const money = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

// Same verified Preyone Payment rails the till offers (see CheckoutModal).
// PayGo is intentionally absent (ZiG-only, not offered in the POS).
const RAILS = [
  { key: 'ecocash', label: 'EcoCash', logo: '/images/pay/ecocash.png', phone: true },
  { key: 'innbucks', label: 'InnBucks', logo: '/images/pay/innbucks.png', phone: false },
  { key: 'omari', label: 'O’mari', logo: '/images/pay/omari.webp', phone: true },
];

const OTHERS = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'bank', label: 'Bank' },
  { key: 'other', label: 'Other' },
];

type Phase = 'form' | 'waiting' | 'done';

export default function PaymentModal({
  doc,
  onCancel,
  onSaved,
}: {
  doc: PosDocument;
  onCancel: () => void;
  onSaved: (updated: PosDocument & { balanceDue?: number }) => void;
}) {
  const balance = Math.max(Number(doc.total) - Number(doc.amount_paid), 0);
  const [amount, setAmount] = useState(String(balance.toFixed(2)));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [phone, setPhone] = useState('');
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [phase, setPhase] = useState<Phase>('form');
  const [intent, setIntent] = useState<{ id: string; token: string; reference: string } | null>(null);
  const [statusText, setStatusText] = useState('Sending request…');
  const [statusState, setStatusState] = useState<'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED'>('PENDING');
  const [elapsed, setElapsed] = useState(0);
  const pollBusy = useRef(false);

  const rail = RAILS.find((r) => r.key === method);
  const value = Number(amount) || 0;
  const canSubmit = !busy && value > 0 && (manual || !rail || method === 'cash');

  const finish = async () => {
    const fresh = await api.document(doc.id);
    onSaved({ ...fresh, balanceDue: Math.max(Number(fresh.total) - Number(fresh.amount_paid), 0) });
  };

  const check = async (intentId: string, token: string) => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    try {
      const s = await api.documentPaymentStatus(intentId, token);
      const state = s.state || s.status;
      setStatusState(state);
      setStatusText(s.failureReason || s.label || (state === 'SUCCESS' ? 'Payment confirmed' : 'Waiting for approval'));
      if (s.status === 'SUCCESS') {
        setPhase('done');
        await finish();
      } else if (s.status === 'FAILED') {
        setPhase('form');
        setIntent(null);
        setError(s.failureReason || 'The payment was not completed. You can retry.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the payment status');
    } finally {
      pollBusy.current = false;
    }
  };

  useEffect(() => {
    if (phase !== 'waiting' || !intent) return;
    const started = Date.now();
    setElapsed(0);
    const tick = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const poll = window.setInterval(() => void check(intent.id, intent.token), 3000);
    void check(intent.id, intent.token);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, intent?.id]);

  const requestPayment = async () => {
    if (!rail) return;
    if (rail.phone && !/^\+?\d{9,15}$/.test(phone.replace(/[\s-]/g, ''))) {
      setError(`Enter the customer's ${rail.label} number.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const created = await api.documentPaymentIntent({
        amount: Math.round(value * 100) / 100,
        paymentMethod: rail.key,
        targetId: doc.id,
        currencyCode: (doc.currency || 'USD').toUpperCase(),
        reasonForPayment: `${doc.doc_number} · ${rail.label} payment`,
        phone: phone.trim() || undefined,
        fullName: doc.customer_name || undefined,
      });
      if (!created.intentId || !created.statusToken) {
        setError('The payment provider did not return a trackable reference.');
        return;
      }
      setIntent({ id: created.intentId, token: created.statusToken, reference: created.referenceNumber });
      setStatusState('PENDING');
      setStatusText('Prompt sent. Ask the customer to approve.');
      setPhase('waiting');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the payment request');
    } finally {
      setBusy(false);
    }
  };

  const submitManual = async () => {
    setBusy(true);
    setError('');
    try {
      const updated = await api.recordPayment(doc.id, {
        amount: Math.round(value * 100) / 100,
        method,
        reference: reference.trim() || undefined,
      });
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment could not be recorded');
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async () => {
    if (intent) {
      await api.documentPaymentCancel(intent.id, intent.token).catch(() => undefined);
    }
    setIntent(null);
    setPhase('form');
  };

  const stateClass =
    statusState === 'SUCCESS' ? 'ok' : statusState === 'FAILED' ? 'bad' : statusState === 'PROCESSING' ? 'live' : 'warn';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card up-card checkout-glass" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Record payment</h3>
        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.6rem' }}>
          {doc.doc_type === 'quotation' ? 'Quotation' : 'Invoice'} {doc.doc_number}
        </div>

        <div className="pay-total-line">
          <span className="lbl">BALANCE DUE</span>
          <span className="amt">{money(balance)}</span>
        </div>

        {phase === 'form' && (
          <>
            <div className="method-tabs" role="tablist" aria-label="Mobile money">
              {RAILS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  role="tab"
                  aria-selected={method === r.key}
                  aria-label={r.label}
                  title={r.label}
                  className={method === r.key ? 'on' : ''}
                  onClick={() => {
                    setMethod(r.key);
                    setManual(false);
                    setError('');
                  }}
                >
                  <img className="method-logo" src={r.logo} alt="" />
                </button>
              ))}
            </div>

            <div className="method-chips" role="group" aria-label="Other methods">
              {OTHERS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className={`method-chip${method === o.key ? ' on' : ''}`}
                  onClick={() => {
                    setMethod(o.key);
                    setManual(false);
                    setError('');
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <label className="field-label">
              {method === 'cash' ? 'Cash tendered ($)' : 'Amount ($)'}
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                autoFocus
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>

            {rail && (
              <>
                <label className="field-label">
                  {rail.label} number
                  <input
                    value={phone}
                    placeholder={rail.phone ? '+263 77 123 4567' : 'Mobile money number'}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>

                {!manual ? (
                  <>
                    <div className="pay-rail-hint">
                      A prompt is pushed to the customer's phone. The invoice is only marked paid
                      once the provider confirms.
                    </div>
                    <button className="primary-btn" disabled={!canSubmit || busy} onClick={() => void requestPayment()}>
                      {busy ? 'Sending request…' : `Send ${rail.label} request`}
                    </button>
                    <button className="link-btn" type="button" onClick={() => setManual(true)}>
                      Record an approval code manually
                    </button>
                  </>
                ) : (
                  <>
                    <label className="field-label">
                      Approval code
                      <input
                        value={reference}
                        placeholder="e.g. 8H3K2M"
                        onChange={(e) => setReference(e.target.value)}
                      />
                    </label>
                    <button className="secondary-btn" disabled={!canSubmit || busy} onClick={() => void submitManual()}>
                      Record manual payment
                    </button>
                    <button className="link-btn" type="button" onClick={() => setManual(false)}>
                      Back to live payment request
                    </button>
                  </>
                )}
              </>
            )}

            {!rail && (
              <button className="primary-btn" disabled={!canSubmit || busy} onClick={() => void submitManual()}>
                {busy ? 'Recording…' : `Record ${money(value)} payment`}
              </button>
            )}
          </>
        )}

        {phase === 'waiting' && intent && (
          <div className={`pay-track ${stateClass}`} aria-live="polite">
            <div className="pay-track-head">
              <span className={`pay-chip ${stateClass}`}>
                {statusState === 'PROCESSING'
                  ? 'Awaiting approval'
                  : statusState === 'SUCCESS'
                    ? 'Confirmed'
                    : 'Request sent'}
              </span>
              <span className="pay-track-amount">{money(value)}</span>
            </div>
            <div className="pay-track-ref">
              Reference <span className="mono">{intent.reference}</span>
            </div>
            <div className="pay-track-hint">{statusText}</div>
            <div className="pay-track-meta">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed
            </div>
            <div className="pay-track-actions">
              <button type="button" className="secondary-btn" onClick={() => void check(intent.id, intent.token)}>
                Check status now
              </button>
              <button type="button" className="ghost-btn" onClick={() => void cancelRequest()}>
                Cancel request
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--danger, #c0392b)', fontSize: '0.8rem', margin: '0.4rem 0' }}>
            {error}
          </div>
        )}

        <button className="secondary-btn" onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  );
}
