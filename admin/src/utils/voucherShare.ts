// ─────────────────────────────────────────────────────────────────────────────
// Direct JPEG sharing (WhatsApp / native share sheet).
//
// The voucher card is painted by `drawVoucherCanvas` — the same painter that
// backs the Download and Print actions — so the image a customer receives is
// byte-identical to the one the counter hands over. We deliberately do not use
// a DOM-screenshot library: the canvas already is the canonical card, and
// rasterising the live DOM would drag in a heavy dependency plus CORS-prone
// logo fetches.
//
// Flow:
//   1. Render the card to a JPEG Blob.
//   2. Native share sheet when the browser can share files (Android Chrome /
//      iOS Safari / installed PWA). This is the only path that actually
//      *attaches* the JPEG inside WhatsApp.
//   3. Otherwise: download the JPEG, best-effort copy it (and the text) to the
//      clipboard, then open WhatsApp Web with the voucher PIN pre-filled.
//
// Every failure mode returns a result instead of throwing, so a caller can show
// one toast and never lose the modal.
// ─────────────────────────────────────────────────────────────────────────────

import { drawVoucherCanvas } from './voucherCard';
import type { VoucherCardData } from './voucherCard';
import { formatVoucherExpiry } from './voucherExpiry';

export interface VoucherShareResult {
  /** How the share resolved. */
  method: 'native-share' | 'downloaded' | 'cancelled' | 'failed';
  /** Human-readable line for the modal's status area. */
  message: string;
  /** The rendered JPEG, when one was produced (useful for tests/previews). */
  blob?: Blob;
  /** Present when rendering failed. */
  error?: string;
}

export interface ShareVoucherInput {
  /** Voucher payload for the canvas painter. */
  data: VoucherCardData;
  /** Voucher PIN, used for the filename and share text. */
  code: string;
  /** Name printed in the card's "Issued By" slot. */
  issuedByName: string;
  /** Optional share text override. */
  text?: string;
}

/** Render the voucher card to a JPEG Blob (95% quality, same as Download). */
export async function renderVoucherJpeg(
  data: VoucherCardData,
  issuedByName: string
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  await drawVoucherCanvas(canvas, data, issuedByName);
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/jpeg', 0.95);
    } catch {
      resolve(null);
    }
  });
  if (!blob) throw new Error('Could not render the voucher card.');
  return blob;
}

/** `voucher-abc123.jpg` — lowercase code, filesystem-safe, WhatsApp-friendly. */
export function voucherJpegName(code: string): string {
  const safe = String(code || 'preyone').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return `voucher-${safe || 'preyone'}.jpg`;
}

/**
 * Fallback message body when a caller passes no `text` override.
 *
 * Kept to the PIN alone when the voucher carries no validity information at
 * all, so existing callers see byte-identical output; when it does, the
 * customer also gets the expiry (formatted through the shared resolver, so it
 * can never read "01/01/1970").
 */
function defaultShareText(code: string, data?: VoucherCardData): string {
  const pin = `Voucher PIN: ${String(code).trim().toLowerCase()}`;
  if (!data) return pin;
  const knowsExpiry =
    (data.expires_at != null && data.expires_at !== '') ||
    (data.created_at != null && data.created_at !== '') ||
    Number(data.duration_min) > 0;
  if (!knowsExpiry) return pin;
  return `${pin}\nValid until: ${formatVoucherExpiry(data)}`;
}

/** Save a Blob to the device via a temporary object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = fileName;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Safari needs the URL to outlive the click handler.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Copy the JPEG plus the PIN text to the clipboard. Browsers only allow
 * `ClipboardItem` for raster images and only on a secure origin, so this is
 * always best-effort: a text-only copy is still a useful fallback.
 */
export async function copyVoucherToClipboard(blob: Blob, text: string): Promise<boolean> {
  try {
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (navigator.clipboard?.write && ClipboardItemCtor) {
      await navigator.clipboard.write([new ClipboardItemCtor({ 'image/jpeg': blob })]);
      return true;
    }
  } catch {
    /* image clipboard unsupported/permission denied — fall through to text */
  }
  try {
    await navigator.clipboard?.writeText?.(text);
    return true;
  } catch {
    return false;
  }
}

/** Open WhatsApp with the PIN pre-filled (works on desktop and mobile web). */
export function openWhatsAppWithText(text: string): void {
  const url = 'https://api.whatsapp.com/send?text=' + encodeURIComponent(text);
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    // Pop-up blocked: navigate the current tab so the action still completes.
    window.location.href = url;
  }
}

/**
 * Share the voucher as a real JPEG file.
 *
 * Never throws. Inspect `result.method` to decide which status line to show.
 */
export async function shareVoucherJpeg(input: ShareVoucherInput): Promise<VoucherShareResult> {
  const code = String(input.code || '').trim().toLowerCase();
  if (!code) return { method: 'failed', message: 'This voucher has no PIN to share.' };

  const text = input.text ?? defaultShareText(code, input.data);
  let blob: Blob;
  try {
    blob = await renderVoucherJpeg(input.data, input.issuedByName || 'Preyone UltraNet');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not render the voucher card.';
    return { method: 'failed', message, error: message };
  }

  const fileName = voucherJpegName(code);
  const file = new File([blob], fileName, { type: 'image/jpeg' });

  // 1) Native share sheet with the actual file attached.
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    try {
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: 'Preyone Voucher', text });
        return { method: 'native-share', message: 'Shared with WhatsApp.', blob };
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'AbortError') {
        return { method: 'cancelled', message: 'Share cancelled.', blob };
      }
      // NotAllowedError / NotSupportedError / DataError → use the fallback.
    }
  }

  // 2) Desktop / unsupported browsers: download, copy, open WhatsApp.
  try {
    downloadBlob(blob, fileName);
  } catch {
    /* download blocked — clipboard + WhatsApp Web below still work */
  }
  const copied = await copyVoucherToClipboard(blob, text);
  openWhatsAppWithText(text);

  return {
    method: 'downloaded',
    message: copied
      ? `Downloaded ${fileName}, copied it to the clipboard and opened WhatsApp — attach the image with Ctrl+V.`
      : `Downloaded ${fileName} and opened WhatsApp — attach the image from your Downloads folder.`,
    blob,
  };
}
