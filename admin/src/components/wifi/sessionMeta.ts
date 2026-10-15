import { formatMac } from '../../utils/format';
import type {
  AuthMethod,
  BandGroup,
  DeviceClass,
  HistoricalClient,
  PrimaryFilter,
  WifiSession,
} from '../../types/wifi';

// Pure, dependency-free helpers shared by the summary cards, filter tabs and
// session table. Kept out of the type module so types/wifi.ts stays types-only.

/** The four top-level client types Ruijie's Client Type donut shows. */
export type ClientType = 'Smartphone' | 'PC' | 'IoT Devices' | 'Other';

export const CLIENT_TYPES: ClientType[] = ['Smartphone', 'PC', 'IoT Devices', 'Other'];

export function clientTypeOf(s: WifiSession): ClientType {
  const c = deviceClassOf(s);
  if (c === 'Smartphone' || c === 'Tablets' || c === 'Smartwatch') return 'Smartphone';
  if (c === 'PC' || c === 'Office devices') return 'PC';
  if (c === 'IoT devices' || c === 'Camera' || c === 'Network Devices') return 'IoT Devices';
  if (c === 'Audio & Video') return 'IoT Devices';
  return 'Other';
}

/**
 * Map one session onto Ruijie's device-class list.
 *
 * `staLabelName` is the most specific field Ruijie sends (live values:
 * "Smartphone", "iPhone", "Windows PC", "TV/TV Box", "Smart Gadgets");
 * `staCategory` and `staOs` are progressively coarser fallbacks.
 */
export function deviceClassOf(s: WifiSession): DeviceClass {
  const label = String(s.staLabelName ?? '').toLowerCase().trim();
  const cat = String(s.staCategory ?? '').toLowerCase().trim();
  const os = String(s.staOs ?? '').toLowerCase().trim();

  if (label) {
    if (label.includes('iphone') || label.includes('smartphone') || label.includes('phone')) return 'Smartphone';
    if (label.includes('tablet') || label.includes('ipad')) return 'Tablets';
    if (label.includes('watch')) return 'Smartwatch';
    if (label.includes('pc') || label.includes('computer')) return 'PC';
    if (label.includes('camera')) return 'Camera';
    if (label.includes('tv') || label.includes('audio') || label.includes('video')) return 'Audio & Video';
    if (label.includes('network') || label.includes('router')) return 'Network Devices';
    if (label.includes('office') || label.includes('printer') || label.includes('scanner')) return 'Office devices';
    if (label.includes('gadget') || label.includes('iot')) return 'IoT devices';
  }

  if (cat === 'computerdevices') return 'PC';
  if (cat === 'avdevices') return 'Audio & Video';
  if (cat === 'aidevices') return 'IoT devices';
  if (cat === 'mobiledevices') return 'Smartphone';

  if (os.includes('windows') || os.includes('mac os') || os.includes('linux')) return 'PC';
  if (os.includes('android') || os.includes('ios') || os.includes('harmony')) return 'Smartphone';

  return 'Other';
}

/** Ruijie reports band as "5G" / "2.4G"; wired clients land in Wired/Other. */
export function bandOf(s: WifiSession): BandGroup {
  const b = String(s.band ?? '').toLowerCase().trim();
  if (b.includes('5')) return '5 GHz';
  if (b.includes('2')) return '2.4 GHz';
  return 'Wired/Other';
}

function isWireless(s: WifiSession): boolean {
  const t = String(s.connectType ?? '').toLowerCase().trim();
  if (!t) return bandOf(s) !== 'Wired/Other';
  return t === 'wireless' || t === 'wifi' || t === 'wi-fi';
}

/**
 * How the client got onto the network.
 *
 * PPSK is declared for parity with the Ruijie console but this deployment has
 * no pre-shared-key SSIDs, so it can never be produced — a session is either
 * bound to a voucher or it was allowed by MAC.
 */
export function authMethodOf(s: WifiSession): AuthMethod {
  return s.code ? 'Voucher' : 'MAC Auto';
}

/** Name column: alias → model → manufacturer → MAC. */
export function displayNameOf(s: WifiSession): string {
  const alias = String(s.label ?? '').trim();
  if (alias) return alias;
  const model = String(s.staModel ?? '').trim();
  if (model) return model;
  const maker = String(s.manufacturer ?? '').trim();
  if (maker) return maker;
  return formatMac(s.mac);
}

/**
 * Traffic cell — binary base to match the backend's MB arithmetic.
 * Unknown is unknown: a live client whose accounting has not landed yet shows
 * an em-dash rather than a fabricated "0 MB".
 */
export function formatTraffic(mb?: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** "Connected At" — YYYY/MM/DD HH:mm:ss, local time. */
export function formatConnectedAt(ms?: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return (
    `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

export function matchesPrimary(s: WifiSession, f: PrimaryFilter): boolean {
  switch (f) {
    case 'All':
      return true;
    case 'Wireless':
      return isWireless(s);
    case 'Wired':
      return !isWireless(s);
    // No blocklist source exists yet — keep the tab honest at zero rather
    // than inventing entries.
    case 'Blocklist':
      return false;
    // Ruijie scores clients 0-100; below 60 is the console's "poor" band.
    case 'Wi-Fi Experience':
      return s.score != null && s.score < 60;
    case 'Auth Clients':
      return !!s.code;
    default:
      return true;
  }
}

export function matchesDeviceClass(s: WifiSession, c: DeviceClass | 'All'): boolean {
  return c === 'All' || deviceClassOf(s) === c;
}

export interface SessionSummary {
  total: number;
  clientTypes: { key: ClientType; value: number }[];
  bands: { key: BandGroup; value: number }[];
  totalMb: number;
  /** Top consumers, already sorted and limited to `limit`. */
  ranking: {
    mac: string;
    name: string;
    model: string | null;
    manufacturer: string | null;
    type: string | null;
    mb: number;
    pct: number;
  }[];
}

export function summarize(sessions: WifiSession[], limit = 4): SessionSummary {
  const typeCounts = new Map<ClientType, number>();
  const bandCounts = new Map<BandGroup, number>();
  let totalMb = 0;

  for (const s of sessions) {
    const t = clientTypeOf(s);
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    const b = bandOf(s);
    bandCounts.set(b, (bandCounts.get(b) ?? 0) + 1);
    totalMb += Number(s.usedMb) || 0;
  }

  const clientTypes = CLIENT_TYPES.map((key) => ({ key, value: typeCounts.get(key) ?? 0 }));
  const bands: BandGroup[] = ['5 GHz', '2.4 GHz', 'Wired/Other'];
  const bandList = bands.map((key) => ({ key, value: bandCounts.get(key) ?? 0 }));

  const ranking = sessions
    .map((s) => ({ s, mb: Number(s.usedMb) || 0 }))
    .filter((r) => r.mb > 0)
    .sort((a, b) => b.mb - a.mb)
    .slice(0, limit)
    .map(({ s, mb }) => ({
      mac: s.mac,
      name: displayNameOf(s),
      model: s.staModel ?? null,
      manufacturer: s.manufacturer ?? null,
      type: s.staLabelName ?? null,
      mb,
      pct: totalMb > 0 ? Math.round((mb / totalMb) * 100) : 0,
    }));

  return { total: sessions.length, clientTypes, bands: bandList, totalMb, ranking };
}

/**
 * Real-time search across the fields the console lets you type into: IP, MAC
 * (any common written form — bare, colon, dash, dot — since Ruijie itself
 * sends bare 12-hex) and the display name, plus the holder / voucher / model
 * text that sits behind those columns.
 */
export function matchesSearch(s: WifiSession, query: string): boolean {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;

  const fields = [
    displayNameOf(s),
    s.ip,
    s.mac,
    s.username,
    s.code,
    s.holderName,
    s.staModel,
    s.manufacturer,
    s.staOs,
    s.deviceName,
    s.ssid,
  ];
  if (fields.some((f) => f != null && String(f).toLowerCase().includes(q))) return true;

  // MAC-shaped queries (≥4 hex digits, separators stripped) also match the
  // separator-free form the controller stores. Strip case-insensitively: the
  // live MACs arrive as "84:1B:77:12:AB:CD", so a lowercase-only class would
  // silently eat the uppercase A-F octets.
  const hex = q.replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
  if (hex.length >= 4) {
    return String(s.mac ?? '')
      .replace(/[^0-9A-Fa-f]/g, '')
      .toLowerCase()
      .includes(hex);
  }
  return false;
}

export function applyFilters(
  sessions: WifiSession[],
  primary: PrimaryFilter,
  deviceClass: DeviceClass | 'All',
  query?: string
): WifiSession[] {
  return sessions.filter(
    (s) =>
      matchesPrimary(s, primary) &&
      matchesDeviceClass(s, deviceClass) &&
      matchesSearch(s, query ?? '')
  );
}

const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Project one audit-trail row onto the live-session shape so both views render
 * through the same table. Telemetry the log never carried (signal, rates,
 * band, health) stays null rather than being invented.
 */
export function historicalToSession(h: HistoricalClient): WifiSession {
  return {
    mac: h.mac,
    ip: h.ip,
    sessionId: null,
    username: h.name ?? h.userAgent ?? null,
    code: h.code,
    holderName: h.holderName,
    holderPhone: h.holderPhone,
    bindingSource: h.bindingSource ?? null,
    usedMb: null,
    upMb: null,
    downMb: null,
    onlineTimeSec: null,
    connectedAt: toMs(h.lastSeen),
    ssid: null,
    band: null,
    rssi: null,
    upRate: null,
    downRate: null,
    label: h.label ?? h.name ?? null,
    manufacturer: null,
    staModel: null,
    staOs: null,
    staLabelName: null,
    channel: null,
    utilization: null,
    score: null,
    scoreReason: null,
    timeDelayMs: null,
    floorNoise: null,
    pktLoseRate: null,
    history: {
      firstSeen: toMs(h.firstSeen),
      lastSeen: toMs(h.lastSeen),
      events: h.events,
      sources: h.sources.map(String),
      userAgent: h.userAgent ?? null,
    },
  };
}
