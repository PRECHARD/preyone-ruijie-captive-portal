// ─────────────────────────────────────────────────────────────────────────────
// Voucher expiry: one resolver, one formatter.
//
// WHY THIS EXISTS
// ---------------
// `vouchers.expires_at` is the CODE's shelf life and is frequently NULL ("never
// expires" — see src/db/migrate.ts). The share text and the printed card used to
// hand that NULL straight to `new Date(...)`, which is `new Date(null)` ===
// epoch 0, so customers were told their voucher was "Valid until 01/01/1970".
// Ruijie's roster adds a second wrinkle: `expiryTime` is epoch MILLISECONDS, but
// other Ruijie surfaces hand back epoch SECONDS, and feeding seconds to
// `new Date()` lands in January 1970 as well.
//
// So every expiry that reaches a customer goes through here:
//   1. prefer a real `expires_at`,
//   2. otherwise derive `created_at + duration_min` (the package validity),
//   3. otherwise derive `now + duration_min`,
//   4. anything before 2000-01-01 is treated as a sentinel, never a date.
//
// Purely additive: nothing here writes to the database and no stored value is
// interpreted differently elsewhere. The three clocks stay separate
// (vouchers.expires_at, vouchers.activated_at, users.session_expires_at).
// ─────────────────────────────────────────────────────────────────────────────

/** A date-ish value as it arrives from Postgres, Ruijie or a form field. */
export type VoucherDateInput = string | number | Date | null | undefined;

/** The fields either surface actually has on hand for a voucher. */
export interface VoucherExpiryInput {
  /** Staff-set shelf life of the code (often NULL = never expires). */
  expires_at?: VoucherDateInput;
  /** When the code was minted — the base for a derived expiry. */
  created_at?: VoucherDateInput;
  /** Package validity in minutes. */
  duration_min?: number | string | null;
}

/** Where the timestamp printed to the customer came from. */
export type VoucherExpirySource = 'expires_at' | 'created_at' | 'now';

export interface ResolvedVoucherExpiry {
  date: Date;
  source: VoucherExpirySource;
  /** True when the date was derived rather than read from `expires_at`. */
  derived: boolean;
}

/** 2000-01-01. Anything older is a sentinel (0, '', '1970-…'), not a real expiry. */
const EARLIEST_REAL_MS = Date.UTC(2000, 0, 1);
/** 2100-01-01. Guards against a bogus duration or a garbage epoch. */
const LATEST_REAL_MS = Date.UTC(2100, 0, 1);

/** Matches `calcValidUntil`'s historical default when a package has no duration. */
export const DEFAULT_VOUCHER_DURATION_MIN = 60;

/** 13-digit epochs are ms; anything shorter is seconds. */
const EPOCH_SECONDS_CEILING = 1e11;

function withinRange(date: Date): boolean {
  const ms = date.getTime();
  return Number.isFinite(ms) && ms >= EARLIEST_REAL_MS && ms < LATEST_REAL_MS;
}

/**
 * Parse a stored/API date without ever producing 1970 or `Invalid Date`.
 *
 * Returns `null` for anything unusable so callers fall through to a derived
 * expiry instead of printing epoch 0.
 */
export function parseVoucherDate(raw: VoucherDateInput): Date | null {
  if (raw == null || raw === '') return null;

  if (raw instanceof Date) return withinRange(raw) ? raw : null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Ruijie sometimes reports epoch seconds; `new Date(seconds)` is 1970.
    const ms = raw < EPOCH_SECONDS_CEILING ? raw * 1000 : raw;
    const date = new Date(ms);
    return withinRange(date) ? date : null;
  }

  const text = String(raw).trim();
  if (!text) return null;
  // `new Date('1761177600')` is Invalid Date, so numeric strings are numbers.
  if (/^\d+(\.\d+)?$/.test(text)) return parseVoucherDate(Number(text));

  const parsed = new Date(text);
  return withinRange(parsed) ? parsed : null;
}

/** Package validity in minutes, clamped to something a calendar can hold. */
export function normalizeVoucherDuration(raw: number | string | null | undefined): number {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_VOUCHER_DURATION_MIN;
  // 10 years. A typo like `duration_min = 999999999` must not become year 4000.
  return Math.min(minutes, 60 * 24 * 366 * 10);
}

/**
 * The expiry the customer should be told, never epoch 0.
 *
 * `expires_at` wins when it is real; otherwise the package validity is applied
 * to `created_at`, and only when even that is missing to `now`.
 */
export function resolveVoucherExpiry(input?: VoucherExpiryInput | null): ResolvedVoucherExpiry {
  const explicit = parseVoucherDate(input?.expires_at);
  if (explicit) return { date: explicit, source: 'expires_at', derived: false };

  const minutes = normalizeVoucherDuration(input?.duration_min);
  const mintedAt = parseVoucherDate(input?.created_at);
  const base = mintedAt ?? new Date();
  return {
    date: new Date(base.getTime() + minutes * 60_000),
    source: mintedAt ? 'created_at' : 'now',
    derived: true,
  };
}

/**
 * Localised date + time for share text and toasts, e.g. `10/29/2026, 2:30 PM`.
 *
 * Local (not ISO/UTC) on purpose: the customer reads this next to their own
 * clock, and Zimbabwe is UTC+2, so a UTC-only string shows an earlier day for
 * late-evening sales.
 */
export function formatVoucherExpiry(input?: VoucherExpiryInput | null): string {
  const { date } = resolveVoucherExpiry(input);
  const day = date.toLocaleDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/**
 * `YYYY-MM-DD` in LOCAL time — the compact form the 800×450 card prints, where
 * a 140px column cannot hold a full timestamp.
 */
export function voucherExpiryIsoDate(input?: VoucherExpiryInput | null): string {
  const { date } = resolveVoucherExpiry(input);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
