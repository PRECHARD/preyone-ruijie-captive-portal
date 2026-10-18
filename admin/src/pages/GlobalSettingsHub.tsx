import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FiUpload, FiExternalLink } from 'react-icons/fi';
import { api, subscriptionApi } from '../api/client';
import Modal from '../components/Modal';
import './GlobalSettingsHub.css';

type Tab = 'general' | 'hardware' | 'kds' | 'invoicing';

interface Catalogue {
  invoiceTemplates: Array<{ id: number; name: string; description: string; layout: string; accentColor: string; showLogo: boolean }>;
  posThemes: Array<{ id: number; name: string; description: string; primary: string; secondary: string; accent: string; bg: string; text: string }>;
  businessProfiles: Array<{ id: string; name: string; description: string; kind: string }>;
  currencies: Array<{ code: string; name: string; symbol: string }>;
  planTiers: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>;
}

interface PosHardware {
  printerName?: string;
  printerIp?: string;
  paperWidth?: string;
  drawerKickEnabled?: boolean;
  scannerEnabled?: boolean;
  scannerPrefix?: string;
  scannerSuffix?: string;
}

interface InvoiceSettings {
  bankName?: string;
  bankAccountName?: string;
  bankAccount?: string;
  swiftCode?: string;
  taxNumber?: string;
}

/** ESC/POS cash-drawer pulse: pin 2 via timer 0. Referenced, never edited. */
const DRAWER_KICK_BYTES = '\\x1B\\x70\\x00\\x19\\xFA';

const RAILS = [
  { key: 'ecocash', label: 'EcoCash' },
  { key: 'innbucks', label: 'InnBucks' },
  { key: 'paygo', label: 'PayGo' },
  { key: 'omari', label: 'Omari' },
];

export default function GlobalSettingsHub() {
  const [tab, setTab] = useState<Tab>('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);

  // Editable company state (camelCase; mapped from the snake_case row).
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [supportPhone, setSupportPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [address, setAddress] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [taxPct, setTaxPct] = useState(0);
  const [invoicePrefix, setInvoicePrefix] = useState('INV-');
  const [quotePrefix, setQuotePrefix] = useState('QUO-');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [termsText, setTermsText] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [businessProfile, setBusinessProfile] = useState('retail');
  const [invoiceTemplateId, setInvoiceTemplateId] = useState(1);
  const [posThemeId, setPosThemeId] = useState(1);
  const [posHardware, setPosHardware] = useState<PosHardware>({});
  const [invoiceSettings, setInvoiceSettings] = useState<InvoiceSettings>({});

  // Billing snapshot for the General tab header.
  const [plan, setPlan] = useState<{ plan_type?: string; subscription_status?: string; subscription_expires_at?: string | null; max_devices?: number } | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);

  const hydrate = useCallback((row: any) => {
    if (!row) return;
    setName(row.name ?? '');
    setEmail(row.email ?? '');
    setSupportPhone(row.support_phone ?? '');
    setWebsite(row.website ?? '');
    setAddress(row.address ?? '');
    setCurrency(row.currency ?? 'USD');
    setTaxPct(Number(row.tax_pct) || 0);
    setInvoicePrefix(row.invoice_prefix ?? 'INV-');
    setQuotePrefix(row.quote_prefix ?? 'QUO-');
    setReceiptFooter(row.receipt_footer ?? '');
    setTermsText(row.terms_text ?? '');
    setLogoUrl(row.logo_url ?? null);
    setBusinessProfile(row.business_profile ?? 'retail');
    setInvoiceTemplateId(Number(row.invoice_template_id) || 1);
    setPosThemeId(Number(row.pos_theme_id) || 1);
    setPosHardware((row.pos_hardware ?? {}) as PosHardware);
    setInvoiceSettings((row.invoice_settings ?? {}) as InvoiceSettings);
    setPlan({
      plan_type: row.plan_type,
      subscription_status: row.subscription_status,
      subscription_expires_at: row.subscription_expires_at,
      max_devices: Number(row.max_devices) || 0,
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, company] = await Promise.all([api.get<Catalogue>('/catalogues'), api.get<any>('/company')]);
      setCatalogue(cat);
      hydrate(company);
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Could not load settings' });
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (extra: Record<string, unknown> = {}) => {
    setSaving(true);
    setMsg(null);
    try {
      const body = {
        name, email, supportPhone, website, address, currency, taxPct,
        invoicePrefix, quotePrefix, receiptFooter, termsText,
        logoUrl, businessProfile, invoiceTemplateId, posThemeId,
        posHardware, invoiceSettings,
        ...extra,
      };
      const updated = await api.put<any>('/company', body);
      hydrate(updated);
      setMsg({ kind: 'ok', text: 'Settings saved.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [name, email, supportPhone, website, address, currency, taxPct, invoicePrefix, quotePrefix,
      receiptFooter, termsText, logoUrl, businessProfile, invoiceTemplateId, posThemeId,
      posHardware, invoiceSettings, hydrate]);

  const onPickLogo = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    try {
      const { logoUrl: validated } = await api.post<{ logoUrl: string }>('/company/logo', { dataUrl });
      setLogoUrl(validated);
      setMsg({ kind: 'ok', text: 'Logo ready — remember to save.' });
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Logo rejected' });
    }
  };

  const selectedTemplate = useMemo(
    () => catalogue?.invoiceTemplates?.find((t) => t.id === invoiceTemplateId) ?? null,
    [catalogue, invoiceTemplateId],
  );
  const selectedTheme = useMemo(
    () => catalogue?.posThemes?.find((t) => t.id === posThemeId) ?? null,
    [catalogue, posThemeId],
  );
  const selectedProfile = useMemo(
    () => catalogue?.businessProfiles?.find((p) => p.id === businessProfile) ?? null,
    [catalogue, businessProfile],
  );

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'hardware', label: 'POS Hardware & Layout' },
    { id: 'kds', label: 'Fast Food & KDS' },
    { id: 'invoicing', label: 'Invoicing & Taxes' },
  ];

  if (loading) return <div className="page"><div className="hint">Loading settings…</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Global Settings Hub</h2>
          <p className="page-desc">Company profile, POS hardware, service mode, invoicing &amp; taxes — all in one place.</p>
        </div>
        <button className="btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {msg && (
        <div className={`form-status ${msg.kind === 'ok' ? 'form-status--success' : 'form-status--error'}`}>{msg.text}</div>
      )}

      <div className="gsh-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`gsh-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── General ─────────────────────────────────────────────── */}
      {tab === 'general' && (
        <>
          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Company name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" />
              </div>
              <div className="auth-field">
                <label>Support email</label>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello@example.com" />
              </div>
              <div className="auth-field">
                <label>Support phone</label>
                <input value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)} placeholder="+263 …" />
              </div>
              <div className="auth-field">
                <label>Website</label>
                <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
              </div>
              <div className="auth-field">
                <label>Address</label>
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city" />
              </div>
              <div className="auth-field">
                <label>Currency</label>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {(catalogue?.currencies ?? [{ code: 'USD', name: 'US Dollar' }, { code: 'ZWG', name: 'Zimbabwe Gold (ZiG)' }, { code: 'ZAR', name: 'South African Rand' }]).map((c) => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Company logo</label>
                <div className="gsh-logo-row">
                  <div className="gsh-logo-preview">
                    {logoUrl ? <img src={logoUrl} alt="Logo" /> : <FiUpload aria-hidden />}
                  </div>
                  <div>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      style={{ display: 'none' }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickLogo(f); e.target.value = ''; }}
                    />
                    <button className="btn-secondary" onClick={() => fileRef.current?.click()}>
                      <FiUpload /> Upload logo
                    </button>
                    <div className="hint">PNG, JPG, WebP or SVG up to 2 MB. Stored with the company profile.</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Plan</label>
                <div className="hint">
                  {plan?.plan_type ?? '—'} · {plan?.subscription_status ?? 'unknown'}
                  {plan?.max_devices ? ` · up to ${plan.max_devices >= 9999 ? 'unlimited' : plan.max_devices} device(s)` : ''}
                </div>
                <button className="btn-secondary" onClick={() => setShowUpgrade(true)}>Upgrade my plan</button>
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── POS Hardware & Layout ───────────────────────────────── */}
      {tab === 'hardware' && (
        <>
          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>ESC/POS thermal printer</label>
                <input
                  value={posHardware.printerName ?? ''}
                  onChange={(e) => setPosHardware({ ...posHardware, printerName: e.target.value })}
                  placeholder="Printer name (e.g. XPrinter XP-80C)"
                />
              </div>
              <div className="auth-field">
                <label>Printer IP (network printers)</label>
                <input
                  value={posHardware.printerIp ?? ''}
                  onChange={(e) => setPosHardware({ ...posHardware, printerIp: e.target.value })}
                  placeholder="192.168.1.50"
                />
              </div>
              <div className="auth-field">
                <label>Paper width</label>
                <select
                  value={posHardware.paperWidth ?? '80mm'}
                  onChange={(e) => setPosHardware({ ...posHardware, paperWidth: e.target.value })}
                >
                  <option value="58mm">58 mm</option>
                  <option value="80mm">80 mm</option>
                </select>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Cash drawer auto-kick</label>
                <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={!!posHardware.drawerKickEnabled}
                    onChange={(e) => setPosHardware({ ...posHardware, drawerKickEnabled: e.target.checked })}
                  />
                  Kick the drawer automatically after cash payments
                </label>
                <div className="hint">
                  ESC/POS pulse (pin 2, timer 0): <code>{DRAWER_KICK_BYTES}</code>
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Barcode scanner</label>
                <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={!!posHardware.scannerEnabled}
                    onChange={(e) => setPosHardware({ ...posHardware, scannerEnabled: e.target.checked })}
                  />
                  Enable barcode scanning at the till
                </label>
              </div>
              <div className="auth-field">
                <label>Prefix (optional)</label>
                <input
                  value={posHardware.scannerPrefix ?? ''}
                  onChange={(e) => setPosHardware({ ...posHardware, scannerPrefix: e.target.value })}
                  placeholder="e.g. SKU:"
                />
              </div>
              <div className="auth-field">
                <label>Suffix / terminator (optional)</label>
                <input
                  value={posHardware.scannerSuffix ?? ''}
                  onChange={(e) => setPosHardware({ ...posHardware, scannerSuffix: e.target.value })}
                  placeholder="e.g. Enter"
                />
              </div>
            </div>
          </section>

          <section className="card">
            <span className="gsh-section-label">POS theme — {selectedTheme?.name ?? `#${posThemeId}`}</span>
            <div className="gsh-grid gsh-theme-grid">
              {(catalogue?.posThemes ?? []).map((t) => (
                <button
                  key={t.id}
                  className={`gsh-theme ${posThemeId === t.id ? 'selected' : ''}`}
                  onClick={() => setPosThemeId(t.id)}
                >
                  <span className="gsh-theme-swatch">
                    <span style={{ background: t.bg }} />
                    <span style={{ background: t.primary }} />
                    <span style={{ background: t.accent }} />
                  </span>
                  <span className="gsh-theme-name">{t.name}</span>
                  <span className="gsh-theme-desc">{t.description}</span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ── Fast Food & KDS ─────────────────────────────────────── */}
      {tab === 'kds' && (
        <>
          <section className="card">
            <span className="gsh-section-label">Business profile</span>
            <div className="gsh-grid gsh-profile-grid">
              {(catalogue?.businessProfiles ?? []).map((p) => (
                <button
                  key={p.id}
                  className={`gsh-profile ${businessProfile === p.id ? 'selected' : ''}`}
                  onClick={() => setBusinessProfile(p.id)}
                >
                  <span className="gsh-profile-title">{p.name}</span>
                  <span className="gsh-profile-desc">{p.description}</span>
                  {p.kind !== 'general' && <span className="gsh-profile-kind">{p.kind === 'qsr' ? 'Quick service' : 'Fine dining'}</span>}
                </button>
              ))}
            </div>
            {selectedProfile && (
              <div className="hint" style={{ marginTop: 14 }}>
                Active mode: <strong>{selectedProfile.name}</strong>. {selectedProfile.kind === 'qsr'
                  ? 'The till will use colour product tiles, modifier popups and KOT routing.'
                  : selectedProfile.kind === 'restaurant'
                    ? 'The till will use an interactive floor plan with table management and bill splitting.'
                    : 'The till will use the standard retail layout.'}
              </div>
            )}
          </section>

          <section className="card">
            <span className="gsh-section-label">Station printer routing</span>
            <div className="hint">
              Kitchen / bar station routing rules and the interactive floor plan are part of <strong>Phase 2</strong> of the
              Fast Food &amp; KDS workstream. The business mode selected above is saved now and drives which layout the
              till loads.
            </div>
          </section>
        </>
      )}

      {/* ── Invoicing & Taxes ───────────────────────────────────── */}
      {tab === 'invoicing' && (
        <>
          <section className="card">
            <div className="auth-form">
              <div className="auth-field">
                <label>Tax rate (%)</label>
                <input
                  type="number" min={0} max={100} step="0.5"
                  value={taxPct}
                  onChange={(e) => setTaxPct(Number(e.target.value) || 0)}
                />
              </div>
              <div className="auth-field">
                <label>Invoice prefix</label>
                <input value={invoicePrefix} onChange={(e) => setInvoicePrefix(e.target.value)} placeholder="INV-" />
              </div>
              <div className="auth-field">
                <label>Quote prefix</label>
                <input value={quotePrefix} onChange={(e) => setQuotePrefix(e.target.value)} placeholder="QUO-" />
              </div>
              <div className="auth-field">
                <label>Receipt footer</label>
                <input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} placeholder="Thank you for your business!" />
              </div>
              <div className="auth-field">
                <label>Terms &amp; conditions</label>
                <textarea rows={3} value={termsText} onChange={(e) => setTermsText(e.target.value)} placeholder="Payment terms, warranty…" />
              </div>
            </div>
          </section>

          <section className="card">
            <span className="gsh-section-label">Bank remittance details</span>
            <div className="auth-form">
              <div className="auth-field">
                <label>Bank name</label>
                <input value={invoiceSettings.bankName ?? ''} onChange={(e) => setInvoiceSettings({ ...invoiceSettings, bankName: e.target.value })} />
              </div>
              <div className="auth-field">
                <label>Account name</label>
                <input value={invoiceSettings.bankAccountName ?? ''} onChange={(e) => setInvoiceSettings({ ...invoiceSettings, bankAccountName: e.target.value })} />
              </div>
              <div className="auth-field">
                <label>Account number</label>
                <input value={invoiceSettings.bankAccount ?? ''} onChange={(e) => setInvoiceSettings({ ...invoiceSettings, bankAccount: e.target.value })} />
              </div>
              <div className="auth-field">
                <label>SWIFT / branch code</label>
                <input value={invoiceSettings.swiftCode ?? ''} onChange={(e) => setInvoiceSettings({ ...invoiceSettings, swiftCode: e.target.value })} />
              </div>
              <div className="auth-field">
                <label>Tax / VAT number</label>
                <input value={invoiceSettings.taxNumber ?? ''} onChange={(e) => setInvoiceSettings({ ...invoiceSettings, taxNumber: e.target.value })} />
              </div>
            </div>
          </section>

          <section className="card">
            <span className="gsh-section-label">Invoice template — {selectedTemplate?.name ?? `#${invoiceTemplateId}`}</span>
            <div className="gsh-grid gsh-tpl-grid">
              {(catalogue?.invoiceTemplates ?? []).map((t) => (
                <button
                  key={t.id}
                  className={`gsh-tpl ${invoiceTemplateId === t.id ? 'selected' : ''}`}
                  onClick={() => setInvoiceTemplateId(t.id)}
                >
                  <span className="gsh-tpl-mini">
                    <span className="gsh-tpl-mini-head" style={{ background: t.accentColor }} />
                    <span className="gsh-tpl-mini-body">
                      <i /><i className="short" /><i /><i className="short" /><i className="total" />
                    </span>
                  </span>
                  <span className="gsh-tpl-name">{t.name}</span>
                  <span className="gsh-tpl-meta">{t.layout}</span>
                </button>
              ))}
            </div>

            {selectedTemplate && (
              <div style={{ marginTop: 18 }}>
                <span className="gsh-section-label">Live preview</span>
                <div className="gsh-preview">
                  <div className="gsh-preview-head" style={{ background: selectedTemplate.accentColor }}>
                    <h4>{name || 'Your Company'}</h4>
                    <p>{invoicePrefix}100247 · {new Date().toLocaleDateString()}</p>
                  </div>
                  <div className="gsh-preview-body">
                    <div className="gsh-preview-row"><span>2 × Coffee beans 1kg</span><span>$18.00</span></div>
                    <div className="gsh-preview-row"><span>1 × Espresso machine</span><span>$240.00</span></div>
                    <div className="gsh-preview-row"><span>Subtotal</span><span>$258.00</span></div>
                    <div className="gsh-preview-row"><span>Tax ({taxPct}%)</span><span>${((258 * taxPct) / 100).toFixed(2)}</span></div>
                    <div className="gsh-preview-total"><span>Total</span><span>${(258 + (258 * taxPct) / 100).toFixed(2)}</span></div>
                  </div>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {showUpgrade && (
        <UpgradeModal
          tiers={catalogue?.planTiers ?? []}
          currentPlan={plan?.plan_type ?? null}
          onClose={() => setShowUpgrade(false)}
          onUpgraded={() => { setShowUpgrade(false); void load(); }}
        />
      )}
    </div>
  );
}

/* ── Upgrade modal (ported from pos/src/components/UpgradeModal.tsx, admin edition:
   Bearer-token client, no QR dependency — opens the Pesepay hosted page.) ── */
function UpgradeModal({ tiers, currentPlan, onClose, onUpgraded }: {
  tiers: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>;
  currentPlan: string | null;
  onClose: () => void;
  onUpgraded: () => void;
}) {
  const [tier, setTier] = useState(() => {
    const idx = tiers.findIndex((t) => t.id === currentPlan);
    return idx >= 0 ? tiers[Math.min(idx + 1, tiers.length - 1)].id : (tiers[1]?.id ?? tiers[0]?.id ?? '');
  });
  const [currencyCode, setCurrencyCode] = useState<'USD' | 'ZiG'>('USD');
  const [rail, setRail] = useState('ecocash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const pollRef = useRef<number | null>(null);
  const notified = useRef(false);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (!redirectUrl) return;
    const started = Date.now();
    pollRef.current = window.setInterval(() => {
      if (Date.now() - started > 180_000) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      subscriptionApi.get<any>('/plans').then((fresh) => {
        if (fresh?.current?.plan_type === tier && !notified.current) {
          notified.current = true;
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          onUpgraded();
        }
      }).catch(() => { /* transient */ });
    }, 8000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); pollRef.current = null; };
  }, [redirectUrl, tier, onUpgraded]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const s = await subscriptionApi.post<any>('/checkout', { tier, currencyCode, paymentMethod: rail });
      setRedirectUrl(s.redirectUrl ?? null);
      setReference(s.reference ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Upgrade my plan" wide>
      {!redirectUrl ? (
        <>
          <div className="gsh-tier-grid">
            {tiers.map((t) => (
              <button key={t.id} className={`gsh-tier ${tier === t.id ? 'selected' : ''}`} onClick={() => setTier(t.id)}>
                {currentPlan === t.id && <span className="gsh-tier-current">CURRENT</span>}
                <span className="gsh-tier-name">{t.name}</span>
                <span className="gsh-tier-price">${t.price}<small>/mo</small></span>
                <span className="gsh-tier-devices">{t.devices >= 9999 ? 'Unlimited devices' : `${t.devices} device(s)`}</span>
              </button>
            ))}
          </div>
          <div className="auth-field">
            <label>Pay with</label>
            <div className="method-tabs" style={{ display: 'flex', gap: 6 }}>
              {RAILS.map((r) => (
                <button key={r.key} className={`btn-secondary ${rail === r.key ? 'active' : ''}`} onClick={() => setRail(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="auth-field">
            <label>Currency</label>
            <div className="method-tabs" style={{ display: 'flex', gap: 6 }}>
              {(['USD', 'ZiG'] as const).map((c) => (
                <button key={c} className={`btn-secondary ${currencyCode === c ? 'active' : ''}`} onClick={() => setCurrencyCode(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          {error && <div className="form-status form-status--error">{error}</div>}
          <button className="btn-primary" disabled={busy || tiers.length === 0} onClick={() => void start()}>
            {busy ? 'Starting checkout…' : 'Pay with Pesepay'}
          </button>
        </>
      ) : (
        <>
          <div className="hint">Scan the QR on your phone or open the Pesepay payment page to complete payment.</div>
          {reference && <div className="hint">Reference: {reference}</div>}
          <button className="btn-primary" onClick={() => window.open(redirectUrl, '_blank', 'noopener')}>
            <FiExternalLink /> Open payment page
          </button>
          <div className="hint" style={{ marginTop: 8 }}>This page watches for confirmation automatically.</div>
        </>
      )}
    </Modal>
  );
}
