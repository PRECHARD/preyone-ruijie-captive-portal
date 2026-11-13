import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

/**
 * WhatsApp / native JPEG sharing.
 *
 * The requirement is that WhatsApp receives a real image *file* named
 * `voucher-<pin>.jpg`, not just a text blurb. These tests pin:
 *   - the filename contract (.jpg, filesystem-safe, lowercase PIN),
 *   - the native path (`navigator.share({ files: [...] })` with an image/jpeg
 *     File),
 *   - the desktop fallback (download + clipboard + WhatsApp Web),
 *   - that no failure mode ever throws (the modal must stay usable).
 */

import { shareVoucherJpeg, voucherJpegName } from '../utils/voucherShare';
import type { VoucherCardData } from '../utils/voucherCard';

const data = {
  code: 'ebywa6',
  package_tier: 'preLite_Daily',
  price_amount: '1.00',
  duration_min: 1440,
  is_uncapped: false,
  data_limit_gb: 5,
  bandwidth_mbps_up: 10,
  bandwidth_mbps_down: 10,
} as unknown as VoucherCardData;

beforeAll(() => {
  // jsdom has no canvas backend: stub just enough for drawVoucherCanvas +
  // canvas.toBlob to resolve with a JPEG blob (same approach as
  // ConsumptionDetailModal.test.tsx).
  const ctxStub = () => ({
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    arc: vi.fn(),
    arcTo: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    drawImage: vi.fn(),
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    roundRect: vi.fn(),
  });

  HTMLCanvasElement.prototype.getContext = function () {
    return ctxStub() as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
  };

  class FakeImage {
    naturalWidth = 100;
    naturalHeight = 90;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) { setTimeout(() => this.onload?.(), 0); }
  }
  vi.stubGlobal('Image', FakeImage);

  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(() => {
  // Remove any share capability a test installed.
  delete (navigator as any).share;
  delete (navigator as any).canShare;
  delete (window as any).ClipboardItem;
  vi.restoreAllMocks();
});

describe('voucherJpegName', () => {
  it('produces a WhatsApp-friendly .jpg filename from the PIN', () => {
    expect(voucherJpegName('ebywa6')).toBe('voucher-ebywa6.jpg');
    expect(voucherJpegName('  EBYWA6 ')).toBe('voucher-ebywa6.jpg');
  });

  it('sanitises path characters and never returns an empty name', () => {
    expect(voucherJpegName('ab/../cd')).toBe('voucher-ab-cd.jpg');
    expect(voucherJpegName('')).toBe('voucher-preyone.jpg');
  });
});

describe('shareVoucherJpeg - native share sheet', () => {
  it('attaches a real image/jpeg File through navigator.share', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    Object.assign(navigator, { share, canShare });

    const result = await shareVoucherJpeg({
      data,
      code: 'ebywa6',
      issuedByName: 'Prechard Muvirimi',
    });

    expect(result.method).toBe('native-share');
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);

    const payload = share.mock.calls[0][0];
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0] as File;
    expect(file.name).toBe('voucher-ebywa6.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(payload.text).toContain('ebywa6');
  });

  it('reports a cancelled share without falling back to a download', async () => {
    const abort = new Error('cancel');
    abort.name = 'AbortError';
    Object.assign(navigator, {
      share: vi.fn().mockRejectedValue(abort),
      canShare: vi.fn().mockReturnValue(true),
    });

    const result = await shareVoucherJpeg({ data, code: 'ebywa6', issuedByName: 'Preyone' });

    expect(result.method).toBe('cancelled');
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
});

describe('shareVoucherJpeg - desktop fallback', () => {
  it('downloads the JPEG, copies it and opens WhatsApp Web', async () => {
    // No navigator.share at all (desktop Chrome).
    const open = vi.spyOn(window, 'open').mockReturnValue({} as any);

    const result = await shareVoucherJpeg({
      data,
      code: 'ebywa6',
      issuedByName: 'Preyone',
    });

    expect(result.method).toBe('downloaded');
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('api.whatsapp.com/send?text='),
      '_blank',
      'noopener,noreferrer'
    );
    expect(result.message).toMatch(/voucher-ebywa6\.jpg/);
  });

  it('falls back to the native share sheet only when files are supported', async () => {
    // Safari-style: canShare exists but refuses files → expect the download path.
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: vi.fn().mockReturnValue(false) });
    vi.spyOn(window, 'open').mockReturnValue({} as any);

    const result = await shareVoucherJpeg({ data, code: 'ebywa6', issuedByName: 'Preyone' });

    expect(result.method).toBe('downloaded');
    expect(share).not.toHaveBeenCalled();
  });
});

describe('shareVoucherJpeg - default text', () => {
  it('includes a real "Valid until" when the voucher knows its validity', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: vi.fn().mockReturnValue(true) });

    await shareVoucherJpeg({
      // expires_at NULL is the common case ("never expires"); the text must
      // derive created_at + duration rather than say 01/01/1970.
      data: { ...data, expires_at: null, created_at: '2026-10-01T10:00:00.000Z' },
      code: 'ebywa6',
      issuedByName: 'Preyone',
    });

    const text = String(share.mock.calls[0][0].text);
    expect(text).toContain('Voucher PIN: ebywa6');
    expect(text).toContain('Valid until:');
    expect(text).not.toContain('1970');
    expect(text).not.toContain('Invalid Date');
  });

  it('stays PIN-only when the voucher carries no validity information', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: vi.fn().mockReturnValue(true) });

    await shareVoucherJpeg({ data: { code: 'ebywa6' }, code: 'ebywa6', issuedByName: 'Preyone' });

    expect(String(share.mock.calls[0][0].text)).toBe('Voucher PIN: ebywa6');
  });
});

describe('shareVoucherJpeg - hardening', () => {
  it('refuses an empty PIN without touching the canvas', async () => {
    const result = await shareVoucherJpeg({ data, code: '   ', issuedByName: 'Preyone' });
    expect(result.method).toBe('failed');
    expect(result.message).toMatch(/no PIN/i);
  });

  it('never throws when rendering fails', async () => {
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((cb: BlobCallback) => cb(null));

    const result = await shareVoucherJpeg({ data, code: 'ebywa6', issuedByName: 'Preyone' });

    expect(result.method).toBe('failed');
    expect(result.error).toBeTruthy();
    spy.mockRestore();
  });
});
