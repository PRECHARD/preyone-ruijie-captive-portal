import type { DeviceClass, PrimaryFilter, WifiSession } from '../../types/wifi';
import { DEVICE_CLASSES, PRIMARY_FILTERS } from '../../types/wifi';
import { matchesDeviceClass, matchesPrimary } from './sessionMeta';
import './wifiSessions.css';

interface Props {
  sessions: WifiSession[];
  primary: PrimaryFilter;
  onPrimary: (f: PrimaryFilter) => void;
  deviceClass: DeviceClass | 'All';
  onDeviceClass: (c: DeviceClass | 'All') => void;
}

/**
 * Two-tier filter bar mirroring the Ruijie client monitor:
 *   [All 31] [Wireless 31] [Wired 0] [Blocklist 1] | [All] [Smartphone] ...
 * Counts are computed live against the full (unfiltered) session list so the
 * tabs always describe the whole population, not the current subset.
 */
export default function SessionFilterTabs({
  sessions,
  primary,
  onPrimary,
  deviceClass,
  onDeviceClass,
}: Props) {
  const primaryCount = (f: PrimaryFilter) =>
    sessions.reduce((n, s) => n + (matchesPrimary(s, f) ? 1 : 0), 0);

  // Class pills are tallied within the selected primary tier, matching how the
  // console narrows the category list as you move between the top tabs.
  const scoped = sessions.filter((s) => matchesPrimary(s, primary));
  const classCount = (c: DeviceClass | 'All') =>
    c === 'All' ? scoped.length : scoped.reduce((n, s) => n + (matchesDeviceClass(s, c) ? 1 : 0), 0);

  return (
    <div className="wf-filters">
      <div className="wf-tier" role="tablist" aria-label="Connection type">
        {PRIMARY_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={primary === f}
            className={`un-tab${primary === f ? ' is-active' : ''}`}
            onClick={() => onPrimary(f)}
          >
            {f}
            <span className="wf-count">{primaryCount(f)}</span>
          </button>
        ))}
      </div>

      <span className="wf-tier-sep" aria-hidden="true" />

      <div className="wf-tier wf-tier--class" role="tablist" aria-label="Device class">
        <button
          type="button"
          role="tab"
          aria-selected={deviceClass === 'All'}
          className={`un-tab un-tab--sm${deviceClass === 'All' ? ' is-active' : ''}`}
          onClick={() => onDeviceClass('All')}
        >
          All
          <span className="wf-count">{classCount('All')}</span>
        </button>
        {DEVICE_CLASSES.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={deviceClass === c}
            className={`un-tab un-tab--sm${deviceClass === c ? ' is-active' : ''}`}
            onClick={() => onDeviceClass(deviceClass === c ? 'All' : c)}
          >
            {c}
            <span className="wf-count">{classCount(c)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
