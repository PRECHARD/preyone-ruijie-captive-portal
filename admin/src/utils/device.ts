import { UAParser } from 'ua-parser-js';

export interface DeviceLabel {
  brand: string;
  model: string;
  kind: string;
}

/**
 * Extract a human device label from a browser User-Agent using ua-parser-js.
 * Captured end-user agents live on users.user_agent (see gateway /report-ua);
 * sessions without a recorded agent degrade to a generic kind or '—'.
 */
export function parseDeviceLabel(ua?: string | null): DeviceLabel | null {
  if (!ua) return null;
  try {
    const p = new UAParser(ua);
    const d = p.getDevice();
    const b = p.getBrowser();
    const os = p.getOS();
    const rawModel = (d.model || '').trim();
    const model = rawModel && rawModel.toLowerCase() !== 'generic' ? rawModel : '';
    const brand = (d.vendor || '').trim();
    const name = b.name || os.name || null;
    const kind = d.type
      ? d.type === 'mobile' ? 'Mobile' : d.type === 'tablet' ? 'Tablet' : d.type
      : model ? 'Device' : name || 'Device';
    return { brand, model, kind };
  } catch {
    return null;
  }
}

/** Compact single-line label for tables, e.g. "Apple iPhone 15 Pro". */
export function deviceShort(ua?: string | null): string {
  const l = parseDeviceLabel(ua);
  if (!l) return '—';
  return [l.brand, l.model].filter(Boolean).join(' ') || l.kind;
}