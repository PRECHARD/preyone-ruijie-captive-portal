import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { PREYONE_COOKIE } from '../src/utils/ssoCookie';
import {
  ADMIN_STARLINK_HASH,
  starlinkAdminRedirect,
} from '../src/utils/starlinkAdminEntry';

function req(partial: {
  host: string;
  path: string;
  method?: string;
  accept?: string;
  dest?: string;
  query?: Record<string, string>;
  cookie?: string;
}): Request {
  return {
    hostname: partial.host,
    path: partial.path,
    method: partial.method || 'GET',
    query: partial.query || {},
    cookies: partial.cookie ? { [PREYONE_COOKIE]: partial.cookie } : {},
    get(name: string) {
      if (name === 'accept') return partial.accept ?? 'text/html';
      if (name === 'sec-fetch-dest') return partial.dest;
      return undefined;
    },
  } as unknown as Request;
}

const ceoCookie = jwt.sign(
  { id: '1', role: 'CEO', email: 'ceo@preyone.com' },
  process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
);

describe('starlink admin entry', () => {
  it('sends the admin console /starlink/portal link back to the management dashboard', () => {
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink/portal',
    }))).toBe(ADMIN_STARLINK_HASH);
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink',
    }))).toBe(ADMIN_STARLINK_HASH);
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink/auth',
    }))).toBe(ADMIN_STARLINK_HASH);
  });

  it('does not steal admin assets, ordinary console pages or the privacy page', () => {
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/',
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/assets/index-D1fgrGO5.js',
      accept: '*/*',
      dest: 'script',
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink-privacy.html',
    }))).toBeNull();
  });

  it('never redirects the starlink customer portal, even for a signed-in admin', () => {
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/',
      cookie: ceoCookie,
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/starlink/portal',
      cookie: ceoCookie,
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/starlink/auth',
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'preyone.com',
      path: '/starlink/portal',
      cookie: ceoCookie,
    }))).toBeNull();
  });
});
