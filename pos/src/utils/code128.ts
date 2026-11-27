/**
 * Minimal dependency-free Code 128-B encoder for Preyone receipt verification.
 *
 * The canonical 107-symbol table below is the published Code 128 bar/space
 * pattern. Set B covers printable ASCII (32-126), which is exactly what our
 * verification payload uses. Keeping this local means the POS SPA needs no new
 * runtime dependency and the same bit stream can be drawn as PDF vectors or as
 * an SVG path for the thermal receipt.
 */

const BARS = [
  11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
  10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
  11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
  10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
  11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
  11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
  11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
  10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
  11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
  10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
  11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
  11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
  11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
  10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
  10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
  11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
  10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
  10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
  11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
  10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
  10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
  11010011100, 1100011101011,
];

const START_B = 104;
const STOP = 106;

function printable(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '');
}

/** `1` is a dark module, `0` a light module; includes start, checksum, stop. */
export function code128Bars(rawValue: string): string {
  const value = printable(String(rawValue || ''));
  if (!value) return '';

  let checksum = START_B;
  let bits = BARS[START_B].toString();

  for (let i = 0; i < value.length; i++) {
    const symbol = value.charCodeAt(i) - 32;
    checksum += symbol * (i + 1);
    bits += BARS[symbol].toString();
  }

  bits += BARS[checksum % 103].toString();
  bits += BARS[STOP].toString();
  return bits;
}

/**
 * Canonical public verification payload. The server resolves
 * `https://preyone.com/verify/<code>`; the scheme is omitted from the bars so
 * a 28-character document ID still scans comfortably on an 80 mm roll. The
 * printed micro-label supplies `preyone.com/verify` for the customer.
 */
export function verificationBarcodePayload(verifyCode: string): string {
  const code = String(verifyCode || '').trim();
  if (!code) return '';
  if (/^https?:\/\//i.test(code)) return printable(code);
  return `preyone.com/verify/${encodeURIComponent(code)}`;
}
