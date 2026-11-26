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
  redirectUrl?: string;
  instructions?: string;
}

/**
 * Payment rails presented exactly like the WiFi checkout tiles: one tap per
 * rail, with the two details Preyone needs to email the invoice captured first.
 */
const RAILS = [
  { key: 'ecocash', label: 'EcoCash', glyph: '📱', hint: 'Pay from your EcoCash wallet', phone: true },
  { key: 'innbucks', label: 'InnBucks', glyph: '💳', hint: 'Authorise in the InnBucks app', phone: false },
  { key: 'omari', label: "O'mari USD", glyph: '🏦', hint: 'USD account · PIN on phone', phone: true },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function UpgradeModal({
  onClose,
  onUpgraded,
}: {
  onClose: () => void;
  onUpgraded: (planType: string) => void;
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
  const [phase, setPhase] = useState<'form' | 'awaiting' | 'success'>('form');
  const [notified, setNotified] = useState(false);
  const pollRef = useRef<number | null>(null);

  const tiers = mergePlanTiers(plans?.tiers);

  useEffect(() => {
    let alive = true;
    api
      .get<SubscriptionPlans>('/api/subscription/plans')
      .then((p) => {
        if (!alive) return;
        setPlans(p);
        const merged = mergePlanTiers(p.tiers);
        if (p.current && merged.some((t) => t.id === p.current!.plan_type)) {
          const idx = merged.findIndex((t) => t.id === p.current!.plan_type);
          const next = merged.slice(idx + 1).find((t) => t.checkoutReady) ?? merged[merged.length - 1];
          setTier(next.id);
        }
      })
      .catch((e) => alive && setLoadErr(e instanceof Error ? e.message : 'Could not load plans'));
    return () => {
      alive = false;
    };
  }, []);

  // Settlement is server-to-server; poll the catalogue until the plan changes,
  // then refresh the whole workspace so the banner/watermark disappear.
  useEffect(() => {
    if (!session || phase !== 'awaiting') return;
    const started = Date.now();
    pollRef.current = window.setInterval(() => {
      if (Date.now() - started > 300_000) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        setError('Still waiting for the provider. Your payment will be applied automatically.');
        return;
      }
      api
        .get<SubscriptionPlans>('/api/subscription/plans')
        .then((fresh) => {
          if (fresh.current && fresh.current.plan_type === session.tier && !notified) {
            setNotified(true);
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setPhase('success');
            onUpgraded(session.tier);
          }
        })
        .catch(() => {
          /* transient */
        });
    }, 5_000);
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
      const s = await api.post<CheckoutSession>('/api/subscription/checkout', {
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
            <span className="up-eyebrow">SECURE PAYMENT · PESEPAY</span>
            <h3 className="modal-title">{phase === 'success' ? 'Payment received' : 'Upgrade my plan'}</h3>
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
                  <span className="up-rail-glyph" aria-hidden>{r.glyph}</span>
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
                {selected?.name || 'Plan'} · {selectedRail?.label}
              </span>
              <strong>{amountLabel}</strong>
            </div>
            <button className="pay-submit" type="button" disabled={busy || !plans || !selected?.checkoutReady} onClick={start}>
              {busy ? 'Starting secure payment…' : `Pay ${amountLabel} with ${selectedRail?.label}`}
            </button>
            <p className="up-secure">🔒 Encrypted by Preyone Payment. Your invoice is emailed as soon as the payment settles.</p>
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
            {error && <div className="banner error">{error}</div>}
            {session.redirectUrl && (
              <button
                className="btn"
                type="button"
                onClick={() => window.open(session.redirectUrl, '_blank', 'noopener')}
              >
                Reopen payment page
              </button>
            )}
          </div>
        )}

        {phase === 'success' && session && (
          <div className="up-stage">
            <div className="checkmark" aria-hidden>✓</div>
            <h4>Payment received</h4>
            <p>
              {session.name} is now active. The receipt and your Preyone invoice PDF were sent to{' '}
              <strong>{session.clientEmail || email}</strong>.
            </p>
            <div className="up-ref">
              <span>Reference</span>
              <strong>{session.reference}</strong>
            </div>
            <button className="btn primary" type="button" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
