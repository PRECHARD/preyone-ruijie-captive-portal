import axios from 'axios';

/**
 * Call Ruijie authentication URL to apply WISPr parameters and unlock a MAC
 * Expects ruijieAuthUrl to be a base URL that accepts query parameters
 */
export async function bypassRuijieFirewall(macAddress: string, ruijieAuthUrl: string, speedBits: number | null, dataBytes: number | null): Promise<boolean> {
  if (!ruijieAuthUrl) return false;
  try {
    let authCommandUrl = ruijieAuthUrl;

    // Ensure URL has a query marker
    if (!authCommandUrl.includes('?')) authCommandUrl += '?';
    else if (!authCommandUrl.endsWith('&') && !authCommandUrl.endsWith('?')) authCommandUrl += '&';

    const ruijiePassword = process.env.RUIJIE_PASSWORD || 'PreyoneNetAccess';
    authCommandUrl += `username=${encodeURIComponent(macAddress)}&password=${encodeURIComponent(ruijiePassword)}`;

    if (speedBits && speedBits > 0) {
      authCommandUrl += `&wispr_bandwidth_max_down=${speedBits}&wispr_bandwidth_max_up=${Math.round(speedBits * 0.5)}`;
    }
    if (dataBytes && dataBytes > 0) {
      authCommandUrl += `&wispr_max_bytes=${dataBytes}`;
    }

    await axios.get(authCommandUrl, { timeout: 5000 });
    console.log(`[AUTONOMOUS HARDWARE PROVISION] Network bypass profile loaded for MAC: ${macAddress}`);
    return true;
  } catch (error: any) {
    console.error('Ruijie bridge deployment error:', error?.message || error);
    return false;
  }
}
