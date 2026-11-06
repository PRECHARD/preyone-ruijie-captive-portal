import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type CheckoutSession, type SubscriptionPlans } from '../api';

// Same enabled rails as the till's CheckoutModal (verified against
// /v1/payment-methods/for-currency). `phone` marks rails that prompt the payer
// for their MSISDN on the Pesepay hosted page.
const RAILS = [
  { key: 'ecocash', label: 'EcoCash', phone: true },
  { key: 'innbucks', label: 'InnBucks', phone: false },
  { key: 'paygo', label: 'PayGo', phone: false },
  { key: 'omari', label: 'Omari', phone: true },
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
  const [tier, setTier] = useState('growth_20');
  const [currency, setCurrency] = useState<'USD' | 'ZiG'>('USD');
  const [rail, setRail] = useState('ecocash');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [qr, setQr] = useState('');
  const [notified, setNotified] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .subscriptionPlans()
      .then((p) => {
        if (!alive) return;
        setPlans(p);
        if (p.current && p.tiers.some((t) => t.id === p.current!.plan_type)) {
          // Default the picker to the next tier up from the current one.
          const idx = p.tiers.findIndex((t) => t.id === p.current!.plan_type);
          setTier(p.tiers[Math.min(idx + 1, p.tiers.length - 1)].id);
        }
      })
      .catch((e) => alive && setLoadErr(e instanceof Error ? e.message : 'Could not load plans'));
    return () => {
      alive = false;
    };
  }, []);

  // While the hosted checkout is open, watch the company plan so the till
  // flips the moment the Pesepay webhook applies the upgrade.
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
        .subscriptionPlans()
        .then((fresh) => {
          if (fresh.current && fresh.current.plan_type === session.tier && !notified) {
            setNotified(true);
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            onUpgraded(session.tier);
          }
        })
        .catch(() => { /* transient */ });
    }, 8_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session, notified, onUpgraded]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await api.subscriptionCheckout({
        tier,
        currencyCode: currency,
        paymentMethod: rail,
        phone: RAILS.find((r) => r.key === rail)?.phone ? phone.trim() || undefined : undefined,
      });
      setSession(s);
      if (s.redirectUrl) {
        const dataUrl = await QRCode.toDataURL(s.redirectUrl, { margin: 1, width: 240 });
        setQr(dataUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  const openGateway = () => {
    if (session?.redirectUrl) window.open(session.redirectUrl, '_blank', 'noopener');
  };

  const currentType = plans?.current?.plan_type ?? null;
  const selectedRail = RAILS.find((r) => r.key === rail);

  return (
    <div className="modal-backdrop" onClick={session ? undefined : onClose}>
      <div className="modal-card upgrade-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Upgrade my plan</h3>
        {loadErr && <div className="err-msg">{loadErr}</div>}

        {!session ? (
          <>
            <div className="tier-grid">
              {(plans?.tiers ?? []).map((t) => (
                <button
                  key={t.id}
                  className={`tier-card${tier === t.id ? ' on' : ''}${currentType === t.id ? ' current' : ''}`}
                  onClick={() => setTier(t.id)}
                >
                  <span className="tier-name">{t.name}</span>
                  <span className="tier-price">
                    ${t.price}
                    <small>/mo</small>
                  </span>
                  <span className="tier-devices">
                    {t.devices >= 9999 ? 'Unlimited devices' : `${t.devices} device${t.devices === 1 ? '' : 's'}`}
                  </span>
                  <span className="tier-tag">{t.tagline}</span>
                  {currentType === t.id && <span className="tier-badge">CURRENT</span>}
                </button>
              ))}
            </div>
            {plans && plans.tiers.length === 0 && <div className="empty-note">No plans available.</div>}

            <div className="upgrade-fields">
              <label className="field-label">
                Pay with
                <div className="method-tabs">
                  {RAILS.map((r) => (
                    <button key={r.key} className={rail === r.key ? 'on' : ''} onClick={() => setRail(r.key)}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field-label">
                Currency
                <div className="method-tabs">
                  {(['USD', 'ZiG'] as const).map((c) => (
                    <button key={c} className={currency === c ? 'on' : ''} onClick={() => setCurrency(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </label>
              {selectedRail?.phone && (
                <label className="field-label">
                  {selectedRail.label} number
                  <input
                    value={phone}
                    placeholder="+263 77 123 4567"
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </label>
              )}
            </div>

            {error && <div className="err-msg">{error}</div>}
            <button className="primary-btn" disabled={busy || !plans} onClick={start}>
              {busy ? 'Starting checkout…' : 'Pay with Pesepay'}
            </button>
            <button className="secondary-btn" onClick={onClose}>Cancel</button>
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
            {qr && (
              <div className="qr-wrap">
                <img src={qr} alt="Pesepay checkout QR" />
                <p className="hint">
                  Scan with your phone to pay on Pesepay, or open the checkout below.
                  This till watches for confirmation automatically.
                </p>
              </div>
            )}
            {session.instructions && <p className="hint">{session.instructions}</p>}
            <div className="hint">Reference: {session.reference}</div>
            <button className="primary-btn" onClick={openGateway}>Open payment page</button>
            <button className="secondary-btn" onClick={onClose}>Close</button>
          </>
        )}
      </div>
    </div>
  );
}
