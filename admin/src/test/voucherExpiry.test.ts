import { describe, it, expect } from 'vitest';

/**
 * Voucher expiry resolution.
 *
 * `vouchers.expires_at` is the code's shelf life and is NULL for "never
 * expires". Both the WhatsApp text and the printed card used to hand that NULL
 * to `new Date(null)`, which is epoch 0 — customers were told their voucher was
 * "Valid until 01/01/1970". Ruijie's `expiryTime` adds a second trap: depending
 * on the endpoint it is epoch ms or epoch seconds, and seconds fed to
 * `new Date()` also land in January 1970.
 *
 * These tests pin the contract every customer-facing surface now shares:
 *   expires_at → created_at + duration_min → now + duration_min, never 1970.
 */

import {
  DEFAULT_VOUCHER_DURATION_MIN,
  formatVoucherExpiry,
  normalizeVoucherDuration,
  parseVoucherDate,
  resolveVoucherExpiry,
  voucherExpiryIsoDate,
} from '../utils/voucherExpiry';
import { calcValidUntil, type VoucherCardData } from '../utils/voucherCard';

const CREATED = '2026-10-01T10:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);

/** `YYYY-MM-DD` from LOCAL parts — what the card prints, in any timezone. */
function localIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

describe('parseVoucherDate', () => {
  it('reads ISO strings, Date objects and epoch milliseconds', () => {
    expect(parseVoucherDate('2026-10-20T10:00:00.000Z')?.getTime()).toBe(Date.parse('2026-10-20T10:00:00.000Z'));
    expect(parseVoucherDate(new Date(CREATED))?.getTime()).toBe(CREATED_MS);
    expect(parseVoucherDate(CREATED_MS)?.getTime()).toBe(CREATED_MS);
  });

  it('normalises Ruijie epoch SECONDS instead of reporting 1970', () => {
    const seconds = Math.floor(Date.parse('2026-10-20T10:00:00.000Z') / 1000);
    const parsed = parseVoucherDate(seconds)!;
    expect(parsed.getUTCFullYear()).toBe(2026);
    expect(parsed.getTime()).toBe(seconds * 1000);
    // Numeric strings (some roster payloads) take the same path.
    expect(parseVoucherDate(String(seconds))?.getUTCFullYear()).toBe(2026);
  });

  it('treats epoch 0 and 1970 sentinels as "no date", not as a date', () => {
    for (const raw of [null, undefined, '', 0, '0', '0000-00-00', '1970-01-01T00:00:00.000Z', 'not-a-date', -1]) {
      expect(parseVoucherDate(raw as never)).toBeNull();
    }
  });
});

describe('normalizeVoucherDuration', () => {
  it('defaults to one hour and refuses nonsense', () => {
    expect(normalizeVoucherDuration(undefined)).toBe(DEFAULT_VOUCHER_DURATION_MIN);
    expect(normalizeVoucherDuration(null)).toBe(DEFAULT_VOUCHER_DURATION_MIN);
    expect(normalizeVoucherDuration(0)).toBe(DEFAULT_VOUCHER_DURATION_MIN);
    expect(normalizeVoucherDuration('not-a-number')).toBe(DEFAULT_VOUCHER_DURATION_MIN);
    expect(normalizeVoucherDuration(1440)).toBe(1440);
    expect(normalizeVoucherDuration('1440')).toBe(1440);
  });

  it('clamps an absurd duration so it cannot become year 4000', () => {
    expect(normalizeVoucherDuration(999_999_999)).toBe(60 * 24 * 366 * 10);
  });
});

describe('resolveVoucherExpiry', () => {
  it('prefers a real expires_at', () => {
    const resolved = resolveVoucherExpiry({
      expires_at: '2026-12-31T21:00:00.000Z',
      created_at: CREATED,
      duration_min: 60,
    });
    expect(resolved.source).toBe('expires_at');
    expect(resolved.derived).toBe(false);
    expect(resolved.date.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('derives created_at + package duration when expires_at is NULL', () => {
    const resolved = resolveVoucherExpiry({ expires_at: null, created_at: CREATED, duration_min: 1440 });
    expect(resolved.source).toBe('created_at');
    expect(resolved.derived).toBe(true);
    expect(resolved.date.getTime()).toBe(CREATED_MS + 1440 * 60_000);
  });

  it('derives created_at + duration when expires_at is an epoch sentinel', () => {
    const resolved = resolveVoucherExpiry({ expires_at: 0, created_at: CREATED, duration_min: 30 });
    expect(resolved.source).toBe('created_at');
    expect(resolved.date.getTime()).toBe(CREATED_MS + 30 * 60_000);
  });

  it('falls back to now + duration when nothing at all is known', () => {
    const before = Date.now();
    const resolved = resolveVoucherExpiry({ code: 'x' } as never);
    expect(resolved.source).toBe('now');
    expect(resolved.date.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_VOUCHER_DURATION_MIN * 60_000);
    expect(resolved.date.getTime()).toBeLessThanOrEqual(Date.now() + DEFAULT_VOUCHER_DURATION_MIN * 60_000);
  });
});

describe('formatVoucherExpiry', () => {
  it('renders a localised date AND time for a real expires_at', () => {
    const date = new Date('2026-10-20T10:00:00.000Z');
    expect(formatVoucherExpiry({ expires_at: date.toISOString() })).toBe(
      `${date.toLocaleDateString()}, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    );
  });

  it('never prints 1970 for a NULL expires_at', () => {
    const text = formatVoucherExpiry({ expires_at: null, created_at: CREATED, duration_min: 1440 });
    expect(text).not.toContain('1970');
    expect(text).toMatch(/\d/);
    expect(text).toContain(new Date(CREATED_MS + 1440 * 60_000).toLocaleDateString());
  });

  it('never prints 1970 for epoch-0 or unparseable values', () => {
    for (const expires_at of [0, '0', '1970-01-01T00:00:00Z', 'garbage']) {
      expect(formatVoucherExpiry({ expires_at, duration_min: 60 })).not.toContain('1970');
    }
  });
});

describe('voucherExpiryIsoDate (the printed card)', () => {
  it('uses the real expiry when present', () => {
    expect(voucherExpiryIsoDate({ expires_at: '2026-10-20T10:00:00.000Z' }))
      .toBe(localIso(new Date('2026-10-20T10:00:00.000Z')));
  });

  it('derives from created_at + duration when expires_at is NULL', () => {
    expect(voucherExpiryIsoDate({ expires_at: null, created_at: CREATED, duration_min: 1440 }))
      .toBe(localIso(new Date(CREATED_MS + 1440 * 60_000)));
  });
});

describe('calcValidUntil — the canvas painter', () => {
  const base: VoucherCardData = {
    code: 'ebywa6',
    package_tier: 'preLite_Daily',
    duration_min: 1440,
    created_at: CREATED,
  };

  it('prints the real expiry date when the row has one', () => {
    expect(calcValidUntil({ ...base, expires_at: '2026-10-20T10:00:00.000Z' }))
      .toBe(localIso(new Date('2026-10-20T10:00:00.000Z')));
  });

  it('prints created_at + duration — not 01/01/1970 — when expires_at is NULL', () => {
    const printed = calcValidUntil({ ...base, expires_at: null });
    expect(printed).not.toBe('1970-01-01');
    expect(printed).not.toContain('1970');
    expect(printed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not throw on an unparseable expires_at (that used to abort the card)', () => {
    expect(() => calcValidUntil({ ...base, expires_at: 'not-a-date' })).not.toThrow();
    expect(calcValidUntil({ ...base, expires_at: 'not-a-date' })).not.toContain('1970');
  });

  it('still works for a partial row (create preview / roster-only card)', () => {
    const printed = calcValidUntil({ code: 'newpin' });
    expect(printed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(printed + 'T12:00:00').getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear());
  });
});
