import { Request } from 'express';
import {
  transformToWISPrProfile,
  generateWISPrAccessAccept,
} from './wisprTransformer';

export interface WISPrSessionConfig {
  sessionToken: string;
  macAddress?: string;
  originalUrl?: string;
  packageData?: {
    data_limit_gb: number | null;
    is_uncapped: boolean;
    bandwidth_mbps_up: number;
    bandwidth_mbps_down: number;
    duration_min: number;
  };
}

export function isSafeSameOriginUrl(rawUrl: string, origin: string): boolean {
  try {
    const url = new URL(rawUrl, origin);
    return url.origin === origin;
  } catch {
    return false;
  }
}

/**
 * Build success URL with optional WISPr bandwidth configuration
 * If package data is provided, includes WISPr parameters for automatic bandwidth and quota setup
 */
export function buildRuijieSuccessUrl(req: Request, config: WISPrSessionConfig): string {
  const base = process.env.RUIJIE_SUCCESS_URL;
  const originalUrl = config.originalUrl || (req.query.url as string);

  let url: URL;
  if (base) {
    try {
      url = new URL(base);
    } catch (err) {
      console.warn('Invalid RUIJIE_SUCCESS_URL value:', base, err);
      url = new URL('/success.html', `${req.protocol}://${req.get('host')}`);
    }
  } else {
    const origin = `${req.protocol}://${req.get('host')}`;
    if (originalUrl && isSafeSameOriginUrl(originalUrl, origin)) {
      url = new URL(originalUrl, origin);
    } else {
      url = new URL('/success.html', origin);
    }
  }

  url.searchParams.set('token', config.sessionToken);

  if (config.packageData && config.macAddress) {
    const wisprProfile = transformToWISPrProfile({
      macAddress: config.macAddress,
      packageData: config.packageData,
    });

    const wisprParams = generateWISPrAccessAccept(wisprProfile, config.sessionToken);

    url.searchParams.append('WISPr-Bandwidth-Max-Up', wisprParams.maxBandwidthUp.toString());
    url.searchParams.append('WISPr-Bandwidth-Max-Down', wisprParams.maxBandwidthDown.toString());

    if (wisprParams.dataQuota) {
      url.searchParams.append('WISPr-Data-Quota', wisprParams.dataQuota.toString());
    }

    url.searchParams.append('WISPr-Session-Timeout', wisprParams.sessionTimeout.toString());
    url.searchParams.append('Billing-Type', wisprParams.billingType);

    if (config.macAddress) {
      url.searchParams.append('Device-MAC', config.macAddress);
    }
  }

  return url.toString();
}

/**
 * Legacy function for backwards compatibility - accepts just session token
 */
export function buildRuijieSuccessUrlLegacy(req: Request, sessionToken: string): string {
  return buildRuijieSuccessUrl(req, { sessionToken });
}

