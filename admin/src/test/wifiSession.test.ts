import { describe, it, expect } from 'vitest';
import type { HistoricalClient, WifiSession } from '../types/wifi';
import { formatMac } from '../utils/format';
import { detectDevice } from '../components/wifi/deviceIcons';
import {
  applyFilters,
  authMethodOf,
  bandOf,
  clientTypeOf,
  deviceClassOf,
  displayNameOf,
  formatConnectedAt,
  formatTraffic,
  historicalToSession,
  matchesPrimary,
  matchesSearch,
  summarize,
} from '../components/wifi/sessionMeta';

/** Minimal session with live Ruijie field values as defaults. */
function s(over: Partial<WifiSession> = {}): WifiSession {
  return {
    mac: '84:1B:77:12:AB:CD',
    ip: '192.168.1.50',
    username: 'M2003J15SC-636333004',
    sessionId: null,
    usedMb: 1500,
    upMb: 100,
    downMb: 1400,
    onlineTimeSec: 3600,
    connectedAt: 1792005974000,
    ssid: 'Preyone-UltraNet',
    band: '5G',
    rssi: -55,
    upRate: 120_000,
    downRate: 9_000_000,
    code: 'PIN-4821',
    holderName: 'Leslie',
    holderPhone: null,
    connectType: 'wireless',
    staLabelName: 'Smartphone',
    ...over,
  };
}

describe('deviceClassOf', () => {
  it('maps the live Ruijie staLabelName values onto the console classes', () => {
    expect(deviceClassOf(s({ staLabelName: 'Smartphone' }))).toBe('Smartphone');
    expect(deviceClassOf(s({ staLabelName: 'iPhone' }))).toBe('Smartphone');
    expect(deviceClassOf(s({ staLabelName: 'Windows PC' }))).toBe('PC');
    expect(deviceClassOf(s({ staLabelName: 'TV/TV Box' }))).toBe('Audio & Video');
    expect(deviceClassOf(s({ staLabelName: 'Smart Gadgets' }))).toBe('IoT devices');
  });

  it('falls back to staCategory, then staOs, then Other', () => {
    expect(deviceClassOf(s({ staLabelName: null, staCategory: 'avDevices' }))).toBe('Audio & Video');
    expect(deviceClassOf(s({ staLabelName: null, staCategory: null, staOs: 'Windows' }))).toBe('PC');
    expect(deviceClassOf(s({ staLabelName: null, staCategory: null, staOs: null }))).toBe('Other');
  });

  it('buckets the four top-level client types', () => {
    expect(clientTypeOf(s({ staLabelName: 'Smartphone' }))).toBe('Smartphone');
    expect(clientTypeOf(s({ staLabelName: 'Windows PC' }))).toBe('PC');
    expect(clientTypeOf(s({ staLabelName: 'TV/TV Box' }))).toBe('IoT Devices');
    expect(clientTypeOf(s({ staLabelName: null, staCategory: null, staOs: null }))).toBe('Other');
  });
});

describe('bandOf', () => {
  it('reads Ruijie band strings', () => {
    expect(bandOf(s({ band: '5G' }))).toBe('5 GHz');
    expect(bandOf(s({ band: '2.4G' }))).toBe('2.4 GHz');
    expect(bandOf(s({ band: null }))).toBe('Wired/Other');
  });
});

describe('matchesPrimary', () => {
  it('splits wireless from wired by connectType', () => {
    expect(matchesPrimary(s({ connectType: 'wireless' }), 'Wireless')).toBe(true);
    expect(matchesPrimary(s({ connectType: 'wireless' }), 'Wired')).toBe(false);
    expect(matchesPrimary(s({ connectType: 'wire' }), 'Wired')).toBe(true);
  });

  it('keeps Blocklist at zero — no blocklist source exists yet', () => {
    expect(matchesPrimary(s(), 'Blocklist')).toBe(false);
  });

  it('flags poor Wi-Fi experience below Ruijie score 60', () => {
    expect(matchesPrimary(s({ score: 42 }), 'Wi-Fi Experience')).toBe(true);
    expect(matchesPrimary(s({ score: 88 }), 'Wi-Fi Experience')).toBe(false);
    expect(matchesPrimary(s({ score: null }), 'Wi-Fi Experience')).toBe(false);
  });

  it('treats only voucher-bound clients as Auth Clients', () => {
    expect(matchesPrimary(s({ code: 'PIN-4821' }), 'Auth Clients')).toBe(true);
    expect(matchesPrimary(s({ code: null }), 'Auth Clients')).toBe(false);
  });
});

describe('authMethodOf', () => {
  it('reports VOUCHER only when a verified code exists, else MAC_AUTO', () => {
    expect(authMethodOf(s({ code: 'PIN-4821' }))).toBe('VOUCHER');
    expect(authMethodOf(s({ code: null, username: 'vivo Y22 Leslie' }))).toBe('MAC_AUTO');
  });

  it('prefers the backend classification when it is present', () => {
    expect(authMethodOf(s({ code: null, authMethod: 'MAC_AUTO', macWhitelisted: true }))).toBe('MAC_AUTO');
    expect(authMethodOf(s({ code: 'PIN-4821', authMethod: 'VOUCHER' }))).toBe('VOUCHER');
  });
});

describe('displayNameOf / MAC formatting', () => {
  it('prefers the alias, then model, then manufacturer, then the MAC', () => {
    expect(displayNameOf(s({ label: 'Reception iPad' }))).toBe('Reception iPad');
    expect(displayNameOf(s({ label: null, staModel: 'S21-Ultra' }))).toBe('S21-Ultra');
    expect(displayNameOf(s({ label: null, staModel: null, manufacturer: 'Xiaomi' }))).toBe('Xiaomi');
    expect(displayNameOf(s({ label: null, staModel: null, manufacturer: null }))).toBe('84:1B:77:12:AB:CD');
  });

  it('renders MACs as uppercase colon-separated pairs in every written form', () => {
    expect(formatMac('84:1b:77:12:ab:cd')).toBe('84:1B:77:12:AB:CD');
    expect(formatMac('841b.7712.abcd')).toBe('84:1B:77:12:AB:CD');
    expect(formatMac('84-1b-77-12-ab-cd')).toBe('84:1B:77:12:AB:CD');
    expect(formatMac('841b7712abcd')).toBe('84:1B:77:12:AB:CD');
  });
});

describe('formatters', () => {
  it('formats traffic in binary units and admits unknown totals', () => {
    expect(formatTraffic(1607.7)).toBe('1.57 GB');
    expect(formatTraffic(450)).toBe('450.0 MB');
    expect(formatTraffic(null)).toBe('—');
  });

  it('formats Connected At as YYYY/MM/DD HH:mm:ss', () => {
    expect(formatConnectedAt(1792005974000)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatConnectedAt(null)).toBe('—');
    expect(formatConnectedAt(0)).toBe('—');
  });
});

describe('summarize / applyFilters', () => {
  const sessions = [
    s({ mac: 'AA', usedMb: 1024, band: '5G', staLabelName: 'Smartphone' }),
    s({ mac: 'BB', usedMb: 512, band: '2.4G', staLabelName: 'Windows PC' }),
    s({ mac: 'CC', usedMb: 0, band: null, connectType: 'wire', staLabelName: null }),
  ];

  it('totals traffic and ranks the top consumers with their identity fields', () => {
    const sum = summarize(sessions);
    expect(sum.total).toBe(3);
    expect(sum.totalMb).toBe(1536);
    expect(sum.ranking.map((r) => r.mac)).toEqual(['AA', 'BB']);
    expect(sum.ranking[0].pct).toBe(67);
    // The card renders the device icon from these, not from an emoji.
    expect(sum.ranking[0].manufacturer).toBe(null);
    expect(sum.ranking[0].type).toBe('Smartphone');
    expect(sum.bands.find((b) => b.key === '5 GHz')?.value).toBe(1);
    expect(sum.bands.find((b) => b.key === 'Wired/Other')?.value).toBe(1);
  });

  it('composes the primary, device-class and search filters', () => {
    expect(applyFilters(sessions, 'All', 'All')).toHaveLength(3);
    expect(applyFilters(sessions, 'Wireless', 'All')).toHaveLength(2);
    expect(applyFilters(sessions, 'Wired', 'All')).toHaveLength(1);
    expect(applyFilters(sessions, 'All', 'PC')).toHaveLength(1);
    expect(applyFilters(sessions, 'Wireless', 'Camera')).toHaveLength(0);
    expect(applyFilters(sessions, 'All', 'All', 'PIN-4821')).toHaveLength(3);
    expect(applyFilters(sessions, 'All', 'All', 'nothing-matches')).toHaveLength(0);
  });
});

describe('matchesSearch', () => {
  it('matches on IP, name and MAC in any common written form', () => {
    const row = s({ label: 'Front Desk TV' });
    expect(matchesSearch(row, '192.168.1.50')).toBe(true);
    expect(matchesSearch(row, 'front desk')).toBe(true);
    expect(matchesSearch(row, '84:1B:77:12:AB:CD')).toBe(true);
    // Ruijie itself sends bare 12-hex, so separator-free input must match too.
    expect(matchesSearch(row, '841b7712')).toBe(true);
    expect(matchesSearch(row, '84-1b-77')).toBe(true);
  });

  it('also searches the holder, voucher code and model behind the columns', () => {
    expect(matchesSearch(s(), 'Leslie')).toBe(true);
    expect(matchesSearch(s(), 'PIN-4821')).toBe(true);
    expect(matchesSearch(s({ label: null, staModel: 'SM-A536B' }), 'sm-a536b')).toBe(true);
  });

  it('treats a blank query as match-all and rejects non-MAC fragments', () => {
    expect(matchesSearch(s(), '   ')).toBe(true);
    // Two stray hex digits are too coarse to be a MAC search.
    expect(matchesSearch(s(), 'zz')).toBe(false);
  });
});

describe('historicalToSession', () => {
  const hist = (over: Partial<HistoricalClient> = {}): HistoricalClient => ({
    mac: 'AABBCCDDEEFF',
    ip: '10.0.0.7',
    name: 'Leslie',
    label: 'Reception iPad',
    code: 'PIN-4821',
    holderName: 'Leslie',
    holderPhone: '0771234567',
    bindingSource: 'voucher_devices',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    firstSeen: '2026-10-01T08:00:00.000Z',
    lastSeen: '2026-10-14T19:26:14.000Z',
    events: 4,
    sources: ['users', 'voucher_devices'],
    ...over,
  });

  it('projects an audit row onto the live session shape', () => {
    const row = historicalToSession(hist());
    expect(row.mac).toBe('AABBCCDDEEFF');
    expect(row.code).toBe('PIN-4821');
    expect(row.holderName).toBe('Leslie');
    expect(row.label).toBe('Reception iPad');
    expect(row.connectedAt).toBe(Date.parse('2026-10-14T19:26:14.000Z'));
    expect(row.history?.firstSeen).toBe(Date.parse('2026-10-01T08:00:00.000Z'));
    expect(row.history?.events).toBe(4);
    expect(row.history?.sources).toEqual(['users', 'voucher_devices']);
  });

  it('never invents telemetry the log never carried', () => {
    const row = historicalToSession(hist());
    expect(row.usedMb).toBe(null);
    expect(row.rssi).toBe(null);
    expect(row.upRate).toBe(null);
    expect(row.downRate).toBe(null);
    expect(row.band).toBe(null);
    expect(row.score).toBe(null);
    // Traffic therefore reads as unknown, not as a fabricated zero.
    expect(formatTraffic(row.usedMb)).toBe('—');
  });

  it('survives malformed timestamps', () => {
    const row = historicalToSession(hist({ firstSeen: null, lastSeen: 'not-a-date' }));
    expect(row.history?.firstSeen).toBe(null);
    expect(row.connectedAt).toBe(null);
  });
});

describe('detectDevice', () => {
  it('prefers the brand mark, then the device shape', () => {
    expect(detectDevice('iPhone 13', 'Apple', 'Smartphone')).toEqual({ brand: 'apple', kind: 'phone' });
    expect(detectDevice('SM-G991B', 'Samsung', 'Smartphone')).toEqual({ brand: 'samsung', kind: 'phone' });
    expect(detectDevice('MacBookAir10,1', 'Apple', null)).toEqual({ brand: 'apple', kind: 'laptop' });
    expect(detectDevice('iPad', 'Apple', 'Tablets')).toEqual({ brand: 'apple', kind: 'tablet' });
  });

  it('lets an explicit shape beat the brand default', () => {
    expect(detectDevice('Hisense 55A6K', 'Hisense', null)).toEqual({ brand: null, kind: 'tv' });
    expect(detectDevice('Hisense', 'Hisense', 'Smartphone')).toEqual({ brand: null, kind: 'phone' });
    expect(detectDevice('Y22', 'vivo', 'TV/TV Box')).toEqual({ brand: 'vivo', kind: 'tv' });
  });

  it('falls back to a generic chip for unknown devices', () => {
    expect(detectDevice(null, null, 'Smart Gadgets')).toEqual({ brand: null, kind: 'generic' });
    expect(detectDevice(null, null, null)).toEqual({ brand: null, kind: 'generic' });
  });

  it('reads Windows PCs and routers from Ruijie labels', () => {
    expect(detectDevice(null, null, 'Windows PC').kind).toBe('desktop');
    expect(detectDevice('EG105G-P', 'Ruijie', 'Gateway').kind).toBe('router');
  });
});
