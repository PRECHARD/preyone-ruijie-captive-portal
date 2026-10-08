import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../api/client', () => {
  const pkg = {
    tier_name: 'PreCore', display_name: 'PreCore', price_amount: '5.00',
    billing_period: 'once', duration_min: 60, bandwidth_mbps_up: 2,
    bandwidth_mbps_down: 5, data_limit_gb: null, is_uncapped: false,
  };
  const voucher = {
    id: 'v-1', code: 'prec-oldcode', price_amount: '5.00', duration_min: 60,
    bandwidth_mbps_up: 2, bandwidth_mbps_down: 5, data_limit_gb: null,
    is_uncapped: false, max_uses: 1, used_count: 0,
    expires_at: '2027-01-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    package_tier: 'PreCore', holder_name: 'Old Holder', holder_phone: '+263771111111',
    device_count: 0, max_devices: 2, status: 'Unused',
  };
  return {
    api: {
      get: vi.fn((path: string) => {
        if (path === '/packages') return Promise.resolve([pkg]);
        if (path === '/vouchers') return Promise.resolve({ vouchers: [voucher] });
        if (path === '/clock-status') return Promise.resolve({ clockedIn: true });
        if (path.includes('approvals')) return Promise.resolve([]);
        return Promise.resolve(null);
      }),
      post: vi.fn(() => Promise.resolve({ code: 'prec-abc123', id: 'v-new' })),
      patch: vi.fn(() => Promise.resolve({ id: 'v-1', code: 'prec-oldcode' })),
      getToken: vi.fn(() => 'bearer-test'),
    },
    ruijieApi: { get: vi.fn(), post: vi.fn() },
    transitApi: { get: vi.fn(), post: vi.fn() },
    systemApi: { get: vi.fn(), post: vi.fn() },
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', fullName: 'Test Manager', role: 'Manager', permissions: [] } }),
}));
vi.mock('../utils/sound', () => ({ playVoucherSound: vi.fn(), playAlertSound: vi.fn() }));
vi.mock('../utils/toast', () => ({ showToast: vi.fn() }));

import { api } from '../api/client';
import Vouchers from '../pages/Vouchers';

beforeAll(() => {
  // jsdom ships no canvas implementation; stub everything drawVoucherCanvas
  // and the QR/JPEG previews touch so the create flow can render.
  const ctx: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 10 }) : () => undefined),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = function () { return ctx; } as any;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
});

describe('Vouchers holder capture (>= $4.99 gate + Edit Holder)', () => {
  beforeEach(() => {
    // Clear call history only — factory implementations survive.
    vi.clearAllMocks();
  });

  it('intercepts a $5.00 single sale and only creates once the customer is recorded', async () => {
    render(<Vouchers />);

    // PreCore costs $5.00 — selecting it fills the sale price above the gate.
    fireEvent.click((await screen.findAllByText('PreCore'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));

    // Gate: modal opens, nothing generated yet.
    expect(await screen.findByText('Customer Details Required')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('e.g. Tendai Moyo'), { target: { value: 'Tendai Moyo' } });
    fireEvent.change(screen.getByPlaceholderText('+263 77 123 4567'), { target: { value: '+263771234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Generate' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vouchers', expect.objectContaining({
        packageTier: 'PreCore',
        priceAmount: 5,
        holderName: 'Tendai Moyo',
        holderPhone: '+263771234567',
      }))
    );
  });

  it('requires a customer name before a gated sale can generate', async () => {
    render(<Vouchers />);
    fireEvent.click((await screen.findAllByText('PreCore'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Customer Details Required')).toBeInTheDocument();

    // Name still empty — Confirm stays disabled and no POST happens.
    expect(screen.getByRole('button', { name: 'Confirm & Generate' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('intercepts bulk generation for a $5.00 tier with the batch holder modal', async () => {
    render(<Vouchers />);
    await screen.findByText('Bulk Voucher Creation');

    fireEvent.change(screen.getByDisplayValue('Select package...'), { target: { value: 'PreCore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Bulk' }));

    expect(await screen.findByText('Batch Customer Details')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/vouchers/bulk', expect.anything());

    fireEvent.change(screen.getByPlaceholderText('e.g. Tendai Moyo'), { target: { value: 'Bulk Buyer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Generate' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vouchers/bulk', expect.objectContaining({
        packageTier: 'PreCore',
        count: 10,
        holderName: 'Bulk Buyer',
      }))
    );
  });

  it('patches holder details from the row action without touching PIN or price', async () => {
    render(<Vouchers />);
    const editBtn = await screen.findByRole('button', { name: 'Edit holder for voucher prec-oldcode' });
    fireEvent.click(editBtn);

    expect(await screen.findByText('Edit Holder — prec-oldcode')).toBeInTheDocument();
    const nameInput = await screen.findByPlaceholderText('e.g. Tendai Moyo');
    expect(nameInput).toHaveValue('Old Holder');

    fireEvent.change(nameInput, { target: { value: 'New Holder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Holder' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/vouchers/v-1', {
        holderName: 'New Holder',
        holderPhone: '+263771111111',
      })
    );
  });
});
