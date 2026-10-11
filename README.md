# preyone-ruijie-captive-portal

A Node.js + TypeScript captive portal app for Ruijie WiFi onboarding, backed by PostgreSQL.

It serves a signup page, validates user input, optionally applies voucher-based session durations, stores sessions/logs in Postgres, and returns a redirect URL for successful captive portal flow completion.

## Features

- Public captive portal signup form (`public/index.html` + `public/js/portal.js`)
- API endpoint for signup with validation and rate limiting
- Voucher support (duration, max uses, expiration)
- Session token generation and expiry tracking
- Admin API to inspect users/access logs and manage vouchers
- Captive portal probe routes for common OS connectivity checks
- Express security middleware (`helmet`, compression, input validation)

## Tech Stack

- Node.js
- TypeScript
- Express
- PostgreSQL (`pg`)

## Project Structure

- `src/index.ts` - server bootstrap, middleware, static hosting, routes
- `src/routes/auth.ts` - public auth/signup/status endpoints
- `src/routes/admin.ts` - API key protected admin endpoints
- `src/db/pool.ts` - Postgres connection pool
- `src/db/migrate.ts` - SQL schema bootstrap migration
- `public/` - captive portal frontend and static pages

## Prerequisites

- Node.js 18+ (Node.js 20 recommended)
- npm 9+
- PostgreSQL 13+ (with `gen_random_uuid()` available)

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```env
PORT=3000
NODE_ENV=production
BASE_URL=https://wifi.preyone.com

DB_HOST=localhost
DB_PORT=5432
DB_NAME=captive_portal
DB_USER=postgres
DB_PASSWORD=your_password

DEFAULT_SESSION_MIN=60
SESSION_CLEANUP_INTERVAL_MIN=15
ENABLE_SESSION_CLEANUP=true

ACCESS_LOG_CLEANUP_INTERVAL_MIN=60
ACCESS_LOG_RETENTION_DAYS=30
ENABLE_ACCESS_LOG_CLEANUP=true

RUIJIE_SUCCESS_URL=/success.html
RUIJIE_PASSWORD=PreyoneNetAccess

JWT_SECRET=generate-a-strong-random-secret

PESEPAY_INTEGRATION_KEY=
# Shared AES key: exactly 16, 24 or 32 bytes. First 16 chars are the IV.
PESEPAY_ENCRYPTION_KEY=
```

### Key Variables

- `JWT_SECRET` — **required** in production. Used for admin JWT tokens and payment status tokens. Generate with `openssl rand -hex 48`.
- `NODE_ENV` — set to `production` for production deployment.
- `BASE_URL` — the public-facing URL of the captive portal (used to build the Pesepay `resultUrl` and `returnUrl`).
- `RUIJIE_SUCCESS_URL` — where users are redirected after signup. Defaults to `/success.html`.
- `PESEPAY_INTEGRATION_KEY` / `PESEPAY_ENCRYPTION_KEY` — leave blank to disable online payments entirely; `/api/payments/initiate` then returns `422`.

### How the payment flow works

> Full operational reference (API quirks, payload shape, reconciliation, troubleshooting):
> **`docs/PESEPAY-INTEGRATION.md`**

1. `POST /api/payments/initiate` validates the package and phone, creates a `pending`
   payment with a `merchant_reference` (`PREY-…`) and a 32-byte `webhook_token`, and
   calls Pesepay's `make-payment` endpoint. The request payload is AES-CBC encrypted
   with `PESEPAY_ENCRYPTION_KEY`.
2. This is a **seamless EcoCash** transaction: the push goes straight to the customer's
   phone — there is **no hosted page to redirect to** (`pollUrl` is a JSON status
   endpoint, not a page). The modal tells the customer to approve on their phone and
   polls `GET /api/payments/status/:id` in place.
3. Completion happens via up to three redundant paths, all minting through one guarded
   `completePayment()`: Pesepay's webhook POST to `resultUrl`
   (`BASE_URL/api/payments/webhook`), the legacy `returnUrl` flow
   (`BASE_URL/api/payments/return`), and the `/status` poll which reconciles pending
   payments directly against the gateway (`check-payment`).

### How Pesepay callbacks are authenticated

Pesepay encrypts the callback payload with the shared `PESEPAY_ENCRYPTION_KEY`, so a
payload that decrypts cleanly **is** from Pesepay. That decryption is the primary
authentication step; an undecryptable payload is rejected with `400` before any
database lookup.

A per-payment 32-byte token is also embedded in the `resultUrl` handed to Pesepay and
verified whenever Pesepay echoes it back. It is deliberately **not** mandatory: an
earlier implementation required an out-of-band credential and rejected every genuine
callback (24 retries on 2026-09-22, all `401`), leaving customers charged with no
voucher issued. The token is only an additional check, because rejecting callbacks is
strictly worse than accepting a forged one we can decrypt.

## Installation

### Backend

```bash
npm install
```

### Admin SPA

```bash
cd admin
npm install
cd ..
```

## Database Setup and Migration

Make sure the database in `DB_NAME` exists and credentials are correct, then run:

```bash
npm run migrate
```

This creates all required tables (users, vouchers, payments, admin_users, etc.) and seeds default packages, AP devices, and alerts.

## Running the App

### Development

```bash
npm run dev
```

### Production Build

```bash
# 1. Build the backend
npm run build

# 2. Build the admin SPA
cd admin && npm run build && cd ..

# 3. Start
npm start
```

Server listens on `http://0.0.0.0:3000` by default.

### Subdomain Routing

| Domain | Serves |
|--------|--------|
| `preyone.com` / `www.preyone.com` | Marketing site (`site/`) |
| `wifi.preyone.com` | Captive portal (`public/`) |
| `admin.preyone.com` | Admin console SPA (`admin/dist/`) |

A reverse proxy (nginx/Caddy) must route these domains to `127.0.0.1:3000` with SSL termination.

## Admin Console

The React SPA admin console is served at `admin.preyone.com`. It provides a full dashboard, voucher management, staff sales, Excel exports, AP monitoring, and more.

## API Reference

### Auth Routes

Base path: `/api/auth`

#### `POST /signup`

Creates a portal session and returns redirect information.

Request body:

```json
{
  "fullName": "Jane Doe",
  "phone": "+123456789",
  "voucherCode": "FREE60",
  "acceptedTos": true
}
```

- `voucherCode` is optional; a default session duration is applied if no voucher is used.

Optional query params are forwarded from captive portal context (e.g. `mac`, `ip`, `url`).

Success response:

```json
{
  "success": true,
  "sessionToken": "uuid",
  "sessionExpiresAt": "2026-05-06T10:30:00.000Z",
  "redirectUrl": "/success.html"
}
```

Validation or voucher errors return `4xx` with `error` or `errors`.

#### `GET /status?token=<sessionToken>`

Checks whether a session is still active.

### Admin Routes

Base path: `/api/admin`  
Auth: Bearer JWT token (obtained via `/api/admin/auth/login`)

#### `GET /users`

Returns latest users (up to 500).

#### `GET /access-log`

Returns recent access log entries (up to 1000).

#### `POST /vouchers`

Creates a voucher.

Request body:

```json
{
  "code": "FREE60",
  "durationMin": 60,
  "maxUses": 1,
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

#### `GET /vouchers`

Lists all vouchers.

## Captive Portal Probe Endpoints

To support OS captive portal checks:

- `GET /generate_204` -> `204`
- `GET /hotspot-detect.html` -> redirect `/`
- `GET /ncsi.txt` -> `Microsoft NCSI`
- `GET /connecttest.txt` -> `Microsoft Connect Test`

## Frontend Flow

The client script in `public/js/portal.js`:

1. Validates required fields.
2. Sends POST to `/api/auth/signup` with query params preserved.
3. Displays API validation errors inline.
4. Redirects to `redirectUrl` and appends `expires` query param when available.

## Testing

```bash
npm test
```

Tests use [Vitest](https://vitest.dev/) — 14 test suites, 153 tests covering auth, payments, admin, redirect logic, session cleanup, and more.

For manual validation:

1. Build check: `npm run build`
2. Database migration: `npm run migrate`
3. Open `http://localhost:3000` and submit signup form
4. Test admin API with Postman/curl using a JWT token

## Troubleshooting

- `tsc is not recognized`
  - Run `npm install` first.
- Database connection errors
  - Verify `.env` values and Postgres availability.
- Unauthorized admin requests
  - Confirm `ADMIN_API_KEY` and `x-admin-key` header match.
- Voucher rejected
  - Check code spelling/case, max uses, and expiration time.

## Security Notes

- Keep `ADMIN_API_KEY` secret.
- Use HTTPS in production.
- Restrict DB/network access to trusted hosts.
- Consider stronger auth for admin endpoints if exposed publicly.

## License

No license file is currently included. Add a `LICENSE` file if you want explicit usage terms.
