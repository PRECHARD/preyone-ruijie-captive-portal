import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const apiState = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: { get: apiState.get },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Test User', role: 'Manager', permissions: [] },
  }),
}));

import ConsumptionDetailModal from '../components/wifi/ConsumptionDetailModal';

const consumptionRow = {
  code: 'ebywa6',
  packageName: 'preLite_Daily',
  usedMB: 850,
  totalMB: 1000,
  pct: 85,
  status: 'low',
  onlineNow: true,
  alertsSent: { t80: 1, t95: 0 },
  lastAlertAt: new Date('2026-10-10T10:00:00Z').toISOString(),
};

const saleRow = {
  id: 'v1',
  code: 'ebywa6',
  price_amount: '1.00',
  duration_min: 1440,
  bandwidth_mbps_up: 10,
  bandwidth_mbps_down: 10,
  data_limit_gb: 5,
  is_uncapped: false,
  max_uses: 1,
  used_count: 1,
  expires_at: '2026-10-20T10:00:00Z',
  created_at: '2026-10-01T10:00:00Z',
  package_tier: 'PreLite',
  status: 'Active',
  first_redeemed_at: '2026-10-02T08:00:00Z',
  activated_at: '2026-10-02T08:00:00Z',
  max_devices: 2,
  device_count: 1,
  devices: [
    { mac_address: 'aa:bb:cc:dd:ee:ff', label: 'Phone', is_active: true, bound_at: '2026-10-02T08:00:00Z', last_seen_at: '2026-10-12T09:00:00Z', unbound_at: null },
  ],
  phone: '+263771234567',
  redemption_name: 'Jane Doe',
  redemption_mac: 'aa:bb:cc:dd:ee:ff',
  redemption_at: '2026-10-02T08:00:00Z',
  traffic_used_bytes: 1024 ** 3,
  traffic_total_bytes: 5 * 1024 ** 3,
  holder_name: 'Jane Doe',
};

beforeAll(() => {
  // jsdom ships no canvas implementation; stub everything the shared
  // voucherCard painter and the JPEG download touch. Methods return a
  // chainable stub so createLinearGradient(...).addColorStop(...) works.
  const ctxStub = () => new Proxy({}, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 10 }) : () => ctxStub()),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = function () {
    return ctxStub() as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(['jpeg'], { type: 'image/jpeg' }));
  };
  // jsdom never loads images, so fire onload on the next tick to release
  // drawVoucherCanvas's await.
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
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

beforeEach(() => {
  vi.clearAllMocks();
  apiState.get.mockResolvedValue({ vouchers: [saleRow] });
});

describe('ConsumptionDetailModal', () => {
  it('shows consumption stats plus the local sale details, like the Vouchers sheet', async () => {
    render(<ConsumptionDetailModal code="ebywa6" row={consumptionRow as any} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Consumption')).toBeTruthy());

    expect(screen.getByText('Voucher ebywa6')).toBeTruthy();
    expect(screen.getByText('LOW 80%')).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByText('850 MB / 1000 MB')).toBeTruthy();
    expect(screen.getByText('85%')).toBeTruthy();
    // local sales grid (vd-* from Vouchers.css)
    expect(screen.getByText('Price')).toBeTruthy();
    expect(screen.getByText('$1.00')).toBeTruthy();
    expect(screen.getByText('1d')).toBeTruthy();
    expect(screen.getByText('10/10 Mbps')).toBeTruthy();
    expect(screen.getByText('5 GB')).toBeTruthy();
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    // redemption + devices
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('+263771234567')).toBeTruthy();
    expect(screen.getAllByText('aa:bb:cc:dd:ee:ff', { selector: '.vd-mono' }).length).toBe(2);
    expect(screen.getByText(/bound/)).toBeTruthy();
    // actions
    expect(screen.getByText('Copy PIN')).toBeTruthy();
    expect(screen.getByText('Copy Details')).toBeTruthy();
    expect(screen.getByText('Download JPEG')).toBeTruthy();
    expect(apiState.get).toHaveBeenCalledWith('/vouchers?search=ebywa6&pageSize=5');
  });

  it('falls back to consumption-only when no local sales record matches', async () => {
    apiState.get.mockResolvedValue({ vouchers: [] });
    render(<ConsumptionDetailModal code="ruijieonly" row={consumptionRow as any} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no local sales record/i)).toBeTruthy());
    // consumption stats still present
    expect(screen.getByText('Consumption')).toBeTruthy();
    // download still available from PIN + roster package
    expect(screen.getByText('Download JPEG')).toBeTruthy();
    // no price cell from a sale that doesn't exist
    expect(screen.queryByText('$1.00')).toBeNull();
  });

  it('copies the PIN to the clipboard and confirms inline', async () => {
    render(<ConsumptionDetailModal code="ebywa6" row={consumptionRow as any} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Copy PIN')).toBeTruthy());

    fireEvent.click(screen.getByText('Copy PIN'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('ebywa6');
    expect(screen.getByRole('status').textContent).toMatch(/PIN copied/);
  });

  it('downloads the voucher card JPEG through the shared canvas painter', async () => {
    render(<ConsumptionDetailModal code="ebywa6" row={consumptionRow as any} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Download JPEG')).toBeTruthy());

    fireEvent.click(screen.getByText('Download JPEG'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Downloaded voucher-ebywa6\.jpeg/));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('closes via the onClose callback', async () => {
    const onClose = vi.fn();
    render(<ConsumptionDetailModal code="ebywa6" row={consumptionRow as any} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('Voucher ebywa6')).toBeTruthy());
    // overlay click (same path the Modal's Escape/close button uses)
    fireEvent.click(document.querySelector('.modal-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });
});
