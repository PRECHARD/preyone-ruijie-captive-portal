import type { ReactNode } from 'react';
import { MarketingNav } from './MarketingNav';
import { SiteFooter } from './SiteFooter';

/** Shared chrome (aurora background, fixed header, footer) for public pages. */
export function MarketingShell({
  path,
  onNavigate,
  onLogin,
  children,
}: {
  path: string;
  onNavigate: (path: string) => void;
  onLogin: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ha-landing ha-landing--nav">
      <div className="ha-aurora" aria-hidden>
        <span className="ha-grid" />
        <span className="ha-orb ha-orb-a" />
        <span className="ha-orb ha-orb-b" />
        <span className="ha-orb ha-orb-c" />
        <span className="ha-scan" />
      </div>

      <MarketingNav currentPath={path} onNavigate={onNavigate} onLogin={onLogin} />

      <main className="ha-marketing">{children}</main>

      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
