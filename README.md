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

Create a `.env` file in the project root:

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=captive_portal
DB_USER=postgres
DB_PASSWORD=postgres

DEFAULT_SESSION_MIN=60
SESSION_CLEANUP_INTERVAL_MIN=15
ENABLE_SESSION_CLEANUP=true
ADMIN_API_KEY=change-me

# Optional: if set, signup success redirects to this URL with ?token=<sessionToken>
RUIJIE_SUCCESS_URL=
```

- `SESSION_CLEANUP_INTERVAL_MIN`: how often the server clears expired sessions, in minutes.
- `ENABLE_SESSION_CLEANUP`: set to `false` to disable automatic cleanup in the server.

### Variable Notes

- `DEFAULT_SESSION_MIN`: fallback session duration (minutes) when no voucher is provided.
- `ADMIN_API_KEY`: required for all `/api/admin/*` requests via the `x-admin-key` header only.
- `RUIJIE_SUCCESS_URL`: optional absolute URL. If omitted, backend uses a safe same-origin `url` query param fallback or `/success.html`.

## Installation

```bash
npm install
```

## Database Setup and Migration

Make sure the database in `DB_NAME` exists and credentials are correct, then run:

```bash
npm run migrate
```

This creates:

- `users`
- `vouchers`
- `access_log`
- supporting indexes

## Running the App

### Development

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

Server starts on:

- `http://0.0.0.0:3000` by default (or `PORT`)

## Admin Console

A simple browser-based admin console is available at `/admin.html`. It uses the `x-admin-key` header to authenticate with the backend and allows you to:

- view vouchers
- create vouchers
- inspect recent user sessions
- inspect the access log

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
Auth: `x-admin-key: <ADMIN_API_KEY>`

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

Tests use [Vitest](https://vitest.dev/) and cover session cleanup, access log cleanup, admin auth middleware, and redirect URL building.

For manual validation:

1. Build check:
   - `npm run build`
2. Database migration:
   - `npm run migrate`
3. Manual flow:
   - Open `/`
   - Submit signup form with valid/invalid payloads
   - Verify redirect behavior and session expiry param
4. API checks (using curl/Postman):
   - `POST /api/auth/signup`
   - `GET /api/auth/status`
   - Admin routes with and without `x-admin-key`

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
