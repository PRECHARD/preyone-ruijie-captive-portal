/**
 * Shared Zimbabwe phone normalizer for server-side company/contact data.
 *
 * Mirrors `formatZimPhone` / `zimPhoneOrEmpty` in the Flutter app so a care
 * line entered as a local 07xx number or a stray 363 prefix is stored/returned
 * in E.164-style +263 form wherever a device would print it.
 */

export function formatZimPhone(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  let s = v.replace(/[^0-9+]/g, '');
  if (s.startsWith('+363')) {
    s = `+263${s.slice(4)}`;
  } else if (s.startsWith('0363') && s.length >= 12) {
    s = `+263${s.slice(4)}`;
  } else if (s.startsWith('363') && s.length >= 11) {
    s = `+263${s.slice(3)}`;
  }
  if (s.startsWith('07') || s.startsWith('08')) {
    s = `+263${s.slice(1)}`;
  } else if (s.startsWith('7') || s.startsWith('8')) {
    s = `+263${s}`;
  }
  return s;
}

/** Server-side analogue of the app's blank-phone helper: '' for blank input. */
export function zimCareLine(raw: string | null | undefined): string {
  return formatZimPhone(raw);
}