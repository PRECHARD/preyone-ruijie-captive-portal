/*
 * Verifies the frozen /data usage PWA lock in docs/frozen-data-pwa.lock.json.
 *
 * The user explicitly froze these files on 2026-11-22. Run this before any task
 * that touches the data-usage PWA: a mismatch means the freeze was broken
 * (or deliberately re-approved and the manifest was not updated).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(root, 'docs', 'frozen-data-pwa.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

let failed = 0;
console.log(`Data-usage PWA lock: ${lock.lock} (${lock.lockedAt})`);
for (const [rel, expected] of Object.entries(lock.files)) {
  let actual;
  try {
    actual = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
  } catch (err) {
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

if (failed) {
  console.error(`\n${failed} locked file(s) differ. Get explicit user approval and update docs/frozen-data-pwa.lock.json before changing them.`);
  process.exit(1);
}
console.log('\nAll locked files match.');
