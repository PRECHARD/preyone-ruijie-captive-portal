import { app, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceRegistrationMessage, type DeviceRegisterBody } from '../shared/device';
import { tilesForModules } from '../shared/plans';
import type { ShellSession } from '../shared/session';

export const API_ORIGIN = 'https://app.preyone.com';

export type { ShellSession };

interface MePayload {
  full_name?: string;
  fullName?: string;
  email?: string;
  role?: string;
  plan_name?: string | null;
  plan_type?: string | null;
  subscribed_modules?: string[] | null;
  error?: string;
}

let token: string | null = null;

export function currentToken(): string | null {
  return token;
}

export function rememberToken(value: string | null): void {
  token = value;
}

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function toShellSession(me: MePayload): ShellSession {
  const modules = Array.isArray(me.subscribed_modules) ? me.subscribed_modules : [];
  return {
    fullName: me.full_name || me.fullName || me.email || 'Signed in',
    email: me.email || '',
    role: me.role || '',
    planName: me.plan_name ?? null,
    planType: me.plan_type ?? null,
    modules,
    tiles: tilesForModules(modules),
  };
}

export async function login(session: Session, email: string, password: string): Promise<ShellSession> {
  const res = await session.fetch(`${API_ORIGIN}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await readJson(res);
  if (!res.ok || typeof body.token !== 'string') {
    throw new Error(typeof body.error === 'string' ? body.error : 'Sign-in failed');
  }
  token = body.token;
  await session.cookies.set({
    url: API_ORIGIN,
    name: 'preyone_token',
    value: body.token,
    domain: '.preyone.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  });
  return fetchMe(session);
}

export async function fetchMe(session: Session): Promise<ShellSession> {
  if (!token) {
    const cookies = await session.cookies.get({ url: API_ORIGIN, name: 'preyone_token' });
    const saved = cookies.find((cookie) => cookie.value)?.value;
    if (saved) token = saved;
  }
  const res = await session.fetch(`${API_ORIGIN}/api/admin/auth/me`, {
    headers: authHeaders(),
  });
  const body = (await readJson(res)) as MePayload;
  if (!res.ok) {
    throw new Error(body.error || 'Session expired. Sign in again.');
  }
  return toShellSession(body);
}

export async function logout(session: Session): Promise<void> {
  token = null;
  await session.fetch(`${API_ORIGIN}/api/admin/auth/logout`, { method: 'POST', headers: authHeaders() }).catch(() => {});
  const cookies = await session.cookies.get({ name: 'preyone_token' });
  await Promise.all(
    cookies.map((cookie) => {
      const host = (cookie.domain || 'app.preyone.com').replace(/^\./, '');
      return session.cookies.remove(`https://${host}${cookie.path || '/'}`, cookie.name);
    })
  );
}

export function deviceId(): string {
  const file = path.join(app.getPath('userData'), 'device-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8 && existing.length <= 64) return existing;
  } catch {
    /* first launch */
  }
  const id = `electron-${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id, 'utf8');
  return id;
}

/** Registers this Mac or PC as device_type electron. Returns a notice when the plan cap refuses it. */
export async function registerDevice(session: Session): Promise<string | null> {
  const res = await session.fetch(`${API_ORIGIN}/api/pos/devices/auto-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      device_uuid: deviceId(),
      device_type: 'electron',
      device_name: os.hostname() || 'Preyone desktop',
      app_version: app.getVersion(),
    }),
  });
  const body = (await readJson(res)) as DeviceRegisterBody;
  return deviceRegistrationMessage(res.status, body);
}

export async function loadPrinterName(session: Session): Promise<string | null> {
  const res = await session.fetch(`${API_ORIGIN}/api/pos/company`, { headers: authHeaders() });
  if (!res.ok) return null;
  const body = await readJson(res);
  const hardware = body.pos_hardware;
  if (hardware && typeof hardware === 'object' && !Array.isArray(hardware)) {
    const name = (hardware as { printerName?: unknown }).printerName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  if (typeof hardware === 'string') {
    try {
      const parsed = JSON.parse(hardware) as { printerName?: unknown };
      if (typeof parsed.printerName === 'string' && parsed.printerName.trim()) return parsed.printerName.trim();
    } catch {
      return null;
    }
  }
  return null;
}

export async function probeOnline(session: Session): Promise<boolean> {
  try {
    const res = await session.fetch(API_ORIGIN, { method: 'HEAD' });
    return res.status > 0;
  } catch {
    return false;
  }
}
