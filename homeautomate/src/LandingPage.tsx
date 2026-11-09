import type { ReactNode } from 'react';

/**
 * Public landing page for homeautomate.preyone.com.
 *
 * The marketing surface is deliberately self-contained: no authenticated API
 * calls run here, so the page renders for logged-out visitors and search
 * crawlers. "Log in" hands off to the SPA's /login route.
 */

type IconName =
  | 'bolt'
  | 'shield'
  | 'climate'
  | 'camera'
  | 'energy'
  | 'satellite'
  | 'spark'
  | 'arrow'
  | 'check'
  | 'lock'
  | 'wifi'
  | 'key'
  | 'home';

const ICON_PATHS: Record<IconName, ReactNode> = {
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13Z" />,
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  climate: (
    <>
      <path d="M10 13.6V5a2 2 0 1 1 4 0v8.6a4.5 4.5 0 1 1-4 0Z" />
      <path d="M12 8v7" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6.5" width="13" height="11" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </>
  ),
  energy: (
    <>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
    </>
  ),
  satellite: (
    <>
      <path d="M5 13a8 8 0 0 0 6 6M2 10a12 12 0 0 0 9 9" />
      <path d="m13 5 6 6-2.5 2.5L19 19l-2 2-5.5-2.5L9 16Z" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  arrow: <path d="M4 12h15m-5.5-5.5L19 12l-5.5 5.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  wifi: (
    <>
      <path d="M3.5 9a13 13 0 0 1 17 0" />
      <path d="M6.8 12.5a8.4 8.4 0 0 1 10.4 0" />
      <path d="M10 16a4 4 0 0 1 4 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 9 9M17 17l2-2M14 14l2-2" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1Z" />
    </>
  ),
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

const FEATURES: Array<{ icon: IconName; title: string; body: string; tag: string }> = [
  {
    icon: 'bolt',
    title: 'Lighting & scenes',
    body: 'Dim, schedule and group every circuit. One tap for Dinner, Movie or Away — across the whole house.',
    tag: 'Instant',
  },
  {
    icon: 'climate',
    title: 'Climate control',
    body: 'Room-by-room temperature, geyser scheduling and humidity rules that keep the house comfortable and the bill low.',
    tag: 'Adaptive',
  },
  {
    icon: 'shield',
    title: 'Security & access',
    body: 'Smart locks, gates and cameras with armed/disarmed scenes and a tamper-proof activity trail.',
    tag: 'Guarded',
  },
  {
    icon: 'energy',
    title: 'Energy intelligence',
    body: 'Live kWh, cost per room and load-shedding patterns. Know what is drawing power before the meter does.',
    tag: 'Metered',
  },
  {
    icon: 'satellite',
    title: 'Starlink gateway',
    body: 'Uptime, latency and throughput are sampled continuously, with automatic failover alerts when the link drops.',
    tag: 'Connected',
  },
  {
    icon: 'spark',
    title: 'Automation rules',
    body: 'If this, then that. Threshold rules run on every telemetry sample — no cloud round-trip, no code.',
    tag: 'Autonomous',
  },
];

const SCENES = [
  { name: 'Good morning', detail: 'Blinds open · Geyser on · Gate unlocked', tone: 'amber' },
  { name: 'Away', detail: 'All lights off · Cameras armed · Locks secured', tone: 'violet' },
  { name: 'Movie night', detail: 'Lounge dimmed 20% · AC 22°C · Notifications muted', tone: 'teal' },
  { name: 'Load-shedding', detail: 'Essentials only · Inverter alert · Starlink backup', tone: 'rose' },
];

export function LandingPage({
  onLogin,
  onSubscribe,
}: {
  onLogin: () => void;
  onSubscribe: () => void;
}) {
  return (
    <div className="ha-landing">
      <div className="ha-aurora" aria-hidden>
        <span className="ha-grid" />
        <span className="ha-orb ha-orb-a" />
        <span className="ha-orb ha-orb-b" />
        <span className="ha-orb ha-orb-c" />
        <span className="ha-scan" />
      </div>

      <header className="ha-nav">
        <a className="ha-brand" href="/" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
          <span className="ha-brand-mark"><Icon name="home" /></span>
          <span className="ha-brand-text">
            <strong>Preyone</strong>
            <small>Home</small>
          </span>
        </a>
        <nav className="ha-nav-links" aria-label="Sections">
          <a href="#platform">Platform</a>
          <a href="#scenes">Scenes</a>
          <a href="#security">Security</a>
          <a href="#how">How it works</a>
        </nav>
        <div className="ha-nav-actions">
          <a className="ha-text-link" href="https://preyone.com">Preyone.com</a>
          <button className="ha-btn ha-btn-ghost" type="button" onClick={onLogin}>
            Log in
          </button>
          <button className="ha-btn ha-btn-primary" type="button" onClick={onSubscribe}>
            Get started
          </button>
        </div>
      </header>

      <main>
        <section className="ha-hero">
          <div className="ha-hero-copy">
            <span className="ha-eyebrow">
              <span className="ha-pulse" /> Preyone 360 · Home automation
            </span>
            <h1>
              Your home,
              <br />
              <span className="ha-gradient-text">thinking ahead.</span>
            </h1>
            <p className="ha-lede">
              Lighting, climate, security, energy and Starlink — orchestrated from one
              intelligent control plane. Built for Zimbabwean homes, engineered for the
              way you actually live.
            </p>
            <div className="ha-cta-row">
              <button className="ha-btn ha-btn-primary ha-btn-lg" type="button" onClick={onLogin}>
                <Icon name="key" />
                Log in to your home
              </button>
              <a className="ha-btn ha-btn-ghost ha-btn-lg" href="#platform">
                Explore the platform
                <Icon name="arrow" />
              </a>
            </div>
            <ul className="ha-proof">
              <li><Icon name="check" /> 99.98% gateway uptime</li>
              <li><Icon name="check" /> Live telemetry every 5s</li>
              <li><Icon name="check" /> 2FA-protected access</li>
            </ul>
          </div>

          <div className="ha-hero-visual" aria-label="Live home control preview">
            <div className="ha-panel">
              <div className="ha-panel-top">
                <div>
                  <span className="ha-panel-kicker">Command centre</span>
                  <div className="ha-panel-title">Riverside Residence</div>
                </div>
                <span className="ha-live"><span /> Live</span>
              </div>

              <div className="ha-tiles">
                <div className="ha-tile">
                  <span className="ha-tile-icon"><Icon name="climate" /></span>
                  <span className="ha-tile-label">Climate</span>
                  <strong>22.5°<small>C</small></strong>
                  <span className="ha-tile-foot">Lounge · cooling</span>
                </div>
                <div className="ha-tile">
                  <span className="ha-tile-icon"><Icon name="shield" /></span>
                  <span className="ha-tile-label">Security</span>
                  <strong>Armed</strong>
                  <span className="ha-tile-foot">8 sensors · all clear</span>
                </div>
                <div className="ha-tile">
                  <span className="ha-tile-icon"><Icon name="energy" /></span>
                  <span className="ha-tile-label">Energy today</span>
                  <strong>4.2<small>kWh</small></strong>
                  <span className="ha-tile-foot">R 8.40 · 31% solar</span>
                </div>
                <div className="ha-tile">
                  <span className="ha-tile-icon"><Icon name="satellite" /></span>
                  <span className="ha-tile-label">Starlink</span>
                  <strong>99.98<small>%</small></strong>
                  <span className="ha-tile-foot">42 ms · 186 Mbps</span>
                </div>
              </div>

              <div className="ha-chart">
                <div className="ha-chart-head">
                  <span>Energy · last 24 hours</span>
                  <span className="ha-chart-tag">−18% vs yesterday</span>
                </div>
                <div className="ha-bars" aria-hidden>
                  {[28, 42, 35, 58, 46, 66, 52, 74, 61, 80, 57, 71, 48, 63, 40, 55, 33, 47, 29, 38, 24, 31, 20, 27].map(
                    (h, i) => (
                      <span key={i} style={{ height: `${h}%`, animationDelay: `${i * 40}ms` }} />
                    )
                  )}
                </div>
              </div>

              <div className="ha-device-row">
                {['Lights', 'Geyser', 'Gate', 'Cameras'].map((device, i) => (
                  <span className={`ha-chip ${i === 0 || i === 2 ? 'on' : ''}`} key={device}>
                    <span className="ha-chip-dot" /> {device}
                  </span>
                ))}
              </div>
            </div>

            <div className="ha-float-card ha-float-a">
              <span className="ha-float-icon"><Icon name="lock" /></span>
              <div>
                <strong>Front gate locked</strong>
                <small>2 seconds ago</small>
              </div>
            </div>
            <div className="ha-float-card ha-float-b">
              <span className="ha-float-icon"><Icon name="wifi" /></span>
              <div>
                <strong>Starlink failover ready</strong>
                <small>Backup link healthy</small>
              </div>
            </div>
          </div>
        </section>

        <section className="ha-stats" aria-label="Platform metrics">
          {[
            ['99.98%', 'Gateway uptime', 'measured across the fleet'],
            ['< 120ms', 'Command latency', 'dashboard to device'],
            ['50+', 'Device profiles', 'switches to satellites'],
            ['24/7', 'Telemetry', 'every five seconds'],
          ].map(([value, label, foot]) => (
            <div className="ha-stat" key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
              <small>{foot}</small>
            </div>
          ))}
        </section>

        <section className="ha-section" id="platform">
          <div className="ha-section-head">
            <span className="ha-eyebrow"><span className="ha-pulse" /> The platform</span>
            <h2>The whole home, one command centre.</h2>
            <p>
              Every device, room and rule in a single live view. No hubs to babysit, no
              vendor silos — just a calm, fast interface that works on the wall tablet,
              the phone in your pocket and the browser at the office.
            </p>
          </div>
          <div className="ha-features">
            {FEATURES.map((feature) => (
              <article className="ha-feature" key={feature.title}>
                <span className="ha-feature-icon"><Icon name={feature.icon} /></span>
                <span className="ha-feature-tag">{feature.tag}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="ha-showcase" id="scenes">
          <div className="ha-showcase-copy">
            <span className="ha-eyebrow"><span className="ha-pulse" /> Scenes</span>
            <h2>One tap. The whole house responds.</h2>
            <p>
              Compose lighting, climate, access and energy into scenes that run exactly
              the way your household does. Triggers evaluate on-device telemetry, so the
              house keeps working when the internet does not.
            </p>
            <ul className="ha-scene-list">
              {SCENES.map((scene) => (
                <li key={scene.name}>
                  <span className={`ha-scene-dot ${scene.tone}`} />
                  <div>
                    <strong>{scene.name}</strong>
                    <small>{scene.detail}</small>
                  </div>
                  <Icon name="arrow" />
                </li>
              ))}
            </ul>
          </div>
          <div className="ha-showcase-visual">
            <div className="ha-room-card">
              <div className="ha-room-head">
                <span className="ha-room-icon"><Icon name="home" /></span>
                <div>
                  <strong>Lounge</strong>
                  <small>4 devices · scene active</small>
                </div>
                <span className="ha-live"><span /> On</span>
              </div>
              <div className="ha-room-grid">
                <div className="ha-room-tile"><Icon name="bolt" /><strong>32%</strong><small>Dimmed</small></div>
                <div className="ha-room-tile"><Icon name="climate" /><strong>22°</strong><small>Cooling</small></div>
                <div className="ha-room-tile"><Icon name="camera" /><strong>HD</strong><small>Streaming</small></div>
                <div className="ha-room-tile"><Icon name="energy" /><strong>0.8</strong><small>kWh</small></div>
              </div>
              <div className="ha-room-foot">
                <span className="ha-chip on"><span className="ha-chip-dot" /> Movie night</span>
                <span className="ha-room-time">Runs until 23:30</span>
              </div>
            </div>
            <div className="ha-ring" aria-hidden>
              <span /><span /><span />
            </div>
          </div>
        </section>

        <section className="ha-security" id="security">
          <div className="ha-security-card">
            <span className="ha-security-icon"><Icon name="shield" /></span>
            <div>
              <h2>Secure by default, private by design.</h2>
              <p>
                Tenant-isolated data, 2FA-ready sign-in and a complete command audit trail.
                Your home telemetry is never pooled with another household — every query is
                scoped to your company and your devices.
              </p>
            </div>
            <ul>
              <li><Icon name="check" /> Tenant-scoped device access</li>
              <li><Icon name="check" /> Two-factor authentication</li>
              <li><Icon name="check" /> Full command &amp; trigger history</li>
              <li><Icon name="check" /> Wildcard SSO across Preyone apps</li>
            </ul>
          </div>
        </section>

        <section className="ha-section ha-how" id="how">
          <div className="ha-section-head">
            <span className="ha-eyebrow"><span className="ha-pulse" /> How it works</span>
            <h2>From box to intelligent home.</h2>
          </div>
          <div className="ha-steps">
            <div className="ha-step">
              <span className="ha-step-num">01</span>
              <h3>Connect</h3>
              <p>Pair switches, sensors, locks, meters and your Starlink gateway over MQTT, HTTP or manual bridges.</p>
            </div>
            <div className="ha-step">
              <span className="ha-step-num">02</span>
              <h3>Automate</h3>
              <p>Build threshold rules and scenes that react to temperature, energy, presence and gateway health.</p>
            </div>
            <div className="ha-step">
              <span className="ha-step-num">03</span>
              <h3>Control</h3>
              <p>Sign in from any browser. Commands land on the device in under 120 ms and stream back instantly.</p>
            </div>
          </div>
        </section>

        <section className="ha-final-cta">
          <div className="ha-final-glow" aria-hidden />
          <span className="ha-eyebrow"><span className="ha-pulse" /> Ready when you are</span>
          <h2>Your home is already smart.<br />Give it a brain.</h2>
          <p>
            Home automation is part of the Preyone 360 suite. Subscribers sign in once and
            manage every device, scene and gateway from one place.
          </p>
          <div className="ha-cta-row">
            <button className="ha-btn ha-btn-primary ha-btn-lg" type="button" onClick={onLogin}>
              <Icon name="key" />
              Log in to manage your home
            </button>
            <button className="ha-btn ha-btn-ghost ha-btn-lg" type="button" onClick={onSubscribe}>
              Subscribe to Preyone 360
              <Icon name="arrow" />
            </button>
          </div>
        </section>
      </main>

      <footer className="ha-footer">
        <div className="ha-footer-brand">
          <span className="ha-brand-mark"><Icon name="home" /></span>
          <div>
            <strong>Preyone Home</strong>
            <small>Intelligent automation for modern Zimbabwean homes.</small>
          </div>
        </div>
        <div className="ha-footer-links">
          <a href="#platform">Platform</a>
          <a href="#security">Security</a>
          <a href="https://preyone.com/business-apps">Preyone 360</a>
          <a href="https://preyone.com">preyone.com</a>
        </div>
        <div className="ha-footer-meta">
          <span>© {new Date().getFullYear()} Preyone</span>
          <span className="ha-footer-status"><span /> All systems operational</span>
        </div>
      </footer>
    </div>
  );
}
