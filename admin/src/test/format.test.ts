import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  fmtBytes,
  fmtUsage,
  formatMac,
  formatSpeed,
  fmtDurationMin,
  fmtDateTime,
} from '../utils/format';

/**
 * Guards the display formatters against a silent unit mismatch.
 *
 * The backend converts data_limit_gb to quota bytes with 1073741824 (see the
 * dataFrom query in src/routes/admin.ts and wisprTransformer.ts). A formatter on
 * a decimal base would render "1 GB" beside a real quota of 1.07 GB, making a
 * voucher look exhausted while the gateway still had data to give.
 */
describe('format utilities', () => {
  describe('fmtBytes', () => {
    it('uses a binary base so it matches backend quota arithmetic', () => {
      expect(fmtBytes(1073741824)).toBe('1.0 GB');
      expect(fmtBytes(1024 * 1024)).toBe('1.0 MB');
      expect(fmtBytes(1024)).toBe('1.0 KB');
      // 1e9 bytes is 953.67 binary MB, NOT "1000 MB". A decimal-base formatter
      // would disagree with the backend about what one gigabyte is.
      expect(fmtBytes(1000000000)).toBe('954 MB');
    });

    it('accepts the string values pg returns for bigint/numeric columns', () => {
      expect(fmtBytes('1073741824')).toBe('1.0 GB');
      expect(fmtBytes('0')).toBe('0 B');
    });

    it('treats null, undefined, negative and non-finite as zero', () => {
      expect(fmtBytes(null)).toBe('0 B');
      expect(fmtBytes(undefined)).toBe('0 B');
      expect(fmtBytes(-5)).toBe('0 B');
      expect(fmtBytes(NaN)).toBe('0 B');
    });

    it('drops the decimal once a unit is large, so columns stay narrow', () => {
      expect(fmtBytes(150 * 1024 * 1024)).toBe('150 MB');
      expect(fmtBytes(1024 * 1024 * 1024 * 150)).toBe('150 GB');
    });
  });

  describe('fmtUsage', () => {
    it('renders the "used / quota" pair the voucher table shows', () => {
      expect(fmtUsage(350 * 1024 * 1024, 1024 * 1024 * 1024)).toBe('350 MB / 1.0 GB');
    });

    it('labels a null quota as Unlimited rather than inventing a cap', () => {
      expect(fmtUsage(350 * 1024 * 1024, null)).toBe('350 MB / Unlimited');
      expect(fmtUsage(0, undefined)).toBe('0 B / Unlimited');
    });
  });

  describe('formatMac', () => {
    it('normalizes every MAC spelling the gateway and DB produce', () => {
      const expected = 'AA:BB:CC:DD:EE:FF';
      expect(formatMac('AABBCCDDEEFF')).toBe(expected);
      expect(formatMac('aa:bb:cc:dd:ee:ff')).toBe(expected);
      expect(formatMac('AA-BB-CC-DD-EE-FF')).toBe(expected);
      expect(formatMac('aa:bb:cc:dd:ee:ff')).toBe(expected);
    });

    it('returns an em dash for a missing MAC', () => {
      expect(formatMac(null)).toBe('—');
      expect(formatMac(undefined)).toBe('—');
    });

    it('passes through values that are not a 12-hex MAC instead of mangling them', () => {
      expect(formatMac('not-a-mac')).toBe('not-a-mac');
    });
  });

  describe('formatSpeed', () => {
    it('renders the up/down pair', () => {
      expect(formatSpeed(2, 5)).toBe('2/5 Mbps');
    });

    it('em dashes only the missing half', () => {
      expect(formatSpeed(null, 5)).toBe('—/5 Mbps');
      expect(formatSpeed(2, null)).toBe('2/— Mbps');
      expect(formatSpeed(null, null)).toBe('—');
    });
  });

  describe('fmtDurationMin', () => {
    it('scales the unit to the magnitude', () => {
      expect(fmtDurationMin(30)).toBe('30min');
      expect(fmtDurationMin(120)).toBe('2h');
      expect(fmtDurationMin(2880)).toBe('2d');
      expect(fmtDurationMin(43200)).toBe('1mo');
    });

    it('em dashes a zero or missing duration', () => {
      expect(fmtDurationMin(0)).toBe('—');
      expect(fmtDurationMin(null)).toBe('—');
    });
  });

  describe('fmtDateTime', () => {
    it('em dashes a null timestamp rather than printing Invalid Date', () => {
      expect(fmtDateTime(null)).toBe('—');
      expect(fmtDateTime(undefined)).toBe('—');
    });

    it('returns an unparseable value verbatim instead of throwing', () => {
      expect(fmtDateTime('not-a-date')).toBe('not-a-date');
    });
  });
});

/**
 * The voucher lifecycle status is a SQL view, not a stored column, precisely so
 * it cannot drift from used_count / expires_at / is_disabled. These assertions
 * pin the migration's definition; if someone reintroduces a stored status
 * column, the view assertions below stop matching.
 */
describe('voucher status derivation', () => {
  const migrateSrc = readFileSync(resolve(__dirname, '../../../src/db/migrate.ts'), 'utf8');

  it('derives status in a view rather than storing it on the row', () => {
    expect(migrateSrc).toContain('CREATE OR REPLACE VIEW voucher_status');
    // A stored status column is exactly the drift risk this design avoids.
    expect(migrateSrc).not.toMatch(
      /ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS status\s/i
    );
  });

  it('orders precedence Disabled > Expired > Active > Unused', () => {
    const view = migrateSrc.slice(migrateSrc.indexOf('CREATE OR REPLACE VIEW voucher_status'));
    const disabledAt = view.indexOf("THEN 'Disabled'");
    const expiredAt = view.indexOf("THEN 'Expired'");
    const activeAt = view.indexOf("THEN 'Active'");
    const unusedAt = view.indexOf("ELSE 'Unused'");
    expect(disabledAt).toBeGreaterThan(-1);
    expect(expiredAt).toBeGreaterThan(disabledAt);
    expect(activeAt).toBeGreaterThan(expiredAt);
    expect(unusedAt).toBeGreaterThan(activeAt);
  });

  it('treats a deleted or disabled voucher as Disabled regardless of usage', () => {
    const view = migrateSrc.slice(migrateSrc.indexOf('CREATE OR REPLACE VIEW voucher_status'));
    expect(view).toContain('v.is_disabled OR v.deleted_at IS NOT NULL');
    expect(view).toContain("v.used_count > 0");
  });

  it('adds the lifecycle columns the admin table depends on', () => {
    expect(migrateSrc).toContain('ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ');
    expect(migrateSrc).toContain('ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migrateSrc).toContain('ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
    expect(migrateSrc).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT');
    expect(migrateSrc).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT');
    expect(migrateSrc).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS alias       TEXT');
  });

  it('indexes the columns the list endpoint now filters and sorts on', () => {
    expect(migrateSrc).toContain('idx_vouchers_code_lower');
    expect(migrateSrc).toContain('idx_vouchers_created_at');
    expect(migrateSrc).toContain('idx_vouchers_package_tier');
    expect(migrateSrc).toContain('idx_vouchers_lifecycle');
  });

  it('backfills first/last name only for names containing a space', () => {
    expect(migrateSrc).toContain("strpos(u.full_name, ' ') > 0");
  });
});