import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { PREYONE_COOKIE } from '../src/utils/ssoCookie';
import {
  ADMIN_STARLINK_HASH,
  ADMIN_STARLINK_URL,
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

  it('does not steal admin assets or ordinary console pages', () => {
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/',
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/assets/index-BJOL1wKM.js',
      accept: '*/*',
      dest: 'script',
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink-privacy.html',
    }))).toBeNull();
  });

  it('sends a signed-in manager on the starlink host to the same dashboard', () => {
    const cookie = jwt.sign(
      { id: '1', role: 'CEO', email: 'ceo@preyone.com' },
      process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
    );
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/',
      cookie,
    }))).toBe(ADMIN_STARLINK_URL);
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/starlink/portal',
      cookie,
    }))).toBe(ADMIN_STARLINK_URL);
  });

  it('leaves customers, staff, reset links and the customer preview on the portal', () => {
    const customer = jwt.sign(
      { id: '9', role: 'portal' },
      process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
    );
    const staff = jwt.sign(
      { id: '2', role: 'Staff' },
      process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
    );
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/starlink/portal',
      cookie: customer,
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/',
      cookie: staff,
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/',
    }))).toBeNull();
    const ceo = jwt.sign(
      { id: '1', role: 'CEO' },
      process.env.JWT_SECRET || 'preyone-jwt-secret-change-in-production',
    );
    expect(starlinkAdminRedirect(req({
      host: 'starlink.preyone.com',
      path: '/starlink/portal',
      query: { mode: 'reset', token: 'abc' },
      cookie: ceo,
    }))).toBeNull();
    expect(starlinkAdminRedirect(req({
      host: 'admin.preyone.com',
      path: '/starlink/portal',
      query: { view: 'customer' },
    }))).toBeNull();
  });
});
