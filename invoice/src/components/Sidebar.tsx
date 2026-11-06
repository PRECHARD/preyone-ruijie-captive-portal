import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { getToken, type Company, type DocType } from '../api';

/**
 * The invoicing workspace rail.
 *
 * Four groups, one mental model: where you are (Workspace), what you are
 * looking at (Document types), what is owed (Financial & ledger) and how the
 * workspace is configured (System & core apps). The document-type list is
 * collapsible and independently scrollable so all twelve types stay reachable
 * without pushing the ledger or app switcher off-screen.
 */

export type View = 'documents' | 'aging' | 'settings';

type IconName =
  | 'docs'
  | 'plus'
  | 'aging'
  | 'wallet'
  | 'ledger'
  | 'settings'
  | 'types'
  | 'chevron'
  | 'pos'
  | 'wifi'
  | 'home'
  | 'external';

const ICONS: Record<IconName, ReactNode> = {
  docs: (
    <>
      <path d="M7.5 3.75h6.25L18 8v11.25a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-14a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M13.75 3.75V8H18" />
      <path d="M9 12.5h6M9 16h6" />
    </>
  ),
  plus: <path d="M12 5.25v13.5M5.25 12h13.5" />,
  aging: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5V9H9" />
      <path d="M12 8.25v4.5l3 1.75" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5Z" />
      <path d="M4 9.75h16" />
      <path d="M15.75 13.5H17" />
    </>
  ),
  ledger: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3h12A1.5 1.5 0 0 1 20 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 19.5Z" />
      <path d="M8.5 3v18" />
      <path d="M12 8.5h4M12 12h4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  types: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5.1a2 2 0 0 1 1.42.59l7.39 7.39a2 2 0 0 1 0 2.83l-5.1 5.1a2 2 0 0 1-2.83 0L4.59 12.6A2 2 0 0 1 4 11.18Z" />
      <circle cx="8.25" cy="8.25" r="1.25" />
    </>
  ),
  chevron: <path d="m6.5 9.25 5.5 5.5 5.5-5.5" />,
  pos: (
    <>
      <path d="M7 8V4.75h10V8" />
      <rect x="4.75" y="8" width="14.5" height="7.5" rx="1.5" />
      <path d="M7 13h10v6.25H7Z" />
      <path d="M16.5 10.5h.01" />
    </>
  ),
  wifi: (
    <>
      <path d="M3.75 9a12.5 12.5 0 0 1 16.5 0" />
      <path d="M6.9 12.45a8.2 8.2 0 0 1 10.2 0" />
      <path d="M10 15.85a4 4 0 0 1 4 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1Z" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/** Lightweight app switcher; every target pre-exists on its own subdomain. */
const CORE_APPS: Array<{ host: string; label: string; icon: IconName }> = [
  { host: 'pos.preyone.com', label: 'POS', icon: 'pos' },
  { host: 'wifi.preyone.com', label: 'WiFi portal', icon: 'wifi' },
  { host: 'homeautomate.preyone.com', label: 'Home automation', icon: 'home' },
];

/**
 * Shape returned by `GET /api/admin/auth/me`. Only the fields the rail needs
 * are modelled; the endpoint also sends permissions, tenant and session data.
 */
interface SessionUser {
  id: string;
  full_name?: string | null;
  email?: string | null;
  role?: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  ceo: 'CEO',
  manager: 'Manager',
  staff: 'Staff',
  cashier: 'Cashier',
};

/** Tones map 1:1 to the `role-badge--*` classes in styles.css. */
function roleTone(role?: string | null): string {
  const key = (role ?? '').toLowerCase();
  return key in ROLE_LABELS ? key : 'staff';
}

function initialsFor(user: SessionUser): string {
  const source = (user.full_name || user.email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** Local tokens the invoice workspace shares with the admin console. */
function clearAuthStorage(): void {
  try {
    localStorage.removeItem('gateway_token');
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
  } catch {
    /* storage can be unavailable in private mode; the cookie still clears */
  }
}

export function Brand({ company }: { company?: Company | null }) {
  const logo = company?.logo_url || (company?.logo_path ? `/images/${company.logo_path}` : null);
  return (
    <div className="brand">
      {logo ? (
        <img className="brand-logo" src={logo} alt={`${company?.name ?? 'Preyone'} logo`} />
      ) : (
        <div className="brand-mark">P</div>
      )}
      <div>
        <div className="brand-name">{company?.name || 'Preyone'}</div>
        <div className="brand-sub">Invoicing</div>
      </div>
    </div>
  );
}

const noop = (): void => {};

export interface SidebarProps {
  company?: Company | null;
  view: View;
  typeFilter: string;
  statusFilter: string;
  types: DocType[];
  onView?: (view: View) => void;
  onAllDocuments?: () => void;
  onType?: (type: string) => void;
  onStatus?: (status: string) => void;
  onNewDocument?: () => void;
}

export default function Sidebar({
  company,
  view,
  typeFilter,
  statusFilter,
  types,
  onView = noop,
  onAllDocuments = noop,
  onType = noop,
  onStatus = noop,
  onNewDocument = noop,
}: SidebarProps) {
  const [typesOpen, setTypesOpen] = useState(true);
  const typesPanelId = useId();

  const [user, setUser] = useState<SessionUser | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  // The rail loads its own identity so it renders in both shells: inside the
  // admin frame (localStorage bearer) and as a standalone invoice tab (wildcard
  // httpOnly cookie). A 401/423 simply hides the card — App owns the lock and
  // login screens.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const token = getToken();

    const load = async () => {
      try {
        const res = await fetch('/api/admin/auth/me', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Session lookup failed (${res.status})`);
        const data = (await res.json()) as SessionUser;
        if (!cancelled) setUser(data?.id ? data : null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);

    // The wildcard SSO cookie is httpOnly, so only the API can clear it. Await
    // the revoke before navigating or the cookie re-authenticates the reload.
    try {
      const token = getToken();
      await fetch('/api/admin/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      /* network failure: local tokens are still dropped below */
    } finally {
      clearAuthStorage();
    }

    window.location.assign('/');
  }, [signingOut]);

  const signedIn = !!user;
  const tone = roleTone(user?.role);
  const displayName = user?.full_name?.trim() || user?.email || 'Signed in';
  const roleLabel = ROLE_LABELS[tone];

  const onDocuments = view === 'documents';
  const allDocumentsActive = onDocuments && typeFilter === 'all' && statusFilter === 'all';
  const outstandingActive = onDocuments && statusFilter === 'unpaid';
  const paidActive = onDocuments && statusFilter === 'paid';
  const agingActive = view === 'aging';
  const settingsActive = view === 'settings';

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <Brand company={company} />

      <nav className="side-nav" aria-label="Invoicing navigation">
        <section className="side-group" aria-label="Workspace">
          <div className="side-group-head">
            <span>Workspace</span>
          </div>
          <button
            type="button"
            className={`nav-item${allDocumentsActive ? ' active' : ''}`}
            aria-current={allDocumentsActive ? 'page' : undefined}
            onClick={onAllDocuments}
          >
            <span className="nav-icon"><Icon name="docs" /></span>
            <span className="nav-text">All documents</span>
          </button>
          <button type="button" className="nav-item nav-cta" onClick={onNewDocument}>
            <span className="nav-icon"><Icon name="plus" /></span>
            <span className="nav-text">New document</span>
          </button>
        </section>

        <section className="side-group side-group--types" aria-label="Document types">
          <button
            type="button"
            className="side-group-head side-group-toggle"
            aria-expanded={typesOpen}
            aria-controls={typesPanelId}
            onClick={() => setTypesOpen((open) => !open)}
          >
            <span className="side-group-name">
              <Icon name="types" />
              Document types
            </span>
            <span className="side-group-meta">
              <span className="side-count">{types.length}</span>
              <Icon name="chevron" className="side-group-chevron" />
            </span>
          </button>

          <div id={typesPanelId} className={`side-collapse${typesOpen ? '' : ' closed'}`}>
            <div className="side-collapse-inner">
              <div className="type-scroll">
                {types.map((t) => {
                  const active = onDocuments && typeFilter === t.type;
                  return (
                    <button
                      key={t.type}
                      type="button"
                      className={`nav-item nav-item--type${active ? ' active' : ''}`}
                      aria-pressed={active}
                      title={t.label}
                      onClick={() => onType(t.type)}
                    >
                      <span className="type-mark">{t.prefix}</span>
                      <span className="nav-text">{t.label}</span>
                      {active && <span className="nav-active-dot" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="side-group" aria-label="Financial and ledger">
          <div className="side-group-head">
            <span>Financial &amp; ledger</span>
          </div>
          <button
            type="button"
            className={`nav-item${outstandingActive ? ' active' : ''}`}
            aria-pressed={outstandingActive}
            onClick={() => onStatus('unpaid')}
          >
            <span className="nav-icon"><Icon name="wallet" /></span>
            <span className="nav-text">Outstanding</span>
          </button>
          <button
            type="button"
            className={`nav-item${paidActive ? ' active' : ''}`}
            aria-pressed={paidActive}
            onClick={() => onStatus('paid')}
          >
            <span className="nav-icon"><Icon name="ledger" /></span>
            <span className="nav-text">Paid ledger</span>
          </button>
          <button
            type="button"
            className={`nav-item${agingActive ? ' active' : ''}`}
            aria-current={agingActive ? 'page' : undefined}
            onClick={() => onView('aging')}
          >
            <span className="nav-icon"><Icon name="aging" /></span>
            <span className="nav-text">AR aging</span>
          </button>
        </section>

        <section className="side-group" aria-label="System and core apps">
          <div className="side-group-head">
            <span>System &amp; core apps</span>
          </div>
          <button
            type="button"
            className={`nav-item${settingsActive ? ' active' : ''}`}
            aria-current={settingsActive ? 'page' : undefined}
            onClick={() => onView('settings')}
          >
            <span className="nav-icon"><Icon name="settings" /></span>
            <span className="nav-text">Templates &amp; theme</span>
          </button>

          <div className="side-apps">
            {CORE_APPS.map((app) => (
              <a
                key={app.host}
                className="app-link"
                href={`https://${app.host}`}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${app.label} (opens in a new tab)`}
                title={app.label}
              >
                <span className="app-icon"><Icon name={app.icon} /></span>
                <span className="app-name">{app.label}</span>
                <Icon name="external" className="ext" />
              </a>
            ))}
          </div>
        </section>
      </nav>

      {profileLoading ? (
        <div className="profile-card profile-card--loading" aria-hidden>
          <span className="profile-avatar profile-skeleton" />
          <span className="profile-lines">
            <span className="skeleton profile-skeleton-line" />
            <span className="skeleton profile-skeleton-line profile-skeleton-line--short" />
          </span>
        </div>
      ) : signedIn ? (
        <div className={`profile-card profile-card--${tone}`}>
          <span className="profile-avatar" aria-hidden>
            {initialsFor(user!)}
          </span>
          <span className="profile-id">
            <span className="profile-name" title={displayName}>
              {displayName}
            </span>
            <span className={`role-badge role-badge--${tone}`}>{roleLabel}</span>
          </span>
          <button
            type="button"
            className="profile-signout"
            onClick={() => void signOut()}
            disabled={signingOut}
            aria-label={`Sign out${user?.full_name ? ` ${user.full_name}` : ''}`}
            title="Sign out"
          >
            <span className="profile-signout-icon" aria-hidden>
              🚪
            </span>
            <span className="profile-signout-text">{signingOut ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      ) : null}

      <div className="sidebar-footer">
        <strong>Preyone Invoicing v3.2</strong>
        <span className="footer-meta">UBL / Peppol ready</span>
      </div>
    </aside>
  );
}
