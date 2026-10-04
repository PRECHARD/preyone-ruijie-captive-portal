import { pool } from '../db/pool';
import {
  createRuijieVoucher,
  isRuijieCloudConfigured as ruijieConfigured,
  RuijieApiError,
} from './ruijieCloud';

export interface RuijieProfileMapping {
  ruijie_user_group_id: string;
  ruijie_profile_uuid: string;
  ruijie_group_name: string | null;
  time_period_min: number | null;
  quota_mb: number | null;
  no_of_device: number | null;
  rate_limit_kbps: number | null;
}

const ACTIVE_PROFILE_SQL = `SELECT ruijie_user_group_id, ruijie_profile_uuid, ruijie_group_name,
                                   time_period_min, quota_mb, no_of_device, rate_limit_kbps
                            FROM voucher_profiles WHERE tier_name = $1 AND active = TRUE LIMIT 1`;

export function isRuijieCloudConfigured(): boolean {
  return ruijieConfigured();
}

export async function findRuijieProfile(tierName: string): Promise<RuijieProfileMapping | null> {
  const { rows } = await pool.query(ACTIVE_PROFILE_SQL, [tierName]);
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ruijie_user_group_id: String(r.ruijie_user_group_id),
    ruijie_profile_uuid: String(r.ruijie_profile_uuid),
    ruijie_group_name: r.ruijie_group_name ?? null,
    time_period_min: r.time_period_min != null ? Number(r.time_period_min) : null,
    quota_mb: r.quota_mb != null ? Number(r.quota_mb) : null,
    no_of_device: r.no_of_device != null ? Number(r.no_of_device) : null,
    rate_limit_kbps: r.rate_limit_kbps != null ? Number(r.rate_limit_kbps) : null,
  };
}

export interface MintedRuijieVoucher {
  codeNo: string;
  profile: string;
  userGroupId: string;
  expiryTime?: number;
  comment: string;
}

/**
 * Mint a single Ruijie Cloud voucher for a tier. Throws RuijieApiError when the
 * tier has no active mapping (unmapped = cannot be sold) or the API rejects the
 * request. Never fabricates a code as a fallback.
 */
export async function mintRuijieVoucherForTier(
  tierName: string,
  comment?: string
): Promise<MintedRuijieVoucher> {
  const profile = await findRuijieProfile(tierName);
  if (!profile) {
    throw new RuijieApiError('unmapped_tier', `Package tier '${tierName}' has no active Ruijie Cloud profile mapping`);
  }
  const cleanComment = (comment || '').slice(0, 50);
  const voucher = await createRuijieVoucher({
    profile: profile.ruijie_profile_uuid,
    userGroupId: profile.ruijie_user_group_id,
    comment: cleanComment,
  });
  return {
    codeNo: voucher.codeNo,
    profile: profile.ruijie_profile_uuid,
    userGroupId: profile.ruijie_user_group_id,
    expiryTime: voucher.expiryTime,
    comment: cleanComment,
  };
}