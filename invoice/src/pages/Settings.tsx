import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken, type Catalog, type Company } from '../api';
import UpgradeModal from '../components/UpgradeModal';
import { mergePlanTiers } from '../plans';
import '../settings.css';

/**
 * Workspace configuration hub.
 *
 * Five tabs, one save path: identity, numbering, tax, payment rails and role
 * access all land in `companies.invoice_settings` (the CEO also writes the
 * canonical company columns). The palette is intentionally violet-on-glass so
 * this surface reads as the control room, not another invoice list.
 */

type TabKey = 'company' | 'numbering' | 'tax' | 'payments' | 'billing' | 'team';
type RoleKey = 'CEO' | 'Staff' | 'Cashier';
type SettingsIconName =
  | 'building'
  | 'hash'
  | 'percent'
  | 'card'
  | 'team'
  | 'gear'
  | 'lock'
  | 'info'
  | 'spark';

interface NumberingRule {
  prefix: string;
  next: number;
}

interface PaymentConfig {
  pesepay: boolean;
  ecocash: boolean;
  omari: boolean;
  innbucks: boolean;
  autoSaveLedger: boolean;
  autoReconcile: boolean;
}

type InvoiceConfig = {
  branding?: {
    taxId?: string;
    registrationNumber?: string;
  };
  taxLabel?: string;
  taxPct?: number;
  taxInclusive?: boolean;
  roundTotals?: boolean;
  numbering?: Record<string, NumberingRule>;
  payments?: Partial<PaymentConfig>;
  roles?: Partial<Record<RoleKey, string[]>>;
};

interface TeamMember {
  id: string;
  full_name: string;
  email?: string | null;
  role: string;
  approved?: boolean;
  has_pin?: boolean;
}

const CURRENCIES = ['USD', 'ZWG', 'ZiG', 'ZAR', 'GBP', 'EUR'];

const TABS: Array<{ key: TabKey; label: string; icon: SettingsIconName; caption: string }> = [
  { key: 'company', label: 'Company & Branding', icon: 'building', caption: 'Legal identity, logo and contacts' },
  { key: 'numbering', label: 'Document Prefixes', icon: 'hash', caption: 'Prefixes and next document numbers' },
  { key: 'tax', label: 'Taxes & Currency', icon: 'percent', caption: 'Ledger currency and VAT defaults' },
  { key: 'payments', label: 'Payment Rails', icon: 'card', caption: 'Pesepay, mobile money and auto-ledger' },
  { key: 'billing', label: 'Upgrade & Billing', icon: 'spark', caption: 'POS / invoicing subscription tiers' },
  { key: 'team', label: 'Team & Roles', icon: 'team', caption: 'Permissions for CEO, Staff and Cashier' },
];

/** Inline icons keep the tabs crisp without depending on an emoji font. */
const SETTINGS_ICONS: Record<SettingsIconName, ReactNode> = {
  building: (
    <>
      <path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V20" />
      <path d="M9 8h1M9 12h1M9 16h1M15 9h3.5A1.5 1.5 0 0 1 20 10.5V20" />
      <path d="M3 20h18" />
    </>
  ),
  hash: <path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16" />,
  percent: (
    <>
      <path d="m5 19 14-14" />
      <circle cx="7" cy="7" r="2.2" />
      <circle cx="17" cy="17" r="2.2" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 14.5h4" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8" />
      <path d="M17 19a5.2 5.2 0 0 0-2-4.1" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.2a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H4a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 5.65 7.8a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 8.08 3.04l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.03-1.56V2a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V8a1.7 1.7 0 0 0 1.56 1.03H22a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m6.5 6.5 2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
      <circle cx="12" cy="12" r="2.4" />
    </>
  ),
};

function SettingsIcon({ name, className }: { name: SettingsIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {SETTINGS_ICONS[name]}
    </svg>
  );
}

const NUMBERING_ROWS: Array<{ key: string; label: string; sample: string; hint: string }> = [
  { key: 'invoice', label: 'Invoice', sample: 'INV-0042', hint: 'Standard sales invoice' },
  { key: 'tax_invoice', label: 'Tax invoice', sample: 'TAX-0042', hint: 'VAT / fiscal invoice' },
  { key: 'quote', label: 'Quotation', sample: 'QUO-0042', hint: 'Estimates and quotes' },
  { key: 'receipt', label: 'Receipt', sample: 'RCP-0042', hint: 'Point-of-sale receipt' },
];

const DEFAULT_NUMBERING: Record<string, NumberingRule> = {
  invoice: { prefix: 'INV-', next: 42 },
  tax_invoice: { prefix: 'TAX-', next: 42 },
  quote: { prefix: 'QUO-', next: 42 },
  receipt: { prefix: 'RCP-', next: 42 },
};

const DEFAULT_PAYMENTS: PaymentConfig = {
  pesepay: true,
  ecocash: true,
  omari: true,
  innbucks: true,
  autoSaveLedger: true,
  autoReconcile: true,
};

const PERMISSIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'documents', label: 'Create & issue documents', hint: 'Quotes, invoices, credit notes and receipts' },
  { key: 'payments', label: 'Record payments', hint: 'Cash, card, EcoCash, O’mari and InnBucks' },
  { key: 'refunds', label: 'Voids & refunds', hint: 'Reverse a document or return money to a customer' },
  { key: 'customers', label: 'Manage customers', hint: 'Edit billing details and contact records' },
  { key: 'reports', label: 'Reports & AR aging', hint: 'See outstanding balances and sales summaries' },
  { key: 'settings', label: 'Change workspace settings', hint: 'Tax, numbering, rails and branding' },
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const DEFAULT_ROLES: Record<RoleKey, string[]> = {
  CEO: ALL_PERMISSION_KEYS,
  Staff: ['documents', 'payments', 'customers', 'reports'],
  Cashier: ['documents', 'payments'],
};

const ROLE_ORDER = ['CEO', 'Manager', 'Staff', 'Cashier'];

function readConfig(company: Company): InvoiceConfig {
  const raw = (company.invoice_settings ?? {}) as InvoiceConfig;
  const numbering = { ...DEFAULT_NUMBERING };
  for (const key of Object.keys(DEFAULT_NUMBERING)) {
    const found = raw.numbering?.[key];
    if (found) {
      numbering[key] = {
        prefix: String(found.prefix ?? DEFAULT_NUMBERING[key].prefix).toUpperCase(),
        next: Number(found.next) > 0 ? Math.floor(Number(found.next)) : DEFAULT_NUMBERING[key].next,
      };
    }
  }
  return {
    branding: {
      taxId: raw.branding?.taxId ?? '',
      registrationNumber: raw.branding?.registrationNumber ?? '',
    },
    taxLabel: raw.taxLabel || 'VAT',
    taxPct:
      typeof raw.taxPct === 'number'
        ? raw.taxPct
        : Number(company.tax_pct) > 0
          ? Number(company.tax_pct)
          : 15.5,
    taxInclusive: raw.taxInclusive ?? true,
    roundTotals: raw.roundTotals ?? false,
    numbering,
    payments: { ...DEFAULT_PAYMENTS, ...(raw.payments ?? {}) },
    roles: {
      CEO: ALL_PERMISSION_KEYS,
      Staff: raw.roles?.Staff ?? DEFAULT_ROLES.Staff,
      Cashier: raw.roles?.Cashier ?? DEFAULT_ROLES.Cashier,
    },
  };
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function initials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : clean.slice(0, 2)).toUpperCase();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  hint?: string;
}) {
  return (
    <label className={`settings-toggle${disabled ? ' is-disabled' : ''}`}>
      <span className="settings-toggle-copy">
        <span className="settings-toggle-label">{label}</span>
        {hint && <span className="settings-toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="settings-switch" aria-hidden>
        <span />
      </span>
    </label>
  );
}

export interface SettingsPageProps {
  catalog: Catalog;
  onCatalog: (next: Catalog) => void;
  /** Deep link to a specific tab (used by previews and future query routes). */
  initialTab?: TabKey;
  /** Existing template/theme designer, rendered inside Company & Branding. */
  documentDesign?: ReactNode;
}

export default function SettingsPage({
  catalog,
  onCatalog,
  initialTab = 'company',
  documentDesign,
}: SettingsPageProps) {
  const company = catalog.company;
  const initial = useMemo(() => readConfig(company), [company]);

  const [tab, setTab] = useState<TabKey>(initialTab);
  const [role, setRole] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [billing, setBilling] = useState<{
    plan_type: string;
    max_devices: number;
    subscription_status: string;
    subscription_expires_at: string | null;
  } | null>(null);
  const [billingErr, setBillingErr] = useState('');

  const [legalName, setLegalName] = useState(company.name ?? '');
  const [address, setAddress] = useState(company.address ?? '');
  const [taxId, setTaxId] = useState(initial.branding?.taxId ?? '');
  const [registrationNumber, setRegistrationNumber] = useState(initial.branding?.registrationNumber ?? '');
  const [email, setEmail] = useState(company.email ?? '');
  const [phone, setPhone] = useState(company.support_phone ?? '');
  const [website, setWebsite] = useState(company.website ?? '');
  const [logoUrl, setLogoUrl] = useState(company.logo_url ?? '');
  const [uploading, setUploading] = useState(false);

  const [currency, setCurrency] = useState(company.currency || 'USD');
  const [taxPct, setTaxPct] = useState(String(initial.taxPct ?? 15.5));
  const [taxLabel, setTaxLabel] = useState(initial.taxLabel || 'VAT');
  const [taxInclusive, setTaxInclusive] = useState(initial.taxInclusive ?? true);
  const [roundTotals, setRoundTotals] = useState(initial.roundTotals ?? false);

  const [numbering, setNumbering] = useState<Record<string, NumberingRule>>({ ...DEFAULT_NUMBERING, ...initial.numbering });
  const [payments, setPayments] = useState<PaymentConfig>({ ...DEFAULT_PAYMENTS, ...(initial.payments ?? {}) });
  const [roles, setRoles] = useState<Record<RoleKey, string[]>>({
    CEO: ALL_PERMISSION_KEYS,
    Staff: initial.roles?.Staff ?? DEFAULT_ROLES.Staff,
    Cashier: initial.roles?.Cashier ?? DEFAULT_ROLES.Cashier,
  });

  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const normalizedRole = (role ?? '').toUpperCase();
  const isCeo = normalizedRole === 'CEO';
  const isManager = isCeo || normalizedRole === 'MANAGER';

  // Identify the session so CEO-only fields can be locked without a second
  // permissions endpoint. `/me` also works through the wildcard SSO cookie.
  useEffect(() => {
    let alive = true;
    const token = getToken();
    fetch('/api/admin/auth/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (alive) setRole(typeof data?.role === 'string' ? data.role : null);
      })
      .catch(() => {
        if (alive) setRole('');
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (tab !== 'team' || team !== null || !isManager) return;
    let alive = true;
    setTeamLoading(true);
    setTeamError(null);
    api
      .get<TeamMember[]>('/api/pos/cashiers')
      .then((rows) => {
        if (alive) setTeam(rows);
      })
      .catch((err) => {
        if (alive) setTeamError(errorText(err));
      })
      .finally(() => {
        if (alive) setTeamLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, team, isManager]);

  useEffect(() => {
    if (tab !== 'billing') return;
    let alive = true;
    api
      .get<{
        current: {
          plan_type: string;
          max_devices: number;
          subscription_status: string;
          subscription_expires_at: string | null;
        } | null;
        tiers: Array<{ id: string; name: string; price: number; devices: number; tagline: string }>;
      }>('/api/subscription/plans')
      .then((res) => {
        if (!alive) return;
        setBilling(res.current);
        setBillingErr('');
      })
      .catch((err) => {
        if (alive) setBillingErr(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [tab, showUpgrade]);

  const taxValue = Number(taxPct) || 0;
  const sampleSubtotal = 1000;
  const sampleTax = !taxInclusive
    ? sampleSubtotal * (taxValue / 100)
    : sampleSubtotal - sampleSubtotal / (1 + taxValue / 100);
  const sampleTotal = taxInclusive ? sampleSubtotal : sampleSubtotal + sampleTax;

  const groupedTeam = useMemo(() => {
    const source = team ?? [];
    const rolesPresent = ROLE_ORDER.filter((r) => source.some((m) => m.role === r));
    const extra = Array.from(new Set(source.map((m) => m.role))).filter((r) => !ROLE_ORDER.includes(r));
    return [...rolesPresent, ...extra].map((roleName) => ({
      role: roleName,
      members: source.filter((m) => m.role === roleName),
    }));
  }, [team]);

  const readSettings = useCallback((): InvoiceConfig => {
    return {
      branding: { taxId: taxId.trim(), registrationNumber: registrationNumber.trim() },
      taxLabel: taxLabel.trim() || 'VAT',
      taxPct: taxValue,
      taxInclusive,
      roundTotals,
      numbering,
      payments,
      roles,
    };
  }, [taxId, registrationNumber, taxLabel, taxValue, taxInclusive, roundTotals, numbering, payments, roles]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    const settings = readSettings();
    try {
      if (isCeo) {
        const saved = await api.put<Company>('/api/admin/company', {
          name: legalName.trim() || company.name,
          address: address.trim(),
          email: email.trim(),
          supportPhone: phone.trim(),
          website: website.trim(),
          currency,
          taxPct: taxValue,
          invoicePrefix: (numbering.invoice?.prefix ?? 'INV-').replace(/-+$/, '') || 'INV',
          quotePrefix: (numbering.quote?.prefix ?? 'QUO-').replace(/-+$/, '') || 'QUO',
          invoiceSettings: settings,
        });
        onCatalog({ ...catalog, company: { ...company, ...saved, invoice_settings: settings } });
        setNotice({ kind: 'ok', text: 'Company profile, tax and payment configuration saved.' });
      } else {
        const saved = await api.patch<Company>('/api/pos/invoice-settings', {
          currency,
          taxPct: taxValue,
          settings,
        });
        onCatalog({ ...catalog, company: { ...company, ...saved, invoice_settings: settings } });
        setNotice({ kind: 'ok', text: 'Workspace settings saved. Legal company details are CEO-only.' });
      }
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    const fresh = readConfig(company);
    setLegalName(company.name ?? '');
    setAddress(company.address ?? '');
    setTaxId(fresh.branding?.taxId ?? '');
    setRegistrationNumber(fresh.branding?.registrationNumber ?? '');
    setEmail(company.email ?? '');
    setPhone(company.support_phone ?? '');
    setWebsite(company.website ?? '');
    setLogoUrl(company.logo_url ?? '');
    setCurrency(company.currency || 'USD');
    setTaxPct(String(fresh.taxPct ?? 15.5));
    setTaxLabel(fresh.taxLabel || 'VAT');
    setTaxInclusive(fresh.taxInclusive ?? true);
    setRoundTotals(fresh.roundTotals ?? false);
    setNumbering({ ...DEFAULT_NUMBERING, ...fresh.numbering });
    setPayments({ ...DEFAULT_PAYMENTS, ...(fresh.payments ?? {}) });
    setRoles({
      CEO: ALL_PERMISSION_KEYS,
      Staff: fresh.roles?.Staff ?? DEFAULT_ROLES.Staff,
      Cashier: fresh.roles?.Cashier ?? DEFAULT_ROLES.Cashier,
    });
    setNotice(null);
  };

  const uploadLogo = (file: File) => {
    setNotice(null);
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setNotice({ kind: 'error', text: 'Logo must be a PNG, JPEG or WebP image.' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setNotice({ kind: 'error', text: 'Logo must be 2 MB or smaller.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      setUploading(true);
      try {
        const res = await api.post<{ logoUrl: string }>('/api/admin/company/logo', {
          dataUrl: String(reader.result),
        });
        setLogoUrl(res.logoUrl);
        onCatalog({ ...catalog, company: { ...company, logo_url: res.logoUrl } });
        setNotice({ kind: 'ok', text: 'Logo saved. It appears on every invoice, quote and receipt.' });
      } catch (err) {
        setNotice({ kind: 'error', text: errorText(err) });
      } finally {
        setUploading(false);
      }
    };
    reader.onerror = () => {
      setNotice({ kind: 'error', text: 'Could not read that file.' });
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const setNumber = (key: string, patch: Partial<NumberingRule>) => {
    setNumbering((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] ?? DEFAULT_NUMBERING[key] ?? { prefix: 'DOC-', next: 1 }),
        ...patch,
      },
    }));
  };

  const togglePayment = (key: keyof PaymentConfig, next: boolean) => {
    setPayments((prev) => ({ ...prev, [key]: next }));
  };

  const togglePermission = (roleKey: RoleKey, permission: string) => {
    if (!isCeo || roleKey === 'CEO') return;
    setRoles((prev) => {
      const current = new Set(prev[roleKey]);
      if (current.has(permission)) current.delete(permission);
      else current.add(permission);
      return { ...prev, [roleKey]: ALL_PERMISSION_KEYS.filter((key) => current.has(key)) };
    });
  };

  const enabledRails = [
    payments.ecocash && 'EcoCash',
    payments.omari && 'O’mari',
    payments.innbucks && 'InnBucks',
  ].filter(Boolean) as string[];

  return (
    <div className="settings-page">
      <section className="settings-hero">
        <div className="settings-hero-mark" aria-hidden>
          <SettingsIcon name="gear" />
        </div>
        <div className="settings-hero-copy">
          <span className="settings-eyebrow">Workspace configuration</span>
          <h2>Settings &amp; branding</h2>
          <p>
            One source of truth for the company identity, document numbering, tax defaults, payment
            rails and role access across every Preyone invoice surface.
          </p>
        </div>
        <div className="settings-hero-chips" aria-label="Current configuration">
          <span className="settings-chip">{currency} ledger</span>
          <span className="settings-chip">{taxValue}% {taxLabel || 'VAT'}</span>
          <span className="settings-chip">{enabledRails.length || 'No'} rails live</span>
        </div>
      </section>

      {notice && <div className={`banner ${notice.kind === 'ok' ? 'ok' : 'error'}`}>{notice.text}</div>}

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`settings-tab-${item.key}`}
              aria-selected={active}
              aria-controls={`settings-panel-${item.key}`}
              className={`settings-tab${active ? ' is-active' : ''}`}
              onClick={() => setTab(item.key)}
              title={item.caption}
            >
              <span className="settings-tab-icon" aria-hidden>
                <SettingsIcon name={item.icon} />
              </span>
              <span className="settings-tab-copy">
                <span className="settings-tab-label">{item.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      {tab === 'company' && (
        <section
          className="settings-panel"
          id="settings-panel-company"
          role="tabpanel"
          aria-labelledby="settings-tab-company"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">01 · Identity</span>
            <h3>Company &amp; branding</h3>
            <p>What customers see on every document, receipt and payment request.</p>
          </header>

          {role !== null && !isCeo && (
            <div className="settings-lock">
              <SettingsIcon name="lock" className="settings-lock-icon" />
              Legal company details are locked to the CEO. You can still update tax, numbering,
              payment rails and branding assets.
            </div>
          )}

          <div className="settings-company-grid">
            <div className="settings-fields">
              <label className="settings-field settings-field--wide">
                <span>Legal name</span>
                <input
                  className="input"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="Preyone Technologies (Pvt) Ltd"
                />
              </label>

              <label className="settings-field settings-field--wide">
                <span>Business address</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder={'14 Borrowdale Road\nHarare, Zimbabwe'}
                />
              </label>

              <label className="settings-field">
                <span>Tax / VAT ID</span>
                <input
                  className="input"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="VAT-123456789"
                />
              </label>

              <label className="settings-field">
                <span>Company registration</span>
                <input
                  className="input"
                  value={registrationNumber}
                  onChange={(e) => setRegistrationNumber(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="CR-1234/2024"
                />
              </label>

              <label className="settings-field">
                <span>Billing email</span>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="accounts@company.com"
                />
              </label>

              <label className="settings-field">
                <span>Support phone</span>
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="+263 77 000 0000"
                />
              </label>

              <label className="settings-field settings-field--wide">
                <span>Website</span>
                <input
                  className="input"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  disabled={role !== null && !isCeo}
                  placeholder="https://preyone.com"
                />
              </label>
            </div>

            <aside className="settings-logo-card">
              <div className="settings-logo-frame">
                {logoUrl ? (
                  <img src={logoUrl} alt="Company logo" />
                ) : (
                  <span className="settings-logo-fallback" aria-hidden>{initials(legalName) || 'P'}</span>
                )}
                <span className="settings-logo-ratio">16 : 7</span>
              </div>
              <div className="settings-logo-copy">
                <strong>Company logo</strong>
                <p>Aspect-ratio locked at 16:7. The image is contained, never stretched.</p>
              </div>
              <div className="settings-logo-actions">
                <button
                  className="btn"
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={(role !== null && !isManager) || uploading}
                >
                  {uploading ? 'Uploading…' : 'Upload logo'}
                </button>
                <span className="settings-hint">PNG, JPEG or WebP · max 2 MB</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadLogo(file);
                  e.target.value = '';
                }}
              />
            </aside>
          </div>

          {documentDesign && isManager && (
            <div className="settings-design">
              <header className="settings-section-head settings-section-head--sub">
                <span className="settings-eyebrow">Document design</span>
                <h3>Templates &amp; workspace theme</h3>
                <p>Choose the A4 finish and the palette every Preyone surface shares.</p>
              </header>
              {documentDesign}
            </div>
          )}

          {documentDesign && role !== null && !isManager && (
            <div className="settings-lock settings-lock--spaced">
              <SettingsIcon name="lock" className="settings-lock-icon" />
              Document templates and workspace themes can only be changed by a CEO or Manager.
            </div>
          )}
        </section>
      )}

      {tab === 'numbering' && (
        <section
          className="settings-panel"
          id="settings-panel-numbering"
          role="tabpanel"
          aria-labelledby="settings-tab-numbering"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">02 · Numbering</span>
            <h3>Document prefixes</h3>
            <p>Set the prefix and the next serial for each document family. Issued numbers never change.</p>
          </header>

          <div className="settings-numbering">
            {NUMBERING_ROWS.map((row) => {
              const rule = numbering[row.key] ?? DEFAULT_NUMBERING[row.key];
              const preview = `${rule.prefix}${String(rule.next).padStart(4, '0')}`;
              return (
                <div className="settings-number-row" key={row.key}>
                  <div className="settings-number-id">
                    <span className="settings-number-glyph" aria-hidden>{row.label.slice(0, 3).toUpperCase()}</span>
                    <div>
                      <strong>{row.label}</strong>
                      <small>{row.hint}</small>
                    </div>
                  </div>
                  <label className="settings-field settings-field--compact">
                    <span>Prefix</span>
                    <input
                      className="input"
                      value={rule.prefix}
                      maxLength={8}
                      disabled={role !== null && !isManager}
                      onChange={(e) => setNumber(row.key, { prefix: e.target.value.toUpperCase() })}
                      aria-label={`${row.label} prefix`}
                    />
                  </label>
                  <label className="settings-field settings-field--compact">
                    <span>Next number</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      step={1}
                      value={rule.next}
                      disabled={role !== null && !isManager}
                      onChange={(e) => setNumber(row.key, { next: Math.max(1, Number(e.target.value) || 1) })}
                      aria-label={`${row.label} next number`}
                    />
                  </label>
                  <span className="settings-number-preview" title="Next document number">{preview}</span>
                </div>
              );
            })}
          </div>

          <div className="settings-note">
            <SettingsIcon name="info" className="settings-lock-icon" />
            The next number is only a starting point — the API always checks the live sequence before
            issuing a document, so two cashiers can never mint the same number.
          </div>
        </section>
      )}

      {tab === 'tax' && (
        <section
          className="settings-panel"
          id="settings-panel-tax"
          role="tabpanel"
          aria-labelledby="settings-tab-tax"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">03 · Money</span>
            <h3>Taxes &amp; currency</h3>
            <p>Ledger currency, default tax treatment and rounding for every new line item.</p>
          </header>

          <div className="settings-tax-grid">
            <div className="settings-fields">
              <label className="settings-field">
                <span>Default currency</span>
                <select
                  className="select"
                  value={currency}
                  disabled={role !== null && !isManager}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {CURRENCIES.map((code) => (
                    <option key={code} value={code}>{code}</option>
                  ))}
                </select>
              </label>

              <label className="settings-field">
                <span>Tax label</span>
                <select
                  className="select"
                  value={taxLabel}
                  disabled={role !== null && !isManager}
                  onChange={(e) => setTaxLabel(e.target.value)}
                >
                  {['VAT', 'GST', 'Sales tax', 'None'].map((label) => (
                    <option key={label} value={label}>{label}</option>
                  ))}
                </select>
              </label>

              <label className="settings-field">
                <span>Default tax %</span>
                <div className="settings-input-suffix">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={0.01}
                    value={taxPct}
                    disabled={role !== null && !isManager}
                    onChange={(e) => setTaxPct(e.target.value)}
                  />
                  <span>%</span>
                </div>
              </label>

              <div className="settings-field">
                <span>Tax basis</span>
                <div className="settings-segmented" role="group" aria-label="Tax basis">
                  <button
                    type="button"
                    className={taxInclusive ? 'is-active' : ''}
                    aria-pressed={taxInclusive}
                    disabled={role !== null && !isManager}
                    onClick={() => setTaxInclusive(true)}
                  >
                    Tax inclusive
                  </button>
                  <button
                    type="button"
                    className={!taxInclusive ? 'is-active' : ''}
                    aria-pressed={!taxInclusive}
                    disabled={role !== null && !isManager}
                    onClick={() => setTaxInclusive(false)}
                  >
                    Tax exclusive
                  </button>
                </div>
              </div>
            </div>

            <aside className="settings-tax-preview">
              <span className="settings-eyebrow">Live calculation</span>
              <div className="settings-tax-line">
                <span>Sample subtotal</span>
                <strong>{money(sampleSubtotal, currency)}</strong>
              </div>
              <div className="settings-tax-line">
                <span>{taxLabel || 'VAT'} ({taxValue}%)</span>
                <strong>{money(sampleTax, currency)}</strong>
              </div>
              <div className="settings-tax-line settings-tax-line--total">
                <span>Document total</span>
                <strong>{money(sampleTotal, currency)}</strong>
              </div>
              <p>
                {taxInclusive
                  ? 'Prices already include tax; the tax portion is extracted on the document.'
                  : 'Tax is added on top of the line price at document time.'}
              </p>
            </aside>
          </div>

          <div className="settings-toggle-stack">
            <Toggle
              checked={roundTotals}
              onChange={setRoundTotals}
              label="Round document totals to the nearest cent"
              hint="Recommended for cash-heavy workspaces and multi-currency ledgers."
            />
          </div>
        </section>
      )}

      {tab === 'payments' && (
        <section
          className="settings-panel"
          id="settings-panel-payments"
          role="tabpanel"
          aria-labelledby="settings-tab-payments"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">04 · Settlement</span>
            <h3>Payment rails</h3>
            <p>Choose which Pesepay mobile-money rails appear on customer payment links.</p>
          </header>

          <div className="settings-gateway">
            <div className="settings-gateway-head">
              <div className="settings-gateway-mark" aria-hidden>P</div>
              <div>
                <strong>Pesepay gateway</strong>
                <p>Single integration for EcoCash, O’mari and InnBucks in USD.</p>
              </div>
              <span className={`settings-status ${payments.pesepay ? 'is-live' : 'is-off'}`}>
                {payments.pesepay ? 'Live' : 'Off'}
              </span>
            </div>
            <Toggle
              checked={payments.pesepay}
              onChange={(next) => togglePayment('pesepay', next)}
              label="Enable Pesepay checkout"
              hint="Adds an online payment action to issued invoices and receipts."
              disabled={role !== null && !isManager}
            />
          </div>

          <div className="settings-rails">
            {[
              { key: 'ecocash' as const, name: 'EcoCash', blurb: 'USD wallet · Econet', mark: 'EC' },
              { key: 'omari' as const, name: 'O’mari', blurb: 'USD wallet · Old Mutual', mark: 'OM' },
              { key: 'innbucks' as const, name: 'InnBucks', blurb: 'USD wallet · InnBucks', mark: 'IB' },
            ].map((rail) => (
              <div className={`settings-rail${payments[rail.key] && payments.pesepay ? ' is-live' : ''}`} key={rail.key}>
                <div className="settings-rail-head">
                  <span className="settings-rail-mark" aria-hidden>{rail.mark}</span>
                  <div>
                    <strong>{rail.name} <em>USD</em></strong>
                    <small>{rail.blurb}</small>
                  </div>
                </div>
                <Toggle
                  checked={payments[rail.key]}
                  onChange={(next) => togglePayment(rail.key, next)}
                  label={`Accept ${rail.name}`}
                  disabled={role !== null && (!isManager || !payments.pesepay)}
                />
              </div>
            ))}
          </div>

          <div className="settings-toggle-stack">
            <Toggle
              checked={payments.autoSaveLedger}
              onChange={(next) => togglePayment('autoSaveLedger', next)}
              label="Auto-save ledger entries"
              hint="Write a payment row the moment Pesepay confirms a successful charge."
              disabled={role !== null && !isManager}
            />
            <Toggle
              checked={payments.autoReconcile}
              onChange={(next) => togglePayment('autoReconcile', next)}
              label="Auto-reconcile pending transactions"
              hint="Sweep stale Pesepay checkouts and close the matching document automatically."
              disabled={role !== null && !isManager}
            />
          </div>

          <div className="settings-note">
            <SettingsIcon name="lock" className="settings-lock-icon" />
            Merchant credentials are stored server-side in the Preyone console. This page only
            controls which rails customers can see.
          </div>
        </section>
      )}

      {tab === 'billing' && (
        <section
          className="settings-panel"
          id="settings-panel-billing"
          role="tabpanel"
          aria-labelledby="settings-tab-billing"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">05 · Subscription</span>
            <h3>Upgrade &amp; billing</h3>
            <p>$10 POS Only · $15 / $20 POS + Invoicing · $30 Unlimited — Pesepay checkout.</p>
          </header>

          {billingErr && <div className="banner error">{billingErr}</div>}

          <div className="settings-billing-card">
            <div>
              <div className="settings-billing-name">
                {billing
                  ? mergePlanTiers().find((t) => t.id === billing.plan_type)?.name ?? billing.plan_type
                  : '—'}
              </div>
              <div className="settings-billing-meta">
                <span>{billing?.subscription_status ?? 'unknown'}</span>
                <span>
                  {billing
                    ? billing.max_devices >= 9999
                      ? 'Unlimited devices'
                      : `Up to ${billing.max_devices} devices`
                    : '—'}
                </span>
                <span>
                  Renews{' '}
                  {billing?.subscription_expires_at
                    ? new Date(billing.subscription_expires_at).toLocaleDateString()
                    : '—'}
                </span>
              </div>
            </div>
            <button className="btn primary" type="button" onClick={() => setShowUpgrade(true)}>
              Upgrade my plan
            </button>
          </div>

          <div className="tier-grid static">
            {mergePlanTiers().map((t) => (
              <div key={t.id} className="tier-card">
                <span className="tier-name">{t.name}</span>
                <span className="tier-price">
                  ${t.price}
                  <small>/mo</small>
                </span>
                <span className="tier-devices">
                  {t.devices >= 9999 ? 'Unlimited devices' : `Up to ${t.devices} devices`}
                </span>
                <span className="tier-tag">{t.tagline}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'team' && (
        <section
          className="settings-panel"
          id="settings-panel-team"
          role="tabpanel"
          aria-labelledby="settings-tab-team"
        >
          <header className="settings-section-head">
            <span className="settings-eyebrow">06 · Access</span>
            <h3>Team &amp; roles</h3>
            <p>Capabilities are mapped to the three active invoice roles: CEO, Staff and Cashier.</p>
          </header>

          {role !== null && !isCeo && (
            <div className="settings-lock">
              <SettingsIcon name="lock" className="settings-lock-icon" />
              Only the CEO can change role permissions. You can review the current matrix and team.
            </div>
          )}

          <div className="settings-matrix" role="table" aria-label="Role permission matrix">
            <div className="settings-matrix-head" role="row">
              <span role="columnheader">Capability</span>
              <span role="columnheader">CEO</span>
              <span role="columnheader">Staff</span>
              <span role="columnheader">Cashier</span>
            </div>
            {PERMISSIONS.map((permission) => (
              <div className="settings-matrix-row" role="row" key={permission.key}>
                <span className="settings-perm" role="cell">
                  <strong>{permission.label}</strong>
                  <small>{permission.hint}</small>
                </span>
                {(['CEO', 'Staff', 'Cashier'] as RoleKey[]).map((roleKey) => (
                  <label className="settings-check" role="cell" key={roleKey}>
                    <input
                      type="checkbox"
                      checked={roleKey === 'CEO' ? true : roles[roleKey].includes(permission.key)}
                      disabled={roleKey === 'CEO' || !isCeo}
                      onChange={() => togglePermission(roleKey, permission.key)}
                      aria-label={`${permission.label} for ${roleKey}`}
                    />
                    <span aria-hidden />
                  </label>
                ))}
              </div>
            ))}
          </div>

          <div className="settings-team">
            <div className="settings-team-head">
              <div>
                <h4>Team directory</h4>
                <p>Active accounts with access to this company’s invoicing workspace.</p>
              </div>
              <span className="settings-chip">
                {team
                  ? `${team.length} ${team.length === 1 ? 'person' : 'people'}`
                  : role === null
                    ? 'Syncing…'
                    : isManager
                      ? 'Loading…'
                      : 'Restricted'}
              </span>
            </div>

            {role !== null && !isManager && !teamError && (
              <div className="settings-empty">The team directory is available to CEOs and Managers.</div>
            )}
            {teamLoading && (
              <div className="settings-empty">
                <span className="spinner" aria-hidden /> Loading team…
              </div>
            )}
            {teamError && !teamLoading && <div className="settings-empty is-error">{teamError}</div>}
            {team && !teamLoading && groupedTeam.length === 0 && (
              <div className="settings-empty">No team members returned yet.</div>
            )}

            {team && !teamLoading && groupedTeam.map((group) => (
              <div className="settings-team-group" key={group.role}>
                <span className={`settings-role settings-role--${group.role.toLowerCase()}`}>{group.role}</span>
                <div className="settings-team-list">
                  {group.members.map((member) => (
                    <div className="settings-member" key={member.id}>
                      <span className="settings-member-avatar" aria-hidden>{initials(member.full_name || member.email || '')}</span>
                      <span className="settings-member-copy">
                        <strong>{member.full_name || member.email || 'Unnamed user'}</strong>
                        <small>{member.email || 'No email on file'}</small>
                      </span>
                      <span className={`settings-member-state ${member.approved === false ? 'is-pending' : 'is-active'}`}>
                        {member.approved === false ? 'Pending' : 'Active'}
                      </span>
                      <span className="settings-member-pin" title={member.has_pin ? 'PIN configured' : 'No PIN'}>
                        {member.has_pin ? 'PIN' : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="settings-note">
            <SettingsIcon name="info" className="settings-lock-icon" />
            Add or deactivate teammates from the Preyone console. This tab controls what each role can
            do once they are inside invoicing.
          </div>
        </section>
      )}

      {tab !== 'billing' && (
        <div className="settings-savebar">
          <div className="settings-savebar-copy">
            <strong>{busy ? 'Saving configuration…' : 'Changes apply to new documents'}</strong>
            <span>
              {role !== null && !isManager
                ? 'Saving requires a CEO or Manager account.'
                : 'Existing issued documents keep their original numbering and tax.'}
            </span>
          </div>
          <div className="settings-savebar-actions">
            <button className="btn ghost" type="button" onClick={reset} disabled={busy}>
              Reset
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={() => void save()}
              disabled={busy || (role !== null && !isManager)}
            >
              {busy && <span className="spinner" aria-hidden />}
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}

      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onUpgraded={() => {
            setShowUpgrade(false);
            setNotice({ kind: 'ok', text: 'Plan upgraded — billing will refresh shortly.' });
          }}
        />
      )}
    </div>
  );
}
