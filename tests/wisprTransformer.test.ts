import { describe, it, expect } from 'vitest';
import {
  transformToWISPrProfile,
  generateWISPrAccessAccept,
  buildRuijieWISPrCallbackUrl,
  parseWISPrRedirectParams,
  calculateBandwidthThrottle,
} from '../src/utils/wisprTransformer';

describe('transformToWISPrProfile', () => {
  const baseInput = {
    macAddress: 'AA:BB:CC:DD:EE:FF',
    packageData: {
      data_limit_gb: 10,
      is_uncapped: false,
      bandwidth_mbps_up: 5,
      bandwidth_mbps_down: 10,
      duration_min: 1440,
    },
  };

  it('converts Mbps to Kbps', () => {
    const result = transformToWISPrProfile(baseInput);
    expect(result.bandwidthUpKbps).toBe(5000);
    expect(result.bandwidthDownKbps).toBe(10000);
  });

  it('converts GB to bytes for capped plans', () => {
    const result = transformToWISPrProfile(baseInput);
    expect(result.dataQuotaBytes).toBe(10 * 1_073_741_824);
  });

  it('returns null dataQuotaBytes for uncapped plans', () => {
    const result = transformToWISPrProfile({
      ...baseInput,
      packageData: { ...baseInput.packageData, is_uncapped: true, data_limit_gb: null },
    });
    expect(result.dataQuotaBytes).toBeNull();
  });

  it('converts duration from minutes to seconds', () => {
    const result = transformToWISPrProfile(baseInput);
    expect(result.durationSeconds).toBe(86400);
  });

  it('handles null data_limit_gb on capped plan', () => {
    const result = transformToWISPrProfile({
      ...baseInput,
      packageData: { ...baseInput.packageData, data_limit_gb: null, is_uncapped: false },
    });
    expect(result.dataQuotaBytes).toBeNull();
  });

  it('returns correct MAC address', () => {
    const result = transformToWISPrProfile(baseInput);
    expect(result.macAddress).toBe('AA:BB:CC:DD:EE:FF');
  });
});

describe('generateWISPrAccessAccept', () => {
  const profile = {
    macAddress: 'AA:BB:CC:DD:EE:FF',
    bandwidthUpKbps: 5000,
    bandwidthDownKbps: 10000,
    dataQuotaBytes: 10_737_418_240,
    isUncapped: false,
    durationSeconds: 86400,
  };

  it('generates correct WISPr parameters', () => {
    const result = generateWISPrAccessAccept(profile, 'session-123');
    expect(result.sessionId).toBe('session-123');
    expect(result.maxBandwidthUp).toBe(5000);
    expect(result.maxBandwidthDown).toBe(10000);
    expect(result.dataQuota).toBe(10_737_418_240);
    expect(result.sessionTimeout).toBe(86400);
  });

  it('sets billing type to quota for capped plans', () => {
    const result = generateWISPrAccessAccept(profile, 's1');
    expect(result.billingType).toBe('quota');
  });

  it('sets billing type to unlimited for uncapped plans', () => {
    const result = generateWISPrAccessAccept({ ...profile, isUncapped: true, dataQuotaBytes: null }, 's1');
    expect(result.billingType).toBe('unlimited');
  });

  it('sets dataQuota to null for uncapped plans', () => {
    const result = generateWISPrAccessAccept({ ...profile, isUncapped: true, dataQuotaBytes: null }, 's1');
    expect(result.dataQuota).toBeNull();
  });
});

describe('buildRuijieWISPrCallbackUrl', () => {
  const wisprProfile = {
    macAddress: 'AA:BB:CC:DD:EE:FF',
    bandwidthUpKbps: 5000,
    bandwidthDownKbps: 10000,
    dataQuotaBytes: 10_737_418_240,
    isUncapped: false,
    durationSeconds: 86400,
  };

  it('builds URL with all WISPr parameters', () => {
    const url = buildRuijieWISPrCallbackUrl({
      successUrl: 'http://portal.local/success',
      sessionId: 'sid-1',
      wisprProfile,
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });

    expect(url).toContain('WISPr-Session-Id=sid-1');
    expect(url).toContain('WISPr-User-Name=preyone_AA%3ABB%3ACC%3ADD%3AEE%3AFF');
    expect(url).toContain('WISPr-Bandwidth-Max-Up=5000');
    expect(url).toContain('WISPr-Bandwidth-Max-Down=10000');
    expect(url).toContain('WISPr-Data-Quota=10737418240');
    expect(url).toContain('WISPr-Session-Timeout=86400');
    expect(url).toContain('Device-MAC=AA%3ABB%3ACC%3ADD%3AEE%3AFF');
    expect(url).toContain('Uncapped=false');
  });

  it('omits data quota for uncapped', () => {
    const url = buildRuijieWISPrCallbackUrl({
      successUrl: 'http://portal.local/success',
      sessionId: 'sid-2',
      wisprProfile: { ...wisprProfile, dataQuotaBytes: null, isUncapped: true },
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });

    expect(url).not.toContain('WISPr-Data-Quota');
    expect(url).toContain('Uncapped=true');
  });
});

describe('parseWISPrRedirectParams', () => {
  it('parses parameters from a WISPr callback URL', () => {
    const result = parseWISPrRedirectParams(
      'http://portal.local/success?WISPr-Session-Id=s1&WISPr-Bandwidth-Max-Up=5000&WISPr-Bandwidth-Max-Down=10000&WISPr-Data-Quota=10737418240&WISPr-Session-Timeout=86400'
    );
    expect(result.sessionId).toBe('s1');
    expect(result.bandwidthUp).toBe(5000);
    expect(result.bandwidthDown).toBe(10000);
    expect(result.dataQuota).toBe(10_737_418_240);
    expect(result.sessionTimeout).toBe(86400);
  });

  it('returns empty object for invalid URL', () => {
    const result = parseWISPrRedirectParams('not-a-url');
    expect(result).toEqual({});
  });

  it('handles missing optional parameters', () => {
    const result = parseWISPrRedirectParams('http://portal.local/success?WISPr-Session-Id=s1');
    expect(result.sessionId).toBe('s1');
    expect(result.dataQuota).toBeUndefined();
  });
});

describe('calculateBandwidthThrottle', () => {
  it('calculates burst as 120% of base', () => {
    const result = calculateBandwidthThrottle(10);
    expect(result.rateKbps).toBe(10000);
    expect(result.burstKbps).toBe(12000);
  });

  it('calculates buffer as 10 seconds of data', () => {
    const result = calculateBandwidthThrottle(10);
    expect(result.bufferSize).toBe(12500);
  });
});
