import crypto from 'crypto';

/**
 * Human-readable, globally unique document identifier.
 *
 * 100 bits of randomness encoded in Crockford base32 (no I/L/O/U, so it can be
 * read from paper without confusion). The `PVN-` prefix is the Preyone
 * namespace; the code is unique in the database and resolves through the public
 * verification endpoint.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 20;

export function generateDocumentVerifyCode(): string {
  const bytes = crypto.randomBytes(20);
  let value = 0;
  let bits = 0;
  let body = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      body += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) body += ALPHABET[(value << (5 - bits)) & 31];
  body = body.slice(0, BODY_LENGTH);
  return `PVN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}`;
}

/** Accepts typed codes, common I/L/O/U confusions and full verification URLs. */
export function normalizeDocumentVerifyCode(value: unknown): string | null {
  let raw = String(value || '').trim().toUpperCase();
  const urlMatch = raw.match(/\/VERIFY\/([^/?#]+)/);
  if (urlMatch) raw = urlMatch[1];
  raw = raw
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (!raw.startsWith('PVN')) return null;
  const body = raw.slice(3);
  if (body.length !== BODY_LENGTH) return null;
  for (const char of body) {
    if (!ALPHABET.includes(char)) return null;
  }
  return `PVN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}`;
}

/** Canonical public verification URL printed on every document. */
export function documentVerifyUrl(code: string): string {
  return `https://preyone.com/verify/${encodeURIComponent(code)}`;
}
