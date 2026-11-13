/**
 * Shared Wi-Fi session shapes for the Active Sessions overhaul.
 *
 * Mirrors GET /api/ruijie/sessions (see EnrichedSession in src/routes/ruijie.ts).
 * Everything the Ruijie console shows is carried through rather than dropped:
 * 34 fields from `current-user`, plus the radio/health half from `sta_users`.
 */

/** Ruijie's client-class taxonomy — drives the filter pills and the donut. */
export type DeviceClass =
  | 'Smartphone'
  | 'Tablets'
  | 'Smartwatch'
  | 'PC'
  | 'Camera'
  | 'Audio & Video'
  | 'Network Devices'
  | 'Office devices'
  | 'IoT devices'
  | 'Other';

export const DEVICE_CLASSES: readonly DeviceClass[] = [
  'Smartphone',
  'Tablets',
  'Smartwatch',
  'PC',
  'Camera',
  'Audio & Video',
  'Network Devices',
  'Office devices',
  'IoT devices',
  'Other',
] as const;

/** Primary tier — mirrors the Ruijie client-monitor tab bar. */
export type PrimaryFilter =
  | 'All'
  | 'Wireless'
  | 'Wired'
  | 'Blocklist'
  | 'Wi-Fi Experience'
  | 'Auth Clients';

export const PRIMARY_FILTERS: readonly PrimaryFilter[] = [
  'All',
  'Wireless',
  'Wired',
  'Blocklist',
  'Wi-Fi Experience',
  'Auth Clients',
] as const;

export type BandGroup = '5 GHz' | '2.4 GHz' | 'Wired/Other';

/** `VOUCHER` and `MAC_AUTO` are the two modes this deployment can produce. */
export type AuthMethod = 'VOUCHER' | 'PPSK' | 'MAC_AUTO';

/** Source list behind a historical client row (see GET /api/ruijie/history). */
export type HistorySource = 'access_log' | 'users' | 'voucher_redemptions' | 'voucher_devices';

/** Which population the client monitor is showing. */
export type ViewMode = 'online' | 'historical';

/**
 * One MAC the portal has ever seen, aggregated from the local logs.
 * Mirrors HistoricalClient in src/routes/ruijie.ts.
 */
export interface HistoricalClient {
  /** 12-hex uppercase, no separators. */
  mac: string;
  ip: string | null;
  /** Best name available: users.full_name, else voucher_devices.label. */
  name: string | null;
  label: string | null;
  /** Verified voucher code only (strict contract). */
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  bindingSource?: string | null;
  userAgent: string | null;
  /** ISO-8601. */
  firstSeen: string | null;
  lastSeen: string | null;
  events: number;
  sources: HistorySource[] | string[];
}

export interface WifiSession {
  mac: string;
  ip: string | null;
  sessionId?: string | null;
  /**
   * Ruijie's own label — a device/person name (live: "vivo Y22 Leslie").
   * NEVER rendered in the Accounts column; see `code`.
   */
  username: string | null;
  /** Raw Ruijie `account` field when it differs from `username`. */
  account?: string | null;
  /** Verified voucher code only (strict contract). Null when unauthenticated. */
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  /** Portal account matched by MAC (GET /api/ruijie/sessions only). */
  accountName?: string | null;
  accountPhone?: string | null;
  accountSessionExpiresAt?: string | null;
  /** Which local source produced `code`. */
  bindingSource?: string | null;
  /** Which fallback stage matched: direct code, MAC binding, or IP/portal. */
  matchedBy?: 'code' | 'mac' | 'ip' | null;
  /** Backend AUTH classification (falls back to code presence). */
  authMethod?: AuthMethod | null;
  /** True when a no-code client is explicitly on the MAC whitelist. */
  macWhitelisted?: boolean;
  /** Voucher data allowance / usage in bytes. Null when unknown or uncapped. */
  dataLimitBytes?: number | null;
  dataUsedBytes?: number | null;
  dataLeftBytes?: number | null;
  isUncapped?: boolean | null;
  /** Active devices linked to the same voucher code. */
  activeDeviceCount?: number;
  deviceMacs?: string[];

  usedMb: number | null;
  upMb: number | null;
  downMb: number | null;
  onlineTimeSec: number | null;
  /** Epoch ms the client came online. */
  connectedAt: number | null;

  ssid: string | null;
  band: string | null;
  rssi: number | null;
  /** Bits per second — see formatRate() in utils/format. */
  upRate: number | null;
  downRate: number | null;

  // ── Identity ──────────────────────────────────────────────────────────────
  /** Alias / custom name shown in the Name column. */
  label?: string | null;
  /** AP name (current-user `deviceName`). */
  deviceName?: string | null;
  apSn?: string | null;
  apName?: string | null;
  buildingName?: string | null;
  groupName?: string | null;
  connectType?: string | null;
  clientSource?: string | null;
  manufacturer?: string | null;
  manufacturerId?: string | null;
  staCategory?: string | null;
  staLabel?: string | null;
  staLabelName?: string | null;
  staOs?: string | null;
  staModel?: string | null;
  isMlo?: boolean | null;
  mloBand?: string | null;

  // ── Radio / health ────────────────────────────────────────────────────────
  channel?: string | null;
  utilization?: number | null;
  /** 0-100 connection health score (Ruijie AI). */
  score?: number | null;
  scoreReason?: string | null;
  timeDelayMs?: number | null;
  floorNoise?: number | null;
  pktLoseRate?: number | null;

  /**
   * Audit-trail extras carried by GET /api/ruijie/history rows only.
   * Null/absent on live cloud sessions — those never had a log entry.
   */
  history?: {
    firstSeen: number | null;
    lastSeen: number | null;
    events: number;
    sources: string[];
    userAgent: string | null;
  } | null;
}

// ── Voucher Consumption & Status tab (GET /api/admin/voucher-analytics) ────
export type ConsumptionStatus =
  | 'ok'
  | 'low'        // >= 80% used
  | 'critical'   // >= 95% used
  | 'exhausted'  // >= 100% used
  | 'unlimited'  // uncapped bundle (quotaMb <= 0)
  | 'idle'       // 0 bytes used, capped bundle
  | 'disabled'   // disableStatus != 0 (used up / cancelled)
  | 'expired';   // Ruijie expiryTime has passed

export interface VoucherConsumptionRow {
  code: string;
  packageName: string | null;
  /** Local voucher holder details, joined by PIN. Null for Ruijie-only codes. */
  holderName?: string | null;
  holderPhone?: string | null;
  priceAmount?: number | null;
  usedMB: number | null;
  totalMB: number | null;
  pct: number | null;
  /** Ruijie expiry timestamp in epoch-ms; null when the roster has no expiry. */
  expiryTime?: number | null;
  status: ConsumptionStatus;
  onlineNow: boolean;
  activeDevices?: number;
  maxDevices?: number | null;
  alertsSent: { t80: number; t95: number };
  lastAlertAt: string | Date | null;
  /**
   * false when the row came from the local vouchers table because the Ruijie
   * roster was temporarily unavailable — usage fields are unknown, not zero.
   */
  usageKnown?: boolean;
}

export interface VoucherConsumptionSummary {
  total: number;
  ok: number;
  low: number;
  critical: number;
  exhausted: number;
  unlimited: number;
  idle: number;
  disabled: number;
  expired: number;
}

export interface VoucherConsumptionResponse {
  generatedAt: string | Date;
  /** false when Ruijie keys are missing — rows empty, tab shows roster-offline state. */
  live: boolean;
  /** true when the roster is a cached snapshot served because the refresh failed. */
  stale?: boolean;
  /** When the roster snapshot was last pulled from Ruijie. */
  rosterFetchedAt?: string | Date | null;
  /** true when the tab is showing local vouchers without live usage. */
  degraded?: boolean;
  /** Human-readable reason for `degraded`; safe to display. */
  warning?: string | null;
  /**
   * Admin-configured low/critical percentages (Settings → Alert Thresholds).
   * Absent on older responses — the tab then assumes 80/95.
   */
  thresholds?: { warn: number; critical: number } | null;
  summary: VoucherConsumptionSummary;
  rows: VoucherConsumptionRow[];
}
