import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { mergePlanTiers } from '../plans';

interface SubscriptionPlans {
  tenantId: string;
  current: {
    plan_type: string;
    max_devices: number;
    subscription_status: string;
    subscription_expires_at: string | null;
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
  redirectUrl?: string;
  instructions?: string;
}

const RAILS = [
  { key: 'ecocash', label: 'EcoCash', phone: true },
  { key: 'innbucks', label: 'InnBucks', phone: false },
  { key: 'omari', label: "O'mari", phone: true },
];

export default function UpgradeModal({
  onClose,
  onUpgraded,
}: {
  onClose: () => void;
  onUpgraded: (planType: string) => void;
}) {
  const [plans, setPlans] = useState<SubscriptionPlans | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tier, setTier] = useState('invoicing_15');
  const [currency, setCurrency] = useState<'USD' | 'ZiG'>('USD');
  const [rail, setRail] = useState('ecocash');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<CheckoutSession | null>(null);
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

  useEffect(() => {
    if (!session) return;
    const started = Date.now();
    pollRef.current = window.setInterval(() => {
      if (Date.now() - started > 180_000) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      api
        .get<SubscriptionPlans>('/api/subscription/plans')
        .then((fresh) => {
          if (fresh.current && fresh.current.plan_type === session.tier && !notified) {
            setNotified(true);
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            onUpgraded(session.tier);
          }
        })
        .catch(() => {
          /* transient */
        });
    }, 8_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session, notified, onUpgraded]);

  const selected = tiers.find((t) => t.id === tier);
  const canCheckout = Boolean(selected?.checkoutReady);
  const selectedRail = RAILS.find((r) => r.key === rail);
  const currentType = plans?.current?.plan_type ?? null;

  const start = async () => {
    if (!canCheckout) {
      setError('This tier is not available for checkout yet.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const s = await api.post<CheckoutSession>('/api/subscription/checkout', {
        tier,
        currencyCode: currency,
        paymentMethod: rail,
        phone: selectedRail?.phone ? phone.trim() || undefined : undefined,
      });
      setSession(s);
      if (s.redirectUrl) window.open(s.redirectUrl, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={session ? undefined : onClose}>
      <div className="modal-card upgrade-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Upgrade my plan</h3>
        {loadErr && <div className="banner error">{loadErr}</div>}

        {!session ? (
          <>
            <div className="tier-grid">
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

            <div className="upgrade-fields">
              <label className="field">
                <span>Pay with</span>
                <div className="method-tabs">
                  {RAILS.map((r) => (
                    <button key={r.key} type="button" className={rail === r.key ? 'on' : ''} onClick={() => setRail(r.key)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>Currency</span>
                <div className="method-tabs">
                  {(['USD', 'ZiG'] as const).map((c) => (
                    <button key={c} type="button" className={currency === c ? 'on' : ''} onClick={() => setCurrency(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </label>
              {selectedRail?.phone && (
                <label className="field">
                  <span>{selectedRail.label} number</span>
                  <input className="input" value={phone} placeholder="+263 77 123 4567" onChange={(e) => setPhone(e.target.value)} />
                </label>
              )}
            </div>

            {error && <div className="banner error">{error}</div>}
            <button className="btn" type="button" disabled={busy || !plans || !canCheckout} onClick={start}>
              {busy ? 'Starting checkout…' : 'Pay with Pesepay'}
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <div className="checkout-summary">
              <span>{session.name} plan</span>
              <strong>
                {session.currencyCode === 'ZiG' ? 'ZiG' : '$'}
                {session.amount}
              </strong>
            </div>
            <div className="muted small">Reference: {session.reference}</div>
            {session.instructions && <p className="muted">{session.instructions}</p>}
            {session.redirectUrl && (
              <button className="btn" type="button" onClick={() => window.open(session.redirectUrl, '_blank', 'noopener')}>
                Open payment page
              </button>
            )}
            <button className="btn ghost" type="button" onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
