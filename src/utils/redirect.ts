import { Request } from 'express';
import {
  transformToWISPrProfile,
  generateWISPrAccessAccept,
} from './wisprTransformer';

export interface WISPrSessionConfig {
  sessionToken: string;
  macAddress?: string;
  originalUrl?: string;
  nasip?: string;
  loginUrl?: string;
  nasMac?: string;
  ssid?: string;
  voucherCode?: string;
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

  // Build success URL with session data (for AP redirect-back or as fallback)
  function buildSuccessUrl(): URL {
    let u: URL;
    if (base) {
      try {
        u = new URL(base);
      } catch (err) {
        console.warn('Invalid RUIJIE_SUCCESS_URL value:', base, err);
        u = new URL('/success.html', `${req.protocol}://${req.get('host')}`);
      }
    } else {
      const origin = `${req.protocol}://${req.get('host')}`;
      if (originalUrl && isSafeSameOriginUrl(originalUrl, origin)) {
        u = new URL(originalUrl, origin);
      } else {
        u = new URL('/success.html', origin);
      }
    }

    u.searchParams.set('token', config.sessionToken);
    u.searchParams.set('loginUrl', config.loginUrl || '');
    u.searchParams.set('origUrl', config.originalUrl || '');
    u.searchParams.set('nas_ip', config.nasip || '');
    u.searchParams.set('nas_mac', config.nasMac || '');
    u.searchParams.set('ssid', config.ssid || '');
    u.searchParams.set('voucher', config.voucherCode || '');
    if (config.macAddress) {
      u.searchParams.set('mac', config.macAddress);
      u.searchParams.set('client_mac', config.macAddress);
    }

    if (config.packageData && config.macAddress) {
      const wisprProfile = transformToWISPrProfile({
        macAddress: config.macAddress,
        packageData: config.packageData,
      });
      const wisprParams = generateWISPrAccessAccept(wisprProfile, config.sessionToken);
      u.searchParams.append('WISPr-Bandwidth-Max-Up', wisprParams.maxBandwidthUp.toString());
      u.searchParams.append('WISPr-Bandwidth-Max-Down', wisprParams.maxBandwidthDown.toString());
      if (wisprParams.dataQuota) {
        u.searchParams.append('WISPr-Data-Quota', wisprParams.dataQuota.toString());
      }
      u.searchParams.append('WISPr-Session-Timeout', wisprParams.sessionTimeout.toString());
      u.searchParams.append('Billing-Type', wisprParams.billingType);
      if (config.macAddress) {
        u.searchParams.append('Device-MAC', config.macAddress);
      }
    }
    return u;
  }

  // Redirect directly to ext_login so MAC authorization happens on main navigation
  // (iOS CNA doesn't reliably execute JS-based background POSTs)
  // CSP formAction is now set to * so success.html's iframe POST also works.
  if (config.loginUrl && config.macAddress) {
    const extLoginUrl = new URL(config.loginUrl);
    extLoginUrl.searchParams.set('client_mac', config.macAddress);
    extLoginUrl.searchParams.set('mac', config.macAddress.replace(/[:-]/g, '').toUpperCase());
    extLoginUrl.searchParams.set('nas_ip', config.nasip || '');
    extLoginUrl.searchParams.set('nas_mac', config.nasMac || '');
    extLoginUrl.searchParams.set('ssid', config.ssid || '');
    extLoginUrl.searchParams.set('username', config.voucherCode || config.macAddress);
    extLoginUrl.searchParams.set('password', config.voucherCode || config.macAddress);
    extLoginUrl.searchParams.set('url', originalUrl || 'http://preyone.com');
    extLoginUrl.searchParams.set('redirect', originalUrl || 'http://preyone.com');
    return extLoginUrl.toString();
  }

  // No ext_login URL available — go straight to success page
  return buildSuccessUrl().toString();
}

/**
 * Legacy function for backwards compatibility - accepts just session token
 */
export function buildRuijieSuccessUrlLegacy(req: Request, sessionToken: string): string {
  return buildRuijieSuccessUrl(req, { sessionToken });
}

