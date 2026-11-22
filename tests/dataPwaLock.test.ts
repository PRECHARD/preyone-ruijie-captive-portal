import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * User-approved freeze (2026-11-22): the /data usage PWA, its success-page
 * hand-off, the check-usage API and its contract tests may not be altered
 * without explicit approval. See docs/frozen-data-pwa.lock.json.
 *
 * When unlocking, the user must approve and the manifest hashes must be
 * updated in the same change — then this test passes again.
 */
const root = process.cwd();
const lock = JSON.parse(readFileSync(path.join(root, 'docs', 'frozen-data-pwa.lock.json'), 'utf8'));

describe('frozen /data usage PWA', () => {
  it('keeps every locked file byte-for-byte unchanged', () => {
    const changed: string[] = [];
    for (const [rel, expected] of Object.entries(lock.files as Record<string, string>)) {
      const actual = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
      if (actual !== expected) changed.push(rel);
    }
    expect(changed).toEqual([]);
  });
});
