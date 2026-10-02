# Preyone Enterprise — Full Project & Architecture Report

_Generated 2026-09-27. Source of truth: the working tree at `preyone-ruijie-captive-portal` + sibling projects below._

## 1. Ecosystem overview

Five code projects + two installed apps that together form Preyone's suite: a backend monolith + 4 web/apps + captive-portal Wi-Fi infrastructure. Everything branded "Preyone" (navy/purple neon theme), one Postgres schema shared by the web apps.

| Project | Location | Stack | Role |
|---|---|---|---|
| **Portal (monolith backend)** | `..\Dev Projects\Web Development Projects\preyone-ruijie-captive-portal` | Node/TS + Express + PostgreSQL + embedded-postgres | ALL APIs, DB, Wi-Fi captive portal, serves every SPA by subdomain |
| **Admin console** | `preyone-ruijie-captive-portal\admin` | React 19 + Vite + Recharts + exceljs/jspdf | Staff management, POS reports, WiFi admin (`admin.preyone.com`) |
| **Web POS** | `preyone-ruijie-captive-portal\pos` | React 19 + Vite + jspdf | Browser till (`pos.preyone.com`), PIN login, offline-capable sales |
| **Native Android POS** | `..\Dev Projects\Web Development Projects\preyone-native-pos` | Kotlin, plain `HttpURLConnection` (no Retrofit), compileSdk 36 | Offline-first till APK (v2.4.3), registers itself to `pos_devices` |
| **Legacy Android WebView POS** | `preyone-desktop\android-pos` | Java WebView | Thin "screen mirror" of desktop POS on LAN (v1.0.0) — being retired |
| **Portal Android admin app (experimental)** | `preyone-ruijie-captive-portal\android` | Kotlin + Compose | Admin dashboards on Android (v1.0.0, debug → `10.0.2.2:3000`, release → `https://admin.preyone.com`) |
| **Desktop POS** (`Preyone POS Desktop`) | `..\Dev Projects\Web Development Projects\preyone-desktop` | Electron 44 + electron-builder | Windowed POS + Invoice; **bundles the whole portal** (`resources/bundle`), embedded backend + Postgres |
| **Standalone Invoice desktop** (`Preyone Enterprise Invoice & Quotation System`) | `preyone-desktop\invoice-launcher` | Electron | Invoice/quotation workstation (reuses :4001 if Desktop POS is running) |
| **Invoice system (web)** | `..\Preyone Branding\...\Invoice Preyone enterprise\Invoice Preyone enterprise\preyone-invoice-system` | React 18 + Vite 5 + express + pg + puppeteer-core | Invoice/quotation document engine, PDF via headless browser |
| **Marketing site** | `preyone-ruijie-captive-portal\site` | static HTML/CSS/JS | `preyone.com` landing page |
| **Enterprise gateway (Phase 1)** | `preyone-ruijie-captive-portal\app` | React 19 + Vite 8, neon theme | `app.preyone.com` — single-login module launcher (POS / Invoice / WiFi / Admin) |
| **Captive portal pages** | `preyone-ruijie-captive-portal\public` | static + JS | `wifi.preyone.com` signup/login/account pages |

## 2. Backend monolith (portal)

**Boot** — `src/index.ts` (206 lines). Express app on `:3000` with helmet/CSP, cors, compression, morgan, cookie parser, rate limiting, JWT auth; `JWT_SECRET` required in production (crash-guard at line 183).

**Subdomain routing (`src/index.ts:98-157`)** — one Node process serves everything:
- `admin.preyone.com` → `admin/dist` (React admin SPA, SPA fallback)
- `app.preyone.com` → `app/dist` (**Enterprise gateway SPA** — Approach B universal tenant gateway; 503 "Gateway build not found" if not built)
- `pos.preyone.com` → `pos/dist` (web POS SPA)
- `wifi.preyone.com` → `public/` captive portal (`/login`, `/account`, `/forgot-password`, `/reset-password` passthrough)
- `preyone.com` / `www` → `site/` marketing
- any IP / unknown host → captive portal (default)

**Captive-portal probes** (`/generate_204`, `/hotspot-detect.html`, `/ncsi.txt`, `/connecttest.txt`, `/wispr`) return WISPr XML so iOS/Android/Windows auto-detect; `gatewayRouter` registered first with `/api/radius/auth`, `/api/radius/acct`, `/ping`, `/auth`, `/portal` for the gateway.

### API route modules (lines each)

| Module | Size | Prefix | Purpose |
|---|---|---|---|
| `routes/auth.ts` | 662 | `/api/auth` | Signup, portal-login, sessions, email verify/password reset, WISPr profile |
| `routes/adminAuth.ts` | 293 | `/api/admin/auth` | Admin signup/login/me/forgot/reset |
| `routes/admin.ts` | **2371** | `/api/admin` | ~110 endpoints (below) |
| `routes/pos.ts` | 994 | `/api/pos` | Tills: PIN auth, shifts, products, customers, checkout, reports, devices |
| `routes/payments.ts` | 498 | `/api/payments` | Pesepay EcoCash initiate/webhook/callback/status |
| `routes/gateway.ts` | 204 | root | RADIUS/ext_login gateway integration |

**Admin surface (groups):** sales & exports (`/my-sales`, `/staff-sales`, Excel + PDF exports per staff), users & roles, dashboard/revenue/charts, time attendance (clock-in/out), staff approval workflow, vouchers (bulk, request-approval, approvals, redemption), cash handovers, customer KPIs, AP devices & health, bandwidth, peak hours, alerts, MAC black/white list, packages CRUD (8 seeded tiers PreLITE→PreEXECUTIVE), QoS view, notifications, settings, audit log, maintenance mode, retention, commissions, broadcasts, kill-sessions, branding, backup, report-schedules, company profile, devices (POS) CRUD + suspend/activate.

**POS surface (`/api/pos`):** `auth/operators`, `auth/pin`, `auth/set-pin` (JWT), `cashiers`, `company` (public profile), `devices/register`, products CRUD + stock, customers CRUD + statements, shifts open/close/current, documents, checkout (with payments array), document payments, void (manager), `reports/summary`, `reports/sales`.

**Middleware:** `adminAuth` (JWT+cookie), `errorHandler`, `maintenanceMode`. Services: `ruijieService`, `pesepayService`, `notificationService`, `sessionCleanup`, `accessLogCleanup`, `voucherPngRenderer`; utils `wisprTransformer`, `redirect` (Ruijie success URL — **DO NOT modify**, per AGENTS.md).

### Database — 35 tables (`src/db/migrate.ts`)

WiFi side: `packages`, `users`, `vouchers`, `payments`, `wispr_profiles`, `access_log`, `voucher_redemptions`, `admin_users`, `transactions`, `settings`, `admin_audit_log`, `sales`, `staff_time_logs`, `ap_devices`, `alerts`, `mac_blacklist`, `mac_whitelist`, `ap_bandwidth_snapshots`, `gateway_heartbeats`, `voucher_approvals`, `cash_handovers`, `retention_policies`, `staff_commissions`, `broadcast_notifications`, `branding`, `backup_logs`, `report_schedules`.

POS side: `pos_products`, `pos_customers`, `pos_shifts`, `pos_documents`, `pos_document_items`, `pos_document_payments`, `companies` (branding singleton for receipts), `pos_devices` (`device_type` desktop|web|android, `company_id`, `server_url`, `status`, `last_seen`).

**Postgres pools:** production via `DB_*` env; local demo via embedded `embedded-postgres` (port **5433**, data in `.pgdata-dev`, DB `preyone_pos`). Dev launcher `scripts/dev-pos.mjs` seeds demo stock + till user **PIN 1234**.

## 3. Admin console (React SPA)

- React 19 + react-router 7 + recharts + exceljs + jspdf + xlsx; Vite dev proxy `/api` → `localhost:3000`.
- ~30 pages: Dashboard, PosSales, PosReports, PosInventory, PosCustomers, Devices (POS), CompanyProfile, MySales, StaffManagement, TimeAttendance, AdminUsers, Vouchers, Packages, Sessions, Users, AccessLog, Alerts, ApDevices, ApHealth, Bandwidth, PeakHours, MacMgmt, AuditLog, Backup, Broadcasts, Reports, Settings, Login.
- **Workspace switcher** (recent work): top-nav `.workspace-switch` toggles "Preyone POS" vs "Preyone UltraNet WiFi" sidebar groups; future review UI.
- **Branding** (recent): `src/utils/companyBrand.ts` (DB-driven), `exportExcel.ts` (exceljs neon theme), `exportPdf.ts` (company header/footer), palette DPB `FF2D1B69` / NP `FFA855F7` / RD `FFB91C1C`, nav brand = `preyonenoneglow-logo-zoom.png` (64px), WiFi tab = `favicon.svg` glow mark.

## 4. Web POS (`pos/`)

- React 19, `src/api.ts` (`fetch('/api/pos'...)` — same-origin; Vite proxies to :3000 in dev; served by portal in prod), jspdf for PDF receipts.
- Components: `Terminal`, `CheckoutModal`, `PinLogin`, `ShiftGate`, `StockManager`, `HistoryView`, `ReceiptModal`, `XReportModal`; `utils/receiptPdf.ts`.
- Features: PIN login, shift open/close with float & variance, product grid + stock management, multi-payment checkout (Cash/EcoCash/Other), X-report, history.

## 5. Native Android POS (`preyone-native-pos`)

- Kotlin, no external HTTP lib (raw `HttpURLConnection` via `Api.kt`, 15 s timeout, 4-thread pool); SharedPreferences store `server_url` (default `http://192.168.110.94:3000`), JWT, user, cached company JSON.
- Screens: `SplashActivity` → `ConfigActivity` (set server URL) → `LoginActivity` (PIN) → `MainActivity`; receipt rendering split into `ThermalReceiptRenderer` (XPrinter) + `DigitalReceiptRenderer` + `ReceiptActions` (share/save/print via FileProvider).
- Release v2.4.3 (`versionCode 10`), minSdk 26 / target 36, signed with `preyone-release.jks` (in `preyone-desktop/android-pos`, passwords `preyone123`). APKs under `release/` (2.0.0 → 2.4.3); also `app/build/outputs`.

## 6. Legacy Android WebView POS (`preyone-desktop\android-pos`)

- Single `MainActivity.java`: WebView with settings sheet, default `http://192.168.120.7:4000`, user-editable. Pure mirror of desktop-hosted POS UI. **LAN-dependent, being retired** in favor of native-pos.

## 7. Desktop apps (Electron)

**`preyone-desktop` — "Preyone POS Desktop"** (`main.js`, 248 lines):
- Packaged: starts embedded portal `scripts/dev-pos.mjs` (embedded Postgres + API :3000), invoice API :4001, static POS UI :4000 with `/api` proxy; opens POS window `localhost:4000` + invoice window `localhost:4001`. Dev mode runs Vite :4000/:5173.
- Bundles entire portal + invoice repos (`resources/_bundle` → `bundle`) via `prepare-resources.mjs`. electron-builder NSIS, `asar: false`. **Requires no system Node** (uses `ELECTRON_RUN_AS_NODE`).
- Single-instance lock, tray-less background keep-alive.

**`preyone-desktop\invoice-launcher` — "Preyone Enterprise Invoice & Quotation System"** (`main.js`, 185 lines): window `localhost:4001`; **reuses :4001 if Desktop POS is already up**, else starts invoice server + own `invoice-data`. Data stored in its own engine (`server/store.js`) + Postgres.

## 8. Invoice system (`preyone-invoice-system`)

- React 18 + Vite 5, express server (`server/index.js`, `pdf.js` via puppeteer-core, `renderDocument.js`), `pg` storage. Enterprise-branded invoices & quotations, PDF generation, `data-test` local store for dev. Served by both desktop apps.

## 9. Payments

- **Pesepay EcoCash** (`services/pesepayService.ts`, `routes/payments.ts`): `/initiate`, `/webhook`, `/callback`, `/status/:paymentId`. Env: `PESEPAY_API_KEY/API_ID/MERCHANT_ID/ENCRYPTION_KEY/BASE_URL`. Docs: `PAYMENT_WISPR_INTEGRATION.md`. Cash + EcoCash + [other] methods in POS.

## 10. Wi-Fi infrastructure (production)

- Flow: Phone → Ruijie AP → **EG105G-P gateway** (ext_login :2060) → **VPS 173.249.7.190** → FreeRADIUS 3.2.5 (REST → localhost:3000) → Node portal (PM2 `preyone-portal`) → PostgreSQL.
- FreeRADIUS client secret `preyone@radius2024`; RADIUS 173.249.7.190:1812/1813. Gateway docs in `docs/EG105G-P-Gateway-Config.md`, golden deploy state in `docs/WORKING-STATE-2026-07-04.md` (auth flow must not change).
- nginx (`deploy/nginx-preyone.conf`): TLS termination for `preyone.com`, `wifi.preyone.com`, etc., proxying to `127.0.0.1:3000`; Let's Encrypt certs.
- PM2 fork, 1 instance, 500 MB memory cap, autorestart (ecosystem.config.js). `server.js` falls back to ts-node if `dist` absent.

## 11. Ports & env matrix

| Port | Service | Where |
|---|---|---|
| 3000 | Portal API (+ static SPAs) | dev, desktop, prod |
| 4000 | POS UI (desktop bundle) | desktop |
| 4001 | Invoice API/UI | desktop |
| 5173 | admin Vite (dev) | local |
| 5174 | pos Vite (dev) | local |
| 5175 | gateway Vite (dev, app/) | local |
| 5433 | embedded Postgres | dev/desktop |
| 2060 | gateway ext_login | EG105G-P |
| 1812/1813 | RADIUS | VPS |

Env (`.env.example`): `PORT`, `NODE_ENV`, `BASE_URL`, `DB_*`, `JWT_SECRET`, session/cleanup intervals, `RUIJIE_PASSWORD` (default `PreyoneNetAccess`), `RUIJIE_SUCCESS_URL`, Pesepay keys.

## 12. Tests

Portal vitest (16 files): admin, auth, approvals, payments, pesepay, portal, pos, redirect (+utils), ruijie, wispr, cleanup services. Admin has vitest + testing-library (Badge, setup). Not continuously run; run via `npm test` / `npx vitest` respectively.

## 13. Approach B — Unified Gateway (app.preyone.com)

**Decision:** Approach B (Unified Gateway + Enterprise Subdomains) over Approach A (Product Subdomains). Rationale: invoice + POS are modules of one business system and must share one ledger, one identity, one company — A would fragment logins/data; B matches the existing monolith subdomain router, DB-driven company branding, and workspace-switcher pattern; and B is the upsell path for the PreLITE→PreEXECUTIVE packages business.

**Target architecture**
```
admin.preyone.com          internal super admin (unchanged)
app.preyone.com            universal tenant gateway — auto-detects active modules
<company>.preyone.com      white-label enterprise portal (Phase 3)
api:  app.preyone.com/api/pos, by-default /api/invoice  (all scoped by company_id JWT claim)
```

**Phase roadmap**
1. **Phase 1 — shared auth + gateway (LIVE):**
   - `app/` gateway SPA scaffolded (React 19 + Vite; dev port **5175**, proxy `/api` → `:3000`): single login via `POST /api/admin/auth/login`, validation via `/api/admin/auth/me`, company branding from `GET /api/pos/company`, module tiles POS / Invoice & Quotation / UltraNet WiFi / Super Admin with dev (`localhost`) vs prod (`*.preyone.com`) URL switching.
   - `src/index.ts:118` — new `app.preyone.com` branch serves `app/dist` (SPA fallback), mirroring admin/pos branches. Reserved-host guard for white-label subdomains to be added in Phase 3.
   - Verified: `tsc` backend build green; gateway `npm run build` green; runtime `app.preyone.com` → HTTP 200 gateway HTML via Host-header test on compiled server.
   - Deployed on prod: `app.preyone.com` serves `app/dist` from the same Node process (`:5000` branch in `src/index.ts`), nginx vhost `/etc/nginx/sites-enabled/app-web` (certbot `--nginx` cert, auto-renew, http→https 301), app SPA verified 200, all pre-existing public hosts verified unchanged (200).**Gateway v2 (plan tier + tags):** gateway build (Vite, dist `index-BZ_87RvE.js`/`index-CJfMtBsh.css`) shows the company's **plan badge** ("Enterprise") next to the brand, a muted **"LAN"** tag on the POS tile (pos.preyone.com has no public DNS — LAN-till use only), and **"Desktop"** tag on the Invoice tile. Redeployed 2026-10-02; verified 200 + new hashes. **Gateway v3 (SSO bootstrap):** `app/src/api.ts` `session()` (cookie `/me` on load when no localStorage token) + `logout()` (`POST /api/admin/auth/logout`, clears cookie) + `credentials:'include'` on all gateway fetches; bundle now `index-BvTpN3uJ.js`, deployed & verified live 2026-10-02.
   - Pending: wildcard `*.preyone.com` Let's Encrypt cert (DNS-01); invoice UI hosting deferred to Phase 3.
2. **Phase 2 — tenancy (IN PROGRESS, backend LIVE on prod):**
   - **Schema:** `subscriptions` table (`company_id` × `module` = `pos|invoice|wifi`, `plan_tier`, `status`, unique pair, seeded active for every company) + `admin_users.company_id` FK + index. Idempotent.
   - **Auth:** JWT now carries `company_id`; `adminAuth` login + `/me` return it; POS PIN/operator selection includes it.
   - **Guards:** `src/middleware/company.ts` — `loadCompany` / `requireCompany` (loads company + active modules onto `req.company`) and `moduleAccess(...)` (403 if module not subscribed). Applied to the whole POS data chain (`router.use(requireAdminAuth, requireStaff, requireCompany)`). **Backward compat:** unassigned accounts fall back to the singleton company, so existing tills keep working until staff are explicitly assigned.
   - **Endpoints:** `GET /api/pos/company/subscriptions` (authed) → `{ company, modules }`; `/devices/register` now binds `company_id` (first-registration wins via `COALESCE`).
   - **Gateway auto-detect:** `app/` fetches subscriptions after login; tiles render only enabled modules; "Super Admin" tile only for CEO/Manager; unknown server → all tiles (dev-friendly).
   - **Verified end-to-end** on embedded stack: PIN login → token `company_id` → `/company/subscriptions` → `{ company: Preyone, modules: [invoice,pos,wifi] }`; admin password login OK too.
   - **Live on prod:** `subscriptions` seeded from `companies` (verified `{"company":"Preyone", modules:[invoice,pos,wifi]}` via DB query); **`plan_tier=enterprise` seeded (UPDATE where null) + surfaced** in `requireCompany`/`/api/pos/company/subscriptions` (verified payload includes `plan_tier:"enterprise"`); `GET /api/pos/company/subscriptions` mounted (401 without token — sits behind the existing auth guard); `router.use(moduleAccess('pos'))` guards the POS data chain from `/devices/*` onward while leaving `/auth/*` open; new `src/middleware/company.ts` (prod singleton, transit-agnostic). Deployed by uploading 4 files + `app/dist` to `/opt/preyone-portal`, `npm run build`, `node dist/db/migrate.js` (exit 0), `pm2 reload` (4×cluster healthy). Backup: `/opt/preyone-backups/predeploy-phase2-20261002-130548/` (src/dist/fe/env/nginx).
   - **Cross-subdomain SSO (LIVE on prod):** single wildcard `Domain=.preyone.com` HTTP-Only `preyone_token` cookie. `src/utils/ssoCookie.ts` (`setPreyoneCookie`/`clearPreyoneCookie`/`resolveAuthToken`); admin login issues 7d JWT **and** sets the cookie; `/me` now accepts Bearer-or-cookie (`resolveAuthToken`) and returns `tenant_id` + `subscribed_modules` (resolved from the singleton profile company, preserving transit `/me` shape); `portal-login` also sets the cookie; admin JWT `expiresIn` 24h→7d; CORS upgraded from open `cors()` to origin-reflect + `credentials:true` (allowlist `https://(*.)preyone.com` + localhost dev; preflight maxAge 1d). SPAs updated: `app/` (session bootstrap + logout + `credentials:include`), `admin/` (`AuthContext` cookie `/me` bootstrap + login/logout cookie), `pos/` (`credentials:include` in `req()`), all `credentials:'include'`. **Verified:** local prod-mode boot (`NODE_ENV=production`) asserted `Set-Cookie … Domain=.preyone.com; HttpOnly; Secure; SameSite=Lax`, cookie `/me` 200 with `tenant_id` + `subscribed_modules`, invalid cookie→401, CORS reflect + credentials, untrusted origin rejected (ALL 9 PASS); vitest stable 161/165 (4 pre-existing). **Deployed** to `/opt/preyone-portal` (4 files staged from prod lineage — `src/utils/ssoCookie.ts` new, `routes/adminAuth.ts`, `routes/auth.ts`, `index.ts`), `tsc` clean, `pm2 reload` 4×cluster green. **Prod verified:** all public hosts 200 (`preyone.com/www/wifi/admin/api/app`), `/api/admin/auth/me` with `Cookie: preyone_token=garbage` → 401 `{"error":"Invalid token"}` (cookie path + cookie-parser + resolver active), gateway serves new bundle. Backup: `/opt/preyone-backups/predeploy-sso-20261002-134856/`. POS `dist`/admin `dist` **not** redeployed (LAN till + local admin redesign are separate workstreams).
   - **Remaining in Phase 2:** per-resource `moduleAccess` sprinkling across data routes (products/sales/inventory — the chain-level guard is live; per-route granularity pending), plan-tier **admin management UI** (backend `plan_tier` now seeded `enterprise`, surfaced in `requireCompany` + `/api/pos/company/subscriptions`, and shown as a badge in the gateway — deferred to the admin workstream), **Invoice UI under gateway** (`app.preyone.com/invoice` — deferred: the invoice system is a separate desktop product, not hosted on this box; tile now tagged "Desktop"), full wildcard cert rotation of the existing leaf certs.
3. **Phase 3 — white-label:** `<company>.preyone.com` reserved-name routing, company branding everywhere, upsell-driven module toggles.

## 14. Known gaps / blockers

- ~~**Deploy creds (BLOCKER):** both documented hosts failed.~~ **Resolved** — working creds: `ssh -i ~/.ssh/id_opencode deploy@158.220.118.91` (key-only, NOPASSWD sudo, fail2ban on sshd). `/opt/preyone-portal` is **not a git repo** → deploys are manual scp (deploy.sh's `git pull` would fail). `173.249.7.190` is stale documentation (times out). Prod DB is **remote** (`DB_HOST` in `.env`; no local socket for pg_dump); migrate is re-runnable by design (`node dist/db/migrate.js` runs on every deploy.sh).
- **Local admin login `till@preyone.com` works now** on the embedded dev stack (seeded `not-used-local`); the earlier 401 was on the older dev DB. Production credentials still unknown.
- **Multi-device concordance** (desktop D1+D2, APK A1+A2): not yet — each desktop runs its own embedded DB; A1 mirrors LAN; A2 config-pointed. Recommended single-hub architecture from previous report; device registration + reports already supported by schema.
- **No true multi-tenancy** yet — `companies` is a singleton row; `clients` table doesn't exist.
- **Live console source mismatch** — production `admin` is a different build than local repo (needs merge/rebuild on deploy).
- **Pre-existing test failures (unrelated to Phase 1):** 4 vitest failures — `pos.test.ts › applies discount then tax on the discounted base` and 3× `redirect.test.ts › buildRuijieSuccessUrl` (extra empty query params). 161/165 pass. Not caused by the gateway change (`pos.ts`, `redirect.ts` untouched).

## 15. Current working session

- This chat = **POS development only** (per user instruction). Admin-console changes were exported to a separate session file for the admin opencode instance; a compact handover prompt was also provided.
- Most recent work: **Approach B Phase 1** — `app/` gateway launched + verified, `app.preyone.com` routing live in `src/index.ts`, report updated (this file).
- **This session (PROD DEPLOYMENT of Phase 1 + Phase 2 backend):** creds obtained from user; server recon (no git repo, 4×cluster on :5000, richer prod codebase than local — transit tenancy, RBAC, `admin_users.company_id` FK to `transit_companies`); host passthrough code adapted for prod as **singleton profile company** (transit-agnostic — prod tokens carry transit `company_id`, not a profile id); made backups; uploaded 4 edited/staged prod files (`src/index.ts` +app.preyone.com branch, `src/routes/pos.ts` +subscriptions+moduleAccess guard, new `src/middleware/company.ts`, `src/db/migrate.ts` +subscriptions) + gateway `app/dist`; built clean, migrate exit 0, pm2 reload → all 4 instances online; certbot cert for `app.preyone.com` deployed. Verified: `app.preyone.com` 200 (title "Preyone Enterprise"), http→301, asset 200; `preyone.com/www/wifi/admin/api` all 200 unchanged; subscriptions endpoint 401 unauthenticated + verified DB payload `{company:Preyone, modules:[invoice,pos,wifi]}`; live admin-console traffic observed flowing (304s) during/after reload. `pos.preyone.com` = LAN-only hostname (nginx vhost exists, **no public DNS**) — pre-existing, untouched. Prod `package.json` unchanged (locals' embedded-postgres devDep NOT deployed); local admin-console redesign NOT deployed. Vitest 161/165 (same 4 pre-existing failures).
- **Follow-up increment (same session):** seeded `plan_tier='enterprise'` (idempotent `UPDATE` in migrate), extended `requireCompany`/`/company/subscriptions` to return `plan_tier`, and built **gateway v2** showing the plan badge, LAN/POS tag and Desktop/Invoice tag (new bundle deployed, all public hosts still 200, DB payload verified `{company:Preyone, plan_tier:enterprise, modules:[invoice,pos,wifi]}`). Changes mirrored into local tree (`middleware/company.ts`, `routes/pos.ts`, `db/migrate.ts`, `app/src/*`); local tsc green; vitest still 161/165.