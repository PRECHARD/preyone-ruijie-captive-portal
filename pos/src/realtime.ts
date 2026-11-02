import { useEffect, useRef, useState } from 'react';
import { auth } from './api';

/**
 * Live sale / stock telemetry for the till.
 *
 * The server broadcasts one `telemetry` event to every socket of a company
 * after a document settles (Pesepay webhook, status poll, or a payment taken at
 * another terminal). Payloads carry the exact stock movements that were
 * applied, so the till can decrement its grid instantly instead of waiting for
 * a manual refresh — and can pulse anything that crossed its low-stock line.
 *
 * The socket is the same `/api/homeautomate/stream` hub the admin console uses.
 * It authenticates with the POS bearer token and reconnects with backoff; a
 * dropped socket never blocks the till because all reads still come from the
 * REST API.
 */

export interface StockMovement {
  productId: string;
  name: string;
  sku?: string | null;
  qty: number;
  previous: number;
  next: number;
  lowStock: boolean;
}

export interface LiveSale {
  event: 'invoice.paid' | 'document.paid';
  documentId?: string | null;
  documentNumber?: string | null;
  amountPaid?: number | null;
  currency?: string | null;
  paymentMethod?: string | null;
  saleRecorded?: boolean;
  stockApplied?: boolean;
  stockMovements: StockMovement[];
  lowStock: StockMovement[];
  source?: string;
  at: number;
}

export interface LiveStock {
  previous: number;
  qty: number;
  lowStock: boolean;
  at: number;
}

interface HubMessage {
  type?: string;
  payload?: Record<string, unknown>;
}

function parseMovement(raw: unknown): StockMovement | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const productId = typeof m.productId === 'string' ? m.productId : '';
  if (!productId) return null;
  return {
    productId,
    name: typeof m.name === 'string' ? m.name : 'Product',
    sku: typeof m.sku === 'string' ? m.sku : null,
    qty: Number(m.qty) || 0,
    previous: Number(m.previous) || 0,
    next: Number(m.next) || 0,
    lowStock: m.lowStock === true,
  };
}

export function useRealtimeSales(enabled: boolean): {
  stock: Record<string, LiveStock>;
  sale: LiveSale | null;
  tick: number;
  connected: boolean;
} {
  const [stock, setStock] = useState<Record<string, LiveStock>>({});
  const [sale, setSale] = useState<LiveSale | null>(null);
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const attemptsRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;

    const connect = () => {
      const token = auth.token();
      if (!token || closed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${scheme}://${window.location.host}/api/homeautomate/stream?token=${encodeURIComponent(token)}`;

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        attemptsRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        let msg: HubMessage;
        try {
          msg = JSON.parse(String(event.data)) as HubMessage;
        } catch {
          return;
        }
        if (msg.type !== 'telemetry' || !msg.payload) return;
        const payload = msg.payload;
        const name = String(payload.event ?? '');
        if (name !== 'invoice.paid' && name !== 'document.paid') return;

        const movements = Array.isArray(payload.stockMovements)
          ? payload.stockMovements.map(parseMovement).filter((m): m is StockMovement => Boolean(m))
          : [];

        if (movements.length > 0) {
          const at = Date.now();
          setStock((prev) => {
            const next = { ...prev };
            for (const m of movements) {
              next[m.productId] = { previous: m.previous, qty: m.next, lowStock: m.lowStock, at };
            }
            return next;
          });
        }

        setSale({
          event: name,
          documentId: (payload.documentId as string | null) ?? null,
          documentNumber: (payload.documentNumber as string | null) ?? null,
          amountPaid: payload.amountPaid == null ? null : Number(payload.amountPaid),
          currency: (payload.currency as string | null) ?? null,
          paymentMethod: (payload.paymentMethod as string | null) ?? null,
          saleRecorded: payload.saleRecorded === true,
          stockApplied: payload.stockApplied === true,
          stockMovements: movements,
          lowStock: Array.isArray(payload.lowStock)
            ? payload.lowStock.map(parseMovement).filter((m): m is StockMovement => Boolean(m))
            : movements.filter((m) => m.lowStock),
          source: typeof payload.source === 'string' ? payload.source : undefined,
          at: Date.now(),
        });
        setTick((n) => n + 1);
      };

      socket.onclose = () => {
        setConnected(false);
        if (!closed) scheduleRetry();
      };
      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      };
    };

    const scheduleRetry = () => {
      if (closed || retryRef.current) return;
      attemptsRef.current += 1;
      // 1s → 2s → 4s → 8s → 15s cap. The till stays usable meanwhile.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attemptsRef.current - 1, 4));
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        connect();
      }, delay);
    };

    // Reconnect immediately when the tab wakes up or the network returns.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const socket = socketRef.current;
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        if (retryRef.current) {
          window.clearTimeout(retryRef.current);
          retryRef.current = null;
        }
        connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);

    connect();

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      if (retryRef.current) window.clearTimeout(retryRef.current);
      retryRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      setConnected(false);
    };
  }, [enabled]);

  return { stock, sale, tick, connected };
}
