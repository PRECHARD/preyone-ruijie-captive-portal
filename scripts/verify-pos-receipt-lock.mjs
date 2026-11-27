/*
 * Verifies the frozen POS receipt "Powered by Preyone Technologies" footer.
 *
 * The user asked on 2026-11-27 that this transit-matched footer stay fixed.
 * The small self-contained files are SHA-256 locked; the surrounding receipt
 * files may keep changing, but removing or rewiring the footer fails here.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(path.join(root, 'docs/frozen-pos-receipt-footer.lock.json'), 'utf8'));
const normalized = (rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
console.log(`POS receipt powered-by lock: ${lock.lock} (${lock.lockedAt})`);

for (const [rel, expected] of Object.entries(lock.files)) {
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
  } catch {
    failed += 1;
    console.error(`  MISSING  ${rel}`);
    continue;
  }
  if (actual === expected) {
    console.log(`  ok       ${rel}`);
  } else {
    failed += 1;
    console.error(`  CHANGED  ${rel}`);
    console.error(`           expected ${expected}`);
    console.error(`           actual   ${actual}`);
  }
}

function expectContains(rel, needle, label) {
  try {
    if (normalized(rel).includes(needle)) {
      console.log(`  ok       ${label}`);
    } else {
      failed += 1;
      console.error(`  BROKEN   ${label} (${rel})`);
    }
  } catch {
    failed += 1;
    console.error(`  MISSING  ${rel}`);
  }
}

expectContains(
  'pos/src/components/ReceiptModal.tsx',
  "import ReceiptPoweredBy from './ReceiptPoweredBy';",
  'modal imports the locked footer component'
);
expectContains(
  'pos/src/components/ReceiptModal.tsx',
  '<ReceiptPoweredBy website={brandWebsite} />',
  'modal renders the locked footer component'
);
expectContains(
  'pos/src/components/ReceiptModal.tsx',
  '<div className="r-thanks">',
  'thank-you line still precedes the footer'
);
expectContains(
  'pos/src/utils/receiptPdf.ts',
  "import { RECEIPT_POWERED_BY, receiptFooterWebsite } from './receiptPoweredBy.ts';",
  'vector fallback imports the locked constants'
);
expectContains('pos/src/utils/receiptPdf.ts', 'RECEIPT_POWERED_BY.label', 'vector fallback draws "Powered by"');
expectContains(
  'pos/src/utils/receiptPdf.ts',
  'RECEIPT_POWERED_BY.brand',
  'vector fallback draws "PREYONE TECHNOLOGIES"'
);
expectContains(
  'pos/src/utils/receiptPdf.ts',
  'receiptFooterWebsite(opts.company.website)',
  'vector fallback draws the locked website'
);

const css = normalized('pos/src/styles.css');
if (/\.r-powered-by[^{]*\{[^}]*!important/s.test(css)) {
  failed += 1;
  console.error('  BROKEN   a stylesheet overrides the inline locked footer styles');
} else {
  console.log('  ok       no stylesheet override of the locked footer styles');
}

if (failed) {
  console.error(
    `\n${failed} locked receipt-footer check(s) failed. Get explicit user approval and update docs/frozen-pos-receipt-footer.lock.json before changing the footer.`
  );
  process.exit(1);
}
console.log('\nAll receipt-footer lock checks match.');
