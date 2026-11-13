import { describe, it, expect } from 'vitest';
import {
  VAT_RATE_PCT,
  extractVatInclusive,
  buildCyclePnL,
  classifyEntryType,
  normalizeRail,
  isPesepayRail,
  splitRailBuckets,
} from '../src/services/revenueCycle';

describe('revenueCycle 3rd-to-3rd rules', () => {
  it('extracts 15.5% VAT from inclusive totals', () => {
    const { gross, tax, net } = extractVatInclusive(115.5, VAT_RATE_PCT);
    expect(gross).toBe(115.5);
    expect(tax).toBe(15.5);
    expect(net).toBe(100);
  });

  it('builds P&L with COGS and expenses', () => {
    const pnl = buildCyclePnL({
      grossRevenue: 1155,
      creditNotes: 0,
      taxCollected: 155,
      cogs: 400,
      expenses: 100,
    });
    expect(pnl.netSales).toBe(1000);
    expect(pnl.grossProfit).toBe(600);
    expect(pnl.operatingProfit).toBe(500);
  });

  it('classifies Pesepay rails and entry types', () => {
    expect(isPesepayRail('ecocash')).toBe(true);
    expect(isPesepayRail('omari')).toBe(true);
    expect(isPesepayRail('innbucks')).toBe(true);
    expect(isPesepayRail('cash')).toBe(false);
    expect(normalizeRail('EcoCash')).toBe('ecocash');
    expect(classifyEntryType({ docType: 'sale', method: 'cash' })).toBe('pos_sale');
    expect(classifyEntryType({ docType: 'invoice', method: 'ecocash' })).toBe('pesepay_collection');
    expect(classifyEntryType({ isCreditNote: true })).toBe('credit_note');
  });

  it('splits cash vs Pesepay buckets', () => {
    const { cashTotal, pesepayTotal, byRail } = splitRailBuckets([
      { method: 'cash', amount: 50 },
      { method: 'ecocash', amount: 30 },
      { method: 'innbucks', amount: 20 },
    ]);
    expect(cashTotal).toBe(50);
    expect(pesepayTotal).toBe(50);
    expect(byRail.ecocash).toBe(30);
    expect(byRail.innbucks).toBe(20);
  });
});
