import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  getToken,
  clearToken,
  logout as apiLogout,
  login as apiLogin,
  verify2fa as apiVerify2fa,
  resend2fa as apiResend2fa,
  unlockSession,
  refreshSession,
  fetchSessionPolicy,
  sessionOutcome,
  subscriptions as fetchSubscriptions,
  type GatewayUser,
  type CompanyProfile,
  type LoginChallenge,
} from './api'
import { company as fetchCompany } from './api'
import {
  ActivityBus,
  formatRemaining,
  INACTIVITY_TIMEOUT_MS,
  MAX_SESSION_LIFETIME_MS,
  INACTIVITY_WARNING_MS,
  REFRESH_MIN_INTERVAL_MS,
  SESSION_EXPIRED_KEY,
} from './sessionPolicy'
import './session.css'

interface Module {
  key: string
  title: string
  desc: string
  prodUrl: string
  devUrl: string
  phase?: string
  hint?: string
}

const MODULES: Module[] = [
  {
    key: 'pos',
    title: 'Preyone POS',
    desc: 'Web terminal — sales, shifts and stock from any browser.',
    prodUrl: '//pos.preyone.com',
    devUrl: 'http://localhost:5174',
    hint: 'LAN',
  },
  {
    key: 'invoice',
    title: 'Invoice & Quotation',
    desc: 'Desktop suite — invoices, quotes and PDF documents.',
    prodUrl: '//invoice.preyone.com',
    devUrl: 'http://localhost:5173',
    phase: 'Desktop',
  },
  {
    key: 'wifi',
    title: 'UltraNet WiFi',
    desc: 'Captive portal, vouchers and network operations.',
    prodUrl: '//wifi.preyone.com',
    devUrl: 'http://localhost:3000',
  },
  {
    key: 'admin',
    title: 'Super Admin',
    desc: 'Internal console — reports, staff, devices and settings.',
    prodUrl: '//admin.preyone.com',
    devUrl: 'http://localhost:5173',
  },
]

function moduleUrl(m: Module): string {
  const host = window.location.hostname
  const isDev = host === 'localhost' || host === '127.0.0.1'
  return isDev ? m.devUrl : m.prodUrl
}

const isAdminAccount = (role: string) => role === 'CEO' || role === 'Manager'

function LoginScreen({
  onLogin,
  onVerify,
}: {
  onLogin: (email: string, password: string) => Promise<LoginChallenge | null>
  onVerify: (challengeToken: string, code: string) => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null)
  const [otp, setOtp] = useState('')
  const [resendIn, setResendIn] = useState(0)

  useEffect(() => {
    if (!challenge || resendIn <= 0) return
    const t = window.setInterval(() => setResendIn((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => window.clearInterval(t)
  }, [challenge, resendIn])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const pending = await onLogin(email, password)
      if (pending) {
        setChallenge(pending)
        setOtp('')
        setResendIn(60)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitOtp(e: FormEvent) {
    e.preventDefault()
    if (!challenge || otp.length !== 6) return
    setBusy(true)
    setError('')
    try {
      await onVerify(challenge.challengeToken, otp)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setError(msg)
      if (/expired|sign in again|no longer active|too many/i.test(msg)) {
        setChallenge(null)
        setOtp('')
      }
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (!challenge || resendIn > 0) return
    setError('')
    try {
      await apiResend2fa(challenge.challengeToken)
      setResendIn(60)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code')
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <span className="login-brow">✦ Secure Gateway</span>
        <img className="login-logo" src="/favicon.svg" alt="Preyone" />
        <h1 className="login-title">Preyone Enterprise</h1>
        <p className="login-tag">Connecting People. Powering Business.</p>

        {challenge ? (
          <form onSubmit={submitOtp}>
            <p className="login-otp-hint">
              We emailed a 6-digit code to <strong>{challenge.maskedEmail}</strong>. It expires in 5 minutes.
            </p>
            <label className="field">
              <span>Verification Code</span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="login-otp"
                autoFocus
                required
              />
            </label>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="login-btn" type="submit" disabled={busy || otp.length !== 6}>
              {busy ? (<><span className="login-spinner" aria-hidden="true" />Verifying…</>) : 'Verify & Sign In'}
            </button>
            <button type="button" className="login-link" onClick={resend} disabled={resendIn > 0}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend Code'}
            </button>
            <button type="button" className="login-link" onClick={() => { setChallenge(null); setOtp(''); setError('') }}>
              Back to Sign In
            </button>
          </form>
        ) : (
          <form onSubmit={submit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@preyone.com"
                required
                autoComplete="username"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <span className="field-pw">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="field-eye"
                  onClick={() => setShowPw((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  {showPw ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  )}
                </button>
              </span>
            </label>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button className="login-btn" type="submit" disabled={busy}>
              {busy ? (<><span className="login-spinner" aria-hidden="true" />Signing in…</>) : 'Sign in'}
            </button>
          </form>
        )}
        <div className="login-foot">One identity · POS · Invoice · WiFi · Admin</div>
      </div>
    </div>
  )
}

/** State A — inactivity lock. Password only; 2FA is not re-triggered. */
function LockOverlay({
  user,
  onUnlock,
  onSignOut,
}: {
  user: GatewayUser | null
  onUnlock: (password: string) => Promise<void>
  onSignOut: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError('')
    try {
      await onUnlock(password)
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock')
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gw-lock" role="dialog" aria-modal="true" aria-labelledby="gw-lock-title">
      <div className="gw-lock-card">
        <img className="gw-lock-logo" src="/favicon.svg" alt="Preyone" />
        <h2 id="gw-lock-title" className="gw-lock-title">Session Locked</h2>
        <p className="gw-lock-sub">
          You were inactive for a while. Enter your password to pick up where you left off.
        </p>
        {user && <div className="gw-lock-identity">{user.fullName || user.email}</div>}
        <form onSubmit={submit}>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              autoFocus
              required
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-btn" type="submit" disabled={busy || !password}>
            {busy ? (<><span className="login-spinner" aria-hidden="true" />Unlocking…</>) : 'Unlock'}
          </button>
        </form>
        <button type="button" className="login-link" onClick={onSignOut}>Sign out instead</button>
      </div>
    </div>
  )
}

function IdleWarning({ msLeft, onStay }: { msLeft: number; onStay: () => void }) {
  return (
    <div className="gw-warning" role="alertdialog" aria-modal="true">
      <div className="gw-warning-card">
        <div className="gw-warning-body">
          <strong>Still there?</strong>
          <span>Your session locks in <b>{formatRemaining(msLeft)}</b> to protect your data.</span>
        </div>
        <button type="button" className="gw-warning-btn" onClick={onStay} autoFocus>
          Stay signed in
        </button>
      </div>
    </div>
  )
}

function GatewayHome({
  user,
  company,
  plan,
  modules,
  onSignOut,
}: {
  user: GatewayUser
  company: CompanyProfile | null
  plan?: string | null
  modules: string[] | null
  onSignOut: () => void
}) {
  const visible = MODULES.filter((m) => {
    if (m.key === 'admin') return isAdminAccount(user.role)
    return modules === null || modules.includes(m.key)
  })
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null

  return (
    <div className="gw-shell">
      <header className="gw-nav">
        <div className="gw-brand">
          <img className="gw-logo" src="/favicon.svg" alt="" />
          <div>
            <div className="gw-brand-name">
              {company?.name ?? 'Preyone Enterprise'}
              {planLabel ? <span className="gw-badge gw-badge--plan">{planLabel}</span> : null}
            </div>
            {company?.tagline && <div className="gw-brand-tag">{company.tagline}</div>}
          </div>
        </div>
        <div className="gw-user">
          <span className="gw-user-name">{user.fullName}</span>
          <span className="gw-user-role">{user.role}</span>
          <button className="gw-logout" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <main className="gw-main">
        <h2 className="gw-title">Your Workspaces</h2>
        <p className="gw-sub">Choose a module. One identity, one company, every product line.</p>
        <div className="gw-grid">
          {visible.map((m) => (
            <a key={m.key} className="gw-card" href={moduleUrl(m)} target={undefined} rel="noopener noreferrer">
              <span className="gw-card-tags">
                {m.phase && <span className="gw-badge">{m.phase}</span>}
                {m.hint && <span className="gw-badge gw-badge--muted">{m.hint}</span>}
              </span>
              <div className={`gw-icon gw-icon--${m.key}`}>
                {m.key === 'pos' && '₵'}
                {m.key === 'invoice' && '◈'}
                {m.key === 'wifi' && '✶'}
                {m.key === 'admin' && '⌘'}
              </div>
              <div className="gw-card-title">{m.title}</div>
              <div className="gw-card-desc">{m.desc}</div>
            </a>
          ))}
        </div>
      </main>

      <footer className="gw-foot">
        {company?.support_phone && (
          <span>
            Support {company.support_phone}
            {company.email ? ` · ${company.email}` : ''}
          </span>
        )}
      </footer>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<GatewayUser | null>(null)
  const [lockIdentity, setLockIdentity] = useState<GatewayUser | null>(null)
  const [company, setCompany] = useState<CompanyProfile | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  const [modules, setModules] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)
  const [warning, setWarning] = useState(false)
  const [msUntilLock, setMsUntilLock] = useState(INACTIVITY_TIMEOUT_MS)

  const busRef = useRef<ActivityBus | null>(null)
  if (busRef.current === null && typeof window !== 'undefined') busRef.current = new ActivityBus()
  const lockedRef = useRef(false)
  const userRef = useRef<GatewayUser | null>(null)
  const lastRefreshRef = useRef(0)
  const inactivityMsRef = useRef(INACTIVITY_TIMEOUT_MS)
  const warningMsRef = useRef(INACTIVITY_WARNING_MS)
  // Mirror of the `warning` state for the 1s tick. Reading the state variable
  // inside the tick closure would go stale (the effect does not re-run on it),
  // leaving the warning bar stuck open after the user moves the mouse.
  const warningRef = useRef(false)
  /** auth_time + 10h. Set exactly once per sign-in; never extended. */
  const absoluteDeadlineRef = useRef<number | null>(null)
  userRef.current = user
  lockedRef.current = locked

  const hideWarning = useCallback(() => {
    warningRef.current = false
    setWarning(false)
  }, [])

  const lockNow = useCallback(() => {
    if (lockedRef.current) return
    lockedRef.current = true
    setLocked(true)
    hideWarning()
  }, [hideWarning])

  const expireNow = useCallback(() => {
    lockedRef.current = false
    setLocked(false)
    hideWarning()
    clearToken()
    localStorage.setItem(SESSION_EXPIRED_KEY, '1')
    absoluteDeadlineRef.current = null
    setUser(null)
  }, [hideWarning])

  /** Arm both clocks from a freshly issued session. */
  const adoptSession = useCallback(async (u: GatewayUser, authTime: string | null) => {
    setUser(u)
    setLockIdentity(null)
    lockedRef.current = false
    setLocked(false)
    hideWarning()
    absoluteDeadlineRef.current = authTime
      ? new Date(authTime).getTime() + MAX_SESSION_LIFETIME_MS
      : Date.now() + MAX_SESSION_LIFETIME_MS
    localStorage.removeItem(SESSION_EXPIRED_KEY)
    busRef.current?.touch()
    lastRefreshRef.current = Date.now()
    const token = getToken()
    if (token) {
      try {
        const acc = await fetchSubscriptions(token)
        setModules(acc ? acc.modules : [])
        setPlan(acc ? acc.plan_tier ?? null : null)
      } catch {
        setModules(null)
      }
    }
  }, [hideWarning])

  useEffect(() => {
    fetchCompany().then(setCompany)
    fetchSessionPolicy().then((p) => {
      if (typeof p?.inactivityTimeoutSec === 'number') {
        inactivityMsRef.current = p.inactivityTimeoutSec * 1000
        warningMsRef.current = Math.min(INACTIVITY_WARNING_MS, inactivityMsRef.current - 5_000)
        setMsUntilLock(inactivityMsRef.current)
      }
    })
    sessionOutcome()
      .then(async (outcome) => {
        if (outcome.state === 'authenticated') {
          setUser(outcome.user)
          absoluteDeadlineRef.current = outcome.authTime
            ? new Date(outcome.authTime).getTime() + MAX_SESSION_LIFETIME_MS
            : Date.now() + MAX_SESSION_LIFETIME_MS
          localStorage.removeItem(SESSION_EXPIRED_KEY)
          const token = getToken()
          if (token) {
            try {
              const acc = await fetchSubscriptions(token)
              setModules(acc ? acc.modules : [])
              setPlan(acc ? acc.plan_tier ?? null : null)
            } catch {
              setModules(null)
            }
          }
          return
        }
        if (outcome.state === 'locked') {
          setLockIdentity(outcome.user)
          lockedRef.current = true
          setLocked(true)
          return
        }
        if (outcome.state === 'expired') {
          localStorage.setItem(SESSION_EXPIRED_KEY, '1')
          clearToken()
        }
      })
      .finally(() => setLoading(false))
  }, [])

  // ── The timer loop ─────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return
    const bus = busRef.current!

    const slideServer = () => {
      const now = Date.now()
      if (now - lastRefreshRef.current < REFRESH_MIN_INTERVAL_MS) return
      lastRefreshRef.current = now
      if (!getToken()) return
      refreshSession()
        .then(() => { /* server clock slid */ })
        .catch((err) => {
          if (err?.status === 423) lockNow()
          else if (err?.status === 401) expireNow()
        })
    }

    const onActivity = () => {
      bus.touch()
      slideServer()
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll']
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    const offBus = bus.onActivity(() => slideServer())

    const tick = () => {
      const now = Date.now()
      const deadline = absoluteDeadlineRef.current
      if (deadline !== null && now >= deadline) {
        expireNow()
        return
      }
      const armedAt = Math.max(bus.latest, lastRefreshRef.current)
      const remaining = inactivityMsRef.current - (now - armedAt)
      if (lockedRef.current) return
      if (remaining <= 0) {
        setMsUntilLock(0)
        lockNow()
        return
      }
      if (remaining <= warningMsRef.current) {
        warningRef.current = true
        setMsUntilLock(remaining)
        setWarning(true)
      } else if (warningRef.current) {
        warningRef.current = false
        setWarning(false)
        setMsUntilLock(remaining)
      }
    }

    bus.touch()
    lastRefreshRef.current = Date.now()
    tick()
    const interval = window.setInterval(tick, 1000)

    return () => {
      window.clearInterval(interval)
      events.forEach((e) => window.removeEventListener(e, onActivity))
      offBus()
    }
  }, [user, lockNow, expireNow])

  const handleLogin = useCallback(async (email: string, password: string) => {
    const result = await apiLogin(email, password)
    if ('requires2fa' in result) return result
    await adoptSession(result.user, result.authTime)
    return null
  }, [adoptSession])

  const handleVerify = useCallback(async (challengeToken: string, code: string) => {
    const { user: u, authTime } = await apiVerify2fa(challengeToken, code)
    await adoptSession(u, authTime)
  }, [adoptSession])

  const handleUnlock = useCallback(async (password: string) => {
    await unlockSession(password)
    lockedRef.current = false
    setLocked(false)
    hideWarning()
    lastRefreshRef.current = Date.now()
    busRef.current?.touch()
    // Re-hydrate the shell: the lock may have been entered straight from a
    // reload, in which case the gateway never fetched the user/subscriptions.
    if (!userRef.current) {
      const outcome = await sessionOutcome()
      if (outcome.state === 'authenticated') {
        await adoptSession(outcome.user, outcome.authTime)
        return
      }
      if (outcome.state === 'expired') {
        expireNow()
        return
      }
    }
    setUser((u) => u ?? lockIdentity)
  }, [adoptSession, expireNow, lockIdentity, hideWarning])

  const handleStaySignedIn = useCallback(() => {
    lastRefreshRef.current = Date.now()
    busRef.current?.touch()
    hideWarning()
  }, [hideWarning])

  const handleSignOut = useCallback(() => {
    const token = getToken()
    if (token) apiLogout()
    clearToken()
    lockedRef.current = false
    setLocked(false)
    hideWarning()
    absoluteDeadlineRef.current = null
    setUser(null)
    setModules(null)
    setPlan(null)
  }, [hideWarning])

  if (loading) {
    return <div className="gw-loading">Loading…</div>
  }

  return (
    <>
      {warning && !locked && <IdleWarning msLeft={msUntilLock} onStay={handleStaySignedIn} />}
      {locked ? (
        /* State A: only the lock overlay — never the sign-in form behind it. */
        <LockOverlay user={user ?? lockIdentity} onUnlock={handleUnlock} onSignOut={handleSignOut} />
      ) : user ? (
        <GatewayHome user={user} company={company} plan={plan} modules={modules} onSignOut={handleSignOut} />
      ) : (
        <LoginScreen onLogin={handleLogin} onVerify={handleVerify} />
      )}
    </>
  )
}
