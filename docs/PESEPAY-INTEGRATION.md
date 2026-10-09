# Pesepay EcoCash Integration — Full Technical Reference

Operational, integration, and troubleshooting documentation for the Preyone UltraNet
captive portal's online payments. Covers everything learned while replacing ContiPay
with Pesepay through to the live, working seamless EcoCash flow.

**Status: WORKING — deployed and verified live on `wifi.preyone.com`**

> Secrets (integration key, encryption key, JWT secret) live only in
> `/opt/preyone-portal/.env` on the VPS (mode 600). Nothing in this document or the
> repo contains those values — never print them, never commit them.

---

## 1. Overview

Customers on the Preyone WiFi buy voucher packages online with EcoCash. Payment runs
through **Pesepay** (payment gateway) end-to-end, and the portal auto-mints the
voucher when the gateway confirms success.

- Portal: `https://wifi.preyone.com`
- Gateway API: `https://api.pesepay.com/api/payments-engine`
- Flow type: **Seamless EcoCash** — the push goes straight to the customer's phone;
  there is **no hosted payment page**.
- Backend package tier prices are all USD.

```
Customer phone → Ruijie AP → EG105G-P gateway → VPS (158.220.118.91:5000 via nginx)
                                                        │
                              Portal POST /initiate ──────┤
                              Pesepay make-payment ───────┼────→ api.pesepay.com
                              (AES-encrypted payload)     │
                                                        ◄┤
                           push to phone (EcoCash PIN)   │  ← customer approves on phone
                              webhook POST /webhook ─────┤  ← Pesepay calls resultUrl
                              portal polls /status ──────┤  ← fallback heartbeat
                              success → voucher minted   │
```

---

## 2. Configuration (`.env`)

| Variable | Required | Purpose |
|----------|----------|---------|
| `PESEPAY_INTEGRATION_KEY` | Yes | Authorization header for all Pesepay API calls (fallback: `PESEPAY_API_KEY`) |
| `PESEPAY_ENCRYPTION_KEY` | Yes | Shared AES key for encrypting requests / decrypting responses. Exactly 16/24/32 bytes; **first 16 chars are the IV** |
| `BASE_URL` | Yes | Public portal URL; used to build `resultUrl` (webhook) and `returnUrl` |
| `JWT_SECRET` | Yes | Signs the payment `statusToken` used by `/api/payments/status` |
| `PESEPAY_BASE_URL` | No | Override the v2 make-payment endpoint |
| `PESEPAY_CHECK_URL` | No | Override the v1 check-payment base URL |
| `PESEPAY_ECOCASH_METHOD_CODE` | No | Emergency override for the EcoCash method code (e.g. `PZW211`) |

If the two required Pesepay keys are absent, `isPesepayConfigured()` returns false and
`POST /api/payments/initiate` answers `422` ("Online payments are not configured…") **in
every environment** — there is deliberately no mock/offline mode that could request real
money with no real payment behind it.

---

## 3. Key Files

| File | Responsibility |
|------|----------------|
| `src/services/pesepayService.ts` | All Pesepay HTTP calls (`make-payment`, `check-payment`), AES encrypt/decrypt, currency/method resolution, amount normalization, friendly error mapping |
| `src/utils/lenientHttp.ts` | Custom HTTP/1.1 client that survives Pesepay's malformed headers (see §6) |
| `src/routes/payments.ts` | `/initiate`, `/webhook`, `/return`, `/status/:id`; `completePayment()` (voucher mint), reconciliation logic |
| `public/js/portal.js` | Payment modal: collects phone, initiates, then **polls `/status` in place** |
| `public/index.html` | Hardcoded package cards (prices + `data-amount`) |
| `src/db/migrate.ts` | Schema + package seed (tier prices) |
| `tests/payments.test.ts` | Route tests incl. reconciliation & normalization |
| `tests/pesepayService.test.ts` | Service tests incl. encrypted-payload shape |
| `tests/lenientHttp.test.ts` | Parser tests incl. the real Pesepay malformed-HSTS fixture |

---

## 4. The Customer Payment Flow (as it works today)

1. Customer taps **Buy now** on a package card. The modal (`portal.js`) asks for a
   Zimbabwe mobile number.
2. `POST /api/payments/initiate` body `{ tier, phone, fullName? }`:
   - Normalizes phone to E.164 (`2637…`).
   - Loads the package, **normalizes the amount** (any price `< 1` → `1.00`).
   - Creates/loads the user, INSERTs a `pending` payment row storing the same
     normalized amount + a `merchant_reference` (`PREY-<16 hex>`) + a 32-byte
     `webhook_token`.
   - Calls Pesepay `v2 make-payment` with an AES-encrypted payload.
   - On success stores `pesepay_reference` + `pesepay_poll_url`, returns
     `{ paymentId, reference, pesepayReference, pesepayPollUrl, status, statusToken, amount, phone, message }`.
3. **There is NO redirect.** The response's `pollUrl` is a JSON status endpoint — the
   modal hides the form and shows *"A payment request has been sent to your phone.
   Approve it with your EcoCash PIN."*, then polls `/api/payments/status/:id` every 3 s
   (max 300 attempts ≈ 15 min) using the signed `statusToken`.
4. `/status` reads the DB row. If the row is `pending` and has a `pesepay_reference`
   it **reconciles against the gateway** (throttled, §8):
   - Gateway `SUCCESS` → voucher minted, row `completed` → modal displays the voucher code.
   - Gateway `FAILED`/`REFUNDED` → row updated → modal shows *"Your payment was
     declined. Check your balance and try again."*
   - Unknown reference / still waiting → stays `pending`, keeps polling.
5. Failure is additionally notified by **EcoCash's own SMS** to the phone (authoritative
   reason, incl. insufficient funds). Our modal message is deliberately generic.

### Response-shaped helpers the frontend relies on
- `status` values seen by `portal.js`: `completed` (shows `voucherCode`),
  `failed` (shows decline message), anything else keeps polling.
- Auth for `/status/:id`: `Authorization: Bearer <statusToken>` or `?token=`.

---

## 5. Pesepay API Facts (learned from live discovery, not docs)

These are merchant-specific values discovered by probing the live API:

| Thing | Value / behaviour | Endpoint used to discover |
|-------|-------------------|--------------------------|
| Active currencies | `ZiG` and `USD` (USD is default) | `GET /api/payments-engine/v1/currencies/active` |
| Legacy currency `ZWG` | **Rejected**: "Currency record was not found for the provided code" | — |
| Native currency code | `ZiG` (mixed case). `normalizePesepayCurrency('ZWG') → 'ZiG'` | — |
| EcoCash USD | code `PZW211`, min **1.00**, max 500 | `GET /api/payments-engine/v1/payment-methods/for-currency?currencyCode=USD` |
| EcoCash ZiG | code `PZW201`, min **2.00**, max 8000 | same endpoint with `ZiG` |
| Legacy method `ECOCASH` | **Rejected** — misleads as *"Can not perform transaction of the specified amount in the specified currency"* | — |
| Reference format | e.g. `20260930145327240-F53457F6` | `make-payment` response |
| Statuses | Strings like `PROCESSING`, `SUCCESS`, `FAILED` | `check-payment` decrypted payload |

`verifyPaymentStatus` uses `GET /api/payments-engine/v1/payments/check-payment?referenceNumber=<enc>` with header `authorization: <integration key>`. It returns `{ status, amount?, currency?, found }` where:
- HTTP **404** → `{ status: 'not_found', found: false }` (Pesepay puts the literal string `"404"` in the body `status` field — that branch prevents it being read as a real status).
- Not-found is **not** treated as failure; payments can take a moment to appear at the gateway.

---

## 6. The Transport Quirk: malformed HSTS header (was the original customer-facing bug)

Pesepay's nginx serves responses with a **malformed HTTP header**:

```
Strict-Transport-Security: max-age=31536000;
 includeSubDomains
```

The continuation starts with a bare LF (obs-fold without CRLF). How different clients behave:

| Client | Result |
|--------|--------|
| `curl` | Tolerates it (lenient) → **worked** |
| `axios` / Node `undici` (`fetch`) / `https.Agent({ insecureHTTPParser: true })` | Throw `HPE_CR_EXPECTED` → **"Parse Error: Missing expected CR after header value"** |
| `src/utils/lenientHttp.ts` | Explicitly handles obs-fold → **works** |

That HPE error surfaced to customers as *"Payment service error: Parse Error:
Missing expected CR after header value"* — it looked like Pesepay being down, but the
real cause was our strict HTTP parser. Verified by saving raw bytes from the socket and
inspecting with `od`.

### `lenientHttp.ts` design
- Plain `node:tls` client (TLS + cert validation ON), talks HTTP/1.1 directly.
- Sends `Connection: close`; reads response until EOF.
- Header parsing rejoins obs-fold lines; handles chunked encoding and
  `content-length` truncation; caps response at 1 MB.
- Returns `{ status, headers, body, json }` where `json` is `JSON.parse(body)` best-effort.
- `parseHttpResponse(bytes, statusCode, statusMessage)` is exported for unit tests —
  the test suite has a fixture of the real Pesepay malformed response.
- NOTE: check-payment's JSON payload line is huge (~2000+ chars); the lenient parser
  must not split it.

---

## 7. The Payload Shape: the HTTP 500 root cause (was the second blocker)

Pesepay `v2 make-payment` returned **HTTP 500 `{"message":null,"status":"500"}`** for our
correctly-configured requests. Root cause found by comparing against the official SDK
(`pesepay-js@1.0.13`, extracted locally — `models/payment.d.ts`):

Legacy SDK `< 1.0` sent `customer.phone` and **no** `paymentMethodRequiredFields`.
v2 requires:

```jsonc
{
  "currencyCode": "USD",
  "paymentMethodCode": "PZW211",
  "customer": {
    "email": "…",
    "phoneNumber": "263771327202",      // NOT "phone"
    "name": "…"
  },
  "paymentMethodRequiredFields": {       // REQUIRED for EcoCash
    "customerPhoneNumber": "263771327202"
  },
  "amountDetails": { "amount": 1.00, "currencyCode": "USD" },
  "reasonForPayment": "…",
  "returnUrl": "…",
  "resultUrl": "…",
  "merchantReference": "PREY-…"
}
```

Missing `phoneNumber` / `paymentMethodRequiredFields` makes Pesepay's backend throw a
bare 500 with a null message. The official SDK's *seamless* payment also overrides
`resultUrl` to `https://pesepay.com/` ("not needed for seamless"). **We keep our own
`resultUrl`** (our webhook) so completion can also arrive by callback; the `/status`
poll is the safety net.

Every request is AES-CBC encrypted: key = `PESEPAY_ENCRYPTION_KEY`, IV = its first 16
chars, PKCS7 padding (`encryptPayload` / `decryptResponse`). Decryption that yields
empty/null is treated as "not from Pesepay".

---

## 8. Reconciliation: the three completion paths

Pesepay's result callback is **not retried** (documented by Pesepay) — a payment can be
settled while no webhook ever arrives. The customer must never be charged without a
voucher, so completion is achieved via three redundant paths, all routed through the
single `completePayment()` mint (see §9):

| Path | Trigger | Notes |
|------|---------|-------|
| **Webhook** `POST /api/payments/webhook` | Pesepay calls `resultUrl` on result | Fast path. Looks up by `merchantReference` in the decrypted payload. Validates amount matches the stored payment. `?token=` is verified only **if present** (echoed by Pesepay) — deliberately not mandatory (§11). |
| **/return** `GET /api/payments/return?ref=PREY-…` | Customer's browser returns from Pesepay's hosted page | Legacy redirect flow's landing. Mirrors the same reconcile logic; redirects the browser to `/?pay=…&tok=…` with a freshly-minted status token. In the seamless flow customers never hit it. |
| **/status poll** `GET /api/payments/status/:id?token=…` | Portal heartbeat after initiate | The reliable fallback (seamless flow has no page to return to). Reconciles pending rows against the gateway (see below), then returns the fresh status. |

### /status reconciliation rules
- Runs **only** when the DB row is `pending` **and** has a `pesepay_reference`.
- **Throttled**: minimum 10 s gap per payment (`RECONCILE_GAP_MS`, in-memory `Map`),
  one in-flight check per payment at a time (`Set`). Client polls every 3 s, so this
  keeps Pesepay traffic to ~1 check/10 s per live payment.
- `check.found && state === 'completed'` → `completePayment()` mints.
- `check.found && (failed|refunded)` → row updated to failed/refunded.
- `!found` → stays pending (may just not have appeared yet).
- A fresh SELECT re-reads the row after reconciling so the response reflects reality.

### The load-bearing `found` flag
`check.found` **gates every mint**. A reference Pesepay doesn't recognise can carry any
status string; it must never produce a voucher. Removing that gate makes the
reconciliation test suite fail — treat it as sacred.

---

## 9. `completePayment()` — the single voucher mint

- Runs one PostgreSQL transaction with `SELECT … FOR UPDATE` row lock **before** minting.
- **Double-mint guard**: if the row is already `completed` when the lock is acquired
  (concurrent webhook + poll), it returns the existing `voucher_code` instead of minting.
- Mints the voucher using the **payment's own `amount`** (what was actually charged),
  not the package's catalogue price (a 0.99 package billed at 1.00 mints a 1.00 voucher).
- Closes the payment (`completed`, `completed_at`, `voucher_code`) and records a row in
  `transactions`.
- Voucher codes are `CT-` + base32-ish (no 0/1/O/I) for easy dictation.

---

## 10. Amount normalization: 0.99 → 1.00

EcoCash settles in **whole dollars** (USD method minimum 1.00). A sub-dollar price like
PreLite's 0.99 could never be paid, so the backend charges a flat **1.00**:

- `normalizePaymentAmount(n)`: `n < 1 → 1`, otherwise rounds to 2 dp. `9.99` stays `9.99`.
- Applied in **two** places so everything agrees:
  1. `/initiate` route before storing `payments.amount` (DB row = actual charge).
  2. `initiateEcoCashPayment` before the pre-flight check and the encrypted request.
- Why the DB row must store 1.00 too: the webhook **amount-match check** compares the
  callback amount to `payments.amount`. A row kept at 0.99 would reject a legitimate
  1.00 callback.
- Also done in the data layer: `packages.price_amount` updated to `1.00`
  (`UPDATE packages SET price_amount = 1.00 WHERE price_amount < 1`), seed in
  `migrate.ts` updated for fresh installs, and the portal card (`public/index.html`)
  shows `$1.00` / `data-amount="1.00"`.

---

## 11. Webhook & token security

- **Primary auth = AES decryption.** A payload that doesn't decrypt cleanly was not
  produced by Pesepay holding our key → rejected with `400` before any lookup.
- `merchantReference` inside the decrypted payload is the lookup key.
- **Per-payment `webhook_token`** (32 random bytes) is appended to `resultUrl`; when
  Pesepay echoes it back it must match the payment's stored token (defense in depth
  against replayed/encrypted payloads).
- It is deliberately **not mandatory**: an earlier implementation made it mandatory and
  rejected every genuine callback (24 × `401` on 2026-09-22), leaving customers charged
  with no voucher. Rejecting real callbacks is worse than accepting a forged one.
- `/status/:id` requires the signed status JWT (`Bearer` or `?token=`), preventing
  payment-ID enumeration; the JWT embeds the payment id and must match.

---

## 12. Phone number handling (verified live)

- Input formats accepted client-side: `0…` and `263…` and `+263…`, with spaces/dashes
  stripped (`portal.js:190`).
- `normalizeZwPhone` → E.164 `2637…` (strips `+`, `00`); `isValidZwPhone` → `/^2637\d{8}$/`.
- The E.164 value is stored (`payments.phone_number`), used for the user lookup, and sent
  to Pesepay in both `customer.phoneNumber` and
  `paymentMethodRequiredFields.customerPhoneNumber`.
- **Live proof**: decrypted probe payloads carried `customer.phoneNumber: "263771327202"`.
- Known edge case (unfixed): a number typed without a leading `0` (e.g. `7 71327202`)
  passes the client regex but is rejected by the server. Cosmetic; the server message is
  clear.

---

## 13. Failure notification

- **Gateway/EcoCash SMS** to the phone is authoritative (includes insufficient-funds
  reason). Nothing in our config controls it.
- **Portal modal** shows *"Your payment was declined. Check your balance and try again."*
  on `status === 'failed'`.
- We deliberately do NOT surface Pesepay's raw `transactionStatusDescription`
  (observed: generic *"Transaction has failed"*). Decision: let real traffic run, inspect
  actual descriptions, then optionally surface a specific "insufficient funds" string.

---

## 14. Error messages: customer vs internal

| Condition | Customer sees | Internal detail |
|-----------|---------------|-----------------|
| Transport/parse failure | "We could not reach the payment provider. Please check your connection and try again." | `detail` logged (e.g. HPE_CR_EXPECTED), never shown |
| HTTP ≥ 400 from Pesepay | `data.message` / `data.error` / "Payment initiation failed" | logged |
| Amount below EcoCash min | "The minimum EcoCash payment in USD is 1.00." | — |
| Amount above max | "The maximum EcoCash payment in USD is 500.00." | — |
| Unsupported currency | "EcoCash is not available in <cur>." | — |
| Missing keys | "Pesepay is not configured on this server." | — |
| Payment failed | "Your payment was declined. Check your balance and try again." | `error_message` = `Gateway reported <STATUS> (status check|callback not received)` |

---

## 15. Testing

```
npm run build      # tsc backend (must be clean)
node --check public/js/portal.js
npx vitest run     # full suite
```

- **400 tests / 28 files** currently (as of the 0.99→1.00 work). Roughly an extra 5–10
  per change.
- Areas covered: encrypted-payload round-trip + tamper detection; currency/method
  resolution incl. the ZiG/ZWG mapping; min/max pre-flight; the **exact v2 payload
  shape** (decrypted in-test: `phoneNumber`, `paymentMethodRequiredFields`); amount
  normalization; reconciliation on `/return` and `/status` (success mint, failed mark,
  not-found stays pending, already-completed never reconciles, the `found` gate); token
  auth; maintenance-mode webhook exemption; lenient-header parser fixture.
- The tests mock `lenientRequest` and `pool`; `completePayment` is exercised through its
  full `BEGIN/SELECT FOR UPDATE/INSERT…/COMMIT` sequence.

---

## 16. Deploying to production

VPS: `deploy@158.220.118.91` (key auth, NOPASSWD sudo), app `/opt/preyone-portal`,
PM2 cluster `preyone-portal` (4 workers) behind nginx → `127.0.0.1:5000`.
Node v24.21.0. PostgreSQL (`preyone-db` container), Redis (`preyone-redis`).

Local checklist:
1. `npm run build` (backend tsc) + `npx vitest run`.
2. If `public/index.html` changed, `node --check public/js/portal.js` etc.
3. `tar -czf deploy-pesepay.tar.gz dist src public/js/portal.js public/index.html package.json package-lock.json`
4. `scp … deploy-pesepay.tar.gz deploy@158.220.118.91:/tmp/pesepay<N>.tar.gz`

On the VPS (run via `nohup setsid bash script … &` — interactive ssh piping times out):
1. Back up: copy `dist`, `src`, `public/js/portal.js`, `public/index.html` into a fresh
   `/opt/preyone-backups/pesepay-<utc>` dir (create with `sudo`).
2. `tar -xzf` in `/opt/preyone-portal`.
3. If `.env` changed: back it up first; never print it.
4. `pm2 restart preyone-portal`; check `pm2 list` (4 × online).
5. Smoke: `curl -I https://wifi.preyone.com` (200), `https://wifi.preyone.com/api/auth/session` (200), live `POST /initiate`.

Verification of a live initiate without charging anyone:
```bash
curl -s -X POST https://wifi.preyone.com/api/payments/initiate \
  -H 'Content-Type: application/json' \
  -d '{"tier":"PreFlow","phone":"0771 327 202"}'
# expect: pesepayReference like 20260930……, status "pending", an amount, a statusToken
```
The reference should be visible via `check-payment` (`transactionStatus` moves from
`PROCESSING` to `FAILED` if never approved / `SUCCESS` if approved). Remember: using a
real number sends a real EcoCash push to it.

Safe probe number: `0770000000` / `263770000000` (won't trigger a payable prompt).

---

## 17. Troubleshooting guide

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Payment service error: Parse Error: Missing expected CR after header value" | Strict HTTP parser chokes on Pesepay's malformed HSTS obs-fold header | Use `lenientHttp`; do NOT reintroduce axios/undici for Pesepay calls |
| "Payment initiation failed" (v2, message null) | Payload shape: `customer.phone` instead of `customer.phoneNumber`, or missing `paymentMethodRequiredFields` | §7 — must be exact SDK shape |
| "Can not perform transaction of the specified amount in the specified currency" | Legacy `ECOCASH` method code (or genuinely out-of-range amount) | Use `PZW211`/`PZW201`; amount within min/max |
| "Currency record was not found for the provided code" | Sent `ZWG` | Send `ZiG` (or `USD`) |
| "The minimum EcoCash payment in USD is 1.00." | Sub-dollar price | Normalization handles 0.99→1.00; only < 1.00 after normalization triggers this |
| Callback 401/403 rejected | Webhook token mismatch | Verify `?token=` matches `webhook_token`; token is optional on purpose |
| Payment stuck `pending` forever | Webhook lost (not retried by Pesepay) + no one polled `/status` | `/status` reconcile now self-heals; customer just keeps the page open |
| `found:false` on check-payment | Reference not yet visible / unknown | Leave pending, don't mint |
| VPS login banned | Fail2Ban on sshd | `fail2ban-client set sshd addignoreip <ip>` |

---

## 18. Open items / decisions on record

1. **Real insufficient-funds string**: not yet observed end-to-end; decision deferred.
   Once real declines occur, inspect `transactionStatusDescription` and optionally map it
   to a specific portal message.
2. **Phone regex edge case**: `7 71327202` (no leading `0`) passes client-side but is
   rejected by the server — cosmetic, unfixed.
3. **Real-money approval test pending**: automated checks stop at "Pesepay accepts the
   payment". The full SUCCESS path (approve push → voucher mints via `/status`) is
   unit-tested; a live approval run (owner's balance, a real $1.00–$9.99 charge) is the
   final confirmation. Be aware the 15:08 GMT test pushed a real request to
   `0771 327 202` (not approved, nothing charged — it FAILED).
4. **Probe cleanup**: Pesepay dashboard contains probe transactions
   (`PROBE-0001`, `DIAG-…`, `V1PROBE-…`, `V2CTRL-…`, `SDKTEST-…`, `P…`, and several
   `PREY-…` rows) — all FAILED/PROCESSING, nothing charged, safe to delete.
5. **Dead nginx line**: `proxy_pass_header x-contipay-signature` is leftover ContiPay
   config — harmless, removable.
6. **Stale pending probe row** `PREY-7862DE7B0E7066AD` (from before recovery code was
   deployed) sits `pending` in the DB — harmless; can be marked failed.

---

## 19. Backup history (production)

Latest first (`/opt/preyone-backups/`):
- `pesepay-20260930-151915` — 0.99→1.00 normalization + package price + card update
- `pesepay-20260930-150824` — /status reconciliation + seamless-flow portal.js
- `pesepay-20260930-145819` — SDK payload shape (phoneNumber / paymentMethodRequiredFields)
- `pesepay-20260930-115712` — lenient HTTP client (pre-seamless)
- `pesepay-20260930-114325`, `pesepay-20260929-120533` — earlier deployments