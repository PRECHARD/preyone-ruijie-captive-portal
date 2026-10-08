import { useCallback, useEffect, useState } from 'react';
import StarlinkAuth from './StarlinkAuth';
import StarlinkPortal from './StarlinkPortal';
import { getToken, clearToken, sfetch } from './api';
import '../styles/StarlinkPortal.css';

type View = 'checking' | 'auth' | 'portal';

function portalPath(): string {
  // Canonical portal URL — works on starlink.preyone.com, admin.preyone.com
  // and preyone.com (the Express subdomain/path branches all serve the same
  // SPA bundle for these paths).
  return '/starlink/portal';
}

function authPath(): string {
  return '/starlink/auth';
}

function navigate(path: string): void {
  try {
    window.history.pushState({}, '', path);
  } catch {
    /* history unavailable — state-only navigation still works */
  }
}

type Evaluated =
  | { mode: 'auth'; resetToken: string; verified: boolean }
  | { mode: 'portal' };

function evaluateLocation(): Evaluated {
  const params = new URLSearchParams(window.location.search);
  const path = window.location.pathname;

  const mode = params.get('mode');
  const token = params.get('token');
  if (mode === 'reset' && token) return { mode: 'auth', resetToken: token, verified: false };
  if (path.startsWith('/starlink/auth')) {
    return { mode: 'auth', resetToken: '', verified: mode === 'verified' };
  }
  return { mode: 'portal' };
}

/** Strips one-shot query params (?mode=&token=) without a history entry. */
function scrubQuery(): void {
  try {
    const clean = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, '', clean);
  } catch {
    /* ignore */
  }
}

export default function StarlinkApp() {
  const [view, setView] = useState<View>('checking');
  const [resetToken, setResetToken] = useState('');
  const [verified, setVerified] = useState(false);

  const showAuth = useCallback((opts?: { resetToken?: string; verified?: boolean; replace?: boolean }) => {
    setResetToken(opts?.resetToken || '');
    setVerified(!!opts?.verified);
    setView('auth');
    const target = authPath();
    if (window.location.pathname !== target) navigate(target);
    else scrubQuery();
    if (opts?.replace) scrubQuery();
  }, []);

  const showPortal = useCallback(() => {
    setView('portal');
    const target = portalPath();
    if (window.location.pathname !== target) navigate(target);
  }, []);

  /* ── boot: validate the stored session before choosing a view ── */
  useEffect(() => {
    let alive = true;
    (async () => {
      const loc = evaluateLocation();
      const token = getToken();

      if (loc.mode === 'auth') {
        // Deep link: reset link or explicit /starlink/auth — never auto-bounce
        // away from a reset form, but a signed-in user on /auth goes to portal.
        if (!token || !loc.resetToken) {
          if (!alive) return;
          showAuth({ resetToken: loc.resetToken, verified: loc.verified, replace: true });
          return;
        }
      }

      if (!token) {
        if (!alive) return;
        showAuth({ verified: loc.mode === 'auth' ? loc.verified : false });
        return;
      }

      try {
        await sfetch('/auth/me');
        if (!alive) return;
        scrubQuery();
        showPortal();
      } catch {
        if (!alive) return;
        clearToken();
        showAuth({ verified: loc.mode === 'auth' ? loc.verified : false });
      }
    })();
    return () => { alive = false; };
  }, [showAuth, showPortal]);

  /* ── back/forward buttons ── */
  useEffect(() => {
    const onPop = () => {
      const loc = evaluateLocation();
      const token = getToken();
      if (loc.mode === 'auth') {
        setResetToken(loc.resetToken);
        setVerified(loc.verified);
        setView('auth');
      } else if (token) {
        setView('portal');
      } else {
        showAuth();
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [showAuth]);

  /* ── body scroll lock while checking ── */
  useEffect(() => {
    document.title = 'Preyone · Starlink Customer Portal';
  }, []);

  if (view === 'checking') {
    return (
      <div className="sp-root">
        <div className="sp-main" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
          <div className="sp-paying">
            <div className="sp-spinner" />
            <p style={{ color: 'var(--sp-mut)' }}>Connecting to Preyone Starlink…</p>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'auth') {
    return (
      <StarlinkAuth
        resetToken={resetToken}
        verified={verified}
        onAuthed={() => {
          scrubQuery();
          showPortal();
        }}
      />
    );
  }

  return (
    <StarlinkPortal
      onSignOut={() => {
        clearToken();
        showAuth();
      }}
    />
  );
}
