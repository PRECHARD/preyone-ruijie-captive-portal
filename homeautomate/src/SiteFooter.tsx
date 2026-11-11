import type { MouseEvent } from 'react';

const FOOTER_LINKS: Array<{ label: string; href: string; external?: boolean }> = [
  { label: 'Platform', href: '/platform' },
  { label: 'Scenes', href: '/scenes' },
  { label: 'Security', href: '/security' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Get connected', href: '/contact' },
  { label: 'Preyone 360', href: 'https://preyone.com/business-apps', external: true },
  { label: 'preyone.com', href: 'https://preyone.com', external: true },
];

export function SiteFooter({ onNavigate }: { onNavigate: (path: string) => void }) {
  const go = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <footer className="ha-footer">
      <div className="ha-footer-brand">
        <span className="ha-brand-mark">
          <img src="/images/preyone-emblem-mark.png" alt="" width={30} height={35} decoding="async" />
        </span>
        <div>
          <strong>Preyone Home</strong>
          <small>Intelligent automation for modern Zimbabwean homes.</small>
        </div>
      </div>
      <div className="ha-footer-links">
        {FOOTER_LINKS.map((link) =>
          link.external ? (
            <a key={link.href} href={link.href}>{link.label}</a>
          ) : (
            <a key={link.href} href={link.href} onClick={go(link.href)}>{link.label}</a>
          )
        )}
      </div>
      <div className="ha-footer-meta">
        <span>© {new Date().getFullYear()} Preyone</span>
        <span className="ha-footer-status"><span /> All systems operational</span>
      </div>
    </footer>
  );
}
