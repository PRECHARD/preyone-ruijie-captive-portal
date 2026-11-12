import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpRight, Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { NAV_LINKS } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Logo } from './Logo'

const isExternal = (to: string) => /^https?:\/\//.test(to)

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const { t } = useI18n()

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
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-5 px-5 sm:px-8 lg:px-10">
        <Link to="/" aria-label="Preyone — home" className="shrink-0">
          <Logo size={60} />
        </Link>

        <nav className="hidden items-center gap-2.5 min-[1380px]:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => {
            const external = isExternal(link.to)
            const fullLoad = external || link.to.startsWith('/starlink')
            const className = `highlight-line whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.1em] transition-colors hover:text-fuchsia-300 ${
              fullLoad ? 'text-cyan-300' : 'text-slate-300'
            }`

            if (external) {
              return (
                <a
                  key={link.to}
                  href={link.to}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={className}
                >
                  {t(link.key)}
                </a>
              )
            }

            if (fullLoad) {
              // Starlink portal is a separate SPA bundle — full page load.
              return (
                <a key={link.to} href={link.to} className={className}>
                  {t(link.key)}
                </a>
              )
            }

            return (
              <Link key={link.to} to={link.to} className={className}>
                {t(link.key)}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-3 lg:flex min-[1380px]:ml-0">
          <LanguageSwitcher />
          <Link
            to="/#contact"
            className="btn-primary whitespace-nowrap px-4 py-2.5 text-[10px] uppercase tracking-wide"
          >
            {t('cta.getConnected')}
            <ArrowUpRight size={14} />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={open}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-100 min-[1380px]:hidden"
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
            className="glass-strong overflow-hidden min-[1380px]:hidden"
          >
            <nav className="container-site flex flex-col gap-1 py-4" aria-label="Mobile">
              {NAV_LINKS.map((link) => {
                const external = isExternal(link.to)
                const fullLoad = external || link.to.startsWith('/starlink')
                const className = `rounded-lg px-3 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors ${
                  fullLoad
                    ? 'text-cyan-300 hover:bg-cyan-400/10 hover:text-cyan-200'
                    : 'text-slate-200 hover:bg-fuchsia-400/10 hover:text-fuchsia-300'
                }`

                if (external) {
                  return (
                    <a
                      key={link.to}
                      href={link.to}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={className}
                    >
                      {link.label}
                    </a>
                  )
                }

                if (fullLoad) {
                  return (
                    <a key={link.to} href={link.to} className={className}>
                      {link.label}
                    </a>
                  )
                }

                return (
                  <Link key={link.to} to={link.to} className={className}>
                    {link.label}
                  </Link>
                )
              })}
              <div className="mt-3 flex items-center justify-between px-3">
                <LanguageSwitcher />
                <Link to="/#contact" className="btn-primary px-5 py-2.5 text-xs uppercase tracking-wide">
                  {t('cta.getConnected')}
                </Link>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
