import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiClock, FiSearch, FiWifi, FiX } from 'react-icons/fi';
import type { DeviceClass, PrimaryFilter, ViewMode, WifiSession } from '../../types/wifi';
import { DEVICE_CLASSES, PRIMARY_FILTERS } from '../../types/wifi';
import { matchesDeviceClass, matchesPrimary } from './sessionMeta';
import './wifiSessions.css';

/**
 * Tabs that only exist in the live feed — a historical row has no band, no
 * connect type and no Ruijie health score, so offering them would just render
 * an empty table for a reason the operator cannot see.
 */
const LIVE_ONLY_TABS: PrimaryFilter[] = ['Wireless', 'Wired', 'Wi-Fi Experience'];

interface Props {
  /** Full (unfiltered) live population — drives the tab counters. */
  sessions: WifiSession[];
  primary: PrimaryFilter;
  onPrimary: (f: PrimaryFilter) => void;
  deviceClass: DeviceClass | 'All';
  onDeviceClass: (c: DeviceClass | 'All') => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  query: string;
  onQuery: (q: string) => void;
  historyCount: number;
}

/**
 * Advanced header controls bar for the client monitor:
 *   [ tabs ......................... ]  [ Online/Historical ▾ ] [ 🔍 ]
 *   [ device-class pills ...................... ]
 * Counts always describe the full population, never the filtered subset.
 */
export default function SessionFilterHeader({
  sessions,
  primary,
  onPrimary,
  deviceClass,
  onDeviceClass,
  view,
  onView,
  query,
  onQuery,
  historyCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tabs = view === 'historical' ? PRIMARY_FILTERS.filter((f) => !LIVE_ONLY_TABS.includes(f)) : PRIMARY_FILTERS;

  const primaryCount = (f: PrimaryFilter) =>
    sessions.reduce((n, s) => n + (matchesPrimary(s, f) ? 1 : 0), 0);

  // Class pills tally within the selected primary tier, matching how the
  // console narrows the category list as you move between the top tabs.
  const scoped = sessions.filter((s) => matchesPrimary(s, primary));
  const classCount = (c: DeviceClass | 'All') =>
    c === 'All' ? scoped.length : scoped.reduce((n, s) => n + (matchesDeviceClass(s, c) ? 1 : 0), 0);

  const chooseView = (next: ViewMode) => {
    if (next === view) {
      setOpen(false);
      return;
    }
    onView(next);
    onDeviceClass('All');
    if (next === 'historical' && LIVE_ONLY_TABS.includes(primary)) onPrimary('All');
    setOpen(false);
  };

  const live = view === 'online';
  const viewCount = live ? sessions.length : historyCount;

  return (
    <div className="wf-header">
      <div className="wf-header-bar">
        <div className="wf-tier wf-tier--primary" role="tablist" aria-label="Connection type">
          {tabs.map((f) => (
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

        <div className="wf-header-controls">
          <div className="wf-view" ref={wrapRef}>
            <button
              type="button"
              className={`wf-view-btn${live ? ' is-live' : ''}`}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label="Client population"
              onClick={() => setOpen((o) => !o)}
            >
              {live ? <FiWifi size={13} /> : <FiClock size={13} />}
              <span>{live ? 'Online Clients' : 'Historical Clients'}</span>
              <span className="wf-count">{viewCount}</span>
              <FiChevronDown size={13} className={open ? 'wf-caret is-open' : 'wf-caret'} />
            </button>

            {open && (
              <ul className="wf-view-menu" role="listbox" aria-label="Client population">
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={live}
                    className={live ? 'is-active' : ''}
                    onClick={() => chooseView('online')}
                  >
                    <FiWifi size={13} />
                    <span className="wf-view-name">
                      <b>Online Clients</b>
                      <em>Live from the Ruijie Cloud controller</em>
                    </span>
                    <span className="wf-count">{sessions.length}</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={!live}
                    className={!live ? 'is-active' : ''}
                    onClick={() => chooseView('historical')}
                  >
                    <FiClock size={13} />
                    <span className="wf-view-name">
                      <b>Historical Clients</b>
                      <em>Full audit trail of every device ever seen</em>
                    </span>
                    <span className="wf-count">{historyCount}</span>
                  </button>
                </li>
              </ul>
            )}
          </div>

          <label className="wf-search">
            <FiSearch size={13} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search IP / MAC / NAME"
              aria-label="Search clients by IP, MAC or name"
            />
            {query ? (
              <button
                type="button"
                className="wf-search-x"
                aria-label="Clear search"
                onClick={() => onQuery('')}
              >
                <FiX size={12} />
              </button>
            ) : null}
          </label>
        </div>
      </div>

      {live && (
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
      )}
    </div>
  );
}
