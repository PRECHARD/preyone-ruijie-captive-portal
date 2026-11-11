import type { ReactNode } from 'react';

/** Shared line icons for the marketing surface and its navigation. */

export type IconName =
  | 'bolt'
  | 'shield'
  | 'climate'
  | 'camera'
  | 'energy'
  | 'satellite'
  | 'spark'
  | 'arrow'
  | 'check'
  | 'lock'
  | 'wifi'
  | 'key'
  | 'home'
  | 'mail'
  | 'phone'
  | 'chat'
  | 'pin'
  | 'menu';

const ICON_PATHS: Record<IconName, ReactNode> = {
  bolt: <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13Z" />,
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  climate: (
    <>
      <path d="M10 13.6V5a2 2 0 1 1 4 0v8.6a4.5 4.5 0 1 1-4 0Z" />
      <path d="M12 8v7" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="6.5" width="13" height="11" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </>
  ),
  energy: (
    <>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
    </>
  ),
  satellite: (
    <>
      <path d="M5 13a8 8 0 0 0 6 6M2 10a12 12 0 0 0 9 9" />
      <path d="m13 5 6 6-2.5 2.5L19 19l-2 2-5.5-2.5L9 16Z" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  arrow: <path d="M4 12h15m-5.5-5.5L19 12l-5.5 5.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  wifi: (
    <>
      <path d="M3.5 9a13 13 0 0 1 17 0" />
      <path d="M6.8 12.5a8.4 8.4 0 0 1 10.4 0" />
      <path d="M10 16a4 4 0 0 1 4 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 9 9M17 17l2-2M14 14l2-2" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1Z" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  phone: (
    <path d="M6.5 3.5 9 9l-2 2a14 14 0 0 0 6 6l2-2 5.5 2.5v3a2 2 0 0 1-2.2 2A18.5 18.5 0 0 1 3.5 5.7 2 2 0 0 1 5.5 3.5Z" />
  ),
  chat: (
    <>
      <path d="M21 12a8 8 0 0 1-8 8H6l-3 2 1-4.2A8 8 0 1 1 21 12Z" />
      <path d="M8.5 11h.01M12 11h.01M15.5 11h.01" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
