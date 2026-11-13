import { useEffect, useState } from 'react';
import type { WifiSession } from '../../types/wifi';
import { getDeviceIcon } from './deviceIcons';
import { summarize } from './sessionMeta';
import './wifiSessions.css';

// ── Donut ────────────────────────────────────────────────────────────────────
// Pure SVG stroke math — no chart dependency. Segments are drawn from a zero
// dasharray on mount so the ring sweeps in, then CSS transitions handle every
// subsequent 30s poll without re-animating.

const R = 40;
const CIRC = 2 * Math.PI * R;

interface Segment {
  label: string;
  value: number;
  color: string;
}

function Donut({ segments, total, centerLabel }: {
  segments: Segment[];
  total: number;
  centerLabel: string;
}) {
  const [drawn, setDrawn] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Offsets are derived, never mutated — each arc's start angle is the sum of
  // every value that precedes it. Zero-value segments are dropped so the ring
  // never shows a hairline sliver for an empty bucket.
  const visible = segments.filter((s) => s.value > 0);
  const arcs = visible.map((seg, i) => {
    const before = visible.slice(0, i).reduce((n, s) => n + s.value, 0);
    const start = total > 0 ? (before / total) * CIRC : 0;
    const len = total > 0 ? (seg.value / total) * CIRC : 0;
    const dash = drawn ? `${len} ${CIRC - len}` : `0 ${CIRC}`;
    const dim = hover != null && hover !== seg.label;
    const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
    return (
      <g key={seg.label} style={dim ? { opacity: 0.35 } : undefined}>
        <circle
          className="wf-donut-arc"
          cx="50"
          cy="50"
          r={R}
          fill="none"
          stroke={seg.color}
          strokeWidth={hover === seg.label ? 14 : 12}
          strokeLinecap="butt"
          strokeDasharray={dash}
          strokeDashoffset={-start}
          transform="rotate(-90 50 50)"
          style={{ filter: `drop-shadow(0 0 5px ${seg.color}66)` }}
          onMouseEnter={() => setHover(seg.label)}
          onMouseLeave={() => setHover((h) => (h === seg.label ? null : h))}
        >
          <title>{`${seg.label}: ${seg.value} client${seg.value === 1 ? '' : 's'} (${pct}%)`}</title>
        </circle>
      </g>
    );
  });

  const tipIndex = hover == null ? -1 : visible.findIndex((s) => s.label === hover);
  const tip = tipIndex >= 0 ? visible[tipIndex] : null;
  const tipStyle = tip ? tipPos(visible, tipIndex, total) : undefined;

  return (
    <div className="wf-donut">
      <div className="wf-donut-ring">
        <svg
          className="wf-donut-svg"
          viewBox="0 0 100 100"
          role="img"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
          {arcs}
          <text x="50" y="47" textAnchor="middle" className="wf-donut-total">{total}</text>
          <text x="50" y="61" textAnchor="middle" className="wf-donut-cap">{centerLabel}</text>
        </svg>

        {tip && (
          <span className="wf-donut-tip" role="status" style={tipStyle}>
            <i style={{ background: tip.color }} />
            <b>{tip.label}</b>
            <span>
              {tip.value} client{tip.value === 1 ? '' : 's'} ·{' '}
              {total > 0 ? Math.round((tip.value / total) * 100) : 0}%
            </span>
          </span>
        )}
      </div>

      <ul className="wf-legend">
        {segments.map((seg) => (
          <li
            key={seg.label}
            className={hover === seg.label ? 'is-active' : undefined}
            onMouseEnter={() => setHover(seg.label)}
            onMouseLeave={() => setHover((h) => (h === seg.label ? null : h))}
          >
            <i style={{ background: seg.color, boxShadow: `0 0 7px ${seg.color}aa` }} />
            <span className="wf-legend-label">{seg.label}</span>
            <b>{seg.value}</b>
            <em>{total > 0 ? Math.round((seg.value / total) * 100) : 0}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Anchor the tooltip just outside the arc at that segment's mid-angle. */
function tipPos(visible: Segment[], index: number, total: number) {
  const before = visible.slice(0, index).reduce((n, s) => n + s.value, 0);
  const mid = -90 + (total > 0 ? ((before + visible[index].value / 2) / total) * 360 : 0);
  const rad = (mid * Math.PI) / 180;
  return {
    left: `${50 + 40 * Math.cos(rad)}%`,
    top: `${50 + 40 * Math.sin(rad)}%`,
  };
}

function CardShell({ title, children, accent, delay }: {
  title: string;
  children: React.ReactNode;
  accent?: string;
  delay?: number;
}) {
  return (
    <section
      className="wf-card wf-card--rise"
      style={{
        ...(accent ? { borderColor: `${accent}33`, '--wf-accent': accent } as React.CSSProperties : null),
        animationDelay: delay != null ? `${delay}ms` : undefined,
      }}
    >
      <header className="wf-card-head">
        <h3>{title}</h3>
        <span className="wf-card-rule" />
      </header>
      {children}
    </section>
  );
}

const TYPE_COLORS: Record<string, string> = {
  Smartphone: '#00F0FF',
  PC: '#A855F7',
  'IoT Devices': '#34D399',
  Other: '#FBBF24',
};

const BAND_COLORS: Record<string, string> = {
  '5 GHz': '#00F0FF',
  '2.4 GHz': '#A855F7',
  'Wired/Other': '#FBBF24',
};

export default function SessionSummaryCards({ sessions }: { sessions: WifiSession[] }) {
  const summary = summarize(sessions);

  const typeSegments = summary.clientTypes.map((t) => ({
    label: t.key,
    value: t.value,
    color: TYPE_COLORS[t.key] ?? '#64748b',
  }));
  const bandSegments = summary.bands.map((b) => ({
    label: b.key,
    value: b.value,
    color: BAND_COLORS[b.key] ?? '#64748b',
  }));

  const maxMb = summary.ranking[0]?.mb ?? 1;

  return (
    <div className="wf-cards">
      <CardShell title="Client Type" accent="#00F0FF" delay={0}>
        <Donut segments={typeSegments} total={summary.total} centerLabel="CLIENTS" />
      </CardShell>

      <CardShell title="Access Type" accent="#A855F7" delay={70}>
        <Donut segments={bandSegments} total={summary.total} centerLabel="CLIENTS" />
      </CardShell>

      <CardShell title="Traffic Ranking" accent="#34D399" delay={140}>
        {summary.ranking.length === 0 ? (
          <p className="wf-empty">No traffic recorded yet.</p>
        ) : (
          <ol className="wf-rank">
            {summary.ranking.map((r, i) => (
              <li key={r.mac}>
                <span className="wf-rank-pos">{i + 1}</span>
                <span className="wf-rank-name" title={r.name}>
                  <i className="wf-rank-icon" aria-hidden="true">
                    {getDeviceIcon(r.model, r.manufacturer, r.type)}
                  </i>
                  {r.name}
                </span>
                <span className="wf-rank-body">
                  <span className="wf-rank-track">
                    <span
                      className="wf-rank-fill"
                      style={{ width: `${Math.max(4, (r.mb / maxMb) * 100)}%` }}
                    />
                  </span>
                  <span className="wf-rank-meta">
                    <b>{r.mb >= 1024 ? `${(r.mb / 1024).toFixed(2)} GB` : `${r.mb.toFixed(1)} MB`}</b>
                    <em>{r.pct}%</em>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardShell>
    </div>
  );
}
