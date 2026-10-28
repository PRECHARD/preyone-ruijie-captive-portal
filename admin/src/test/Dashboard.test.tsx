import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Dashboard monthly revenue target.
 *
 * `/api/admin/revenue-target` is the canonical source (settings-backed, written
 * from My Sales and Settings). A tenant that has never saved one answers
 * `configured: false` and `pct: null`; the Dashboard must still render a
 * meaningful gauge rather than "Not set", so it falls back to a $500 baseline.
 *
 * The gauge is a radial SVG: `stroke-dashoffset` on `.revenue-gauge__arc` is
 * animated by CSS, so the assertions read the numeric offset rather than a
 * rendered width.
 */

const apiState = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/client', () => ({
  api: { get: apiState.get },
  ruijieApi: { get: vi.fn(), post: vi.fn() },
  transitApi: { get: vi.fn(), post: vi.fn() },
  systemApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', fullName: 'Test User', role: 'CEO', permissions: [] } }),
}));

import Dashboard from '../pages/Dashboard';

const DASHBOARD = {
  metrics: {
    totalUsers: 10,
    vouchersCreated: 20,
    vouchersUsed: 5,
    totalRevenue: 100,
    activeSessions: 2,
    pendingPayments: { count: 0, total: 0 },
    activeVouchers: 1,
    dataConsumedToday: 1024,
    fupTriggered: 0,
    apOnline: 1,
    apTotal: 1,
  },
  sales: {
    daily: { amount: 0, count: 0 },
    weekly: { amount: 0, count: 0 },
    monthly: { amount: 0, count: 0 },
  },
  charts: { dailySales: [], dailySignups: [] },
  sales24h: [],
  byTier: [],
  recentSales: [],
};

function targetPayload(overrides: Record<string, unknown> = {}) {
  return {
    target: 0,
    achieved: 125,
    remaining: 0,
    pct: null,
    currency: 'USD',
    label: 'October 2026',
    configured: false,
    ...overrides,
  };
}

function stubApi(target: Record<string, unknown>) {
  apiState.get.mockImplementation((path: string) => {
    if (path === '/dashboard') return Promise.resolve(DASHBOARD);
    if (path === '/revenue-target') return Promise.resolve(target);
    return Promise.resolve({});
  });
}

const arcOffset = (): number => {
  const arc = document.querySelector('.revenue-gauge__arc') as SVGElement | null;
  if (!arc) throw new Error('revenue gauge arc not rendered');
  return Number(arc.getAttribute('stroke-dashoffset'));
};

beforeEach(() => {
  vi.clearAllMocks();
  stubApi(targetPayload());
});

describe('Dashboard revenue target', () => {
  it('fetches the canonical endpoint on mount', async () => {
    render(<Dashboard />);

    await waitFor(() => expect(apiState.get).toHaveBeenCalledWith('/revenue-target'));
    expect(apiState.get).toHaveBeenCalledWith('/dashboard');
  });

  it('falls back to a $500 target when none is configured', async () => {
    render(<Dashboard />);

    // 125 of the default 500 → 25%.
    expect(await screen.findByText(/\$500\.00 USD/)).toBeInTheDocument();
    expect(screen.getByText(/^\$125\.00$/)).toBeInTheDocument();
    expect(screen.getByText(/Default target of \$500\.00/)).toBeInTheDocument();
  });

  it('uses the saved target when one exists, and ignores the default', async () => {
    stubApi(targetPayload({ configured: true, target: 1000, achieved: 250, pct: 25, remaining: 750 }));

    render(<Dashboard />);

    expect(await screen.findByText(/\$1000\.00 USD/)).toBeInTheDocument();
    expect(screen.getByText(/To go this month/i)).toBeInTheDocument();
    expect(screen.queryByText(/Default target/)).not.toBeInTheDocument();
  });

  it('drives the radial gauge from the percentage of target', async () => {
    stubApi(targetPayload({ configured: true, target: 400, achieved: 100, pct: 25, remaining: 300 }));

    render(<Dashboard />);
    await screen.findByText(/\$400\.00 USD/);

    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    // A quarter of the ring is drawn: the offset is the undrawn 75%.
    expect(arcOffset()).toBeCloseTo(circumference * 0.75, 3);
    expect(document.querySelector('.revenue-gauge')?.getAttribute('aria-label')).toContain('25.0 percent');
  });

  it('caps the ring at a full circle when the target is exceeded', async () => {
    stubApi(targetPayload({ configured: true, target: 100, achieved: 250, pct: 250, remaining: 0 }));

    render(<Dashboard />);
    await screen.findByText(/\$100\.00 USD/);

    expect(arcOffset()).toBeCloseTo(0, 3);
    // The headline number still reports the real over-achievement.
    expect(screen.getByText(/250\.0%/)).toBeInTheDocument();
  });
});
