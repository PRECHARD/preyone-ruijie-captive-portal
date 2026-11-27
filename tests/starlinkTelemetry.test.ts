import { describe, it, expect } from 'vitest';
import type { StarlinkUsageSnapshot } from '../src/db/starlink';
import {
  autoTopupPriceUsd,
  buildDailyUsage,
  buildTelemetryMetrics,
  currentTelemetryCycle,
  parseTelemetrySyncBody,
  StarlinkTelemetryError,
} from '../src/services/starlinkTelemetry';

const KIT_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(offsetDays: number, priority: number, standard: number): StarlinkUsageSnapshot {
  const at = new Date(Date.now() - offsetDays * 86_400_000);
  return {
    id: `snapshot-${offsetDays}`,
    kit_id: KIT_ID,
    recorded_at: at.toISOString(),
    priority_used_gb: priority,
    standard_used_gb: standard,
    download_mbps: 42,
    upload_mbps: 12,
    latency_ms: 38,
    ping_drop_rate: 1.5,
    obstruction_percent: 0.4,
    uptime_seconds: 864000,
    online_status: true,
  };
}

describe('Starlink telemetry forecasting', () => {
  it('turns cumulative counters into 30 padded daily consumption points', () => {
    const daily = buildDailyUsage([snapshot(1, 10, 0), snapshot(0, 25, 5)]);

    expect(daily).toHaveLength(30);
    expect(daily[daily.length - 1].date).toBe(new Date().toISOString().slice(0, 10));
    expect(daily[daily.length - 2]).toMatchObject({ priority_gb: 10, standard_gb: 0, total_gb: 10 });
    expect(daily[daily.length - 1]).toMatchObject({ priority_gb: 15, standard_gb: 5, total_gb: 20 });
    expect(daily.slice(0, -2).every((point) => point.total_gb === 0)).toBe(true);
  });

  it('computes burn rate, remaining data and an exhaustion projection', () => {
    const metrics = buildTelemetryMetrics(
      [snapshot(10, 20, 0), snapshot(0, 60, 10)],
      10,
      100
    );

    expect(metrics.priority_used_gb).toBe(60);
    expect(metrics.standard_used_gb).toBe(10);
    expect(metrics.remaining_gb).toBe(40);
    expect(metrics.daily_burn_rate_gb).toBe(5);
    expect(metrics.days_remaining).toBe(8);
    expect(metrics.total_percent).toBeCloseTo(63.64, 1);
    expect(metrics.projected_exhaustion_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // DB reads are newest-first; the same result must hold for that ordering.
    const reversed = buildTelemetryMetrics(
      [snapshot(0, 60, 10), snapshot(10, 20, 0)],
      10,
      100
    );
    expect(reversed).toEqual(metrics);
  });

  it('uses a per-cycle calendar key and mirrors published data bundle prices', () => {
    expect(currentTelemetryCycle(new Date('2026-11-27T12:00:00Z'))).toBe('202611');
    expect(autoTopupPriceUsd(10)).toBe(5);
    expect(autoTopupPriceUsd(50)).toBe(19);
    expect(autoTopupPriceUsd(7)).toBeCloseTo(2.45, 2);
  });

  it('accepts single, wrapped and snake_case sync payloads', () => {
    const single = parseTelemetrySyncBody({
      kitId: KIT_ID,
      priority_used_gb: 12,
      standard_used_gb: 3,
      online_status: 'false',
    });
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ priorityUsedGb: 12, standardUsedGb: 3, onlineStatus: false });

    const wrapped = parseTelemetrySyncBody({
      snapshots: [{ kit_id: KIT_ID, priorityUsedGb: 8, recordedAt: '2026-11-27T08:00:00Z' }],
    });
    expect(wrapped[0].recordedAt).toBe('2026-11-27T08:00:00Z');
  });

  it('rejects snapshots without a valid kit id', () => {
    expect(() => parseTelemetrySyncBody({ kitId: 'not-a-uuid', priorityUsedGb: 1 }))
      .toThrowError(StarlinkTelemetryError);
  });
});
