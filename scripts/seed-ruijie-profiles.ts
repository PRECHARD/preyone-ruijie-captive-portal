/**
 * Phase 5 — seed `voucher_profiles` for the sellable tiers from the live Ruijie
 * Cloud user-group list.
 *
 * The Ruijie Cloud profile is the actual network enforcement — it is the source
 * of truth for what a redeemed code grants. This script maps each sellable
 * package tier to its Ruijie user group, cross-checking duration and quota
 * (what the customer pays for) as HARD requirements, and reporting device-limit
 * and rate-limit deltas as warnings (Ruijie grants MORE devices = over-service,
 * harmless; Ruijie rate < package rate = under-service, needs attention).
 *
 * Usage:
 *   node -r ts-node/register/transpile-only scripts/seed-ruijie-profiles.ts --list
 *   node -r ts-node/register/transpile-only scripts/seed-ruijie-profiles.ts
 *   ... --mint 1 --profile <uuid> --group <id>   (verification: mint real codes)
 */
import { pool } from '../src/db/pool';
import { getRuijieUserGroups, createRuijieVoucher, RuijieApiError } from '../src/services/ruijieCloud';
import 'dotenv/config';

// Authoritative tier -> Ruijie group-name mapping (verified live against
// group 9624342). Matched by EXACT group name so a renamed/added group can
// never be silently mapped to the wrong tier.
const TIER_TO_GROUP: Record<string, string> = {
  'PreLite': 'preLite_Daily',
  'PreLite Plus': 'preLitePlus_2days',
  'PreLink': 'preLink_Weekly',
  'PreGo': 'preGo_Monthly',
  'PreFlow': 'preFlow_Monthly',
  'PreCore': 'preCore_Monthly',
  'PreBizPlus': 'preBizPlus_Monthly',
  'PreFam': 'preFam_Monthly',
  'PreBizPro': 'preBizPro_Monthly',
  'PreMax': 'preMax_Monthly',
  'PreUltra': 'preUltra_Monthly',
  'PreExecutive': 'preExecutive_Monthly',
};

// ── Owner-confirmed deltas (business policy, NOT bugs) ──────────────────────
// The Ruijie profile is the real enforcement. These profile/package deltas are
// intentional and must not be "corrected" by future seed runs:
//   - Device limits: PreBizPlus/PreMax/PreUltra/PreExecutive intentionally grant
//     more devices than the advertised 1-device package (deliberate policy).
//   - PreGo: the Ruijie profile is capped at ~2Mbps although the package is
//     sold at 5Mbps — accepted as-is.
const ACCEPTED_DELTAS: Record<string, string> = {
  PreGo: 'rate cap ~2Mbps vs 5Mbps package — accepted as-is',
  PreBizPlus: 'device limit 2 vs 1 — intentional policy',
  PreMax: 'device limit 4 vs 1 — intentional policy',
  PreUltra: 'device limit 5 vs 1 — intentional policy',
  PreExecutive: 'device limit 6 vs 1 — intentional policy',
};

interface Match {
  tier: string;
  groupId: string;
  profileUuid: string;
  groupName: string;
  timePeriodMin: number | null;
  quotaMb: number | null;
  noOfDevice: number | null;
  rateLimitKbps: number | null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const groups = await getRuijieUserGroups();
    console.log(`\n${groups.length} user groups in 9624342:\n`);
    for (const g of groups) {
      console.log(`  id=${g.id}  name="${g.name}"  profile=${g.authProfileId}`);
      console.log(`       dur=${g.timePeriodMin ?? '?'}min quota=${g.quotaMb ?? 'unlimited'}MB devs=${g.noOfDevice ?? '?'} down=${g.rateLimitKbps ?? '?'}kbps`);
    }
    console.log('\nDone. No database writes in --list mode.');
    return;
  }

  const groups = await getRuijieUserGroups();
  if (groups.length === 0) {
    throw new RuijieApiError('no_groups', 'Ruijie user-group list is empty — refusing to seed');
  }

  const { rows: pkgs } = await pool.query(
    `SELECT tier_name, duration_min, data_limit_gb, is_uncapped, bandwidth_mbps_up, max_devices
     FROM packages WHERE tier_name = ANY($1::text[]) AND deleted_at IS NULL`,
    [Object.keys(TIER_TO_GROUP)]
  );
  const pkgByName = new Map(pkgs.map((p: any) => [p.tier_name, p]));

  const matches: Match[] = [];
  const warnings: string[] = [];

  // Records a device/rate delta as either an accepted policy note or a real
  // warning, depending on the owner-confirmed ACCEPTED_DELTAS list.
  const noteDelta = (tier: string, message: string) => {
    const accepted = ACCEPTED_DELTAS[tier];
    if (accepted) {
      console.log(`  · ${tier}: ${message} (accepted — ${accepted})`);
    } else {
      warnings.push(`${tier}: ${message}`);
    }
  };

  for (const [tier, groupName] of Object.entries(TIER_TO_GROUP)) {
    const matchesForTier = groups.filter((g) => g.name === groupName);
    if (matchesForTier.length !== 1) {
      throw new RuijieApiError('mapping', `Expected exactly 1 Ruijie group named "${groupName}" for ${tier}, found ${matchesForTier.length}`);
    }
    const g = matchesForTier[0];
    if (!g.authProfileId) {
      throw new RuijieApiError('missing_profile', `Ruijie group "${g.name}" has no authProfileId`);
    }

    const pkg: any = pkgByName.get(tier);
    if (!pkg) {
      warnings.push(`${tier}: no active row in packages table (skipped cross-check)`);
    } else {
      // HARD: duration — the customer bought a time window.
      if (pkg.duration_min != null && g.timePeriodMin != null && pkg.duration_min !== g.timePeriodMin) {
        throw new RuijieApiError('duration_mismatch', `Tier ${tier}: Ruijie duration ${g.timePeriodMin}min != package ${pkg.duration_min}min`);
      }
      // HARD: quota — the customer bought a data allowance (0 = unlimited).
      const pkgQuotaMb = pkg.is_uncapped ? 0 : (pkg.data_limit_gb ?? 0) * 1024;
      const ruijieQuotaMb = g.quotaMb ?? 0;
      if (pkgQuotaMb !== ruijieQuotaMb) {
        throw new RuijieApiError('quota_mismatch', `Tier ${tier}: Ruijie quota ${ruijieQuotaMb}MB != package ${pkgQuotaMb}MB`);
      }
      // SOFT: devices / rate — deltas flow through noteDelta() so owner-confirmed
      // policy (ACCEPTED_DELTAS) is reported as accepted, not as a warning.
      if (g.noOfDevice != null && pkg.max_devices != null && g.noOfDevice !== pkg.max_devices) {
        noteDelta(tier, `devices Ruijie=${g.noOfDevice} vs package=${pkg.max_devices}`);
      }
      if (g.rateLimitKbps != null && pkg.bandwidth_mbps_up != null) {
        const ruijieMbps = g.rateLimitKbps / 1000;
        if (ruijieMbps + 0.01 < pkg.bandwidth_mbps_up) {
          noteDelta(tier, `Ruijie down rate ${ruijieMbps}Mbps < package ${pkg.bandwidth_mbps_up}Mbps`);
        }
      }
    }

    matches.push({
      tier,
      groupId: g.id,
      profileUuid: g.authProfileId,
      groupName: g.name,
      timePeriodMin: g.timePeriodMin ?? null,
      quotaMb: g.quotaMb ?? null,
      noOfDevice: g.noOfDevice ?? null,
      rateLimitKbps: g.rateLimitKbps ?? null,
    });
    console.log(`✓ ${tier} -> "${g.name}" (id=${g.id})`);
  }

  if (warnings.length > 0) {
    console.log('\n⚠ WARNINGS (Ruijie profile is the real enforcement — review these):');
    for (const w of warnings) console.log(`  - ${w}`);
    console.log('');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of matches) {
      await client.query(
        `INSERT INTO voucher_profiles
          (tier_name, ruijie_user_group_id, ruijie_profile_uuid, ruijie_group_name,
           time_period_min, quota_mb, no_of_device, rate_limit_kbps, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (tier_name) DO UPDATE SET
           ruijie_user_group_id = EXCLUDED.ruijie_user_group_id,
           ruijie_profile_uuid = EXCLUDED.ruijie_profile_uuid,
           ruijie_group_name = EXCLUDED.ruijie_group_name,
           time_period_min = EXCLUDED.time_period_min,
           quota_mb = EXCLUDED.quota_mb,
           no_of_device = EXCLUDED.no_of_device,
           rate_limit_kbps = EXCLUDED.rate_limit_kbps,
           active = TRUE,
           updated_at = NOW()`,
        [m.tier, m.groupId, m.profileUuid, m.groupName, m.timePeriodMin, m.quotaMb, m.noOfDevice, m.rateLimitKbps]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log(`Seeded ${matches.length} voucher_profile mappings.`);

  if (args.includes('--mint')) {
    const count = Number(args[args.indexOf('--mint') + 1]) || 1;
    const profileUuid = process.env.RUIJIE_VERIFY_PROFILE || args[args.indexOf('--profile') + 1];
    const groupId = process.env.RUIJIE_VERIFY_GROUP || args[args.indexOf('--group') + 1];
    if (!profileUuid || !groupId) {
      throw new RuijieApiError('verify_config', `--mint requires --profile <uuid> --group <id>`);
    }
    for (let i = 0; i < count; i++) {
      const v = await createRuijieVoucher({ profile: profileUuid, userGroupId: groupId, comment: `seed verify ${Date.now()}` });
      console.log(`Minted ${v.codeNo} (group=${groupId}, expiry=${v.expiryTime ?? 'n/a'})`);
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nSeed failed:', err instanceof RuijieApiError ? `[${err.code}] ${err.message}` : (err as Error).message);
    process.exit(1);
  }
);