import { pool } from '../db/pool';
import {
  getRuijieUserGroups,
  isRuijieCloudConfigured,
  upsertRuijieUserGroup,
  type RuijieUserGroup,
  type RuijieUserGroupPolicy,
  type UpsertedRuijieUserGroup,
} from './ruijieCloud';
import { isThrottleError, throttledRuijieCall } from './ruijieSync';
import { RuijieApiError } from './ruijieErrors';

/**
 * Package → Ruijie Cloud User Group auto-provisioning.
 *
 * Creating or editing a package must never depend on Ruijie being reachable:
 * the tenant quota is tiny and routinely returns `{ code: 44 }`. So the flow is
 *
 *   1. derive the desired group policy from the package row;
 *   2. persist that policy in `ruijie_user_group_sync` (status `pending`);
 *   3. push it through the shared pacing queue / circuit breaker in
 *      `ruijieSync.throttledRuijieCall()` on a fire-and-forget call;
 *   4. on success mark the row `synced`, otherwise keep it `pending`/`failed`
 *      with the error. Nothing is thrown to the admin request.
 *
 * The local row is the retry source of truth, so a later edit (or a manual
 * retry) re-sends the same upsert and Ruijie matches it by group name.
 */

export type UserGroupSyncStatus = 'pending' | 'synced' | 'failed' | 'skipped';

export interface PackagePolicyRow {
  tier_name: string;
  display_name: string;
  duration_min: number | null;
  data_limit_gb: string | number | null;
  is_uncapped: boolean | null;
  bandwidth_mbps_up: number | null;
  bandwidth_mbps_down: number | null;
  max_devices: number | null;
}

export interface ProvisionResult {
  tierName: string;
  status: UserGroupSyncStatus;
  /** True when Ruijie was not applied and the local cache holds the desired state. */
  degraded: boolean;
  error?: string;
  userGroupId?: string;
}

function mbpsToKbps(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024) : 0;
}

/**
 * Translate a package row into the user-group policy Ruijie enforces.
 * Pure and exported so the mapping can be unit-tested without a database.
 */
export function userGroupPolicyFromPackage(pkg: PackagePolicyRow): RuijieUserGroupPolicy {
  const unlimited = pkg.is_uncapped !== false;
  const quotaMb = unlimited
    ? 0
    : Math.max(0, Math.round(Number(pkg.data_limit_gb ?? 0) * 1024));
  return {
    name: pkg.tier_name,
    comment: pkg.display_name,
    timePeriodMin: pkg.duration_min ?? null,
    quotaMb,
    noOfDevice: pkg.max_devices ?? 1,
    rateLimitKbpsUp: mbpsToKbps(pkg.bandwidth_mbps_up),
    rateLimitKbpsDown: mbpsToKbps(pkg.bandwidth_mbps_down),
  };
}

async function recordDesiredPolicy(policy: RuijieUserGroupPolicy): Promise<void> {
  await pool.query(
    `INSERT INTO ruijie_user_group_sync
       (tier_name, desired_name, time_period_min, quota_mb, no_of_device,
        rate_limit_kbps_up, rate_limit_kbps_down, sync_status, attempts,
        last_attempt_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 1, NOW(), NOW())
     ON CONFLICT (tier_name) DO UPDATE SET
       desired_name         = EXCLUDED.desired_name,
       time_period_min      = EXCLUDED.time_period_min,
       quota_mb             = EXCLUDED.quota_mb,
       no_of_device         = EXCLUDED.no_of_device,
       rate_limit_kbps_up   = EXCLUDED.rate_limit_kbps_up,
       rate_limit_kbps_down = EXCLUDED.rate_limit_kbps_down,
       sync_status          = 'pending',
       attempts             = ruijie_user_group_sync.attempts + 1,
       last_error           = NULL,
       last_attempt_at      = NOW(),
       updated_at           = NOW()`,
    [
      policy.name,
      policy.name,
      policy.timePeriodMin ?? null,
      policy.quotaMb ?? null,
      policy.noOfDevice ?? null,
      policy.rateLimitKbpsUp ?? null,
      policy.rateLimitKbpsDown ?? null,
    ]
  );
}

async function recordOutcome(
  tierName: string,
  status: UserGroupSyncStatus,
  userGroupId?: string | null,
  error?: string
): Promise<void> {
  await pool.query(
    `UPDATE ruijie_user_group_sync
        SET sync_status = $2,
            ruijie_user_group_id = COALESCE($3, ruijie_user_group_id),
            last_error = $4,
            synced_at = CASE WHEN $2 = 'synced' THEN NOW() ELSE synced_at END,
            updated_at = NOW()
      WHERE tier_name = $1`,
    [tierName, status, userGroupId ?? null, error ?? null]
  );
}

export interface ProvisionOptions {
  /** Test seam: replace the Ruijie push. */
  push?: (policy: RuijieUserGroupPolicy) => Promise<UpsertedRuijieUserGroup>;
  /** Test seam: replace the tenant user-group list read. */
  list?: () => Promise<RuijieUserGroup[]>;
  /** Skip the pacing wait (explicit admin "send now" actions). */
  immediate?: boolean;
  /** Injected clock/sleep, forwarded to the shared pacing queue (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ActiveMapping {
  ruijie_user_group_id: string;
  ruijie_profile_uuid: string;
}

async function getActiveMapping(tierName: string): Promise<ActiveMapping | null> {
  const { rows } = await pool.query(
    `SELECT ruijie_user_group_id, ruijie_profile_uuid
       FROM voucher_profiles WHERE tier_name = $1 AND active = TRUE LIMIT 1`,
    [tierName]
  );
  if (rows.length === 0) return null;
  return {
    ruijie_user_group_id: String(rows[0].ruijie_user_group_id),
    ruijie_profile_uuid: String(rows[0].ruijie_profile_uuid),
  };
}

/**
 * Write the `voucher_profiles` mapping that the mint path requires.
 *
 * `findRuijieProfile()` refuses to mint a tier that has no active mapping, so a
 * package is only truly sellable once this row exists. The group's own
 * `authProfileId` is the profile UUID; copying it (rather than inventing one)
 * is what makes the minted code enforce the group's policy.
 */
async function upsertVoucherProfile(tierName: string, group: RuijieUserGroup): Promise<void> {
  await pool.query(
    `INSERT INTO voucher_profiles
       (tier_name, ruijie_user_group_id, ruijie_profile_uuid, ruijie_group_name,
        time_period_min, quota_mb, no_of_device, rate_limit_kbps, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     ON CONFLICT (tier_name) DO UPDATE SET
       ruijie_user_group_id = EXCLUDED.ruijie_user_group_id,
       ruijie_profile_uuid  = EXCLUDED.ruijie_profile_uuid,
       ruijie_group_name    = EXCLUDED.ruijie_group_name,
       time_period_min      = EXCLUDED.time_period_min,
       quota_mb             = EXCLUDED.quota_mb,
       no_of_device         = EXCLUDED.no_of_device,
       rate_limit_kbps      = EXCLUDED.rate_limit_kbps,
       active               = TRUE,
       updated_at           = NOW()`,
    [
      tierName,
      group.id,
      group.authProfileId,
      group.name,
      group.timePeriodMin ?? null,
      group.quotaMb ?? null,
      group.noOfDevice ?? null,
      group.rateLimitKbps ?? null,
    ]
  );
}

function groupMatchesPolicy(group: RuijieUserGroup, policy: RuijieUserGroupPolicy): boolean {
  if ((group.timePeriodMin ?? null) !== (policy.timePeriodMin ?? null)) return false;
  if ((group.quotaMb ?? 0) !== (policy.quotaMb ?? 0)) return false;
  if ((group.noOfDevice ?? 1) !== (policy.noOfDevice ?? 1)) return false;
  const down = policy.rateLimitKbpsDown ?? 0;
  if (down > 0 && group.rateLimitKbps != null && group.rateLimitKbps !== down) return false;
  return true;
}

function pacing(options: ProvisionOptions, label: string) {
  return {
    label,
    immediate: options.immediate,
    now: options.now,
    sleep: options.sleep,
  };
}

async function findGroupByName(
  tierName: string,
  options: ProvisionOptions
): Promise<RuijieUserGroup | null> {
  const list = options.list ?? getRuijieUserGroups;
  const groups = await throttledRuijieCall(() => list(), pacing(options, `usergroup:list:${tierName}`));
  return groups.find((g) => g.name === tierName) ?? null;
}

/**
 * Provision (or update) the Ruijie User Group for one package tier.
 *
 * Never throws: every failure is recorded locally and returned as a degraded
 * result, because the caller is a package save that must not fail on throttle.
 */
export async function provisionRuijieUserGroupForPackage(
  tierName: string,
  options: ProvisionOptions = {}
): Promise<ProvisionResult> {
  if (!tierName) return { tierName, status: 'skipped', degraded: true, error: 'tier name missing' };

  let policy: RuijieUserGroupPolicy;
  try {
    const { rows } = await pool.query<PackagePolicyRow>(
      `SELECT tier_name, display_name, duration_min, data_limit_gb, is_uncapped,
              bandwidth_mbps_up, bandwidth_mbps_down, max_devices
         FROM packages WHERE tier_name = $1 AND deleted_at IS NULL LIMIT 1`,
      [tierName]
    );
    if (rows.length === 0) {
      return { tierName, status: 'skipped', degraded: true, error: 'package not found' };
    }
    policy = userGroupPolicyFromPackage(rows[0]);
    await recordDesiredPolicy(policy);
  } catch (err) {
    return {
      tierName,
      status: 'failed',
      degraded: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!isRuijieCloudConfigured()) {
    // Credentials absent (dev/test): keep the desired policy cached so a later
    // deployment can push it without re-saving the package.
    try {
      await recordOutcome(tierName, 'skipped', null, 'Ruijie Cloud not configured');
    } catch { /* cache write is best-effort */ }
    return { tierName, status: 'skipped', degraded: true, error: 'Ruijie Cloud not configured' };
  }

  const push = options.push ?? upsertRuijieUserGroup;
  try {
    const existing = await getActiveMapping(tierName);

    if (existing) {
      // Already sellable: keep the original contract and just push the policy.
      const applied = await throttledRuijieCall(
        () => push(policy),
        pacing(options, `usergroup:${tierName}`)
      );
      const groupId = applied?.id ?? existing.ruijie_user_group_id;
      await recordOutcome(tierName, 'synced', groupId);
      return { tierName, status: 'synced', degraded: false, userGroupId: groupId };
    }

    // No mapping yet means `findRuijieProfile()` will reject every mint for
    // this tier ("no active Ruijie Cloud profile mapping"). A package can be
    // seeded by migrate (no API save), so reconcile the mapping here: find the
    // group by name, create it only when it is genuinely absent, then copy its
    // id + authProfileId into voucher_profiles.
    let group = await findGroupByName(tierName, options);
    if (!group) {
      await throttledRuijieCall(
        () => push(policy),
        pacing(options, `usergroup:create:${tierName}`)
      );
      group = await findGroupByName(tierName, options);
    }
    if (!group || !group.authProfileId) {
      throw new RuijieApiError(
        'unmapped_tier',
        `Ruijie group "${tierName}" is missing or has no auth profile`
      );
    }

    // The mapping is what makes the tier sellable, so write it before the
    // best-effort policy alignment. A stale policy is a warning, not a blocker.
    await upsertVoucherProfile(tierName, group);
    if (!groupMatchesPolicy(group, policy)) {
      try {
        await throttledRuijieCall(
          () => push(policy),
          pacing(options, `usergroup:align:${tierName}`)
        );
        group = (await findGroupByName(tierName, options)) ?? group;
        await upsertVoucherProfile(tierName, group);
      } catch (alignErr) {
        console.warn(
          `[ruijie-usergroup] ${tierName} mapped but policy not aligned: ` +
            `${alignErr instanceof Error ? alignErr.message : String(alignErr)}`
        );
      }
    }

    await recordOutcome(tierName, 'synced', group.id);
    return { tierName, status: 'synced', degraded: false, userGroupId: group.id };
  } catch (err) {
    // Throttles and an open breaker are retryable; everything else is a hard
    // rejection (bad payload, missing permission). Both stay cached locally.
    const status: UserGroupSyncStatus = isThrottleError(err) ? 'pending' : 'failed';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ruijie-usergroup] ${tierName} not applied (${status}): ${message}`);
    try {
      await recordOutcome(tierName, status, null, message);
    } catch { /* cache write is best-effort */ }
    return { tierName, status, degraded: true, error: message };
  }
}

const inFlight = new Set<string>();

/**
 * Fire-and-forget provisioning used by the package CRUD handlers. Returns
 * `true` when a job was queued, `false` when one is already running for that
 * tier (a rapid double-save collapses into one Ruijie call).
 */
export function queueRuijieUserGroupProvisioning(tierName: string): boolean {
  if (!tierName || inFlight.has(tierName)) return false;
  // Without credentials there is nothing to push; the package save stays local
  // and the next configured save/edit provisions the group.
  if (!isRuijieCloudConfigured()) return false;
  inFlight.add(tierName);
  const run = () => {
    void provisionRuijieUserGroupForPackage(tierName)
      .catch((err) => {
        console.warn(`[ruijie-usergroup] ${tierName} background job failed:`, err);
      })
      .finally(() => inFlight.delete(tierName));
  };
  // setTimeout(0) rather than await: the admin save must answer immediately.
  setTimeout(run, 0);
  return true;
}

/** Latest cached desired/applied state for a tier (ops + tests). */
export async function getRuijieUserGroupSync(tierName: string): Promise<{
  tier_name: string;
  sync_status: UserGroupSyncStatus;
  ruijie_user_group_id: string | null;
  attempts: number;
  last_error: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT tier_name, sync_status, ruijie_user_group_id, attempts, last_error
       FROM ruijie_user_group_sync WHERE tier_name = $1 LIMIT 1`,
    [tierName]
  );
  return rows.length > 0 ? (rows[0] as any) : null;
}

/** Test helper: forget queued/in-flight jobs. */
export function __resetRuijieUserGroupQueueForTests(): void {
  inFlight.clear();
}
