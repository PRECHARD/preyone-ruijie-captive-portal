/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PAYMENT GATEWAY ADAPTER  ·  Starlink invoice payments
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is the ONLY place the UI talks to a payment provider. The React
 * component (`StarlinkPaymentPortal.tsx`) never calls `fetch` directly — it
 * calls the functions below. To change provider, edit this file only; the UI
 * stays untouched.
 *
 * ── How a website payment becomes a numbered invoice ──────────────────────────
 *
 *  1. POST /api/site/invoices  → the server validates the plan against its own
 *     price list, creates an `online` invoice in `pos_documents`, opens a
 *     Pesepay intent against it, and returns { invoiceNumber, redirectUrl,
 *     intentId, statusToken }.
 *  2. The browser is redirected to Pesepay. Nothing is settled yet.
 *  3. The buyer pays. Pesepay calls POST /api/payments/pesepay/callback, which
 *     credits the same invoice and flips it to `paid`.
 *  4. The buyer returns and we poll GET /api/payments/pesepay/status/:intentId
 *     with the status token to show the invoice number and final state.
 *
 * The amount sent from here is display-only. The server re-derives every
 * chargeable amount from SERVER_SIDE_PLANS in src/routes/siteInvoices.ts and
 * rejects anything outside the published range, so a tampered or stale
 * frontend cannot change what is charged.
 */

/* ── Types ─────────────────────────────────────────────────────────────── */

export type PlanId =
  | 'starlink-mini'
  | 'starlink-standard'
  | 'starlink-priority'
  | 'starlink-custom'

export type Plan = {
  id: PlanId
  label: string
  /** `0` means "no published tariff" — the customer must type the amount. */
  amount: number
  note: string
  /** Accepted range for the manual amount, in USD. */
  min?: number
  max?: number
}

/**
 * Display copy for the Starlink price list. The chargeable amounts are owned by
 * the server (SERVER_SIDE_PLANS in src/routes/siteInvoices.ts); keep the fixed
 * prices here in step with it.
 */
export const STARLINK_PLANS: Plan[] = [
  {
    id: 'starlink-mini',
    label: 'Starlink Mini Kit',
    amount: 350,
    note: 'Portable kit — up to 100 Mbps',
  },
  {
    id: 'starlink-standard',
    label: 'Starlink Standard Kit',
    amount: 480,
    note: 'Full-size dish — up to 220 Mbps',
  },
  {
    id: 'starlink-priority',
    label: 'Starlink Priority',
    amount: 0,
    min: 200,
    max: 5000,
    note: 'Business priority — enter your quoted amount',
  },
  {
    id: 'starlink-custom',
    label: 'Custom Installation',
    amount: 0,
    min: 100,
    max: 10000,
    note: 'Bespoke installation quoted to fit the site',
  },
]

export type RailId = 'ecocash' | 'innbucks' | 'omari' | 'paygo'

export type PaymentRail = {
  rail: RailId
  code: string
  min: number
  max: number
  requiresPhone: boolean
}

export type PaymentRequest = {
  accountRef: string
  fullName: string
  email: string
  phone: string
  planId: PlanId
  amount: number
  paymentMethod: RailId
  /** Reused across retries so a double-tap cannot raise two invoices. */
  idempotencyKey: string
}

export type CheckoutResponse = {
  invoiceId: string
  invoiceNumber: string
  referenceNumber: string
  intentId: string
  statusToken: string
  /**
   * `seamless` means the buyer approves on their own handset and we poll for
   * the result; `redirect` means the gateway wants the browser sent to a hosted
   * page first. Pesepay's v2 make-payment is seamless for EcoCash/Innbucks/
   * Omari, so `redirect` is currently only a forward-compatible branch.
   */
  mode: 'seamless' | 'redirect'
  redirectUrl: string | null
  instructions: string | null
  amount: number
  currency: string
  taxPct: number
  taxAmount: number
  paymentMethod: RailId
  accountRef: string
  planLabel: string
}

export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED'

export type StatusResponse = {
  status: PaymentStatus
  referenceNumber: string
  amount: number
  currency: string
  createdAt?: string
  completedAt?: string
}

/* ── Errors ────────────────────────────────────────────────────────────── */

export type PaymentErrorKind = 'validation' | 'declined' | 'network' | 'server'

/** Normalised error so the UI can style declined cards differently to 500s. */
export class PaymentError extends Error {
  kind: PaymentErrorKind

  constructor(message: string, kind: PaymentErrorKind = 'server') {
    super(message)
    this.name = 'PaymentError'
    this.kind = kind
  }
}

/* ── Endpoints ─────────────────────────────────────────────────────────── */

const CREATE_INVOICE_ENDPOINT = '/api/site/invoices'
const RAILS_ENDPOINT = '/api/site/payment-rails'

/** Human labels for the gateway rails, keyed the same way as `RailId`. */
export const RAIL_LABELS: Record<RailId, string> = {
  ecocash: 'EcoCash',
  innbucks: 'Innbucks',
  omari: 'Omari',
  paygo: 'PayGo',
}

/**
 * Reads the rails the server can actually settle for USD today, so the picker
 * never offers a method that would be rejected at submit. Falls back to the
 * static list if the endpoint is briefly unavailable so the form still renders.
 */
export async function fetchPaymentRails(): Promise<PaymentRail[]> {
  try {
    const response = await fetch(RAILS_ENDPOINT, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('unavailable')
    const data = (await response.json()) as { rails?: PaymentRail[] }
    if (Array.isArray(data.rails) && data.rails.length > 0) return data.rails
  } catch {
    // Fall through to the static list below.
  }
  return [
    { rail: 'ecocash', code: 'PZW211', min: 1, max: 500, requiresPhone: true },
    { rail: 'innbucks', code: 'PZW212', min: 1, max: 1000, requiresPhone: false },
    { rail: 'omari', code: 'PZW216', min: 0.5, max: 500, requiresPhone: true },
  ]
}

type GatewayErrorBody = { error?: string; code?: string; declineReason?: string }

async function readError(response: Response, fallback: string): Promise<PaymentError> {
  let body: GatewayErrorBody | null = null
  try {
    body = (await response.json()) as GatewayErrorBody
  } catch {
    // Non-JSON error page (proxy error, gateway timeout). Use the fallback.
  }
  const isDecline = response.status === 402 || body?.code === 'card_declined'
  return new PaymentError(
    body?.declineReason || body?.error || fallback,
    isDecline ? 'declined' : response.status < 500 ? 'validation' : 'server',
  )
}

/**
 * Opens a website payment: creates the numbered invoice and returns the
 * Pesepay redirect plus the tokens needed to poll for settlement.
 *
 * Throws `PaymentError` on every failure path — callers only ever need to
 * catch one type. Network faults, HTTP errors and unparseable bodies are all
 * normalised here so no `try/catch` branching leaks into the component.
 */
export async function createStarlinkPayment(payload: PaymentRequest): Promise<CheckoutResponse> {
  let response: Response

  try {
    response = await fetch(CREATE_INVOICE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Same-origin so the request carries the SSO cookie like every other
      // call to this API, and so the browser treats it as a normal navigation
      // target when we hand redirectUrl to Pesepay.
      credentials: 'same-origin',
    })
  } catch {
    // fetch only rejects on a transport failure — DNS, TLS, offline, CORS.
    throw new PaymentError(
      'Could not reach the payment server. Check your connection and try again.',
      'network',
    )
  }

  if (!response.ok) {
    throw await readError(
      response,
      `Payment could not be started (HTTP ${response.status}). Please try again.`,
    )
  }

  let data: CheckoutResponse | null = null
  try {
    data = (await response.json()) as CheckoutResponse
  } catch {
    throw new PaymentError('The payment server returned an unreadable response.', 'server')
  }

  if (!data?.intentId || !data?.invoiceNumber) {
    throw new PaymentError('Payment server did not return an invoice.', 'server')
  }

  return data
}

/**
 * Polls the gateway for the settled state of an intent.
 *
 * The status token is bound server-side to this exact intent, so the public
 * endpoint cannot be used to inspect somebody else's payment.
 */
export async function fetchPaymentStatus(
  intentId: string,
  statusToken: string,
): Promise<StatusResponse> {
  const url = `/api/payments/pesepay/status/${encodeURIComponent(intentId)}?token=${encodeURIComponent(statusToken)}`

  let response: Response
  try {
    response = await fetch(url, { credentials: 'same-origin' })
  } catch {
    throw new PaymentError('Could not confirm your payment status.', 'network')
  }

  if (!response.ok) {
    throw await readError(response, 'Could not confirm your payment status.')
  }

  return (await response.json()) as StatusResponse
}