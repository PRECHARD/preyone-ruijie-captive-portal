import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), getToken: vi.fn(() => 'bearer-test') },
  transitApi: { get: vi.fn(), post: vi.fn() },
  systemApi: { get: vi.fn(), post: vi.fn() },
  ruijieApi: {
    get: vi.fn((path: string) =>
      path === '/status'
        ? Promise.resolve(undefined)
        : Promise.resolve({ skipped: true, reason: 'test', users: [], devices: [] })),
    post: vi.fn(() => Promise.resolve({ skipped: true, reason: 'test' })),
  },
}));

vi.mock('../api/pos', () => ({
  posApi: {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), convertToInvoice: vi.fn(),
  },
  money: (n: any) => '$' + (Number(n) || 0).toFixed(2),
}));

import { api, transitApi } from '../api/client';
import { posApi } from '../api/pos';
import WifiDashboard from '../pages/WifiDashboard';
import TransitOperationsDashboard from '../pages/TransitOperationsDashboard';
import PosDashboard from '../pages/PosDashboard';
import { liveWifi } from './fixtures/liveWifi';
import { liveTransit } from './fixtures/liveTransit';
import { livePos } from './fixtures/livePos';

function tick() { return new Promise((r) => setTimeout(r, 0)); }

describe('Sector dashboards render against live CEO payloads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('WifiDashboard — live UltraNet aggregate', async () => {
    (api.get as any).mockResolvedValue(liveWifi as any);
    render(<WifiDashboard />);
    expect(await screen.findByText('Preyone UltraNet WiFi')).toBeInTheDocument();
    expect(screen.getByText('Auth Success')).toBeInTheDocument();
    expect(screen.getByText('Command Center')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Network'));
    expect(screen.getByText('Access Point Monitoring')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Sessions'));
    expect(screen.getByText('Active Client Sessions')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/dashboard/wifi');
    expect(api.get).toHaveBeenCalledWith('/dashboard/ultranet/sales-summary');
  });

  it('TransitOperationsDashboard — live Mupota Bus Service aggregate', async () => {
    (transitApi.get as any).mockResolvedValue(liveTransit as any);
    render(<TransitOperationsDashboard />);
    expect(await screen.findByText('Preyone Transit Operations')).toBeInTheDocument();
    expect(screen.getByText('Mupota Bus Service · mupota-bus-service')).toBeInTheDocument();
    expect(screen.getByText('Trips — Last 7 Days')).toBeInTheDocument();
    expect(screen.getAllByText('MUTARE - CHIPENDEKE').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('601-20261002').length).toBeGreaterThan(0);
    expect(transitApi.get).toHaveBeenCalledWith('/dashboard');
  });

  it('TransitOperationsDashboard — quiet 24h window falls back to the 7-day chart', async () => {
    (transitApi.get as any).mockResolvedValue(liveTransit as any);
    const { container } = render(<TransitOperationsDashboard />);
    await screen.findByText('Preyone Transit Operations');
    await tick();
    expect(screen.getByText('Trips — Last 7 Days')).toBeInTheDocument();
    expect(screen.getByText('No departures in the last 24h', { exact: false })).toBeInTheDocument();
    const bars = container.querySelectorAll('.hist-bar');
    expect(bars.length).toBe((liveTransit as any).history7d.length);
  });

  it('WifiDashboard — voucher usage lists users connected with sold vouchers', async () => {
    (api.get as any).mockResolvedValue(liveWifi as any);
    render(<WifiDashboard />);
    await screen.findByText('Preyone UltraNet WiFi');
    fireEvent.click(screen.getByRole('tab', { name: 'Vouchers' }));
    expect(screen.getByText('Voucher Usage')).toBeInTheDocument();
    const d = liveWifi as any;
    if (d.voucherUsage && d.voucherUsage.length > 0) {
      expect(screen.getAllByText(d.voucherUsage[0].voucher_code).length).toBeGreaterThan(0);
      expect(screen.getAllByText(d.voucherUsage[0].holder_name).length).toBeGreaterThan(0);
    }
  });

  it('PosDashboard — live POS aggregate', async () => {
    (posApi.get as any).mockResolvedValue(livePos as any);
    render(<PosDashboard />);
    expect(await screen.findByText('Preyone POS')).toBeInTheDocument();
    expect(screen.getByText("Today's Till")).toBeInTheDocument();
    expect(screen.getByText('Recent Documents')).toBeInTheDocument();
    expect(posApi.get).toHaveBeenCalledWith('/dashboard');
  });
});