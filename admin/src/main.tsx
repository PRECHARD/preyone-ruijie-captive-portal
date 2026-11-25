import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './styles/pages.css'
import './styles/theme.css'
import { AuthProvider } from './context/AuthContext'
import App from './App'
import StarlinkApp from './starlink/StarlinkApp'
import { registerServiceWorker } from './pwa'

/**
 * The Starlink customer portal ships inside this bundle but has its own shell
 * (own auth, own navbar, plain-CSS neon skin). It owns /starlink/* deep links
 * on the public site and is served on starlink.preyone.com.
 *
 * admin.preyone.com is never the customer portal — even at /starlink/portal.
 * That path is the old navbar link; it must open the management dashboard
 * (StarlinkAdmin tabs), not rewrite itself into the customer shell.
 */
const onAdminConsole = window.location.hostname === 'admin.preyone.com'
const isStarlinkPortal =
  !onAdminConsole && (
    window.location.pathname.startsWith('/starlink') ||
    window.location.hostname.startsWith('starlink.')
  )

createRoot(document.getElementById('root')!).render(
  isStarlinkPortal ? (
    <StrictMode>
      <StarlinkApp />
    </StrictMode>
  ) : (
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>
  ),
)

registerServiceWorker()
