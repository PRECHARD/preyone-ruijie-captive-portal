import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { NAV_LINKS } from '../lib/data'
import { Logo } from './Logo'

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setOpen(false)
  }, [location])

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'glass-strong py-3 shadow-[0_8px_40px_rgba(5,6,15,0.45)]' : 'bg-transparent py-5'
      }`}
    >
      <div className="container-site flex items-center justify-between gap-6">
        <Link to="/" aria-label="Preyone — home" className="shrink-0">
          <Logo size={60} />
        </Link>

        <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
          {NAV_LINKS.map((link) =>
            link.to.startsWith('/starlink') ? (
              // Starlink portal is a separate SPA bundle — full page load.
              <a
                key={link.to}
                href={link.to}
                className="highlight-line text-xs font-bold uppercase tracking-[0.16em] text-cyan-300 transition-colors hover:text-fuchsia-300"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.to}
                to={link.to}
                className="highlight-line text-xs font-bold uppercase tracking-[0.16em] text-slate-300 transition-colors hover:text-fuchsia-300"
              >
                {link.label}
              </Link>
            )
          )}
        </nav>

        <div className="hidden items-center gap-4 lg:flex">
          <a href="tel:+263771327202" className="text-xs font-bold tracking-wide text-slate-300 transition-colors hover:text-cyan-300">
          </a>
          <Link to="/#contact" className="btn-primary px-5 py-2.5 text-xs uppercase tracking-wide">
            Get Connected
            <ArrowUpRight size={14} />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={open}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-100 lg:hidden"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            className="glass-strong overflow-hidden lg:hidden"
          >
            <nav className="container-site flex flex-col gap-1 py-4" aria-label="Mobile">
              {NAV_LINKS.map((link) =>
                link.to.startsWith('/starlink') ? (
                  <a
                    key={link.to}
                    href={link.to}
                    className="rounded-lg px-3 py-2.5 text-sm font-bold uppercase tracking-wider text-cyan-300 transition-colors hover:bg-cyan-400/10 hover:text-cyan-200"
                  >
                    {link.label}
                  </a>
                ) : (
                  <Link
                    key={link.to}
                    to={link.to}
                    className="rounded-lg px-3 py-2.5 text-sm font-bold uppercase tracking-wider text-slate-200 transition-colors hover:bg-fuchsia-400/10 hover:text-fuchsia-300"
                  >
                    {link.label}
                  </Link>
                )
              )}
              <Link to="/#contact" className="btn-primary mt-3 w-full py-3.5 text-sm uppercase tracking-wide">
                Get Connected
              </Link>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}