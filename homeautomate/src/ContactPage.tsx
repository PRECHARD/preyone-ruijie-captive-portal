import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { MarketingShell } from './PageShell';
import { fetchMarketingPage, type ContactPageData } from './marketing';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ContactPageData };

export function ContactPage({
  onNavigate,
  onLogin,
}: {
  onNavigate: (path: string) => void;
  onLogin: () => void;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchMarketingPage<ContactPageData>('/api/contact', controller.signal)
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
  }, [attempt]);

  return (
    <MarketingShell path="/contact" onNavigate={onNavigate} onLogin={onLogin}>
      {state.status === 'loading' ? (
        <div className="ha-page-loading" aria-busy="true">
          <span className="ha-page-spinner" aria-hidden />
          <p>Connecting you to the team…</p>
        </div>
      ) : state.status === 'error' ? (
        <div className="ha-page-error" role="alert">
          <span className="ha-page-error-icon"><Icon name="satellite" /></span>
          <h1>Signal lost.</h1>
          <p>{state.message}. Check the connection and try again.</p>
          <button className="ha-btn ha-btn-primary" type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
            <Icon name="arrow" />
          </button>
        </div>
      ) : (
        <ContactContent data={state.data} />
      )}
    </MarketingShell>
  );
}

function ContactContent({ data }: { data: ContactPageData }) {
  return (
    <>
      <section className="ha-page-hero ha-contact-hero">
        <div className="ha-page-hero-copy">
          <span className="ha-eyebrow"><span className="ha-pulse" /> {data.eyebrow}</span>
          <h1>{data.title}</h1>
          <p className="ha-page-lede">{data.lede}</p>
          <div className="ha-cta-row">
            <a className="ha-btn ha-btn-primary ha-btn-lg" href="mailto:support@preyone.com?subject=Preyone%20Home%20automation%20enquiry">
              Start an enquiry
              <Icon name="arrow" />
            </a>
            <a className="ha-btn ha-btn-ghost ha-btn-lg" href="https://wa.me/263771327202" target="_blank" rel="noopener noreferrer">
              <Icon name="chat" />
              WhatsApp us
            </a>
          </div>
        </div>

        <div className="ha-contact-panel">
          <div className="ha-contact-panel-head">
            <span className="ha-contact-panel-icon"><Icon name="key" /></span>
            <div>
              <strong>Direct channels</strong>
              <small>No ticket queues, no phone trees.</small>
            </div>
            <span className="ha-live"><span /> Online</span>
          </div>
          <div className="ha-contact-channels">
            {data.channels.map((channel) => {
              const content = (
                <>
                  <span className="ha-contact-channel-icon"><Icon name={channel.icon} /></span>
                  <span className="ha-contact-channel-copy">
                    <small>{channel.label}</small>
                    <strong>{channel.value}</strong>
                  </span>
                  {channel.href ? <Icon name="arrow" /> : null}
                </>
              );
              return channel.href ? (
                <a
                  key={channel.label}
                  className="ha-contact-channel"
                  href={channel.href}
                  target={channel.href.startsWith('http') ? '_blank' : undefined}
                  rel={channel.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                >
                  {content}
                </a>
              ) : (
                <div className="ha-contact-channel" key={channel.label}>{content}</div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="ha-section ha-page-section ha-contact-details">
        <div className="ha-contact-detail-card">
          <span className="ha-eyebrow"><span className="ha-pulse" /> The details</span>
          <h2>What to expect.</h2>
          <dl>
            {data.details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="ha-contact-steps">
          {data.steps.map((step) => (
            <div className="ha-step" key={step.number}>
              <span className="ha-step-num">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="ha-final-cta ha-page-cta">
        <div className="ha-final-glow" aria-hidden />
        <span className="ha-eyebrow"><span className="ha-pulse" /> {data.cta.eyebrow ?? 'Prefer to talk?'}</span>
        <h2>{data.cta.title}</h2>
        <p>{data.cta.body}</p>
        <div className="ha-cta-row">
          <a className="ha-btn ha-btn-primary ha-btn-lg" href={data.cta.href}>
            {data.cta.label}
            <Icon name="phone" />
          </a>
          {data.cta.secondaryHref && data.cta.secondaryLabel ? (
            <a className="ha-btn ha-btn-ghost ha-btn-lg" href={data.cta.secondaryHref}>
              {data.cta.secondaryLabel}
            </a>
          ) : null}
        </div>
      </section>
    </>
  );
}
