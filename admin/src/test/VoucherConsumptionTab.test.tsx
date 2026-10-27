import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiState = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../api/client', () => ({
  api: { get: apiState.get },
  ruijieApi: { get: vi.fn(), post: vi.fn() },
  transitApi: { get: vi.fn(), post: vi.fn() },
  systemApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Test User', role: 'Manager', permissions: [] },
  }),
}));

import VoucherConsumptionTab from '../components/wifi/VoucherConsumptionTab';

function row(overrides: Record<string, unknown> = {}) {
  return {
    code: 'ebywa6',
    packageName: 'preLite_Daily',
    usedMB: 100,
    totalMB: 1000,
    pct: 10,
    status: 'ok',
    onlineNow: false,
    alertsSent: { t80: 0, t95: 0 },
    lastAlertAt: null,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    live: true,
    summary: {
      total: 5, ok: 1, low: 1, critical: 1, exhausted: 1, unlimited: 1, idle: 0, disabled: 0,
    },
    rows: [
      row({ code: 'drained1', usedMB: 1000, pct: 100, status: 'exhausted' }),
      row({ code: 'crit95x', usedMB: 960, pct: 96, status: 'critical', alertsSent: { t80: 1, t95: 1 } }),
      row({ code: 'low80x', usedMB: 850, pct: 85, status: 'low', alertsSent: { t80: 1, t95: 0 } }),
      row({ code: 'okfine', usedMB: 100, pct: 10, status: 'ok' }),
      row({ code: 'unl1', usedMB: 2048, totalMB: null, pct: null, status: 'unlimited' }),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiState.get.mockResolvedValue(payload());
});

describe('VoucherConsumptionTab', () => {
  it('renders the roster with Vouchers-page styling, bars and badge tones', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('VOUCHER CONSUMPTION')).toBeTruthy());

    // live-pill (Vouchers design language) instead of a custom pulse chip
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('crit95x')).toBeTruthy();
    expect(screen.getByText('CRIT 95%')).toBeTruthy();
    expect(screen.getByText('LOW 80%')).toBeTruthy();
    expect(screen.getByText('DRAINED')).toBeTruthy();
    expect(screen.getByText('96%')).toBeTruthy();
    // shared card + data-table shell
    expect(document.querySelector('.card.card-table')).toBeTruthy();
    expect(document.querySelector('.data-table')).toBeTruthy();
    expect(document.querySelector('.code-cell')).toBeTruthy();
    // 80/95 tick markers ride on every capped bar
    expect(document.querySelectorAll('.un-consume__tick').length).toBeGreaterThan(0);
  });

  it('shows used / Unlimited dynamically for uncapped bundles', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('unl1')).toBeTruthy());
    expect(screen.getByText('/ Unlimited')).toBeTruthy();
    expect(screen.getByText('∞')).toBeTruthy();
    expect(screen.getByText('UNLIMITED')).toBeTruthy();
  });

  it('filters by PIN from the search box, combined with the status chips', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('crit95x')).toBeTruthy());

    const box = screen.getByLabelText('Search voucher PIN or package');
    fireEvent.change(box, { target: { value: 'low80' } });
    await waitFor(() => {
      expect(screen.queryByText('crit95x')).toBeNull();
      expect(screen.getByText('low80x')).toBeTruthy();
      expect(screen.getByText('Showing 1 of 5 vouchers')).toBeTruthy();
    });

    // chip counts follow the search: only low80x survives the query
    fireEvent.click(screen.getByRole('button', { name: /Critical 95%\+/ }));
    await waitFor(() => {
      expect(screen.queryByText('low80x')).toBeNull();
      expect(screen.getByText('No vouchers match your search.')).toBeTruthy();
    });
  });

  it('filters to critical-and-below on the Critical 95%+ chip', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('crit95x')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Critical 95%\+/ }));
    await waitFor(() => {
      expect(screen.queryByText('okfine')).toBeNull();
      expect(screen.queryByText('low80x')).toBeNull();
      expect(screen.getByText('crit95x')).toBeTruthy();
      expect(screen.getByText('drained1')).toBeTruthy();
    });
  });

  it('shows the roster-offline state when Ruijie keys are missing', async () => {
    apiState.get.mockResolvedValue(payload({ live: false, rows: [], summary: {
      total: 0, ok: 0, low: 0, critical: 0, exhausted: 0, unlimited: 0, idle: 0, disabled: 0,
    } }));
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('ROSTER OFFLINE')).toBeTruthy());
    expect(screen.getByText(/Ruijie Cloud keys are missing/)).toBeTruthy();
  });

  it('surfaces fetch failures as an empty-state error', async () => {
    apiState.get.mockRejectedValue(new Error('Request failed (502)'));
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('Could not load')).toBeTruthy());
    expect(screen.getByText('Request failed (502)')).toBeTruthy();
  });

  it('re-fetches on manual refresh', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(2));
  });

  it('opens the voucher detail modal when a PIN is clicked', async () => {
    render(<VoucherConsumptionTab />);
    await waitFor(() => expect(screen.getByText('crit95x')).toBeTruthy());

    fireEvent.click(screen.getByText('crit95x'));
    await waitFor(() => expect(screen.getByText('Voucher crit95x')).toBeTruthy());
    // consumption stats from the roster row are in the sheet (a second
    // CRIT 95% badge appears alongside the table's own row badge). The h4
    // is scoped by role because the table also has a "Consumption" column.
    expect(screen.getByRole('heading', { name: 'Consumption', level: 4 })).toBeTruthy();
    expect(screen.getAllByText('CRIT 95%').length).toBeGreaterThan(1);
    expect(screen.getByText('Download JPEG')).toBeTruthy();
    // the modal fetches the local sales row through the same mocked client
    await waitFor(() => expect(
      apiState.get.mock.calls.some((c) => String(c[0]).startsWith('/vouchers?search=crit95x')),
    ).toBe(true));

    // closing restores the bare table
    fireEvent.click(document.querySelector('.modal-overlay')!);
    await waitFor(() => expect(screen.queryByText('Voucher crit95x')).toBeNull());
    expect(screen.getByText('crit95x')).toBeTruthy();
  });

  it('keeps local vouchers visible when Ruijie is rate-limiting the roster', async () => {
    apiState.get.mockResolvedValue(payload({
      degraded: true,
      warning: 'Ruijie Cloud is temporarily unavailable or rate-limiting us, so live usage is paused.',
      summary: { total: 1, ok: 0, low: 0, critical: 0, exhausted: 0, unlimited: 0, idle: 1, disabled: 0, expired: 0 },
      rows: [row({ code: 'localonly', usedMB: null, totalMB: null, pct: null, status: 'idle', usageKnown: false })],
    }));
    render(<VoucherConsumptionTab />);

    await waitFor(() => expect(screen.getByText('localonly')).toBeTruthy());
    // The degraded banner explains why usage is missing instead of hiding the table.
    expect(screen.getByText(/rate-limiting us/)).toBeTruthy();
    expect(screen.getByText('NO LIVE DATA')).toBeTruthy();
  });

  it('labels a cached snapshot instead of claiming it is live', async () => {
    apiState.get.mockResolvedValue(payload({
      stale: true,
      rosterFetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    }));
    render(<VoucherConsumptionTab />);

    await waitFor(() => expect(screen.getByText('Cached')).toBeTruthy());
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.getByText(/last successful reading/)).toBeTruthy();
  });
});
