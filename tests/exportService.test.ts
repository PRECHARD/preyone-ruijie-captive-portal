import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Report export contract. These assertions pin the column set the accountant
 * asked for (Timestamp · Voucher Code · Package Tier · Amount · Payment Rail ·
 * Staff / Sold By · Status) and the period maths the scheduler relies on.
 */

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery },
}));

import {
  SALES_REPORT_COLUMNS,
  buildSalesCsv,
  fetchSalesReportRows,
  parseReportPeriod,
  previousMonthPeriod,
  toReportCells,
  type SalesReportRow,
} from '../src/services/exportService';

function row(overrides: Partial<SalesReportRow> = {}): SalesReportRow {
  return {
    timestamp: '2026-09-14T10:30:00.000Z',
    voucherCode: 'abc123',
    packageTier: 'preLite_Daily',
    amount: 1.5,
    currency: 'USD',
    paymentRail: 'Cash',
    staffName: 'Prechard Muvirimi',
    status: 'Active',
    saleType: 'new',
    handoverStatus: 'handed_over',
    ...overrides,
  };
}

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [] });
});

describe('SALES_REPORT_COLUMNS', () => {
  it('is exactly the agreed seven-column ledger', () => {
    expect(SALES_REPORT_COLUMNS.map((c) => c.header)).toEqual([
      'Timestamp',
      'Voucher Code',
      'Package Tier',
      'Amount (USD/ZiG)',
      'Payment Rail',
      'Staff / Sold By',
      'Status',
    ]);
  });

  it('gives every column a usable width', () => {
    for (const column of SALES_REPORT_COLUMNS) {
      expect(column.width).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('toReportCells', () => {
  it('maps a row in column order', () => {
    expect(toReportCells(row())).toEqual([
      '2026-09-14T10:30:00.000Z',
      'abc123',
      'preLite_Daily',
      '1.50 USD',
      'Cash',
      'Prechard Muvirimi',
      'Active',
    ]);
  });

  it('always renders two decimals on the amount', () => {
    const cells = toReportCells(row({ amount: 12 }));
    expect(cells[3]).toBe('12.00 USD');
  });

  it('keeps the non-USD currency code (ZiG pricing)', () => {
    expect(toReportCells(row({ amount: 30, currency: 'ZiG' }))[3]).toBe('30.00 ZiG');
  });
});

describe('buildSalesCsv', () => {
  it('writes the header even with no rows', () => {
    const csv = buildSalesCsv([]);
    expect(csv.trim().split('\n')).toHaveLength(1);
    expect(csv).toContain('Amount (USD/ZiG)');
  });

  it('quotes cells that contain commas or quotes', () => {
    const csv = buildSalesCsv([row({ staffName: 'Muvirimi, Prechard "PM"' })]);
    expect(csv).toContain('"Muvirimi, Prechard ""PM"""');
  });

  it('emits one line per row after the header', () => {
    const csv = buildSalesCsv([row(), row({ voucherCode: 'def456' })]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('def456');
  });
});

describe('previousMonthPeriod', () => {
  it('covers the whole previous calendar month in UTC', () => {
    const period = previousMonthPeriod(new Date('2026-10-27T09:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(period.label).toBe('September 2026');
  });

  it('rolls the year back for a January report', () => {
    const period = previousMonthPeriod(new Date('2027-01-03T08:00:00.000Z'));
    expect(period.from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(period.label).toBe('December 2026');
  });
});

describe('parseReportPeriod', () => {
  it('falls back to the previous month for junk input', () => {
    const fallback = previousMonthPeriod();
    expect(parseReportPeriod('not-a-date', 'also-bad').from.getTime()).toBe(fallback.from.getTime());
    expect(parseReportPeriod().label).toBe(fallback.label);
  });

  it('falls back when the window is inverted', () => {
    const fallback = previousMonthPeriod();
    const period = parseReportPeriod('2026-10-01', '2026-09-01');
    expect(period.from.getTime()).toBe(fallback.from.getTime());
  });

  it('honours an explicit from/to window', () => {
    const period = parseReportPeriod('2026-08-01', '2026-09-01');
    expect(period.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(period.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('fetchSalesReportRows', () => {
  it('shapes database rows into the ledger contract', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        {
          sold_at: new Date('2026-09-14T10:30:00.000Z'),
          voucher_code: 'abc123',
          amount: '1.50',
          currency: 'USD',
          payment_method: 'EcoCash',
          sale_type: 'new',
          staff_name: 'Prechard Muvirimi',
          handover_status: 'handed_over',
          package_tier: 'preLite_Daily',
          is_disabled: false,
          expires_at: new Date('2030-01-01T00:00:00.000Z'),
          used_count: 2,
        },
      ],
    });

    const rows = await fetchSalesReportRows(previousMonthPeriod(new Date('2026-10-03T08:00:00.000Z')));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      voucherCode: 'abc123',
      amount: 1.5,
      currency: 'USD',
      paymentRail: 'EcoCash',
      staffName: 'Prechard Muvirimi',
      status: 'Active',
      handoverStatus: 'handed_over',
    });
    expect(rows[0].timestamp).toBe('2026-09-14T10:30:00.000Z');
  });

  it('labels a disabled code, an unredeemed code and a renewal', async () => {
    poolQuery.mockResolvedValue({
      rows: [
        { voucher_code: 'a', amount: 1, is_disabled: true, used_count: 1, handover_status: 'pending' },
        { voucher_code: 'b', amount: 1, is_disabled: false, used_count: 0, handover_status: 'pending' },
        { voucher_code: 'c', amount: 1, sale_type: 'renewal', used_count: 1, handover_status: 'pending' },
      ],
    });

    const rows = await fetchSalesReportRows(previousMonthPeriod());
    expect(rows.map((r) => r.status)).toEqual(['Disabled', 'Unused', 'Renewal']);
  });
});
