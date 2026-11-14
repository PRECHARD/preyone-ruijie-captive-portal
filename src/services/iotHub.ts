import type { Server as HttpServer } from 'http';
import type { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Home-automation push hub.
 *
 * The IoT dashboard needs device state to move without the operator hitting
 * refresh: a switch flips, a meter ticks, a StarLink gateway drops. This module
 * owns the single `/api/homeautomate/stream` WebSocket endpoint:
 *
 *   • authentication — the same JWT the SPAs already hold (Bearer header,
 *     `?token=` query or the wildcard SSO cookie), so no second auth system;
 *   • tenancy — sockets are grouped by company id, and a broadcast can only
 *     reach subscribers of that company;
 *   • liveness — server-side ping every 30s plus socket cleanup, so a dead
 *     tablet does not hold memory forever behind a proxy that forgot it.
 *
 * Routes call `broadcastToCompany()` after every mutation; nothing else needs
 * to know the transport.
 */
export interface IotEvent {
  type: 'hello' | 'device_state' | 'telemetry' | 'trigger' | 'alert' | 'pong';
  companyId?: string;
  at: string;
  payload: Record<string, unknown>;
}

type Socket = WebSocket & { companyId?: string; alive?: boolean; isAlive?: boolean };

const clients = new Map<string, Set<Socket>>();
let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;

function parseToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
  } catch {
    /* fall through to the cookie */
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    const match = /(?:^|;\s*)preyone_token=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Resolve the company for a socket. Admin sessions carry `portalCompanyId`;
 * unassigned accounts are only allowed while exactly one company exists, which
 * mirrors requireCompany() rather than granting a silent first-company fallback.
 */
async function resolveSocketCompany(token: string | null): Promise<string | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || '', {
      algorithms: ['HS256'],
    }) as Record<string, unknown>;
    const companyId =
      (payload.portalCompanyId as string | undefined) ??
      (payload.companyId as string | undefined) ??
      null;
    if (companyId) return companyId;
    const { pool } = await import('../db/pool');
    const { rows } = await pool.query('SELECT id FROM companies ORDER BY created_at LIMIT 2');
    return rows.length === 1 ? rows[0].id : null;
  } catch {
    return null;
  }
}

function reject(socket: import('stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Attach the upgrade handler. Safe to call once per process. */
export function attachHomeAutomationSocket(server: HttpServer): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      reject(socket, '400 Bad Request');
      return;
    }
    if (pathname !== '/api/homeautomate/stream') {
      // Not ours: leave the socket alone so other upgrade handlers can claim it.
      return;
    }

    void (async () => {
      const companyId = await resolveSocketCompany(parseToken(req));
      if (!companyId) {
        reject(socket, '401 Unauthorized');
        return;
      }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        const client = ws as Socket;
        client.companyId = companyId;
        client.alive = true;
        client.on('pong', () => {
          client.alive = true;
        });
        client.on('message', (raw) => {
          // The only client message we honour is a keepalive ping.
          if (String(raw).slice(0, 40).includes('ping')) {
            client.send(JSON.stringify({ type: 'pong', at: new Date().toISOString(), payload: {} }));
          }
        });
        client.on('close', () => {
          clients.get(companyId)?.delete(client);
        });
        if (!clients.has(companyId)) clients.set(companyId, new Set());
        clients.get(companyId)!.add(client);
        client.send(
          JSON.stringify({
            type: 'hello',
            companyId,
            at: new Date().toISOString(),
            payload: { stream: 'homeautomate', intervalHintMs: 5000 },
          })
        );
      });
    })();
  });

  heartbeat = setInterval(() => {
    for (const [companyId, sockets] of clients) {
      for (const socket of sockets) {
        if (socket.alive === false) {
          socket.terminate();
          sockets.delete(socket);
          continue;
        }
        socket.alive = false;
        try {
          socket.ping();
        } catch {
          sockets.delete(socket);
        }
      }
      if (sockets.size === 0) clients.delete(companyId);
    }
  }, 30_000);
  heartbeat.unref?.();
}

/** Broadcast an event to every socket of one company. Never throws. */
export function broadcastToCompany(companyId: string, event: Omit<IotEvent, 'companyId' | 'at'> & { at?: string }): void {
  const sockets = clients.get(companyId);
  if (!sockets || sockets.size === 0) return;
  const message = JSON.stringify({
    ...event,
    companyId,
    at: event.at ?? new Date().toISOString(),
  });
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(message);
      } catch {
        sockets.delete(socket);
      }
    }
  }
}

/** Diagnostics for the admin health page / tests. */
export function iotHubStats(): { companies: number; sockets: number } {
  let sockets = 0;
  for (const set of clients.values()) sockets += set.size;
  return { companies: clients.size, sockets };
}

/** Close all sockets and stop the heartbeat (tests / graceful shutdown). */
export async function closeIotHub(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const set of clients.values()) {
    for (const socket of set) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }
  clients.clear();
  if (wss) {
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    wss = null;
  }
}
