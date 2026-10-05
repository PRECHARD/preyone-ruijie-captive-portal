import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  getToken,
  clearToken,
  logout as apiLogout,
  login as apiLogin,
  me as fetchMe,
  session as fetchSession,
  company as fetchCompany,
  subscriptions as fetchSubscriptions,
  type GatewayUser,
  type CompanyProfile,
} from './api'

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

function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onLogin(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <img className="login-logo" src="/favicon.svg" alt="Preyone" />
        <h1 className="login-title">Preyone Enterprise</h1>
        <p className="login-tag">Connecting People. Powering Business.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

function GatewayHome({ user, company, plan, modules }: { user: GatewayUser; company: CompanyProfile | null; plan?: string | null; modules: string[] | null }) {
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
          <button className="gw-logout" onClick={() => { clearToken(); apiLogout(); window.location.reload() }}>
            Sign out
          </button>
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
  const [company, setCompany] = useState<CompanyProfile | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  const [modules, setModules] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = getToken()
    fetchCompany().then(setCompany)
    if (!token) {
      // SSO: inherit a session from the wildcard HTTP-Only cookie (login on any
      // *.preyone.com app). /me returns the user + subscribed_modules directly.
      fetchSession()
        .then((u) => {
          if (u) {
            setUser(u)
            setModules(u.subscribed_modules ?? null)
          }
        })
        .finally(() => setLoading(false))
      return
    }
    fetchMe(token)
      .then((u) => {
        setUser(u)
        return fetchSubscriptions(token).then((acc) => {
          setModules(acc ? acc.modules : [])
          setPlan(acc ? acc.plan_tier ?? null : null)
        })
      })
      .catch(() => setModules(null))
      .finally(() => setLoading(false))
  }, [])

  const handleLogin = useCallback(async (email: string, password: string) => {
    const u = await apiLogin(email, password)
    setUser(u)
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
  }, [])

  if (loading) {
    return <div className="gw-loading">Loading…</div>
  }

  return user ? <GatewayHome user={user} company={company} plan={plan} modules={modules} /> : <LoginScreen onLogin={handleLogin} />
}