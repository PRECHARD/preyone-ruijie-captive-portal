import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Month-End / Staff commission report.
 *
 * Regression guard for the CEO omission: the report used to join
 * `staff_commissions` inner-style, so an account without a commission row (or
 * with one created later) simply disappeared. Every selling account - CEO
 * included - must appear with its aggregated sales and computed commission.
 */

const poolQuery = vi.hoisted(() => vi.fn());

vi.mock('../src/db/pool', () => ({
  pool: { query: poolQuery },
}));

import {
  buildMonthEndSummary,
  buildSalesWorkbook,
  type ReportPeriod,
  type SalesReportRow,
} from '../src/services/exportService';

const period: ReportPeriod = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-10-01T00:00:00.000Z'),
  label: 'September 2026',
};

function sale(overrides: Partial<SalesReportRow> = {}): SalesReportRow {
  return {
    timestamp: '2026-09-14T10:30:00.000Z',
    voucherCode: 'abc123',
    packageTier: 'preLite_Daily',
    amount: 10,
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
  poolQuery.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (/FROM cash_handovers WHERE status = 'pending'/.test(text)) {
      return { rows: [{ active_count: 2, active_value: 40 }] };
    }
    if (/staff_commissions/.test(text)) {
      return {
        rows: [
          {
            staff_id: 'ceo-1',
            role: 'CEO',
            staff_name: 'Prechard Muvirimi',
            commission_pct: 0,
            sales_count: 3,
            gross: 120,
          },
          {
            staff_id: 'staff-1',
            role: 'Staff',
            staff_name: 'Tariro Ncube',
            commission_pct: 10,
            sales_count: 2,
            gross: 25,
          },
          {
            staff_id: 'staff-2',
            role: 'Staff',
            staff_name: 'Zero Sales',
            commission_pct: 5,
            sales_count: 0,
            gross: 0,
          },
        ],
      };
    }
    if (/status = 'approved'/.test(text)) {
      return { rows: [{ approved_value: 100 }] };
    }
    return { rows: [] };
  });
});

describe('buildMonthEndSummary - staff commission sheet', () => {
  it('includes the CEO alongside staff, with aggregated sales and commission', async () => {
    const summary = await buildMonthEndSummary(period, [
      sale({ amount: 40 }),
      sale({ amount: 40 }),
      sale({ amount: 40 }),
      sale({ staffName: 'Tariro Ncube', amount: 15 }),
      sale({ staffName: 'Tariro Ncube', amount: 10 }),
    ]);

    const ceo = summary.staffCommissions.find((line) => line.staffName === 'Prechard Muvirimi');
    expect(ceo).toBeDefined();
    expect(ceo).toMatchObject({
      role: 'CEO',
      salesCount: 3,
      gross: 120,
      commissionPct: 0,
      commissionDue: 0,
    });

    const staff = summary.staffCommissions.find((line) => line.staffName === 'Tariro Ncube');
    expect(staff).toMatchObject({ role: 'Staff', salesCount: 2, gross: 25, commissionDue: 2.5 });

    // A staff member with a commission rate but no sales still shows up.
    expect(summary.staffCommissions.map((line) => line.staffName)).toContain('Zero Sales');
    expect(summary.staffCommissionTotal).toBe(2.5);
    expect(summary.totalRevenue).toBe(145);
  });

  it('keeps sales booked under a retired name without inventing a commission', async () => {
    const summary = await buildMonthEndSummary(period, [
      sale({ staffName: 'Legacy Seller', amount: 30 }),
    ]);

    const legacy = summary.staffCommissions.find((line) => line.staffName === 'Legacy Seller');
    expect(legacy).toMatchObject({ staffId: null, role: null, gross: 30, commissionDue: 0 });
    // The unattributed "Online" bucket is never a commission line.
    expect(summary.staffCommissions.some((line) => line.staffName === 'Online')).toBe(false);
  });

  it('aggregates the period window in SQL rather than matching staff names', async () => {
    await buildMonthEndSummary(period, [sale()]);
    const commissionCall = poolQuery.mock.calls.find(([sql]) => /staff_commissions/.test(String(sql)));
    expect(commissionCall).toBeDefined();
    expect(commissionCall![1]).toEqual([period.from, period.to]);
  });
});

describe('buildSalesWorkbook - Month-End branding', () => {
  it('adds a commission sheet that lists the CEO', () => {
    const wb = buildSalesWorkbook({
      sheetName: 'Month-End Sales',
      rows: [sale()],
      title: 'Month-End Sales & Reconciliation Ledger',
      subtitle: 'Period: September 2026',
      company: { name: 'Preyone', email: 'admin@preyone.com', website: 'https://preyone.com' },
      commissions: {
        lines: [
          {
            staffId: 'ceo-1',
            staffName: 'Prechard Muvirimi',
            role: 'CEO',
            salesCount: 3,
            gross: 120,
            commissionPct: 0,
            commissionDue: 0,
          },
        ],
        total: 0,
        currency: 'USD',
      },
    });

    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Month-End Sales', 'Commissions']);
    const commissionSheet = wb.getWorksheet('Commissions')!;
    const cells: string[] = [];
    commissionSheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value != null) cells.push(String(cell.value));
      });
    });
    expect(cells).toContain('Prechard Muvirimi');
    expect(cells).toContain('CEO');
    expect(cells).toContain('Staff Sales & Commission Report');
    expect(cells).toContain('TOTAL');

    // The logo media is registered once and reused by both sheets: an emailed
    // workbook must not carry two copies of the same image.
    const media = (wb.model as unknown as { media?: unknown[] }).media ?? [];
    expect(media.length).toBeLessThanOrEqual(1);
  });

  it('still builds a text-only masthead when no logo asset resolves', () => {
    const wb = buildSalesWorkbook({
      sheetName: 'Sales',
      rows: [sale()],
      title: 'Month-End Sales',
      company: { name: 'Preyone' },
    });
    expect(wb.worksheets).toHaveLength(1);
    expect(wb.getWorksheet('Sales')!.getCell('A2').value).toBe('Month-End Sales');
  });
});
