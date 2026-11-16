/**
 * Backfill `voucher_profiles` for active package tiers that have no active
 * Ruijie Cloud mapping.
 *
 * Tiers seeded by `npm run migrate` never pass through the package create/edit
 * API, so their Ruijie group mapping has to be reconciled separately. The mint
 * path refuses unmapped tiers ("Package tier 'x' has no active Ruijie Cloud
 * profile mapping"), which is exactly what this script fixes.
 *
 * Idempotent: existing mappings are left alone, groups are matched by exact
 * name, and every outbound call is paced by the shared Ruijie sync queue.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only scripts/sync-ruijie-mappings.ts
 *   ... --dry-run          list what would be synced, no writes/API calls
 *   ... --tier preMicro_Daily
 */
import 'dotenv/config';
import { pool } from '../src/db/pool';
import { isRuijieCloudConfigured } from '../src/services/ruijieCloud';
import { provisionRuijieUserGroupForPackage } from '../src/services/ruijieUserGroups';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tierFlag = args.indexOf('--tier');
  const tierArg = tierFlag >= 0 ? args[tierFlag + 1] : undefined;

  const { rows } = await pool.query(
    `SELECT p.tier_name
       FROM packages p
       LEFT JOIN voucher_profiles vp
              ON vp.tier_name = p.tier_name AND vp.active = TRUE
      WHERE p.deleted_at IS NULL
        AND vp.id IS NULL
        ${tierArg ? 'AND p.tier_name = $1' : ''}
      ORDER BY p.price_amount ASC`,
    tierArg ? [tierArg] : []
  );

  const tiers: string[] = rows.map((r: any) => r.tier_name);
  if (tiers.length === 0) {
    console.log('All active package tiers already have a Ruijie mapping.');
    return;
  }

  console.log(`${tiers.length} unmapped tier(s): ${tiers.join(', ')}`);
  if (dryRun) {
    console.log('Dry run — no Ruijie calls, no writes.');
    return;
  }
  if (!isRuijieCloudConfigured()) {
    console.error('Ruijie Cloud is not configured (RUIJIE_CLOUD_APPID/SECRET/GROUP_ID); nothing to sync.');
    process.exitCode = 2;
    return;
  }

  let failed = 0;
  for (const tier of tiers) {
    const result = await provisionRuijieUserGroupForPackage(tier);
    const line = `${tier}: ${result.status}${result.userGroupId ? ` (group ${result.userGroupId})` : ''}${result.error ? ` — ${result.error}` : ''}`;
    console.log(line);
    if (result.status !== 'synced') failed += 1;
  }

  if (failed > 0) {
    console.error(`${failed} tier(s) not mapped. Re-run when Ruijie quota recovers.`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('Sync failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
