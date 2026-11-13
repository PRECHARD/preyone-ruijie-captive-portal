import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  path.resolve(__dirname, '../db/migrations/v4_accounting_ledger.sql'),
  'utf8'
);

describe('stock_applied backfill', () => {
  it('only marks till and online checkout documents as already applied', () => {
    expect(sql).toMatch(/d\.channel IN \('till', 'online'\)/);
    expect(sql).not.toMatch(/SET stock_applied = TRUE[\s\S]*?WHERE stock_applied = FALSE\s+AND EXISTS/);
  });

  it('clears the flag on unpaid office documents that have no payments', () => {
    expect(sql).toMatch(/SET stock_applied = FALSE/);
    expect(sql).toMatch(/d\.channel = 'office'/);
    expect(sql).toMatch(/pos_document_payments/);
  });
});
