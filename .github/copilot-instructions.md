# Copilot Instructions

## Architecture

- The main service is an Express/TypeScript backend. `src/index.ts` configures middleware and host-based frontend serving, then mounts API routers from `src/routes/`. PostgreSQL access is through `src/db/pool.ts`; schema changes belong in the migrations run by `npm run migrate`. Reusable business logic and scheduled work live in `src/services/` and `src/jobs/`.
- The same server serves several separate frontends: `public/` is the captive portal (`wifi.preyone.com` and unknown hosts), `site/` builds the marketing SPA, `admin/` builds the admin and Starlink portals, and `pos/` and `app/` are separate SPAs. `bus-ticket-app/` is the Flutter transit app, which uses the transit API.
- Voucher sign-up connects the captive portal to Ruijie gateway authorization and FreeRADIUS. The auth route creates the user/session and WISPr data; `src/utils/redirect.ts` builds the gateway redirect. Payment callbacks also create access through guarded payment-completion logic in the payments service.
- `src/index.ts` depends on route order: API and special routes must remain reachable before host-based static handling and the final SPA fallback. Keep sitemap/robots and gateway helper routes ahead of that fallback.

## Build, test, and lint

Run commands from the indicated project directory:

| Project | Build | Tests | Lint / type check |
|---|---|---|---|
| Backend (repository root) | `npm run build` | `npm test`; one file: `npm test -- tests/auth.test.ts` | No root lint script |
| Backend E2E (requires migrated PostgreSQL) | — | `npm run test:e2e`; one file: `npm run test:e2e -- e2e/route_templates.e2e.test.ts` | — |
| Admin (`admin/`) | `npm run build` | `npm test`; one file: `npm test -- src/path/to/file.test.ts` | `npm run lint` |
| Marketing site (`site/`) | `npm run build` | No test script | `npm run typecheck` |
| POS (`pos/`) | `npm run build` | No test script | TypeScript check is included in the build |
| Gateway app (`app/`) | `npm run build` | No test script | TypeScript check is included in the build |
| Flutter transit app (`bus-ticket-app/`) | `flutter build` (choose the target platform) | `flutter test`; one file: `flutter test test/ticket_numbering_test.dart` | `flutter analyze` |

The root Vitest suite uses `vitest.config.ts` and mocks database access. E2E tests use `vitest.e2e.config.ts`, require the real PostgreSQL schema, and run serially. Run `npm run migrate` before E2E tests when the database schema is not current. CI runs `npm ci`, `npm run build`, and `npm test` on Node 18 and 20.

For a production site image pass, `cd site && npm run optimize` uses Sharp to generate optimized assets.

## Repository-specific conventions

- Treat the voucher redemption flow in `src/routes/auth.ts`, `buildRuijieSuccessUrl()` in `src/utils/redirect.ts`, and the captive portal CSP in `src/index.ts` as production-critical. Do not change their behavior without explicit approval. Gateway context (`client_mac`, `login_url`, `ssid`, `nas_ip`, `nas_mac`, `url`) is read from `req.query`, not the signup body.
- The Ruijie success redirect must go directly to `ext_login`, with `url`, `redirect`, and `next_url` carrying the original destination. The CSP `formAction: ["*"]` is required for form posts to the gateway; restricting it to `'self'` breaks authorization.
- User inserts that target the partial unique email index must retain `ON CONFLICT (email) WHERE email IS NOT NULL AND email != '' DO NOTHING`. A bare conflict target cannot infer the partial index; `tests/partialIndexConflict.test.ts` guards this regression.
- Keep migrations idempotent and run `npm run migrate` before restarting the production service after schema changes. On the production VPS, `DB_HOST` must be `127.0.0.1` (not `localhost`). Never expose or overwrite production `.env` values.
- Host routing and SPA fallbacks can return `index.html` for unknown paths. When changing static serving or deployments, preserve the correct host-to-build mapping and ensure missing bundles/downloads fail explicitly rather than being mistaken for valid assets. Built frontend assets are ignored by Git, so deployment packaging must include the required `dist` outputs.
