import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Lock,
  Mail,
  Phone,
  Printer,
  Receipt,
  RotateCcw,
  SatelliteDish,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createStarlinkPayment,
  fetchPaymentRails,
  fetchPaymentStatus,
  PaymentError,
  RAIL_LABELS,
  STARLINK_PLANS,
} from '../lib/payments'
import type { CheckoutResponse, PaymentRail, PlanId, RailId } from '../lib/payments'

/* ── Types ─────────────────────────────────────────────────────────────── */

type FieldName = 'accountRef' | 'fullName' | 'email' | 'phone' | 'amount'

type FieldErrors = Partial<Record<FieldName, string>>

type Status = 'idle' | 'submitting' | 'awaiting' | 'checking' | 'success'

type Banner = {
  kind: 'error' | 'info'
  message: string
  /** Declines get retry advice; server faults get a support hint. */
  hint?: string
}

/** Survives a reload so we can still confirm the result, if the browser allows. */
type PendingCheckout = {
  invoiceNumber: string
  invoiceId: string
  referenceNumber: string
  intentId: string
  statusToken: string
  amount: number
  currency: string
  planLabel: string
  accountRef: string
  email: string
  paymentMethod: RailId
  instructions: string | null
}

const PENDING_KEY = 'preyone.pendingStarlinkCheckout'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/** Zimbabwe mobile in international form, e.g. 263771234567. */
const PHONE_RE = /^2637\d{8}$/

const money = (value: number, currency: string) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)

const formatStamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

/** Random key so a retry of the same attempt cannot raise a second invoice. */
function newIdempotencyKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `slp_${random.replace(/[^A-Za-z0-9]/g, '')}`
}

function readPendingCheckout(): PendingCheckout | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as PendingCheckout) : null
  } catch {
    return null
  }
}

function writePendingCheckout(checkout: PendingCheckout | null): void {
  try {
    if (checkout) sessionStorage.setItem(PENDING_KEY, JSON.stringify(checkout))
    else sessionStorage.removeItem(PENDING_KEY)
  } catch {
    // Private-mode browsers reject sessionStorage; polling is then skipped but
    // the payment still completes server-side, so this is not fatal.
  }
}

/* ── Component ─────────────────────────────────────────────────────────── */

export function StarlinkPaymentPortal() {
  /* Form state ---------------------------------------------------------- */
  const [accountRef, setAccountRef] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [planId, setPlanId] = useState<PlanId>('starlink-standard')
  const [amount, setAmount] = useState('480')
  const [railId, setRailId] = useState<RailId>('ecocash')
  const [rails, setRails] = useState<PaymentRail[]>([])

  /* UI state ------------------------------------------------------------ */
  const [errors, setErrors] = useState<FieldErrors>({})
  const [status, setStatus] = useState<Status>('idle')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [result, setResult] = useState<(PendingCheckout & { completedAt?: string }) | null>(null)
  /** The invoice currently being watched for settlement. */
  const [pending, setPending] = useState<PendingCheckout | null>(null)

  /** Held for the lifetime of one attempt so retries reuse the same key. */
  const idempotencyKey = useRef(newIdempotencyKey())

  /** Derived loading flag — every control and the form read this. */
  const isSubmitting = status === 'submitting'
  const isChecking = status === 'checking' || status === 'awaiting'
  const isBusy = isSubmitting || isChecking

  const selectedPlan = useMemo(
    () => STARLINK_PLANS.find((plan) => plan.id === planId) ?? STARLINK_PLANS[0],
    [planId],
  )

  const selectedRail = useMemo(
    () => rails.find((rail) => rail.rail === railId),
    [rails, railId],
  )

  const parsedAmount = Number.parseFloat(amount)
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0

  /** EcoCash and Omari prompt the buyer for an OTP, so a phone is mandatory. */
  const phoneRequired = selectedRail?.requiresPhone ?? true

  /** Rail limits come from the server; only enforce once they have loaded. */
  const railAmountOk =
    amountValid &&
    (!selectedRail || (parsedAmount >= selectedRail.min && parsedAmount <= selectedRail.max))

  /* ── Side effects ──────────────────────────────────────────────────── */

  useEffect(() => {
    let active = true
    void fetchPaymentRails().then((loaded) => {
      if (active && loaded.length > 0) setRails(loaded)
    })
    return () => {
      active = false
    }
  }, [])

  /**
   * Adopt any checkout left in sessionStorage. Covers a page reload or a
   * return from a redirect-style rail, so a settled invoice is still confirmed.
   */
  useEffect(() => {
    const stored = readPendingCheckout()
    if (stored) setPending(stored)
  }, [])

  /**
   * Watch the pending invoice until the gateway settles it.
   *
   * Pesepay's v2 make-payment is seamless — the buyer approves on their own
   * handset — so nothing navigates away and this poll is the whole experience.
   * A transient status outage falls back to an info banner rather than
   * stranding the customer, because the server-side callback still settles the
   * invoice regardless.
   */
  useEffect(() => {
    if (!pending) return

    let cancelled = false
    setStatus('checking')

    const watch = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (cancelled) return
        try {
          const state = await fetchPaymentStatus(pending.intentId, pending.statusToken)
          if (cancelled) return

          if (state.status === 'SUCCESS') {
            writePendingCheckout(null)
            setPending(null)
            setResult({ ...pending, completedAt: state.completedAt })
            setStatus('success')
            return
          }
          if (state.status === 'FAILED') {
            writePendingCheckout(null)
            setPending(null)
            setBanner({
              kind: 'error',
              message: `Payment for invoice ${pending.invoiceNumber} was not completed.`,
              hint: 'No money was taken. You can start a new payment below.',
            })
            setStatus('idle')
            return
          }
        } catch (error) {
          if (cancelled) return
          // 4xx here means the token was rejected or the intent is gone; retrying
          // will not help, so hand back to the customer with the invoice number.
          if (!(error instanceof PaymentError) || error.kind === 'validation') {
            writePendingCheckout(null)
            setPending(null)
            setBanner({
              kind: 'info',
              message: `Invoice ${pending.invoiceNumber} was raised, but we could not confirm the payment automatically.`,
              hint: 'It will settle as soon as the gateway reports back. Quote this invoice number if you contact support.',
            })
            setStatus('idle')
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }

      if (cancelled) return
      setBanner({
        kind: 'info',
        message: `Payment for invoice ${pending.invoiceNumber} is still processing.`,
        hint: 'Mobile wallet approvals can take a few minutes. Your invoice is reserved and will settle automatically.',
      })
      setStatus('idle')
    }

    void watch()
    return () => {
      cancelled = true
    }
  }, [pending])

  /* ── Validation ─────────────────────────────────────────────────────── */

  const validate = (): boolean => {
    const next: FieldErrors = {}

    if (!accountRef.trim()) {
      next.accountRef = 'Enter your account or installation reference'
    }

    if (!fullName.trim()) {
      next.fullName = 'Enter the client full name'
    }

    if (!email.trim()) {
      next.email = 'Enter an email so we can send the receipt'
    } else if (!EMAIL_RE.test(email.trim())) {
      next.email = 'Enter a valid email address'
    }

    if (phoneRequired) {
      if (!phone.trim()) {
        next.phone = `${RAIL_LABELS[railId]} needs your mobile number`
      } else if (!PHONE_RE.test(phone.replace(/\s/g, ''))) {
        next.phone = 'Use the format 263771234567'
      }
    } else if (phone.trim() && !PHONE_RE.test(phone.replace(/\s/g, ''))) {
      next.phone = 'Use the format 263771234567'
    }

    if (!amount.trim()) {
      next.amount = 'Enter the payment amount'
    } else if (!amountValid) {
      next.amount = 'Amount must be greater than zero'
    } else if (!railAmountOk) {
      next.amount = `${RAIL_LABELS[railId]} accepts $${selectedRail?.min} to $${selectedRail?.max}`
    }

    setErrors(next)
    return Object.keys(next).length === 0
  }

  /** Clears a single field error as soon as the customer edits it. */
  const clearError = (field: FieldName) => {
    if (errors[field]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[field]
        return next
      })
    }
  }

  /* ── Handlers ───────────────────────────────────────────────────────── */

  /** Selecting a plan pre-fills the published tariff; `amount: 0` clears it. */
  const handlePlanChange = (nextId: PlanId) => {
    setPlanId(nextId)
    const plan = STARLINK_PLANS.find((p) => p.id === nextId)
    setAmount(plan && plan.amount > 0 ? String(plan.amount) : '')
    clearError('amount')
    setBanner(null)
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (isBusy) return

    setBanner(null)
    if (!validate()) return

    setStatus('submitting')

    try {
      // ── GATEWAY CALL ──────────────────────────────────────────────────
      // Raises a numbered invoice, then opens the gateway payment against it.
      // Swapping provider happens in `src/lib/payments.ts`; nothing below
      // this line knows which gateway is in use.
      const checkout: CheckoutResponse = await createStarlinkPayment({
        accountRef: accountRef.trim(),
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim().replace(/\s/g, ''),
        planId,
        amount: parsedAmount,
        paymentMethod: railId,
        idempotencyKey: idempotencyKey.current,
      })
      // ─────────────────────────────────────────────────────────────────

      const tracked: PendingCheckout = {
        invoiceNumber: checkout.invoiceNumber,
        invoiceId: checkout.invoiceId,
        referenceNumber: checkout.referenceNumber,
        intentId: checkout.intentId,
        statusToken: checkout.statusToken,
        amount: checkout.amount,
        currency: checkout.currency,
        planLabel: checkout.planLabel,
        accountRef: checkout.accountRef,
        email: email.trim().toLowerCase(),
        paymentMethod: railId,
        instructions: checkout.instructions,
      }

      // Persisted so a reload mid-approval still resolves to the same invoice.
      writePendingCheckout(tracked)

      if (checkout.mode === 'redirect' && checkout.redirectUrl) {
        window.location.assign(checkout.redirectUrl)
        return
      }

      // Seamless rail: the buyer is approving on their phone right now, so stay
      // on the page and watch the invoice settle.
      setStatus('awaiting')
      setPending(tracked)
    } catch (err) {
      // Only PaymentError should ever arrive, but never let an unexpected
      // throw leave the button spinning forever.
      const failure =
        err instanceof PaymentError
          ? err
          : new PaymentError('Something went wrong. Please try again.', 'server')

      setBanner({
        kind: 'error',
        message: failure.message,
        hint:
          failure.kind === 'declined'
            ? 'Check the details or try a different payment method.'
            : failure.kind === 'network'
              ? 'Your connection dropped. You can safely try again — you will not be charged twice.'
              : 'If you were charged, quote the invoice number below when contacting support.',
      })
      setStatus('idle')
    }
  }

  const resetForm = () => {
    // A fresh key, so the next attempt is a genuinely new invoice.
    idempotencyKey.current = newIdempotencyKey()
    writePendingCheckout(null)
    setAccountRef('')
    setFullName('')
    setEmail('')
    setPhone('')
    setPlanId('starlink-standard')
    setAmount('480')
    setErrors({})
    setBanner(null)
    setResult(null)
    setPending(null)
    setStatus('idle')
  }

  /* ── Awaiting approval screen (seamless mobile-wallet rails) ──────────── */

  if (pending && status !== 'success') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="glass-strong glow-cyan rounded-3xl p-8 sm:p-12"
      >
        <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
            <Loader2 size={32} className="animate-spin" />
          </div>

          <span className="chip">Awaiting your approval</span>

          <h2 className="mt-5 font-display text-3xl tracking-wide text-white sm:text-4xl">
            Check your {RAIL_LABELS[pending.paymentMethod] ?? 'mobile'} phone
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Invoice{' '}
            <span className="font-mono font-semibold text-cyan-300">{pending.invoiceNumber}</span>{' '}
            for <span className="font-semibold text-cyan-300">{pending.planLabel}</span> has been
            raised for{' '}
            <span className="font-semibold text-cyan-300">{money(pending.amount, pending.currency)}</span>.
            Approve the prompt on your handset to settle it.
          </p>

          {/* Gateway instructions ---------------------------------------- */}
          {pending.instructions && (
            <div className="mt-7 rounded-2xl border border-cyan-400/25 bg-cyan-400/8 px-5 py-4 text-left">
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300/80">
                What to do next
              </p>
              <p className="mt-2 text-sm leading-relaxed text-cyan-50">{pending.instructions}</p>
            </div>
          )}

          <p className="mt-7 text-xs text-slate-500">
            This page updates automatically once your mobile wallet confirms. Please keep it open.
          </p>

          <div className="mt-8 flex justify-center">
            <button type="button" onClick={resetForm} className="btn-ghost px-7 py-3.5 text-sm uppercase">
              <RotateCcw size={16} />
              Cancel and start over
            </button>
          </div>
        </div>
      </motion.div>
    )
  }

  /* ── Confirmation screen ────────────────────────────────────────────── */

  if (status === 'success' && result) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="glass-strong glow-cyan rounded-3xl p-8 sm:p-12"
      >
        <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-400/10 text-emerald-300">
            <CheckCircle2 size={34} />
          </div>

          <span className="chip">Payment received</span>

          <h2 className="mt-5 font-display text-4xl tracking-wide text-white sm:text-5xl">
            Thank you, {result.planLabel}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            Invoice{' '}
            <span className="font-mono font-semibold text-cyan-300">{result.invoiceNumber}</span>{' '}
            has been issued and settled. A copy is on its way to{' '}
            <span className="font-semibold text-cyan-300">{result.email || 'your email'}</span>.
          </p>

          {/* Invoice detail --------------------------------------------------- */}
          <dl className="mt-9 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/5 text-left sm:grid-cols-2">
            <Detail label="Invoice number" value={result.invoiceNumber} mono accent />
            <Detail label="Payment reference" value={result.referenceNumber} mono />
            <Detail label="Service / plan" value={result.planLabel} />
            <Detail label="Account reference" value={result.accountRef} mono />
            <Detail
              label="Amount paid"
              value={money(result.amount, result.currency)}
              accent
            />
            <Detail
              label="Paid via"
              value={RAIL_LABELS[result.paymentMethod] ?? result.paymentMethod}
            />
            <Detail
              label="Paid on"
              value={result.completedAt ? formatStamp(result.completedAt) : 'Just now'}
            />
            <Detail label="Status" value="Paid" />
          </dl>

          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <button type="button" onClick={() => window.print()} className="btn-primary px-7 py-3.5 text-sm uppercase">
              <Printer size={16} />
              Print invoice
            </button>
            <button type="button" onClick={resetForm} className="btn-ghost px-7 py-3.5 text-sm uppercase">
              <RotateCcw size={16} />
              New payment
            </button>
          </div>
        </div>
      </motion.div>
    )
  }

  /* ── Form ───────────────────────────────────────────────────────────── */

  const fieldError = (field: FieldName) =>
    errors[field] ? (
      <span className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-rose-400">
        <AlertTriangle size={12} />
        {errors[field]}
      </span>
    ) : null

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
      {/* ── Form column ──────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-busy={isBusy}
        className="glass mesh-card relative overflow-hidden rounded-3xl p-6 sm:p-9"
      >
        <header className="mb-8">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/8 text-cyan-300">
            <SatelliteDish size={22} />
          </div>
          <h2 className="font-display text-3xl tracking-wide text-white sm:text-4xl">
            Settle your account
          </h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-slate-400">
            Enter your details and we will raise a numbered invoice for you. Pay with your mobile
            wallet and the invoice is settled as soon as the gateway confirms.
          </p>
        </header>

        {/* Error / decline banner --------------------------------------- */}
        <AnimatePresence initial={false}>
          {banner && (
            <motion.div
              key="banner"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              role="alert"
              aria-live="assertive"
              className="overflow-hidden"
            >
              <div
                className={`mb-6 flex gap-3 rounded-2xl border p-4 ${
                  banner.kind === 'info'
                    ? 'border-cyan-400/30 bg-cyan-500/10'
                    : 'border-rose-400/30 bg-rose-500/10'
                }`}
              >
                {banner.kind === 'info' ? (
                  <Receipt size={20} className="mt-0.5 shrink-0 text-cyan-300" />
                ) : (
                  <AlertTriangle size={20} className="mt-0.5 shrink-0 text-rose-400" />
                )}
                <div className="text-sm">
                  <p className={`font-bold ${banner.kind === 'info' ? 'text-cyan-100' : 'text-rose-200'}`}>
                    {banner.message}
                  </p>
                  {banner.hint && <p className="mt-1 text-slate-300/80">{banner.hint}</p>}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 1. Account reference ------------------------------------------ */}
        <div className="mb-5">
          <FieldLabel htmlFor="slp-accountRef" hint="Required">
            Account / Installation Reference
          </FieldLabel>
          <input
            id="slp-accountRef"
            name="accountRef"
            type="text"
            inputMode="text"
            autoComplete="off"
            required
            disabled={isBusy}
            value={accountRef}
            onChange={(e) => {
              setAccountRef(e.target.value)
              clearError('accountRef')
            }}
            placeholder="e.g. INV-20481 or your site address"
            aria-invalid={Boolean(errors.accountRef)}
            className={`input-surface ${errors.accountRef ? 'border-rose-400/60' : ''}`}
          />
          {fieldError('accountRef')}
        </div>

        {/* 2. Client name + 3. Email ------------------------------------- */}
        <div className="mb-5 grid gap-5 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="slp-fullName" hint="Required">
              Client Full Name
            </FieldLabel>
            <input
              id="slp-fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              required
              disabled={isBusy}
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value)
                clearError('fullName')
              }}
              placeholder="Tatenda Moyo"
              aria-invalid={Boolean(errors.fullName)}
              className={`input-surface ${errors.fullName ? 'border-rose-400/60' : ''}`}
            />
            {fieldError('fullName')}
          </div>

          <div>
            <FieldLabel htmlFor="slp-email" hint="Required">
              Email Address
            </FieldLabel>
            <div className="relative">
              <Mail size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                id="slp-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={isBusy}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  clearError('email')
                }}
                placeholder="you@example.com"
                aria-invalid={Boolean(errors.email)}
                className={`input-surface pl-11 ${errors.email ? 'border-rose-400/60' : ''}`}
              />
            </div>
            {fieldError('email')}
          </div>
        </div>

        {/* 4. Mobile number ---------------------------------------------- */}
        <div className="mb-5">
          <FieldLabel htmlFor="slp-phone" hint={phoneRequired ? 'Required' : 'Optional'}>
            Mobile Number
          </FieldLabel>
          <div className="relative">
            <Phone size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              id="slp-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required={phoneRequired}
              disabled={isBusy}
              value={phone}
              onChange={(e) => {
                // Digits and a leading + only — the server wants 2637XXXXXXXX.
                setPhone(e.target.value.replace(/[^0-9+]/g, '').replace(/^\+/, '263'))
                clearError('phone')
              }}
              placeholder="263771234567"
              aria-invalid={Boolean(errors.phone)}
              className={`input-surface pl-11 ${errors.phone ? 'border-rose-400/60' : ''}`}
            />
          </div>
          {fieldError('phone')}
        </div>

        {/* 5. Service / plan --------------------------------------------- */}
        <div className="mb-5">
          <FieldLabel htmlFor="slp-plan" hint="Required">
            Service / Plan
          </FieldLabel>
          <select
            id="slp-plan"
            name="planId"
            required
            disabled={isBusy}
            value={planId}
            onChange={(e) => handlePlanChange(e.target.value as PlanId)}
            className="input-surface appearance-none"
          >
            {STARLINK_PLANS.map((plan) => (
              <option key={plan.id} value={plan.id} className="bg-panel">
                {plan.label}
                {plan.amount > 0 ? ` — $${plan.amount}` : ' — custom amount'}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-slate-500">{selectedPlan.note}</p>
        </div>

        {/* 6. Amount ------------------------------------------------------ */}
        <div className="mb-5">
          <FieldLabel htmlFor="slp-amount" hint={selectedPlan.amount > 0 ? 'Editable' : 'Required'}>
            Payment Amount (USD)
          </FieldLabel>
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-display text-lg text-cyan-300">
              $
            </span>
            <input
              id="slp-amount"
              name="amount"
              type="text"
              inputMode="decimal"
              required
              disabled={isBusy}
              value={amount}
              onChange={(e) => {
                // Digits and one decimal point only — no letters, no negatives.
                const next = e.target.value.replace(/[^0-9.]/g, '')
                setAmount(next)
                clearError('amount')
              }}
              placeholder="480.00"
              aria-invalid={Boolean(errors.amount)}
              className={`input-surface pl-9 font-display text-lg tracking-wide ${errors.amount ? 'border-rose-400/60' : ''}`}
            />
          </div>
          {fieldError('amount')}
        </div>

        {/* 7. Payment method ---------------------------------------------- */}
        <fieldset className="mb-8" disabled={isBusy}>
          <legend className="mb-3 flex w-full items-baseline justify-between gap-2 text-xs font-bold uppercase tracking-wider text-slate-300">
            <span>Payment Method</span>
            <span className="text-[10px] font-semibold tracking-widest text-cyan-400/70">Required</span>
          </legend>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {rails.length === 0
              ? // Placeholder while the server's live rail list loads.
                [0, 1].map((i) => (
                  <div key={i} className="h-[62px] animate-pulse rounded-2xl border border-white/10 bg-white/5" />
                ))
              : rails.map((rail) => {
                  const active = rail.rail === railId
                  return (
                    <label
                      key={rail.rail}
                      className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                        active
                          ? 'border-cyan-400/60 bg-cyan-400/10'
                          : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                      }`}
                    >
                      <input
                        type="radio"
                        name="paymentMethod"
                        value={rail.rail}
                        checked={active}
                        onChange={() => {
                          setRailId(rail.rail)
                          clearError('phone')
                          clearError('amount')
                        }}
                        className="sr-only"
                      />
                      <Smartphone size={17} className={active ? 'text-cyan-300' : 'text-slate-400'} />
                      <span className="flex-1">
                        <span className="block text-sm font-semibold text-white">
                          {RAIL_LABELS[rail.rail] ?? rail.rail}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          ${rail.min} – ${rail.max}
                          {rail.requiresPhone ? ' · OTP to your phone' : ''}
                        </span>
                      </span>
                      {active && <CheckCircle2 size={16} className="text-cyan-300" />}
                    </label>
                  )
                })}
          </div>
        </fieldset>

        {/* Submit ---------------------------------------------------------- */}
        <button
          type="submit"
          disabled={isBusy}
          className="btn-primary w-full px-8 py-4 text-sm uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 sm:w-auto sm:min-w-64"
        >
          {isBusy ? (
            <span className="flex items-center gap-2.5">
              <Loader2 size={16} className="animate-spin" />
              {status === 'checking' ? 'Confirming payment...' : 'Creating invoice...'}
            </span>
          ) : (
            <span className="flex items-center gap-2.5">
              <Lock size={15} />
              Pay {amountValid && railAmountOk ? money(parsedAmount, 'USD') : 'now'}
            </span>
          )}
        </button>

        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs text-slate-500 sm:justify-start">
          <ShieldCheck size={14} className="shrink-0 text-emerald-400" />
          Payments are processed over an encrypted connection. Never share your payment details with
          anyone, including Preyone staff.
        </p>
      </form>

      {/* ── Summary column ───────────────────────────────────────────── */}
      <aside className="glass mesh-card sticky top-28 rounded-3xl p-6">
        <span className="chip">Order summary</span>

        <dl className="mt-6 space-y-4 text-sm">
          <SummaryRow label="Service" value={selectedPlan.label} />
          <SummaryRow label="Client" value={fullName.trim() || '—'} />
          <SummaryRow label="Reference" value={accountRef.trim() || '—'} mono />
          <SummaryRow label="Email" value={email.trim() || '—'} />
          <SummaryRow
            label="Method"
            value={RAIL_LABELS[railId] ?? railId}
          />
        </dl>

        <div className="mt-6 flex items-end justify-between border-t border-white/10 pt-5">
          <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
            Total due
          </span>
          <span
            className={`font-display text-3xl tracking-wide ${amountValid && railAmountOk ? 'text-gradient-cyan' : 'text-slate-600'}`}
          >
            {amountValid && railAmountOk ? money(parsedAmount, 'USD') : '$0.00'}
          </span>
        </div>

        <ul className="mt-6 grid gap-2.5 border-t border-white/10 pt-5 text-xs text-slate-400">
          <li className="flex items-start gap-2">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-cyan-400" />
            Numbered invoice raised instantly
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-cyan-400" />
            Settled the moment the gateway confirms
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-cyan-400" />
            EcoCash, Innbucks, Omari &amp; PayGo
          </li>
        </ul>
      </aside>
    </div>
  )
}

/* ── Local presentational helpers ───────────────────────────────────────── */

type FieldLabelProps = {
  htmlFor: string
  children: string
  hint?: string
}

function FieldLabel({ htmlFor, children, hint }: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-bold uppercase tracking-wider text-slate-300"
    >
      <span>{children}</span>
      {hint && <span className="text-[10px] font-semibold tracking-widest text-cyan-400/70">{hint}</span>}
    </label>
  )
}

type DetailProps = {
  label: string
  value: string
  mono?: boolean
  accent?: boolean
}

function Detail({ label, value, mono, accent }: DetailProps) {
  return (
    <div className="bg-panel-2/70 px-5 py-4">
      <dt className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</dt>
      <dd
        className={`mt-1.5 break-all text-sm font-semibold ${
          accent ? 'font-display text-2xl tracking-wide text-emerald-300' : 'text-slate-100'
        } ${mono ? 'font-mono text-[13px]' : ''}`}
      >
        {value}
      </dd>
    </div>
  )
}

type SummaryRowProps = {
  label: string
  value: string
  mono?: boolean
}

function SummaryRow({ label, value, mono }: SummaryRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs font-bold uppercase tracking-widest text-slate-500">
        {label}
      </dt>
      <dd
        className={`truncate text-right font-semibold text-slate-200 ${mono ? 'font-mono text-[13px]' : ''}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}