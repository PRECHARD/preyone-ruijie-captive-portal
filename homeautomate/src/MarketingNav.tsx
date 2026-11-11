import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Icon, type IconName } from './icons';

/**
 * Shared marketing header.
 *
 * Fixed at the top of every public page so the glass state can react to scroll.
 * The bar starts nearly transparent, then gains a frosted backdrop, a light
 * border and a faint neon rail once the visitor leaves the hero.
 */

const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: 'Home', href: '/' },
  { label: 'Platform', href: '/platform' },
  { label: 'Scenes', href: '/scenes' },
  { label: 'Security', href: '/security' },
];

const POST_LINKS: Array<{ label: string; href: string }> = [
  { label: 'How it works', href: '/how-it-works' },
];

const SOLUTIONS: Array<{ label: string; href: string; body: string; icon: IconName }> = [
  { label: 'Smart Lighting', href: '/solutions/lighting', body: 'Dimming, zones and daylight scenes', icon: 'bolt' },
  { label: 'Climate & Energy', href: '/solutions/climate', body: 'Comfort bands and live kWh', icon: 'climate' },
  { label: 'Audio & Entertainment', href: '/solutions/audio', body: 'Zoned sound and media scenes', icon: 'spark' },
];

function isActive(currentPath: string, href: string): boolean {
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export function MarketingNav({
  currentPath,
  onNavigate,
  onLogin,
}: {
  currentPath: string;
  onNavigate: (path: string) => void;
  onLogin: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  const [solutionsOpen, setSolutionsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setSolutionsOpen(false);
    setMobileOpen(false);
  }, [currentPath]);

  useEffect(() => {
    if (!solutionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setSolutionsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSolutionsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [solutionsOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const go = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(path);
  };

  const solutionsActive = currentPath.startsWith('/solutions');

  return (
    <header className={`ha-nav${scrolled ? ' is-scrolled' : ''}${mobileOpen ? ' is-open' : ''}`}>
      <span className="ha-nav-rail" aria-hidden />
      <span className="ha-nav-notch ha-nav-notch-l" aria-hidden />
      <span className="ha-nav-notch ha-nav-notch-r" aria-hidden />

      <div className="ha-nav-inner">
        <a className="ha-brand ha-brand--nav" href="/" onClick={go('/')} aria-label="Preyone Home Automate — home">
          <span className="ha-brand-glow" aria-hidden />
          <img
            className="ha-logo"
            src="/images/preyonenoneglow-logo-400.png"
            alt="Preyone"
            width={220}
            height={47}
            decoding="async"
          />
          <span className="ha-brand-divider" aria-hidden />
          <span className="ha-brand-stack">
            <span className="ha-brand-kicker">Preyone 360</span>
            <strong>HOME AUTOMATE</strong>
          </span>
        </a>

        <nav className="ha-nav-links" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={isActive(currentPath, link.href) ? 'is-active' : undefined}
              aria-current={isActive(currentPath, link.href) ? 'page' : undefined}
              onClick={go(link.href)}
            >
              {link.label}
            </a>
          ))}

          <div
            className={`ha-nav-dropdown${solutionsOpen ? ' is-open' : ''}${solutionsActive ? ' is-active' : ''}`}
            ref={dropdownRef}
            onMouseEnter={() => setSolutionsOpen(true)}
            onMouseLeave={() => setSolutionsOpen(false)}
          >
            <button
              type="button"
              className="ha-dropdown-trigger"
              aria-haspopup="true"
              aria-expanded={solutionsOpen}
              onClick={() => setSolutionsOpen((open) => !open)}
            >
              Solutions
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div className="ha-dropdown-panel" role="menu" aria-label="Solutions">
              <span className="ha-dropdown-glow" aria-hidden />
              {SOLUTIONS.map((solution) => (
                <a
                  key={solution.href}
                  href={solution.href}
                  className={currentPath === solution.href ? 'is-active' : undefined}
                  role="menuitem"
                  onClick={go(solution.href)}
                >
                  <span className="ha-dropdown-icon"><Icon name={solution.icon} /></span>
                  <span className="ha-dropdown-copy">
                    <strong>{solution.label}</strong>
                    <small>{solution.body}</small>
                  </span>
                  <Icon name="arrow" />
                </a>
              ))}
            </div>
          </div>

          {POST_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={isActive(currentPath, link.href) ? 'is-active' : undefined}
              aria-current={isActive(currentPath, link.href) ? 'page' : undefined}
              onClick={go(link.href)}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ha-nav-actions">
          <button className="ha-btn ha-btn-ghost ha-nav-login" type="button" onClick={onLogin}>
            <Icon name="key" />
            Log in
          </button>
          <a className="ha-btn ha-btn-primary ha-nav-cta" href="/contact" onClick={go('/contact')}>
            GET CONNECTED
            <Icon name="arrow" />
          </a>
          <button
            type="button"
            className={`ha-menu-toggle${mobileOpen ? ' is-open' : ''}`}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="ha-mobile-menu"
            onClick={() => setMobileOpen((open) => !open)}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      <div className={`ha-mobile-menu${mobileOpen ? ' is-open' : ''}`} id="ha-mobile-menu">
        <div className="ha-mobile-inner">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={isActive(currentPath, link.href) ? 'is-active' : undefined}
              aria-current={isActive(currentPath, link.href) ? 'page' : undefined}
              onClick={go(link.href)}
            >
              <span>{link.label}</span>
              <Icon name="arrow" />
            </a>
          ))}
          <div className="ha-mobile-group">
            <span className="ha-mobile-label">Solutions</span>
            {SOLUTIONS.map((solution) => (
              <a
                key={solution.href}
                href={solution.href}
                className={currentPath === solution.href ? 'is-active' : undefined}
                onClick={go(solution.href)}
              >
                <span className="ha-mobile-solution">
                  <Icon name={solution.icon} />
                  {solution.label}
                </span>
                <Icon name="arrow" />
              </a>
            ))}
          </div>
          {POST_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={isActive(currentPath, link.href) ? 'is-active' : undefined}
              aria-current={isActive(currentPath, link.href) ? 'page' : undefined}
              onClick={go(link.href)}
            >
              <span>{link.label}</span>
              <Icon name="arrow" />
            </a>
          ))}
          <div className="ha-mobile-actions">
            <button className="ha-btn ha-btn-ghost" type="button" onClick={onLogin}>
              <Icon name="key" />
              Log in
            </button>
            <a className="ha-btn ha-btn-primary" href="/contact" onClick={go('/contact')}>
              GET CONNECTED
              <Icon name="arrow" />
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
