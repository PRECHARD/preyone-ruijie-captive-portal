# Preyone Transit Staff Portal (`transit.preyone.com`)

Phase 0 + 1 of the staff self-service rollout. No Flutter/APK change is needed —
the installed v27 app keeps working exactly as before.

## What it does

- Staff sign in with their **transit app username + password** (not admin credentials).
- Staff can set/reset their password from the web, add an email, update profile,
  and view their own devices, shifts, trips, sales and trip manifests.
- One-time setup links are emailed via the existing Brevo/SMTP relay.
- The existing app’s **Forgot Password / PIN?** dialog also works for transit staff
  because `/api/auth/request-password-reset` now falls back to `transit_users`.

## Danger boundaries

- `transit.preyone.com` serves `transit/dist` — a separate bundle with its own
  `localStorage` token. It never uses `admin_users` cookies or admin JWTs.
- Portal endpoints use the **session** JWT from `/api/transit/auth/login`
  (`type: 'session'`). They deliberately cannot call device-bound app endpoints.
- Operator/admin management remains at `admin.preyone.com`. This portal is read-only
  for operations; it cannot change `min_app_version`, disable devices or edit trips.

## Database changes

`npm run migrate` adds to `transit_users`:

- `email TEXT NOT NULL DEFAULT ''` (nullable in practice; blank = unset)
- `password_setup_token TEXT`
- `password_setup_expires_at TIMESTAMPTZ`
- unique index on `(company_id, lower(email)) WHERE email != ''`

Existing Fleet-created staff are unaffected. They can add an email after their
first portal login and request setup links from then on.

## API

Public (rate-limited):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/transit/portal/auth/request-setup` | Send a one-time setup link by email |
| GET | `/api/transit/portal/auth/verify-setup?token=` | Validate a link before showing the form |
| POST | `/api/transit/portal/auth/set-password` | Consume the link and set a strong password |

Staff session (`Authorization: Bearer <sessionToken>`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/transit/portal/me` | Profile + company |
| PATCH | `/api/transit/portal/me` | Update name, phone, email |
| POST | `/api/transit/portal/me/change-password` | Change with current password |
| GET | `/api/transit/portal/devices` | Bound device + offline authorisation status |
| GET | `/api/transit/portal/shifts` | Own shifts |
| GET | `/api/transit/portal/trips` | Own trips |
| GET | `/api/transit/portal/sales` | Own ticket/revenue totals |
| GET | `/api/transit/portal/manifest/:tripNo` | Own trip tickets, blank names → `N/A` |

## Deploy

1. Point DNS `transit.preyone.com` → `158.220.118.91`.
2. Add an nginx vhost mirroring the Starlink/POS vhosts: proxy all traffic to
   `http://127.0.0.1:5000`, then issue TLS with Certbot.
3. Deploy the repo including `transit/dist` (see `AGENTS.md` deploy checklist).
4. Run `npm run migrate` **before** `pm2 restart preyone-portal --update-env`.
5. Optional: set `TRANSIT_PORTAL_URL` in `.env` (defaults to
   `https://transit.preyone.com`) if the public base URL differs.

Smoke test:

```bash
curl -I https://transit.preyone.com/
curl -s https://transit.preyone.com/api/transit/portal/auth/verify-setup?token=bogus
# expected: 400 {"error":"Invalid or expired setup link."}
```

## Tests

```bash
npm run build                       # server tsc
npx vitest run tests/transitPortal.test.ts
cd transit && npm run build          # SPA tsc + vite
```
