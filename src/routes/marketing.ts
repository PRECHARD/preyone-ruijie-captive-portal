import { Router, type Response } from 'express';

/**
 * Public marketing content for homeautomate.preyone.com.
 *
 * The Home Automation SPA is a static Vite bundle, so every marketing page
 * (`/platform`, `/scenes`, `/solutions/*`, …) asks this router for its copy.
 * Keeping the content here means the page shells stay tiny, the same JSON can
 * feed future surfaces (site search, sitemap, app cards) and a copy change does
 * not require a SPA rebuild. All endpoints are read-only, unauthenticated and
 * cached at the edge — nothing here touches vouchers, RADIUS or the gateway.
 */
export const marketingRouter = Router();

type MarketingStat = { value: string; label: string; foot?: string };
type MarketingCard = { icon: string; title: string; body: string; tag?: string };
type MarketingStep = { number: string; title: string; body: string };
type MarketingCta = {
  eyebrow?: string;
  title: string;
  body: string;
  label: string;
  href: string;
  secondaryLabel?: string;
  secondaryHref?: string;
};

type MarketingPage = {
  slug: string;
  eyebrow: string;
  title: string;
  lede: string;
  stats: MarketingStat[];
  cards: MarketingCard[];
  steps?: MarketingStep[];
  bullets?: string[];
  cta: MarketingCta;
};

const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';

function send<T>(res: Response, payload: T): void {
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.json(payload);
}

const PLATFORM: MarketingPage = {
  slug: 'platform',
  eyebrow: 'The platform',
  title: 'One command centre for the whole home.',
  lede:
    'Lighting, climate, access, energy and Starlink in a single live view. No hubs to babysit, no vendor silos — just a fast interface that works on the wall tablet, the phone in your pocket and the browser at the office.',
  stats: [
    { value: '99.98%', label: 'Gateway uptime', foot: 'measured across the fleet' },
    { value: '< 120ms', label: 'Command latency', foot: 'dashboard to device' },
    { value: '50+', label: 'Device profiles', foot: 'switches to satellites' },
    { value: '24/7', label: 'Telemetry', foot: 'sampled every five seconds' },
  ],
  cards: [
    {
      icon: 'bolt',
      title: 'Lighting & scenes',
      tag: 'Instant',
      body: 'Dim, schedule and group every circuit. One tap for Dinner, Movie or Away — across the whole house.',
    },
    {
      icon: 'climate',
      title: 'Climate control',
      tag: 'Adaptive',
      body: 'Room-by-room temperature, geyser scheduling and humidity rules that keep the house comfortable and the bill low.',
    },
    {
      icon: 'shield',
      title: 'Security & access',
      tag: 'Guarded',
      body: 'Smart locks, gates and cameras with armed/disarmed scenes and a tamper-proof activity trail.',
    },
    {
      icon: 'energy',
      title: 'Energy intelligence',
      tag: 'Metered',
      body: 'Live kWh, cost per room and load-shedding patterns. Know what is drawing power before the meter does.',
    },
    {
      icon: 'satellite',
      title: 'Starlink gateway',
      tag: 'Connected',
      body: 'Uptime, latency and throughput are sampled continuously, with automatic failover alerts when the link drops.',
    },
    {
      icon: 'spark',
      title: 'Automation rules',
      tag: 'Autonomous',
      body: 'If this, then that. Threshold rules run on every telemetry sample — no cloud round-trip, no code.',
    },
  ],
  steps: [
    { number: '01', title: 'Connect', body: 'Pair switches, sensors, locks, meters and your Starlink gateway over MQTT, HTTP or manual bridges.' },
    { number: '02', title: 'Automate', body: 'Build threshold rules and scenes that react to temperature, energy, presence and gateway health.' },
    { number: '03', title: 'Control', body: 'Sign in from any browser. Commands land on the device in under 120 ms and stream back instantly.' },
  ],
  cta: {
    eyebrow: 'Ready when you are',
    title: 'Your home is already smart. Give it a brain.',
    body: 'Home automation is part of the Preyone 360 suite. Subscribers sign in once and manage every device, scene and gateway from one place.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Log in',
    secondaryHref: '/login',
  },
};

const SCENES: MarketingPage = {
  slug: 'scenes',
  eyebrow: 'Scenes',
  title: 'One tap. The whole house responds.',
  lede:
    'Compose lighting, climate, access and energy into scenes that run exactly the way your household does. Triggers evaluate on-device telemetry, so the house keeps working when the internet does not.',
  stats: [
    { value: '1 tap', label: 'Whole-home recall', foot: 'any room, any screen' },
    { value: '6', label: 'Devices per scene', foot: 'average household' },
    { value: '0', label: 'Cloud round-trips', foot: 'rules run on the edge' },
    { value: '24/7', label: 'Offline execution', foot: 'internet optional' },
  ],
  cards: [
    {
      icon: 'home',
      title: 'Good morning',
      tag: '06:00',
      body: 'Blinds open, geyser starts, gate unlocks and the kitchen lights warm to 40%.',
    },
    {
      icon: 'lock',
      title: 'Away',
      tag: 'One tap',
      body: 'All lights off, cameras armed, locks secured and energy-hungry plugs isolated.',
    },
    {
      icon: 'camera',
      title: 'Movie night',
      tag: 'Lounge',
      body: 'Lounge dimmed to 20%, AC to 22°C, notifications muted and the TV input switched.',
    },
    {
      icon: 'energy',
      title: 'Load-shedding',
      tag: 'Automatic',
      body: 'Essentials only, inverter alert, Starlink backup and non-critical circuits parked.',
    },
    {
      icon: 'satellite',
      title: 'Welcome home',
      tag: 'Geofence',
      body: 'Gate opens on approach, hallway lights guide you in and the geyser catches up overnight.',
    },
    {
      icon: 'spark',
      title: 'Custom scenes',
      tag: 'Yours',
      body: 'Build a scene from any device, trigger or schedule. Save it once and call it from anywhere.',
    },
  ],
  steps: [
    { number: '01', title: 'Pick the moment', body: 'Name the scene after the way you live: Sunday lunch, study time, guests arriving.' },
    { number: '02', title: 'Add the devices', body: 'Choose every light, thermostat, lock and plug that should respond, then set the target state.' },
    { number: '03', title: 'Run it anywhere', body: 'Trigger from the dashboard, a wall switch, a schedule or a telemetry threshold.' },
  ],
  cta: {
    eyebrow: 'Scenes that fit',
    title: 'Build the moments your home already has.',
    body: 'Start with two scenes and grow into a full routine. Preyone Home keeps every scene versioned and reversible.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Explore the platform',
    secondaryHref: '/platform',
  },
};

const SECURITY: MarketingPage = {
  slug: 'security',
  eyebrow: 'Security',
  title: 'Secure by default, private by design.',
  lede:
    'Tenant-isolated data, 2FA-ready sign-in and a complete command audit trail. Your home telemetry is never pooled with another household — every query is scoped to your company and your devices.',
  stats: [
    { value: '2FA', label: 'Sign-in protection', foot: 'TOTP-ready accounts' },
    { value: '100%', label: 'Commands audited', foot: 'who, what, when' },
    { value: 'Tenant', label: 'Data isolation', foot: 'per-company scoping' },
    { value: 'TLS', label: 'In transit', foot: 'HTTPS everywhere' },
  ],
  cards: [
    {
      icon: 'lock',
      title: 'Smart locks & gates',
      tag: 'Access',
      body: 'Lock, unlock and verify every entry point. Each command is attributed to a user and kept in the audit trail.',
    },
    {
      icon: 'camera',
      title: 'Camera awareness',
      tag: 'Watch',
      body: 'Arm cameras with a scene, see their health in the dashboard and get alerted when a feed drops.',
    },
    {
      icon: 'shield',
      title: 'Armed / disarmed scenes',
      tag: 'State',
      body: 'One action secures the house: locks down, cameras armed, motion rules live and alerts routed.',
    },
    {
      icon: 'key',
      title: 'Two-factor authentication',
      tag: 'Identity',
      body: 'Add a second factor to the Preyone account that protects every app in the suite.',
    },
    {
      icon: 'energy',
      title: 'Tamper & anomaly rules',
      tag: 'Detect',
      body: 'Unexpected device state changes, repeated unlocks and offline sensors surface as alerts.',
    },
    {
      icon: 'spark',
      title: 'Full command history',
      tag: 'Audit',
      body: 'Every dashboard action, trigger and automation result is written to a searchable timeline.',
    },
  ],
  bullets: [
    'Tenant-scoped device access',
    'Two-factor authentication',
    'Full command & trigger history',
    'Wildcard SSO across Preyone apps',
  ],
  cta: {
    eyebrow: 'Peace of mind',
    title: 'Know the house is secure, even when you are not there.',
    body: 'Security is built into the platform, not sold as an add-on. Every home starts with an audited, tenant-scoped control plane.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'See how it works',
    secondaryHref: '/how-it-works',
  },
};

const LIGHTING: MarketingPage = {
  slug: 'solutions/lighting',
  eyebrow: 'Solutions · Smart lighting',
  title: 'Light that follows the rhythm of your home.',
  lede:
    'From a single dimmer to every circuit in the house, Preyone Home gives you precise control, schedules and scenes without rewiring your life.',
  stats: [
    { value: '0–100%', label: 'Dimming range', foot: 'smooth, flicker-free' },
    { value: '1 tap', label: 'Whole-home recall', foot: 'scenes and schedules' },
    { value: '16M', label: 'Colour options', foot: 'on supported fixtures' },
    { value: 'Offline', label: 'Scene execution', foot: 'runs without internet' },
  ],
  cards: [
    { icon: 'bolt', title: 'Circuit control', tag: 'Core', body: 'Group lights by room, floor or function and control them together or independently.' },
    { icon: 'spark', title: 'Scenes & schedules', tag: 'Routine', body: 'Wake-up ramps, sunset warm-up and movie-night dimming that repeat reliably.' },
    { icon: 'energy', title: 'Energy-aware lighting', tag: 'Efficient', body: 'See which circuits burn the most power and schedule them around load-shedding.' },
    { icon: 'home', title: 'Room presets', tag: 'Comfort', body: 'Save a favourite level for every room and recall it from the wall tablet or phone.' },
    { icon: 'wifi', title: 'Works with your bridge', tag: 'Open', body: 'MQTT, HTTP and manual bridges bring supported fixtures into one dashboard.' },
    { icon: 'shield', title: 'Away simulation', tag: 'Secure', body: 'Vary lights while you travel so the house never looks empty.' },
  ],
  steps: [
    { number: '01', title: 'Map the circuits', body: 'Name each light or group by room so every scene reads like the house, not a wiring diagram.' },
    { number: '02', title: 'Set the levels', body: 'Choose brightness, colour temperature and transition speed for each scene.' },
    { number: '03', title: 'Automate the day', body: 'Schedule sunrise, sunset and occupancy rules, then override with one tap whenever you want.' },
  ],
  cta: {
    eyebrow: 'Smart lighting',
    title: 'See your home in a better light.',
    body: 'Tell us about your rooms and fixtures and we will map a lighting plan that fits the way you live.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Climate & energy',
    secondaryHref: '/solutions/climate',
  },
};

const CLIMATE: MarketingPage = {
  slug: 'solutions/climate',
  eyebrow: 'Solutions · Climate & energy',
  title: 'Comfort that pays for itself.',
  lede:
    'Room-by-room temperature, geyser scheduling and live energy insight. Preyone Home keeps the house comfortable while cutting the power you do not need.',
  stats: [
    { value: '22°C', label: 'Typical setpoint', foot: 'room by room' },
    { value: '−18%', label: 'Energy saved', foot: 'on scheduled homes' },
    { value: '5s', label: 'Telemetry cadence', foot: 'temperature and kWh' },
    { value: 'R 0', label: 'Guesswork', foot: 'live cost visibility' },
  ],
  cards: [
    { icon: 'climate', title: 'Room-by-room climate', tag: 'Comfort', body: 'Independent setpoints for bedrooms, lounge and home office, with humidity-aware rules.' },
    { icon: 'energy', title: 'Geyser scheduling', tag: 'Savings', body: 'Heat water when power is cheapest and the household actually needs it.' },
    { icon: 'bolt', title: 'Load-shedding routines', tag: 'Resilience', body: 'Drop non-essential circuits, protect the inverter and keep Starlink online.' },
    { icon: 'meter', title: 'Live kWh & cost', tag: 'Insight', body: 'See consumption per room and per device, priced in the currency you pay in.' },
    { icon: 'spark', title: 'Threshold triggers', tag: 'Automatic', body: 'If temperature climbs above 26°C, cool the room; if solar drops, shed the load.' },
    { icon: 'satellite', title: 'Starlink-aware', tag: 'Connected', body: 'Coordinate backup power and connectivity so critical systems stay up.' },
  ],
  steps: [
    { number: '01', title: 'Measure first', body: 'Connect meters, thermostats and the geyser so the platform can see what the house actually uses.' },
    { number: '02', title: 'Set comfort bands', body: 'Define the temperature and humidity range for each room, plus the hours that matter.' },
    { number: '03', title: 'Automate savings', body: 'Let rules trim the peaks, pre-heat before load-shedding and report the savings each month.' },
  ],
  cta: {
    eyebrow: 'Climate & energy',
    title: 'Comfort you can measure. Savings you can see.',
    body: 'We will size the sensors and routines around your home, geyser and inverter setup.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Smart lighting',
    secondaryHref: '/solutions/lighting',
  },
};

const AUDIO: MarketingPage = {
  slug: 'solutions/audio',
  eyebrow: 'Solutions · Audio & entertainment',
  title: 'Sound that moves with the moment.',
  lede:
    'Whole-home audio, room zones and entertainment scenes that wake the house, set the dinner mood and wind it down again — all from the same command centre.',
  stats: [
    { value: 'Multi', label: 'Room zones', foot: 'independent or grouped' },
    { value: '1 tap', label: 'Scene recall', foot: 'music + lighting + TV' },
    { value: 'Low', label: 'Latency', foot: 'local network playback' },
    { value: 'Any', label: 'Source', foot: 'streaming, TV or line-in' },
  ],
  cards: [
    { icon: 'bolt', title: 'Room zones', tag: 'Audio', body: 'Give every room its own source and volume, then group them for a party or a quiet evening.' },
    { icon: 'spark', title: 'Entertainment scenes', tag: 'Routine', body: 'Dim the lights, switch the TV input and start the playlist with one tap.' },
    { icon: 'home', title: 'Dinner & hosting', tag: 'Mood', body: 'Warm lighting, background music and a comfortable temperature arrive together.' },
    { icon: 'camera', title: 'TV & media control', tag: 'Integrated', body: 'Bring supported TVs, amps and streamers into the same scene engine as the lights.' },
    { icon: 'wifi', title: 'Local-first playback', tag: 'Reliable', body: 'Streams stay on the local network when the internet link is unstable.' },
    { icon: 'key', title: 'Guest-friendly', tag: 'Simple', body: 'Give visitors a single “Guest” scene instead of a crash course in your AV rack.' },
  ],
  steps: [
    { number: '01', title: 'Define the zones', body: 'Name each room and the speakers or media players that belong to it.' },
    { number: '02', title: 'Build the moment', body: 'Pair audio with lighting, climate and blinds to create a complete entertainment scene.' },
    { number: '03', title: 'Play it anywhere', body: 'Recall the scene from the dashboard, a wall switch or a voice assistant bridge.' },
  ],
  cta: {
    eyebrow: 'Audio & entertainment',
    title: 'Set the scene, not the volume.',
    body: 'Tell us what you listen to and where, and we will design zones that stay simple to live with.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Explore scenes',
    secondaryHref: '/scenes',
  },
};

const HOW_IT_WORKS: MarketingPage = {
  slug: 'how-it-works',
  eyebrow: 'How it works',
  title: 'From box to intelligent home.',
  lede:
    'A Preyone Home install is deliberately boring: connect the devices, describe the routines, and let the platform do the remembering. Most homes are live in a single visit.',
  stats: [
    { value: '1 day', label: 'Typical install', foot: 'standard home' },
    { value: '5s', label: 'Telemetry cadence', foot: 'continuous sampling' },
    { value: '< 120ms', label: 'Command latency', foot: 'dashboard to device' },
    { value: '24/7', label: 'Monitoring', foot: 'gateway and devices' },
  ],
  cards: [
    { icon: 'wifi', title: 'Connect', tag: 'Step 01', body: 'Pair switches, sensors, locks, meters and the Starlink gateway over MQTT, HTTP or manual bridges.' },
    { icon: 'spark', title: 'Automate', tag: 'Step 02', body: 'Build threshold rules and scenes that react to temperature, energy, presence and gateway health.' },
    { icon: 'key', title: 'Control', tag: 'Step 03', body: 'Sign in from any browser. Commands land on the device in under 120 ms and stream back instantly.' },
    { icon: 'shield', title: 'Secure', tag: 'Step 04', body: 'Turn on two-factor authentication, scope the household and review the command audit trail.' },
    { icon: 'energy', title: 'Optimise', tag: 'Step 05', body: 'Watch the first weeks of telemetry, then trim schedules and thresholds around real usage.' },
    { icon: 'satellite', title: 'Stay online', tag: 'Step 06', body: 'Starlink health is monitored continuously, with alerts and backup routines when the link drops.' },
  ],
  steps: [
    { number: '01', title: 'Walkthrough', body: 'We map the rooms, circuits and devices you want on the platform, and confirm what needs a bridge.' },
    { number: '02', title: 'Install & pair', body: 'Devices are mounted, paired and labelled. Every room appears in the dashboard before we leave.' },
    { number: '03', title: 'Handover', body: 'You get a short tour, the scenes you asked for and a support line for the first month.' },
  ],
  cta: {
    eyebrow: 'Get started',
    title: 'Book a home automation walkthrough.',
    body: 'Tell us about the house and we will come back with a device plan, a scene plan and a clear price.',
    label: 'GET CONNECTED',
    href: '/contact',
    secondaryLabel: 'Explore the platform',
    secondaryHref: '/platform',
  },
};

const SOLUTIONS_INDEX = {
  slug: 'solutions',
  eyebrow: 'Solutions',
  title: 'Pick the room. We will wire the intelligence.',
  lede:
    'Every solution shares the same command centre, so lighting, climate and audio can run as one routine instead of three separate apps.',
  solutions: [
    {
      slug: 'solutions/lighting',
      title: 'Smart Lighting',
      body: 'Precise dimming, room presets and scenes that follow the day.',
      href: '/solutions/lighting',
      icon: 'bolt',
    },
    {
      slug: 'solutions/climate',
      title: 'Climate & Energy',
      body: 'Comfort bands, geyser scheduling and live kWh visibility.',
      href: '/solutions/climate',
      icon: 'climate',
    },
    {
      slug: 'solutions/audio',
      title: 'Audio & Entertainment',
      body: 'Zoned sound and entertainment scenes that stay simple.',
      href: '/solutions/audio',
      icon: 'spark',
    },
  ],
};

const CONTACT = {
  slug: 'contact',
  eyebrow: 'Get connected',
  title: "Let's wire your home.",
  lede:
    'Tell us about the house, the rooms and the devices you already own. A Preyone Home specialist will map a plan and come back with a clear scope and price.',
  channels: [
    {
      icon: 'mail',
      label: 'Email',
      value: 'support@preyone.com',
      href: 'mailto:support@preyone.com?subject=Preyone%20Home%20automation%20enquiry',
    },
    { icon: 'phone', label: 'Call us', value: '+263 771 327 202', href: 'tel:+263771327202' },
    { icon: 'chat', label: 'WhatsApp', value: 'Chat with our team', href: 'https://wa.me/263771327202' },
    { icon: 'pin', label: 'Location', value: 'Harare, Zimbabwe', href: undefined },
  ],
  details: [
    { label: 'Coverage', value: 'Harare, Zimbabwe and surrounding areas' },
    { label: 'Response time', value: 'Within one business day' },
    { label: 'Home visits', value: 'By appointment, Monday to Saturday' },
    { label: 'Suite access', value: 'Included with Preyone 360 subscriptions' },
  ],
  steps: [
    { number: '01', title: 'Tell us about the home', body: 'Rooms, devices and the routines you want. A photo of the distribution board helps.' },
    { number: '02', title: 'Get a plan', body: 'We propose the bridges, sensors and scenes that fit your budget and wiring.' },
    { number: '03', title: 'Book the install', body: 'Choose a slot and we will pair, label and hand over the dashboard in one visit.' },
  ],
  cta: {
    eyebrow: 'Prefer to talk?',
    title: 'Call the home automation desk.',
    body: 'Weekdays 08:00–17:00 CAT. If we miss you, leave a message and we will call back the same day.',
    label: 'CALL +263 771 327 202',
    href: 'tel:+263771327202',
    secondaryLabel: 'Email support',
    secondaryHref: 'mailto:support@preyone.com?subject=Preyone%20Home%20automation%20enquiry',
  },
};

const PAGES: Array<[string, MarketingPage]> = [
  ['/platform', PLATFORM],
  ['/scenes', SCENES],
  ['/security', SECURITY],
  ['/solutions/lighting', LIGHTING],
  ['/solutions/climate', CLIMATE],
  ['/solutions/audio', AUDIO],
  ['/how-it-works', HOW_IT_WORKS],
];

for (const [path, page] of PAGES) {
  marketingRouter.get(path, (_req, res) => send(res, page));
}

marketingRouter.get('/solutions', (_req, res) => send(res, SOLUTIONS_INDEX));
marketingRouter.get('/contact', (_req, res) => send(res, CONTACT));
