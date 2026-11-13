import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Swappable payload for the paginated list endpoint: a test installs its own
// rows (bound, active, disabled) and beforeEach clears it back to `defaultRow`.
const listState = vi.hoisted(() => ({
  rows: null as unknown[] | null,
  defaultRow: {
    id: 'v-1', code: 'prec-oldcode', price_amount: '5.00', duration_min: 60,
    bandwidth_mbps_up: 2, bandwidth_mbps_down: 5, data_limit_gb: null,
    is_uncapped: false, max_uses: 1, used_count: 0,
    expires_at: '2027-01-01T00:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z',
    package_tier: 'PreCore', holder_name: 'Old Holder', holder_phone: '+263771111111',
    device_count: 0, max_devices: 2, status: 'Unused',
  },
}));

vi.mock('../api/client', () => {
  const pkg = {
    tier_name: 'PreCore', display_name: 'PreCore', price_amount: '5.00',
    billing_period: 'once', duration_min: 60, bandwidth_mbps_up: 2,
    bandwidth_mbps_down: 5, data_limit_gb: null, is_uncapped: false,
  };
  // Deliberately different from PreCore on every field the renew form reads,
  // so a package swap is observable rather than a no-op.
  const pkgMax = {
    tier_name: 'PreMax', display_name: 'PreMax', price_amount: '9.50',
    billing_period: 'once', duration_min: 1440, bandwidth_mbps_up: 10,
    bandwidth_mbps_down: 20, data_limit_gb: 20, is_uncapped: false,
  };
  const voucher = listState.defaultRow;
  return {
    api: {
      get: vi.fn((path: string) => {
        if (path === '/packages') return Promise.resolve([pkg, pkgMax]);
        // The live list walks pages (`/vouchers?pageSize=200&page=N`), so match
        // on the query string rather than the bare path.
        if (path.startsWith('/vouchers?')) return Promise.resolve({ vouchers: listState.rows ?? [voucher] });
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

// vi.mock is hoisted above module init, so the mutable auth fixture has to be
// created with vi.hoisted or it would hit the TDZ when the factory runs.
const authState = vi.hoisted(() => ({ role: 'Manager', permissions: [] as string[] }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Test User', role: authState.role, permissions: authState.permissions },
  }),
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

// Runs before every describe-level beforeEach, so each test starts from the
// default single-voucher list unless it installs its own rows.
beforeEach(() => { listState.rows = null; });

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
        count: 2,
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

describe('Vouchers Manage actions (company.admin gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'Manager';
    authState.permissions = [];
  });

  const openDetailDialog = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'View details for voucher prec-oldcode' }));
    return within(await screen.findByRole('dialog'));
  };

  it('offers Renew, Disable, Delete and Release bindings to a Manager', async () => {
    render(<Vouchers />);
    const d = await openDetailDialog();

    expect(await d.findByRole('button', { name: 'Renew / Resell' })).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Release all bindings' })).toBeInTheDocument();
  });

  it('hides every company.admin action from Staff so they cannot hit a 403', async () => {
    authState.role = 'Staff';
    render(<Vouchers />);
    const d = await openDetailDialog();

    // The detail modal still opens and stays browsable — only the gated
    // actions disappear. permissions is [] so this also exercises the
    // role-list fallback rather than the permissions check. (The Redemption
    // section is conditional on redemption data, so assert on a static one.)
    expect(d.getByText('Share & Notify')).toBeInTheDocument();
    expect(d.queryByRole('button', { name: 'Renew / Resell' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(d.queryByRole('button', { name: 'Release all bindings' })).toBeNull();
  });

  it('still shows them when the permissions array carries company.admin', async () => {
    authState.role = 'Staff';
    authState.permissions = ['company.admin'];
    render(<Vouchers />);
    const d = await openDetailDialog();

    expect(await d.findByRole('button', { name: 'Renew / Resell' })).toBeInTheDocument();
    expect(d.getByRole('button', { name: 'Release all bindings' })).toBeInTheDocument();
  });
});

describe('Renew / Resell package switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'Manager';
    authState.permissions = [];
  });

  /** Detail modal first, then the Renew modal it opens on top of it. */
  const openRenewModal = async (): Promise<HTMLElement> => {
    render(<Vouchers />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details for voucher prec-oldcode' }));
    const detail = within(await screen.findByRole('dialog'));
    fireEvent.click(await detail.findByRole('button', { name: 'Renew / Resell' }));
    const dialogs = await screen.findAllByRole('dialog');
    return dialogs[dialogs.length - 1];
  };

  const fieldValue = (dialog: HTMLElement, label: string) =>
    (within(dialog).getByLabelText(label) as HTMLInputElement).value;

  it('pre-fills validity, price, speed and quota when a tier is picked', async () => {
    const renew = await openRenewModal();
    const r = within(renew);

    // Nothing swapped yet: the voucher's own duration, and no package detail grid.
    expect(fieldValue(renew, 'Package')).toBe('');
    expect(fieldValue(renew, 'Additional duration (minutes)')).toBe('60');
    expect(r.queryByText('Speed')).toBeNull();

    fireEvent.change(r.getByLabelText('Package'), { target: { value: 'PreMax' } });

    expect(fieldValue(renew, 'Additional duration (minutes)')).toBe('1440');
    expect(fieldValue(renew, 'Amount paid (USD) *')).toBe('9.50');
    expect(r.getByText('Speed')).toBeInTheDocument();
    expect(r.getByText('10/20 Mbps')).toBeInTheDocument();
    expect(r.getByText('20 GB')).toBeInTheDocument();
    expect(r.getByText('Validity')).toBeInTheDocument();
    expect(r.getByText(/Swaps PreCore → PreMax/)).toBeInTheDocument();
  });

  it('posts the chosen tier with the renewal so the backend applies it', async () => {
    const renew = await openRenewModal();
    const r = within(renew);

    fireEvent.change(r.getByLabelText('Package'), { target: { value: 'PreMax' } });
    fireEvent.click(r.getByRole('button', { name: 'Renew for $9.50' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vouchers/v-1/renew', expect.objectContaining({
        packageTier: 'PreMax',
        durationMin: 1440,
        priceAmount: 9.5,
      }))
    );
  });

  it('keeps the current package when the picker is left on its default', async () => {
    const renew = await openRenewModal();
    const r = within(renew);

    fireEvent.click(r.getByRole('button', { name: 'Renew for $5.00' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/vouchers/v-1/renew', expect.objectContaining({
        packageTier: undefined,
        durationMin: 60,
        priceAmount: 5,
      }))
    );
  });
});

describe('Voucher list liveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'Manager';
    authState.permissions = [];
  });

  const rowOf = async (code: string) =>
    (await screen.findByRole('button', { name: `View details for voucher ${code}` })).closest('tr') as HTMLElement;

  it('walks every page so older codes are never hidden behind the 25-row default', async () => {
    render(<Vouchers />);
    await rowOf('prec-oldcode');

    expect(api.get).toHaveBeenCalledWith('/vouchers?pageSize=200&page=1');
    // One short page ends the walk — no pointless second request.
    expect(api.get).not.toHaveBeenCalledWith('/vouchers?pageSize=200&page=2');
  });

  it('flags a bound voucher with a status badge and a live In use chip', async () => {
    listState.rows = [
      { ...listState.defaultRow, id: 'v-live', code: 'live-code', status: 'Active', device_count: 2 },
      { ...listState.defaultRow, id: 'v-off', code: 'off-code', status: 'Disabled', is_disabled: true, device_count: 0 },
    ];
    render(<Vouchers />);

    const live = await rowOf('live-code');
    expect(within(live).getByText('Active')).toHaveClass('badge--yes');
    expect(within(live).getByText('In use')).toHaveClass('badge--live');
    expect(within(live).getByText('2/2')).toHaveClass('dev-chip', 'dev-chip--live');

    const off = await rowOf('off-code');
    expect(within(off).getByText('Disabled')).toHaveClass('badge--no');
    expect(within(off).queryByText('In use')).toBeNull();
    expect(within(off).getByText('0/2')).toHaveClass('dev-chip--idle');
  });

  it('filters the unified voucher list by lifecycle status', async () => {
    listState.rows = [
      { ...listState.defaultRow, id: 'v-unused', code: 'unused-code', status: 'Unused' },
      { ...listState.defaultRow, id: 'v-active', code: 'active-code', status: 'Active', used_count: 1 },
      { ...listState.defaultRow, id: 'v-expired', code: 'expired-code', status: 'Expired' },
    ];
    render(<Vouchers />);

    await rowOf('unused-code');
    fireEvent.change(screen.getByLabelText('Filter vouchers by status'), { target: { value: 'Active' } });

    expect(screen.getByRole('button', { name: 'View details for voucher active-code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View details for voucher unused-code' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View details for voucher expired-code' })).toBeNull();
  });
});

describe('Bulk voucher quantity controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'Manager';
    authState.permissions = [];
  });

  it('defaults to 2, steps by one and never goes below 2', async () => {
    render(<Vouchers />);

    const label = await screen.findByText('Users');
    const field = label.closest('.form-field') as HTMLElement;
    const input = field.querySelector('input[type="number"]') as HTMLInputElement;
    const [minus, plus] = within(field).getAllByRole('button') as HTMLButtonElement[];

    expect(input.value).toBe('2');
    fireEvent.click(plus);
    expect(input.value).toBe('3');
    fireEvent.click(minus);
    fireEvent.click(minus);
    expect(input.value).toBe('2');
  });
});
