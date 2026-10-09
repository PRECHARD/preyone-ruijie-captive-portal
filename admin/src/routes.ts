/**
 * Hash-based deep linking for the Admin Console.
 *
 * The console deliberately mounts no router (react-router-dom is unused): the
 * active page is a single piece of component state. That made every page
 * unreachable by URL, so the Preyone Transit workspace and the tenant-management
 * page could not be bookmarked, shared, or linked from the app.preyone.com
 * gateway -- a broken or missing link just silently re-rendered Overview.
 *
 * A URL fragment fixes that without introducing a router or a history entry per
 * click: `#/<workspace>/<section>`, e.g. `#/transit/tenants`.
 */
import { workspaceForSection, type Workspace } from './workspace';

export type ParsedRoute = { workspace: Workspace | null; section: string | null };

const WORKSPACES: readonly Workspace[] = ['ultranet', 'transit', 'pos'];

/**
 * Parse `location.hash` into a workspace + section pair.
 *
 * Accepts `#/transit/tenants`, `#/transit` (workspace root) and a bare
 * `#/tenants` section. Returns nulls for an empty or unrecognised hash so the
 * caller can fall back to persisted workspace state.
 */
export function parseHash(hash: string): ParsedRoute {
  const raw = hash.replace(/^#\/?/, '');
  if (!raw) return { workspace: null, section: null };
  const parts = raw.split('/').filter(Boolean);
  const [first, second] = parts;
  if (WORKSPACES.includes(first as Workspace)) {
    return { workspace: first as Workspace, section: second || 'overview' };
  }
  // Not a workspace prefix: treat the whole fragment as a section name.
  return { workspace: null, section: first || null };
}

/** Read the current route out of the browser URL. */
export function currentRoute(): ParsedRoute {
  return typeof window === 'undefined' ? { workspace: null, section: null } : parseHash(window.location.hash);
}

/**
 * Build the fragment for a section, resolving which workspace it belongs to.
 *
 * `workspace` is only a tiebreaker for sections scoped to 'both' (Overview);
 * every other section carries its own workspace so the URL always matches the
 * sidebar the user is looking at.
 */
export function buildHash(workspace: Workspace, section: string): string {
  const scope = workspaceForSection(section);
  const ws = scope === 'both' ? workspace : scope;
  return `#/${ws}/${section}`;
}

/**
 * Write the fragment, using replaceState for the very first paint so landing
 * directly on a deep link does not add a history entry the back button would
 * have to unwind through an identical URL.
 */
export function writeHash(workspace: Workspace, section: string, replace = false): void {
  if (typeof window === 'undefined') return;
  const next = buildHash(workspace, section);
  if (window.location.hash === next) return;
  if (replace) {
    window.history.replaceState(null, '', next);
    return;
  }
  window.location.hash = next;
}
