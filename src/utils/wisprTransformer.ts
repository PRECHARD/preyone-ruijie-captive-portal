/**
 * WISPr (Wireless Internet Service Provider roaming) Parameter Transformer
 * Converts Preyone package parameters into WISPr-compliant bandwidth and data quota configurations
 * for deployment on Ruijie AP hardware
 */

interface PackageData {
  data_limit_gb: number | null;
  is_uncapped: boolean;
  bandwidth_mbps_up: number;
  bandwidth_mbps_down: number;
  duration_min: number;
}

interface WISPrProfile {
  macAddress: string;
  bandwidthUpKbps: number;
  bandwidthDownKbps: number;
  dataQuotaBytes: number | null;
  isUncapped: boolean;
  durationSeconds: number;
}

interface WISPrParameters {
  sessionId: string;
  maxBandwidthUp: number; // Kbps
  maxBandwidthDown: number; // Kbps
  dataQuota: number | null; // Bytes
  sessionTimeout: number; // Seconds
  isUncapped: boolean;
  accountBalance?: number;
  billingType: string;
}

/**
 * Transform package data into WISPr profile
 * Handles conversion of human-readable speeds/limits to network-level parameters
 */
export function transformToWISPrProfile(input: {
  macAddress: string;
  packageData: PackageData;
}): WISPrProfile {
  const { macAddress, packageData } = input;

  // Convert Mbps to Kbps (1 Mbps = 1000 Kbps)
  const bandwidthUpKbps = packageData.bandwidth_mbps_up * 1000;
  const bandwidthDownKbps = packageData.bandwidth_mbps_down * 1000;

  // Convert GB to Bytes (1 GB = 1,073,741,824 bytes)
  const dataQuotaBytes = packageData.is_uncapped
    ? null
    : (packageData.data_limit_gb != null ? packageData.data_limit_gb * 1_073_741_824 : null);

  return {
    macAddress,
    bandwidthUpKbps,
    bandwidthDownKbps,
    dataQuotaBytes,
    isUncapped: packageData.is_uncapped,
    durationSeconds: packageData.duration_min * 60,
  };
}

/**
 * Generate WISPr Access-Accept parameters for Ruijie AP
 * These parameters are sent in the authentication response to configure the session
 */
export function generateWISPrAccessAccept(profile: WISPrProfile, sessionId: string): WISPrParameters {
  return {
    sessionId,
    maxBandwidthUp: profile.bandwidthUpKbps,
    maxBandwidthDown: profile.bandwidthDownKbps,
    dataQuota: profile.dataQuotaBytes,
    sessionTimeout: profile.durationSeconds,
    isUncapped: profile.isUncapped,
    billingType: profile.isUncapped ? 'unlimited' : 'quota',
  };
}

/**
 * Generate HTTP callback URL with WISPr parameters
 * This URL is returned to the Ruijie AP after successful authentication
 * The AP will redirect the user's device to this URL, which will set up the session
 */
export function buildRuijieWISPrCallbackUrl(input: {
  successUrl: string;
  sessionId: string;
  wisprProfile: WISPrProfile;
  macAddress: string;
}): string {
  const { successUrl, sessionId, wisprProfile, macAddress } = input;

  const url = new URL(successUrl);

  // WISPr-defined parameters
  url.searchParams.append('WISPr-Session-Id', sessionId);
  url.searchParams.append('WISPr-User-Name', `preyone_${macAddress}`);

  // Bandwidth parameters (in Kbps)
  url.searchParams.append('WISPr-Bandwidth-Max-Up', wisprProfile.bandwidthUpKbps.toString());
  url.searchParams.append('WISPr-Bandwidth-Max-Down', wisprProfile.bandwidthDownKbps.toString());

  // Data quota (if applicable)
  if (wisprProfile.dataQuotaBytes) {
    url.searchParams.append('WISPr-Data-Quota', wisprProfile.dataQuotaBytes.toString());
  }

  // Session timeout in seconds
  url.searchParams.append('WISPr-Session-Timeout', wisprProfile.durationSeconds.toString());

  // Uncapped indicator
  url.searchParams.append('Uncapped', wisprProfile.isUncapped ? 'true' : 'false');

  // Ruijie-specific extensions
  url.searchParams.append('Ruijie-Model', 'WISPr-Compatible');
  url.searchParams.append('Device-MAC', macAddress);

  return url.toString();
}

/**
 * Parse WISPr parameters from redirect callback
 * Used to validate parameters returned by Ruijie AP
 */
export function parseWISPrRedirectParams(redirectUrl: string): {
  sessionId?: string;
  bandwidthUp?: number;
  bandwidthDown?: number;
  dataQuota?: number;
  sessionTimeout?: number;
} {
  try {
    const url = new URL(redirectUrl);
    return {
      sessionId: url.searchParams.get('WISPr-Session-Id') || undefined,
      bandwidthUp: parseInt(url.searchParams.get('WISPr-Bandwidth-Max-Up') || '0'),
      bandwidthDown: parseInt(url.searchParams.get('WISPr-Bandwidth-Max-Down') || '0'),
      dataQuota: url.searchParams.get('WISPr-Data-Quota')
        ? parseInt(url.searchParams.get('WISPr-Data-Quota')!)
        : undefined,
      sessionTimeout: parseInt(url.searchParams.get('WISPr-Session-Timeout') || '0'),
    };
  } catch (error) {
    console.error('Error parsing WISPr redirect parameters:', error);
    return {};
  }
}

/**
 * Log WISPr configuration for debugging
 */
export function logWISPrConfiguration(_profile: WISPrProfile, _params: WISPrParameters): void {
  // intentionally empty — debug logs removed
}

/**
 * Estimate bandwidth throttle rate based on package tier
 * Used for traffic shaping on Ruijie AP
 */
export function calculateBandwidthThrottle(originalMbps: number): {
  burstKbps: number; // Peak rate
  rateKbps: number; // Sustained rate
  bufferSize: number; // Bytes
} {
  const baseKbps = originalMbps * 1000;

  return {
    burstKbps: Math.ceil(baseKbps * 1.2), // Allow 20% burst
    rateKbps: baseKbps,
    bufferSize: Math.ceil((baseKbps / 8) * 10), // 10 seconds of buffer
  };
}
