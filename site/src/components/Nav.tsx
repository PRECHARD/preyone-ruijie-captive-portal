import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, ChevronDown, Menu, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { NAV_LINKS, type NavLink, type NavMenuLink } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { LanguageSwitcher } from './LanguageSwitcher'
import { Logo } from './Logo'

const isExternalHref = (href: string) => /^https?:\/\//.test(href)

const canHover = () =>
  typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

function MenuLinkRow({ item }: { item: NavMenuLink }) {
  const external = item.external || isExternalHref(item.href)
  const fullLoad = external || item.href.startsWith('/starlink')

  const content = (
    <>
      <span className="block text-[12.5px] font-semibold leading-snug text-slate-100">
        {item.label}
      </span>
      {item.desc ? (
        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{item.desc}</span>
      ) : null}
    </>
  )

  const className =
    'nav-menu-item group flex items-start justify-between gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400/60'

  if (external) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={className}>
        <span>{content}</span>
        <ArrowUpRight
          size={13}
          className="mt-0.5 shrink-0 text-slate-500 transition-colors group-hover:text-cyan-300"
        />
      </a>
    )
  }

  if (fullLoad) {
    return (
      <a href={item.href} className={className}>
        <span>{content}</span>
      </a>
    )
  }

  return (
    <Link to={item.href} className={className}>
      <span>{content}</span>
    </Link>
  )
}

function DesktopMenuItem({
  link,
  open,
  onOpen,
  onClose,
  onToggle,
}: {
  link: NavLink
  open: boolean
  onOpen: () => void
  onClose: () => void
  onToggle: () => void
}) {
  const { t } = useI18n()
  const external = link.external || isExternalHref(link.to)
  const fullLoad = external || link.to.startsWith('/starlink')
  const hasMenu = Boolean(link.menu?.length)
  const triggerClass = `highlight-line whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.12em] transition-colors hover:text-fuchsia-300 ${
    fullLoad || open ? 'text-cyan-300' : 'text-slate-300'
  }`

  if (!hasMenu) {
    if (external) {
      return (
        <a href={link.to} target="_blank" rel="noopener noreferrer" className={triggerClass}>
          {t(link.key)}
        </a>
      )
    }
    if (fullLoad) {
      return (
        <a href={link.to} className={triggerClass}>
          {t(link.key)}
        </a>
      )
    }
    return (
      <Link to={link.to} className={triggerClass}>
        {t(link.key)}
      </Link>
    )
  }

  const panelWidth = link.menu?.length && link.key === 'nav.apps' ? 'w-[680px]' : 'w-72'
  const grouped = Boolean(link.menu?.some((group) => group.title))
  const chevronClass = `flex h-5 w-4 items-center justify-center rounded transition-colors hover:text-fuchsia-300 ${
    fullLoad || open ? 'text-cyan-300' : 'text-slate-400'
  }`

  // The label navigates to the section/page; the chevron only toggles the panel.
  const label = external ? (
    <a
      href={link.to}
      target="_blank"
      rel="noopener noreferrer"
      className={triggerClass}
      onClick={onClose}
    >
      {t(link.key)}
    </a>
  ) : fullLoad ? (
    <a href={link.to} className={triggerClass} onClick={onClose}>
      {t(link.key)}
    </a>
  ) : (
    <Link to={link.to} className={triggerClass} onClick={onClose}>
      {t(link.key)}
    </Link>
  )

  return (
    <div
      className="relative flex items-center gap-1"
      onMouseEnter={() => {
        if (canHover()) onOpen()
      }}
      onMouseLeave={() => {
        if (canHover()) onClose()
      }}
    >
      {label}

      <button
        type="button"
        className={chevronClass}
        aria-label={`${t(link.key)} menu`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={`nav-menu-${link.key}`}
        onClick={onToggle}
      >
        <ChevronDown
          size={12}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className={`absolute left-0 top-full z-50 pt-3 ${panelWidth}`}>
          <div id={`nav-menu-${link.key}`} className="nav-glass-panel p-2.5">
            {grouped ? (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
                {link.menu?.map((group, groupIndex) => (
                  <div key={group.title ?? groupIndex} className="min-w-0">
                    {group.title ? (
                      <p className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-300/80">
                        {group.title}
                      </p>
                    ) : null}
                    <div className="grid gap-0.5">
                      {group.items.map((item) => (
                        <MenuLinkRow key={`${item.href}-${item.label}`} item={item} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-0.5">
                {link.menu?.map((group, groupIndex) =>
                  group.items.map((item) => (
                    <MenuLinkRow key={`${item.href}-${item.label}-${groupIndex}`} item={item} />
                  )),
                )}
              </div>
            )}

            {link.key === 'nav.apps' ? (
              <div className="mt-1 border-t border-white/10 p-1 pt-2">
                <Link
                  to="/business-apps"
                  className="nav-menu-item flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-cyan-300"
                >
                  View all business apps
                  <ArrowRight size={13} />
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MobileMenuItem({ link, onNavigate }: { link: NavLink; onNavigate: () => void }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const external = link.external || isExternalHref(link.to)
  const fullLoad = external || link.to.startsWith('/starlink')
  const itemClass =
    'flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors'

  if (link.menu?.length) {
    return (
      <div className="nav-mobile-details">
        <div className="flex items-center gap-1">
          <Link
            to={link.to}
            onClick={onNavigate}
            className={`${itemClass} flex-1 text-slate-200 hover:bg-white/5 hover:text-white`}
          >
            {t(link.key)}
          </Link>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={`mobile-menu-${link.key}`}
            aria-label={`${t(link.key)} menu`}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <ChevronDown
              size={15}
              className={`nav-mobile-chevron transition-transform duration-200 ${
                expanded ? 'rotate-180' : ''
              }`}
            />
          </button>
        </div>
        {expanded ? (
          <div
            id={`mobile-menu-${link.key}`}
            className="mb-1 mt-1 grid gap-0.5 border-l border-white/10 pl-2"
          >
            {link.menu.map((group, groupIndex) => (
              <div key={group.title ?? groupIndex} className="min-w-0">
                {group.title ? (
                  <p className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-[0.18em] text-cyan-300/80">
                    {group.title}
                  </p>
                ) : null}
                {group.items.map((item) => {
                  const itemExternal = item.external || isExternalHref(item.href)
                  const itemFullLoad = itemExternal || item.href.startsWith('/starlink')
                  const inner = (
                    <>
                      <span className="block text-[12.5px] font-semibold text-slate-200">
                        {item.label}
                      </span>
                      {item.desc ? (
                        <span className="mt-0.5 block text-[11px] text-slate-500">{item.desc}</span>
                      ) : null}
                    </>
                  )

                  if (itemExternal) {
                    return (
                      <a
                        key={`${item.href}-${item.label}`}
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={onNavigate}
                        className="block rounded-lg px-3 py-2 transition-colors hover:bg-white/5"
                      >
                        {inner}
                      </a>
                    )
                  }
                  if (itemFullLoad) {
                    return (
                      <a
                        key={`${item.href}-${item.label}`}
                        href={item.href}
                        onClick={onNavigate}
                        className="block rounded-lg px-3 py-2 transition-colors hover:bg-white/5"
                      >
                        {inner}
                      </a>
                    )
                  }
                  return (
                    <Link
                      key={`${item.href}-${item.label}`}
                      to={item.href}
                      onClick={onNavigate}
                      className="block rounded-lg px-3 py-2 transition-colors hover:bg-white/5"
                    >
                      {inner}
                    </Link>
                  )
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  if (external) {
    return (
      <a
        href={link.to}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onNavigate}
        className={`${itemClass} text-cyan-300 hover:bg-cyan-400/10 hover:text-cyan-200`}
      >
        {link.label}
        <ArrowUpRight size={14} />
      </a>
    )
  }

  if (fullLoad) {
    return (
      <a
        href={link.to}
        onClick={onNavigate}
        className={`${itemClass} text-cyan-300 hover:bg-cyan-400/10 hover:text-cyan-200`}
      >
        {link.label}
      </a>
    )
  }

  return (
    <Link
      to={link.to}
      onClick={onNavigate}
      className={`${itemClass} text-slate-200 hover:bg-fuchsia-400/10 hover:text-fuchsia-300`}
    >
      {link.label}
    </Link>
  )
}

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const location = useLocation()
  const headerRef = useRef<HTMLElement | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setOpen(false)
    setOpenMenu(null)
  }, [location])

  useEffect(() => {
    if (!openMenu) return

    const onPointerDown = (event: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setOpenMenu(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu])

  return (
    <header
      ref={headerRef}
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'glass-strong py-3 shadow-[0_8px_40px_rgba(5,6,15,0.45)]' : 'bg-transparent py-5'
      }`}
    >
      <div className="container-site flex items-center justify-between gap-5">
        <Link to="/" aria-label="Preyone — home" className="shrink-0">
          <Logo size={60} />
        </Link>

        <nav className="hidden items-center gap-3 xl:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <DesktopMenuItem
              key={link.key}
              link={link}
              open={openMenu === link.key}
              onOpen={() => setOpenMenu(link.key)}
              onClose={() => setOpenMenu((current) => (current === link.key ? null : current))}
              onToggle={() => setOpenMenu((current) => (current === link.key ? null : link.key))}
            />
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-3 lg:flex xl:ml-0">
          <LanguageSwitcher />
          <Link
            to="/#contact"
            className="btn-primary whitespace-nowrap px-4 py-2.5 text-[10.5px] uppercase tracking-wide"
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
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-100 xl:hidden"
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
            className="nav-mobile-panel overflow-hidden xl:hidden"
          >
            <nav className="container-site flex flex-col gap-1 py-4" aria-label="Mobile">
              {NAV_LINKS.map((link) => (
                <MobileMenuItem
                  key={link.key}
                  link={link}
                  onNavigate={() => setOpen(false)}
                />
              ))}
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
