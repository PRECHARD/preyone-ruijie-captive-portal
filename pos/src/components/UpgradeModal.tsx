import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { mergePlanTiers } from '../plans';
import '../upgradeCheckout.css';

interface SubscriptionPlans {
  tenantId: string;
  current: {
    plan_type: string;
    max_devices: number;
    subscription_status: string;
    subscription_expires_at: string | null;
    account_number?: string | null;
  } | null;
  tiers: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>;
  currency: string;
}

interface CheckoutSession {
  success: boolean;
  tier: string;
  name: string;
  amount: number;
  currencyCode: string;
  paymentMethod: string;
  reference: string;
  invoiceNumber?: string;
  clientEmail?: string;
  intentId?: string | null;
  statusToken?: string | null;
  redirectUrl?: string;
  instructions?: string;
}

/**
 * The one checkout design used across Invoice and POS: real payment logos on
 * glass tiles, a translucent emerald card, and an immediate unsuccessful state.
 */
const RAILS = [
  {
    key: 'ecocash',
    label: 'EcoCash',
    logo: '/images/pay/ecocash.png',
    hint: 'Pay from your EcoCash wallet',
    phone: true,
  },
  {
    key: 'innbucks',
    label: 'InnBucks',
    logo: '/images/pay/innbucks.png',
    hint: 'Authorise in the InnBucks app',
    phone: false,
  },
  {
    key: 'omari',
    label: "O'mari",
    logo: '/images/pay/omari.webp',
    hint: 'Approve with your phone PIN',
    phone: true,
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type Phase = 'form' | 'awaiting' | 'failed' | 'success';

export default function UpgradeModal({
  onClose,
  onUpgraded,
  appName = 'POS',
}: {
  onClose: () => void;
  onUpgraded: (planType: string) => void;
  appName?: string;
}) {
  const [plans, setPlans] = useState<SubscriptionPlans | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tier, setTier] = useState('pos_invoice_15');
  const [currency, setCurrency] = useState<'USD' | 'ZiG'>('USD');
  const [rail, setRail] = useState('ecocash');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [notified, setNotified] = useState(false);
  const pollRef = useRef<number | null>(null);

  const tiers = mergePlanTiers(plans?.tiers);

  useEffect(() => {
    let alive = true;
    api
      .subscriptionPlans()
      .then((p: SubscriptionPlans) => {
        if (!alive) return;
        setPlans(p);
        const merged = mergePlanTiers(p.tiers);
        if (p.current && merged.some((t) => t.id === p.current!.plan_type)) {
          const idx = merged.findIndex((t) => t.id === p.current!.plan_type);
          const next = merged.slice(idx + 1).find((t) => t.checkoutReady) ?? merged[merged.length - 1];
          setTier(next.id);
        }
      })
      .catch((e: unknown) => alive && setLoadErr(e instanceof Error ? e.message : 'Could not load plans'));
    return () => {
      alive = false;
    };
  }, []);

  // Poll the payment itself (not just the plan), so a rejection shows the
  // unsuccessful screen within seconds instead of silently waiting.
  useEffect(() => {
    if (!session || phase !== 'awaiting') return;
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 300_000) {
        setError('Still waiting for confirmation. If you were charged, contact support with the reference.');
        return;
      }
      try {
        if (session.intentId && session.statusToken) {
          const status = await api.checkoutStatus(session.intentId, session.statusToken);
          if (status.status === 'FAILED') {
            setPhase('failed');
            setError('Payment was unsuccessful. No money was taken — please try again.');
            return;
          }
          if (status.status === 'SUCCESS') {
            setPhase('success');
            if (!notified) {
              setNotified(true);
              onUpgraded(session.tier);
            }
            return;
          }
        }
        const fresh = await api.subscriptionPlans();
        if (fresh.current && fresh.current.plan_type === session.tier && !notified) {
          setNotified(true);
          setPhase('success');
          onUpgraded(session.tier);
        }
      } catch {
        /* transient poll failure — keep waiting */
      }
    };
    pollRef.current = window.setInterval(poll, 4_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session, phase, notified, onUpgraded]);

  const selected = tiers.find((t) => t.id === tier);
  const selectedRail = RAILS.find((r) => r.key === rail);
  const currentType = plans?.current?.plan_type ?? null;
  const amountLabel = `${currency === 'ZiG' ? 'ZiG' : '$'}${selected?.price ?? 0}`;

  const start = async () => {
    if (!selected?.checkoutReady) {
      setError('This tier is not available for checkout yet.');
      return;
    }
    if (!fullName.trim()) {
      setError('Enter the client or company name for the invoice.');
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address — the payment invoice is sent there.');
      return;
    }
    if (!/^\+?\d{9,15}$/.test(phone.replace(/[\s-]/g, ''))) {
      setError('Enter a valid phone number for the payment.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const s = await api.subscriptionCheckout({
        tier,
        currencyCode: currency,
        paymentMethod: rail,
        fullName: fullName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      });
      setSession(s);
      setPhase('awaiting');
      if (s.redirectUrl) window.open(s.redirectUrl, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop up-backdrop" onClick={phase === 'form' ? onClose : undefined}>
      <div className="modal-card up-card" onClick={(e) => e.stopPropagation()}>
        <header className="up-head">
          <div>
            <span className="up-eyebrow">SECURE PAYMENT · PREYONE PAYMENT</span>
            <h3 className="modal-title">
              {phase === 'success' ? 'Payment received' : phase === 'failed' ? 'Payment was unsuccessful' : 'Upgrade my plan'}
            </h3>
          </div>
          <button className="up-close" type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {loadErr && <div className="banner error">{loadErr}</div>}

        {phase === 'form' && (
          <>
            <div className="tier-grid up-tiers">
              {tiers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`tier-card${tier === t.id ? ' on' : ''}${currentType === t.id ? ' current' : ''}`}
                  onClick={() => setTier(t.id)}
                >
                  <span className="tier-name">{t.name}</span>
                  <span className="tier-price">
                    ${t.price}
                    <small>/mo</small>
                  </span>
                  <span className="tier-devices">
                    {t.devices >= 9999 ? 'Unlimited devices' : `Up to ${t.devices} devices`}
                  </span>
                  <span className="tier-tag">{t.tagline}</span>
                  {currentType === t.id && <span className="tier-badge">CURRENT</span>}
                </button>
              ))}
            </div>

            <div className="up-section-title">Where should we send the invoice?</div>
            <div className="up-fields">
              <label className="field">
                <span>Client / company name</span>
                <input
                  className="input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Floniel Babyware"
                />
              </label>
              <label className="field">
                <span>Email address</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="billing@company.com"
                />
              </label>
              <label className="field">
                <span>Phone number</span>
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+263 77 123 4567"
                />
              </label>
            </div>

            <div className="up-section-title">Choose a payment method</div>
            <div className="up-rails">
              {RAILS.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`up-rail${rail === r.key ? ' selected' : ''}`}
                  onClick={() => setRail(r.key)}
                >
                  <img className="up-rail-logo" src={r.logo} alt={r.label} />
                  <strong>{r.label}</strong>
                  <small>{r.hint}</small>
                  <span className="up-rail-check" aria-hidden>✓</span>
                </button>
              ))}
            </div>

            <div className="up-currency">
              <span>Currency</span>
              <div className="method-tabs">
                {(['USD', 'ZiG'] as const).map((c) => (
                  <button key={c} type="button" className={currency === c ? 'on' : ''} onClick={() => setCurrency(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {error && <div className="banner error">{error}</div>}
            <div className="up-summary">
              <span>
                {selected?.name || 'Plan'} · {selectedRail?.label} · {appName}
              </span>
              <strong>{amountLabel}</strong>
            </div>
            <button className="pay-submit" type="button" disabled={busy || !plans || !selected?.checkoutReady} onClick={start}>
              {busy ? 'Starting secure payment…' : `Pay ${amountLabel} with ${selectedRail?.label}`}
            </button>
            <p className="up-secure">🔒 Secure payment by Preyone. Your invoice is emailed as soon as the payment settles.</p>
          </>
        )}

        {phase === 'awaiting' && session && (
          <div className="up-stage">
            <div className="pay-radar" aria-hidden><i /><i /><i /></div>
            <h4>Check your {selectedRail?.label} phone</h4>
            <p>Approve the payment request to activate {session.name}. Keep this window open.</p>
            <div className="up-ref">
              <span>Reference</span>
              <strong>{session.reference}</strong>
            </div>
            {session.invoiceNumber && (
              <div className="up-ref">
                <span>Invoice</span>
                <strong>{session.invoiceNumber}</strong>
              </div>
            )}
            {session.instructions && <p className="up-instructions">{session.instructions}</p>}
            {session.redirectUrl && (
              <button
                className="btn"
                type="button"
                onClick={() => window.open(session.redirectUrl, '_blank', 'noopener')}
              >
                Reopen payment page
              </button>
            )}
            <button
              className="btn ghost"
              type="button"
              onClick={async () => {
                if (session.intentId && session.statusToken) {
                  try {
                    await api.checkoutCancel(session.intentId, session.statusToken);
                  } catch {
                    /* best effort */
                  }
                }
                setPhase('failed');
                setError('Payment was cancelled. No money was taken — retry when ready.');
              }}
            >
              Cancel payment
            </button>
          </div>
        )}

        {(phase === 'failed' || phase === 'success') && session && (
          <div className="up-stage">
            <div className={phase === 'success' ? 'checkmark' : 'up-fail-mark'} aria-hidden>
              {phase === 'success' ? '✓' : '!'}
            </div>
            <h4>{phase === 'success' ? 'Payment received' : 'Payment was unsuccessful'}</h4>
            <p>
              {phase === 'success'
                ? `${session.name} is now active. The receipt and your Preyone invoice PDF were sent to ${session.clientEmail || email}.`
                : 'No money has been taken for this attempt. A notification was sent to your email — you can retry with the same or another payment method.'}
            </p>
            <div className="up-ref">
              <span>Reference</span>
              <strong>{session.reference}</strong>
            </div>
            <div className="up-actions">
              {phase === 'failed' && (
                <button className="btn primary" type="button" onClick={() => { setPhase('form'); setSession(null); }}>
                  Try again
                </button>
              )}
              <button className="btn ghost" type="button" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
