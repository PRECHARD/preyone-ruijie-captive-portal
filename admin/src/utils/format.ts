/**
 * Shared display formatters for the admin SPA.
 *
 * The base unit matters here and is not arbitrary: the backend converts a
 * voucher's data_limit_gb to bytes with 1073741824 (see the dataFrom query in
 * src/routes/admin.ts and wisprTransformer.ts). Any formatter using a decimal
 * base (1e9) would render "1 GB" next to a quota that is actually 1.07 GB and
 * make a voucher look like it had run out early.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Binary-based byte formatter, matching the backend's quota arithmetic. */
export function fmtBytes(bytes: number | string | null | undefined): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (n == null || !Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= GB) return `${(n / GB).toFixed(n / GB >= 100 ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n / MB >= 100 ? 0 : 1)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(n / KB >= 100 ? 0 : 1)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * "350 MB / 1 GB" — used vs quota. Renders an em dash for the quota half when the
 * voucher is uncapped, because showing "used / —" is clearer than inventing a cap.
 */
export function fmtUsage(
  usedBytes: number | string | null | undefined,
  totalBytes: number | string | null | undefined
): string {
  const used = fmtBytes(usedBytes);
  if (totalBytes == null) return `${used} / Unlimited`;
  return `${used} / ${fmtBytes(totalBytes)}`;
}

/**
 * Render any MAC spelling as colon-separated uppercase hex. The gateway, the
 * signup query string and voucher_devices all disagree on spelling, so this
 * strips to 12 hex chars first and regroups — matching the display convention
 * used in MacMgmt's placeholder.
 */
export function formatMac(mac: string | null | undefined): string {
  if (!mac) return '—';
  const hex = String(mac).replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  if (hex.length !== 12) return String(mac);
  return hex.match(/.{2}/g)!.join(':');
}

/** Compact speed label, e.g. "2/5 Mbps". */
export function formatSpeed(upMbps: number | null, downMbps: number | null): string {
  if (upMbps == null && downMbps == null) return '—';
  return `${upMbps ?? '—'}/${downMbps ?? '—'} Mbps`;
}

/** Duration in minutes as a short human label. */
export function fmtDurationMin(minutes: number | null | undefined): string {
  if (!minutes) return '—';
  if (minutes >= 43200) return `${Math.round(minutes / 43200)}mo`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}min`;
}

/** Timestamp for table cells; null-safe and never throws on a malformed value. */
export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

/** Local YYYY-MM-DD for <input type="date"> value attributes. */
export function toDateInputValue(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}