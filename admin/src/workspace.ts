/** Admin Console workspaces: Preyone UltraNet WiFi (ISP) vs Preyone Transit (Bus Operations). */
export type Workspace = 'ultranet' | 'transit' | 'pos';

/** Whether a section belongs to a specific workspace or is global ('both'). */
export type WorkspaceScope = Workspace | 'both';

export const WORKSPACE_KEY = 'admin_workspace';

/**
 * Sections owned by the Preyone UltraNet WiFi workspace. This includes the
 * platform's system settings / notifications panels, which belong exclusively
 * to the WiFi workspace (never the Preyone Transit Operations workspace).
 */
const ULTRA_SECTIONS: readonly string[] = [
  'vouchers',
  'sessions',
  'access-log',
  'ap-health',
  'ap-devices',
  'bandwidth',
  'peak-hours',
  'mac-mgmt',
  'gateway-settings',
  'my-sales',
  'reports',
  'users',
  'packages',
  'settings',
  'admin-users',
  'staff',
  'time',
  'alerts',
  'broadcasts',
  'system-health',
  'platform-audit',
  'audit-log',
  'backup',
];

/** Sections owned by the Preyone Transit Operations workspace. */
const TRANSIT_SECTIONS: readonly string[] = [
  'tenants',
  'global-revenue',
  'fleet',
  'live-shifts',
  'trips',
  'tickets',
  'transit-devices',
  'financials',
  'company-profile',
];

/** Sections owned by the Preyone POS workspace (Point of Sale / retail). */
const POS_SECTIONS: readonly string[] = [
  'pos-sales',
  'pos-inventory',
  'pos-customers',
  'pos-reports',
  'pos-devices',
  'pos-company',
];

/** The workspace a section lives in; 'both' for global sections shown everywhere. */
export function workspaceForSection(section: string): WorkspaceScope {
  if (ULTRA_SECTIONS.includes(section)) return 'ultranet';
  if (TRANSIT_SECTIONS.includes(section)) return 'transit';
  if (POS_SECTIONS.includes(section)) return 'pos';
  return 'both';
}

/** Restore the persisted workspace, defaulting to UltraNet WiFi. */
export function loadWorkspace(): Workspace {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(WORKSPACE_KEY);
  } catch {
    /* storage unavailable */
  }
  return saved === 'ultranet' || saved === 'transit' || saved === 'pos' ? saved : 'ultranet';
}

/** Persist the selected workspace across page refreshes. */
export function persistWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, ws);
  } catch {
    /* storage unavailable */
  }
}