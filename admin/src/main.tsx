import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import './styles/pages.css'
import { AuthProvider } from './context/AuthContext'
import App from './App'
import StarlinkApp from './starlink/StarlinkApp'

/**
 * The Starlink customer portal ships inside this bundle but has its own shell
 * (own auth, own navbar, plain-CSS neon skin). It owns any /starlink/* deep
 * link and is also served on the starlink.preyone.com subdomain, where the
 * Express fallback delivers index.html for every path.
 */
const isStarlinkPortal =
  window.location.pathname.startsWith('/starlink') ||
  window.location.hostname.startsWith('starlink.')

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
