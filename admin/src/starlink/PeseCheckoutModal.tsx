import { useState, type FormEvent } from 'react';
import { FiDollarSign, FiExternalLink, FiPhone, FiShield, FiWifi, FiPackage } from 'react-icons/fi';
import {
  fmtMoney, monthLabel, slCheckout, ApiError,
  type SlCheckoutResult, type SlCustomer, type SlKit,
} from './api';

export type CheckoutKind = 'wallet_topup' | 'data_topup' | 'kit_purchase';

const RAILS = [
  { id: 'ecocash', label: 'EcoCash', hint: 'Mobile money' },
  { id: 'innbucks', label: 'InnBucks', hint: 'Wallet' },
  { id: 'omari', label: 'Omari', hint: 'Bank' },
] as const;

const BUNDLES = [
  { gb: 10, price: 5, label: 'Starter' },
  { gb: 50, price: 19, label: 'Standard' },
  { gb: 100, price: 35, label: 'Pro' },
  { gb: 250, price: 79, label: 'Unlimited-ish' },
] as const;

const QUICK_AMOUNTS = [5, 10, 20, 50, 100];

export default function PeseCheckoutModal({
  customer,
  kits,
  initialKind = 'wallet_topup',
  onClose,
  onQueued,
}: {
  customer: SlCustomer;
  kits: SlKit[];
  initialKind?: CheckoutKind;
  onClose: () => void;
  onQueued: (result: SlCheckoutResult) => void;
}) {
  const [kind, setKind] = useState<CheckoutKind>(initialKind);
  const [amount, setAmount] = useState<string>(initialKind === 'kit_purchase' ? '250' : '');
  const [rail, setRail] = useState<string>('ecocash');
  const [phone, setPhone] = useState<string>(customer.phone || '');
  const [kitId, setKitId] = useState<string>(kits[0]?.id || '');
  const [bundleIdx, setBundleIdx] = useState(1);
  const [kitNumber, setKitNumber] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState<SlCheckoutResult | null>(null);
  const [error, setError] = useState('');

  const bundle = BUNDLES[bundleIdx];
  const effectiveAmount =
    kind === 'data_topup' ? bundle.price
      : kind === 'kit_purchase' ? Number(amount || 0)
        : Number(amount || 0);

  const switchKind = (k: CheckoutKind) => {
    setKind(k);
    setError('');
    setAmount(k === 'kit_purchase' ? '250' : '');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (kind !== 'data_topup') {
      const n = Number(amount);
      if (!Number.isFinite(n) || n <= 0) {
        setError('Enter a valid amount');
        return;
      }
      if (n > 2000) {
        setError('Maximum checkout amount is $2,000.00');
        return;
      }
    }
    if (kind === 'data_topup' && !kitId) {
      setError('Register a kit first — data top-ups are tied to a kit.');
      return;
    }

    setBusy(true);
    try {
      const result = await slCheckout({
        kind,
        amount: effectiveAmount,
        paymentMethod: rail,
        phone: rail === 'innbucks' ? undefined : phone,
        returnUrl: `${window.location.origin}${window.location.pathname}`,
        ...(kind === 'data_topup'
          ? { kitId, gb: bundle.gb, bundleName: `${bundle.gb}GB ${bundle.label}` }
          : {}),
        ...(kind === 'kit_purchase'
          ? { kitNumber: kitNumber.trim(), nickname: nickname.trim() }
          : {}),
      });

      if (result.redirectUrl) {
        setRedirecting(result);
        onQueued(result);
        // Leave to Pese's hosted checkout; they return to returnUrl on completion.
        window.setTimeout(() => {
          window.location.href = result.redirectUrl!;
        }, 450);
      } else {
        onQueued(result);
        onClose();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the payment. Please try again.');
      setBusy(false);
    }
  };

  if (redirecting) {
    return (
      <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Redirecting to Pese">
        <div className="sp-modal">
          <div className="sp-modal-body">
            <div className="sp-paying">
              <div className="sp-spinner" aria-hidden="true" />
              <div>
                <h3 style={{ margin: '0 0 6px', fontFamily: 'var(--font-display)', letterSpacing: '0.06em' }}>
                  Redirecting to Pese
                </h3>
                <p style={{ margin: 0, color: 'var(--sp-mut)', fontSize: 13.5 }}>
                  Invoice <b style={{ color: 'var(--sp-cyan)' }}>{redirecting.invoiceNumber}</b> created —
                  complete payment on the secure Pese checkout.
                </p>
                <p style={{ margin: '8px 0 0', color: 'var(--sp-dim)', fontSize: 12 }}>
                  Reference {redirecting.referenceNumber}
                </p>
              </div>
              <FiExternalLink size={22} color="#00e5ff" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-modal-overlay" role="dialog" aria-modal="true" aria-label="Pese checkout" onClick={onClose}>
      <form className="sp-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="sp-modal-head">
          <h3>Checkout · Pese Payments</h3>
          <button type="button" className="sp-modal-close" onClick={onClose} aria-label="Close checkout">✕</button>
        </div>

        <div className="sp-modal-body">
          {error && <div className="sp-alert sp-alert--err" role="alert">{error}</div>}

          <div className="sp-kind-tabs">
            <button
              type="button"
              className={'sp-kind-tab' + (kind === 'wallet_topup' ? ' is-active' : '')}
              onClick={() => switchKind('wallet_topup')}
            >
              <FiDollarSign size={18} /> Wallet Top Up
            </button>
            <button
              type="button"
              className={'sp-kind-tab' + (kind === 'data_topup' ? ' is-active' : '')}
              onClick={() => switchKind('data_topup')}
            >
              <FiWifi size={18} /> Data Top Up
            </button>
            <button
              type="button"
              className={'sp-kind-tab' + (kind === 'kit_purchase' ? ' is-active' : '')}
              onClick={() => switchKind('kit_purchase')}
            >
              <FiPackage size={18} /> Buy Starlink Kit
            </button>
          </div>

          {kind === 'wallet_topup' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-amount">Top-up amount (USD)</label>
                <input
                  id="sl-amount"
                  className="sp-input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  required
                />
              </div>
              <div className="sp-filters" style={{ marginBottom: 16 }}>
                {QUICK_AMOUNTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className={'sp-chip' + (Number(amount) === q ? ' is-active' : '')}
                    onClick={() => setAmount(String(q))}
                  >
                    {fmtMoney(q)}
                  </button>
                ))}
              </div>
            </>
          )}

          {kind === 'data_topup' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-kit-select">Kit</label>
                <select
                  id="sl-kit-select"
                  className="sp-select"
                  style={{ width: '100%', minWidth: 0 }}
                  value={kitId}
                  onChange={(e) => setKitId(e.target.value)}
                >
                  {kits.length === 0 && <option value="">No kits registered yet</option>}
                  {kits.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.nickname || 'Untitled kit'} · {k.kit_number}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sp-field">
                <label>Data bundle</label>
                <div className="sp-bundles">
                  {BUNDLES.map((b, i) => (
                    <button
                      key={b.gb}
                      type="button"
                      className={'sp-bundle' + (i === bundleIdx ? ' is-active' : '')}
                      onClick={() => setBundleIdx(i)}
                    >
                      <b>{b.gb}GB</b>
                      <span>{b.label} bundle</span>
                      <strong>{fmtMoney(b.price)}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {kind === 'kit_purchase' && (
            <>
              <div className="sp-field">
                <label htmlFor="sl-kitnum">Kit serial (from the box)</label>
                <input
                  id="sl-kitnum"
                  className="sp-input"
                  value={kitNumber}
                  onChange={(e) => setKitNumber(e.target.value)}
                  placeholder="e.g. UT-4X2H91P"
                />
              </div>
              <div className="sp-field">
                <label htmlFor="sl-kitnick">Nickname (optional)</label>
                <input
                  id="sl-kitnick"
                  className="sp-input"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="Home, Office, Shop…"
                />
              </div>
              <div className="sp-field">
                <label htmlFor="sl-kitprice">Kit price (USD)</label>
                <input
                  id="sl-kitprice"
                  className="sp-input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="250"
                  required
                />
              </div>
            </>
          )}

          <div className="sp-field">
            <label>Payment method</label>
            <div className="sp-rails">
              {RAILS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={'sp-rail' + (rail === r.id ? ' is-active' : '')}
                  onClick={() => setRail(r.id)}
                >
                  {r.label}
                  <small>{r.hint}</small>
                </button>
              ))}
            </div>
          </div>

          {rail !== 'innbucks' && (
            <div className="sp-field">
              <label htmlFor="sl-payphone">Payer phone (EcoCash / Omari)</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="sl-payphone"
                  className="sp-input"
                  style={{ paddingLeft: 40 }}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+263 77 123 4567"
                />
                <FiPhone style={{ position: 'absolute', left: 13, top: 13, color: '#64748b' }} />
              </div>
            </div>
          )}

          <div className="sp-summary">
            <div>
              <div className="sp-summary-k">
                {kind === 'data_topup'
                  ? `${bundle.gb}GB bundle · ${monthLabel(new Date().toISOString())}`
                  : kind === 'kit_purchase' ? 'Starlink kit purchase' : 'Wallet credit'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--sp-dim)', marginTop: 4 }}>
                {RAILS.find((r) => r.id === rail)?.label} · settled in USD
              </div>
            </div>
            <div className="sp-summary-v">{fmtMoney(effectiveAmount)}</div>
          </div>

          <div className="sp-secure">
            <FiShield /> Secured by Pese — Preyone never stores your card or wallet PIN
          </div>
        </div>

        <div className="sp-modal-foot">
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="sp-btn sp-btn--primary" style={{ width: 'auto' }} disabled={busy}>
            {busy ? 'Starting…' : `Pay ${fmtMoney(effectiveAmount)} with Pese`}
          </button>
        </div>
      </form>
    </div>
  );
}
