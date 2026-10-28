import { pool } from '../db/pool';
import {
  isRuijieCloudConfigured,
  upsertRuijieUserGroup,
  type RuijieUserGroupPolicy,
  type UpsertedRuijieUserGroup,
} from './ruijieCloud';
import { isThrottleError, throttledRuijieCall } from './ruijieSync';

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
  /** Skip the pacing wait (explicit admin "send now" actions). */
  immediate?: boolean;
  /** Injected clock/sleep, forwarded to the shared pacing queue (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

  try {
    const push = options.push ?? upsertRuijieUserGroup;
    const applied = await throttledRuijieCall(() => push(policy), {
      label: `usergroup:${tierName}`,
      immediate: options.immediate,
      now: options.now,
      sleep: options.sleep,
    });
    await recordOutcome(tierName, 'synced', applied?.id ?? null);
    return { tierName, status: 'synced', degraded: false, userGroupId: applied?.id };
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
