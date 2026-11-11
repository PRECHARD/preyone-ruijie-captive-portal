import { Icon, type IconName } from './icons';
import { MarketingNav } from './MarketingNav';
import { SiteFooter } from './SiteFooter';

/**
 * Public landing page for homeautomate.preyone.com.
 *
 * The marketing surface is deliberately self-contained: no authenticated API
 * calls run here, so the page renders for logged-out visitors and search
 * crawlers. "Log in" hands off to the SPA's /login route.
 */

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
  onNavigate,
}: {
  onLogin: () => void;
  onSubscribe: () => void;
  onNavigate: (path: string) => void;
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

      <MarketingNav currentPath="/" onNavigate={onNavigate} onLogin={onLogin} />

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

      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
