import { useEffect, useState, type MouseEvent } from 'react';
import { Icon, type IconName } from './icons';
import { MarketingShell } from './PageShell';
import { fetchMarketingPage, type MarketingPageData } from './marketing';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: MarketingPageData };

const ORBIT_ICONS: IconName[] = ['bolt', 'climate', 'shield', 'energy'];

function Article({
  data,
  onNavigate,
}: {
  data: MarketingPageData;
  onNavigate: (path: string) => void;
}) {
  const go = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <>
      <section className="ha-page-hero">
        <div className="ha-page-hero-copy">
          <span className="ha-eyebrow"><span className="ha-pulse" /> {data.eyebrow}</span>
          <h1>{data.title}</h1>
          <p className="ha-page-lede">{data.lede}</p>
          <div className="ha-cta-row">
            <a className="ha-btn ha-btn-primary ha-btn-lg" href={data.cta.href} onClick={go(data.cta.href)}>
              {data.cta.label}
              <Icon name="arrow" />
            </a>
            {data.cta.secondaryHref && data.cta.secondaryLabel ? (
              <a className="ha-btn ha-btn-ghost ha-btn-lg" href={data.cta.secondaryHref} onClick={go(data.cta.secondaryHref)}>
                {data.cta.secondaryLabel}
              </a>
            ) : null}
          </div>
        </div>

        <div className="ha-page-visual" aria-hidden>
          <span className="ha-page-ring ring-a" />
          <span className="ha-page-ring ring-b" />
          <span className="ha-page-ring ring-c" />
          <span className="ha-page-core">
            <Icon name={data.cards[0]?.icon ?? 'home'} />
          </span>
          {ORBIT_ICONS.map((icon, index) => (
            <span key={icon} className={`ha-page-chip chip-${index}`}>
              <Icon name={icon} />
            </span>
          ))}
          <span className="ha-page-scan" />
        </div>
      </section>

      <section className="ha-stats" aria-label="Platform metrics">
        {data.stats.map((stat) => (
          <div className="ha-stat" key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
            {stat.foot ? <small>{stat.foot}</small> : null}
          </div>
        ))}
      </section>

      <section className="ha-section ha-page-section">
        <div className="ha-section-head">
          <span className="ha-eyebrow"><span className="ha-pulse" /> {data.eyebrow}</span>
          <h2>Built for the way you live.</h2>
          <p>{data.lede}</p>
        </div>
        <div className="ha-features">
          {data.cards.map((card) => (
            <article className="ha-feature" key={card.title}>
              <span className="ha-feature-icon"><Icon name={card.icon} /></span>
              {card.tag ? <span className="ha-feature-tag">{card.tag}</span> : null}
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      {data.steps && data.steps.length > 0 ? (
        <section className="ha-section ha-how ha-page-section">
          <div className="ha-section-head">
            <span className="ha-eyebrow"><span className="ha-pulse" /> How it works</span>
            <h2>Three steps to a smarter home.</h2>
          </div>
          <div className="ha-steps">
            {data.steps.map((step) => (
              <div className="ha-step" key={step.number}>
                <span className="ha-step-num">{step.number}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data.bullets && data.bullets.length > 0 ? (
        <section className="ha-section ha-page-section">
          <ul className="ha-page-bullets">
            {data.bullets.map((bullet) => (
              <li key={bullet}><Icon name="check" /> {bullet}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ha-final-cta ha-page-cta">
        <div className="ha-final-glow" aria-hidden />
        <span className="ha-eyebrow"><span className="ha-pulse" /> {data.cta.eyebrow ?? 'Ready when you are'}</span>
        <h2>{data.cta.title}</h2>
        <p>{data.cta.body}</p>
        <div className="ha-cta-row">
          <a className="ha-btn ha-btn-primary ha-btn-lg" href={data.cta.href} onClick={go(data.cta.href)}>
            {data.cta.label}
            <Icon name="arrow" />
          </a>
          {data.cta.secondaryHref && data.cta.secondaryLabel ? (
            <a className="ha-btn ha-btn-ghost ha-btn-lg" href={data.cta.secondaryHref} onClick={go(data.cta.secondaryHref)}>
              {data.cta.secondaryLabel}
            </a>
          ) : null}
        </div>
      </section>
    </>
  );
}

function LoadingState() {
  return (
    <div className="ha-page-loading" aria-busy="true">
      <span className="ha-page-spinner" aria-hidden />
      <p>Loading command centre…</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="ha-page-error" role="alert">
      <span className="ha-page-error-icon"><Icon name="satellite" /></span>
      <h1>Signal lost.</h1>
      <p>{message}. Check the connection and try again.</p>
      <button className="ha-btn ha-btn-primary" type="button" onClick={onRetry}>
        Retry
        <Icon name="arrow" />
      </button>
    </div>
  );
}

export function MarketingPage({
  path,
  onNavigate,
  onLogin,
}: {
  path: string;
  onNavigate: (path: string) => void;
  onLogin: () => void;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchMarketingPage<MarketingPageData>(`/api${path}`, controller.signal)
      .then((data) => {
        setState({ status: 'ready', data });
        document.title = `${data.title} · Preyone Home`;
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not load this page',
        });
      });
    return () => controller.abort();
  }, [path, attempt]);

  return (
    <MarketingShell path={path} onNavigate={onNavigate} onLogin={onLogin}>
      {state.status === 'ready' ? (
        <Article data={state.data} onNavigate={onNavigate} />
      ) : state.status === 'error' ? (
        <ErrorState message={state.message} onRetry={() => setAttempt((value) => value + 1)} />
      ) : (
        <LoadingState />
      )}
    </MarketingShell>
  );
}
