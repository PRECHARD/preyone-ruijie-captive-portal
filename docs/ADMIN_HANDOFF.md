# Admin Console — API & Schema Handoff

**Scope:** the Admin Console workstream — every HTTP endpoint exposed by `src/routes/admin.ts` and
`src/routes/adminAuth.ts`, the authentication/tenancy invariants the console depends on, and the
PostgreSQL schema those endpoints read and write.

| Item | Value |
| --- | --- |
| Document generated | 2026-10-03 |
| Backend routers documented | `adminRouter` (`src/routes/admin.ts`), `adminAuthRouter` (`src/routes/adminAuth.ts`) |
| Route handlers catalogued | **109** (102 in `admin.ts` + 7 in `adminAuth.ts`) |
| Adjacent surfaces referenced | `posRouter` (`/api/pos/company*`), `authRouter` (`/api/auth/*`), `paymentsRouter` (`/api/payments/*`), `gatewayRouter` |
| Mount points | `/api/admin/auth` → `adminAuthRouter`, `/api/admin` → `adminRouter` (src/index.ts:200-201) |
| Verification method | Route handlers extracted directly from source (`router.<verb>(` / `adminAuthRouter.<verb>(`), each cross-checked against its inline `requireRole(...)` guard and line number. Counts are exact, not estimated. |

> Production is the source of truth. The server copy at `/opt/preyone-portal` is **not** a git
> repository; deployments are manual `scp` transfers. See [Deployment & Drift](#deployment--drift).

---

## 1. Required HTTP headers

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization: Bearer <jwt>` | **Yes — for every `/api/admin/*` route and every guarded `/api/pos/*` route** | `adminRouter.use(requireAdminAuth)` (src/routes/admin.ts:13) and `posRouter.use(requireAdminAuth, requireStaff, requireCompany)` (src/routes/pos.ts:154). HS256 JWT verified with `JWT_SECRET`. Missing/invalid/expired → `401`. A token whose `admin_users.approved` flag is false is rejected at request time, so deactivation takes effect immediately without waiting for expiry. |
| `Cookie: preyone_token=<jwt>` | **Alternative credential for `GET /api/admin/auth/me` only** | Cross-subdomain SSO cookie (see [§3](#3-session--sso-model)). It is *not* accepted by `adminRouter` — console pages must still send the `Authorization` header. |
| `Content-Type: application/json` | Yes, for requests with a body | `express.json()` with a 5 MB body cap. |
| `x-tenant-id` | **Not required — and not consumed anywhere** | Verified: `x-tenant-id` / `x_tenant_id` have **zero occurrences in `src/`**. Tenant identity is derived server-side from the verified token and the database. The API deliberately ignores any client-supplied tenant header so a caller can never switch tenant by forging a header. Frontends must not send it; if one appears in a request it is inert. |

---

## 2. Authentication & Session — `/api/admin/auth/*`

All seven routes live in `src/routes/adminAuth.ts`. **None of them require an existing token**
(session bootstrap is the point); `/me` accepts Bearer *or* cookie.

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/auth/verify-email` | public | Consumes `?token=`; flips `admin_users.email_verified`; redirects to `/verify-email.html?status=verified\|failed`. |
| POST | `/api/admin/auth/signup` | public, rate-limited | `authLimiter` 10 req / 15 min / IP. Body: `fullName, email, phone, password, role?`. Rejects disposable/throwaway email domains. Enforces **1 CEO** and **max 2 Managers** (`409` otherwise). `Staff` accounts are created with `approved = false` and must be approved before sign-in. `bcrypt` cost 12. `201` with `{ user }` (+ `pendingApproval: true` for Staff). |
| POST | `/api/admin/auth/login` | public, rate-limited | Same limiter. Returns `{ token, user }`; the JWT is valid **7 days**. Also sets the `preyone_token` SSO cookie. `403` when a Staff account is still unapproved. |
| POST | `/api/admin/auth/logout` | public | Clears the SSO cookie. The JWT itself is stateless and remains valid until expiry — client must discard its copy. |
| GET | `/api/admin/auth/me` | Bearer **or** cookie | `resolveAuthToken(req)` = `Authorization` first, cookie second. Returns the full user row **plus `tenant_id` and `subscribed_modules`** (see [§4](#4-multi-tenant--tenant-id-invariants)). `401` if the user no longer exists. |
| POST | `/api/admin/auth/forgot-password` | public | Always `200` (no email enumeration). Issues a 32-byte hex `reset_token` valid **1 hour** and emails the link. |
| POST | `/api/admin/auth/reset-password` | public | Body `{ token, password }`; password ≥ 6 chars. Validates token **and** `reset_token_expires_at > NOW()`, re-hashes with bcrypt 12, nulls the token, writes an `admin_audit_log` row (`password_reset`). |

---

## 3. Session & SSO model

- **JWT payload** (signed at login, `HS256`, `expiresIn: '7d'`):

  ```json
  { "id": "<uuid>", "email": "…", "role": "CEO|Manager|Staff",
    "fullName": "…", "company_id": "<uuid|null>" }
  ```

  Typed as `AdminUser` in src/middleware/adminAuth.ts:15-21. There is **no `tenant_id` or
  `subscribed_modules` claim inside the token** — both are computed per request (see [§4](#4-multi-tenant--tenant-id-invariants)).
- **SSO cookie** (`src/utils/ssoCookie.ts`): name `preyone_token`; `HttpOnly`; `SameSite=Lax`;
  `Path=/`; `Max-Age=7d`; `Secure` + `Domain=.preyone.com` in production only (no `Domain`
  attribute in development, so the cookie stays host-local). Set on `POST /login`, cleared on
  `POST /logout`.
- **Cross-subdomain flow:** `admin.preyone.com`, `app.preyone.com`, `*.preyone.com` share the
  cookie, so a user signed in on one subdomain is recognised by `GET /api/admin/auth/me` on
  another. The console SPA calls `/me` on load and, on success, keeps its own Bearer token in
  `localStorage`. **Cookie-only requests cannot call `/api/admin/*` business routes** — `requireAdminAuth`
  reads the `Authorization` header only.
- **Secret handling:** `JWT_SECRET` must be set in `.env`. If it is missing the process falls back to
  `preyone-jwt-secret-change-in-production` and logs a warning at first use — treat that warning as a
  production incident.
- **Rate limiting:** 10 attempts / 15 min / IP, applied to `signup` and `login` only.

### RBAC legend (used in every table below)

| Marker | Meaning |
| --- | --- |
| **any-authed** | Any authenticated admin account, `Staff` included (no `requireRole`). Data is still scoped to the caller where applicable. |
| **CEO/Manager** | `requireRole('CEO', 'Manager')` → `403 Insufficient permissions` otherwise. |
| **CEO** | `requireRole('CEO')`. |

Business rules that apply across modules: Staff must be **clocked in** (`POST /clock-in`) before
selling vouchers; bulk/restricted-tier voucher creation by Staff requires an approval request;
`GET /users` and sales endpoints are scoped to the caller's own records for Staff accounts.

---

## 4. Multi-tenant & tenant-id invariants

### 4.1 What the console receives

`GET /api/admin/auth/me` response (the session payload the SPA bootstraps from):

```json
{
  "id": "…", "full_name": "…", "email": "…", "phone": "…",
  "role": "Manager", "company_id": "…|null",
  "created_at": "…", "email_verified": true,
  "tenant_id": "…",
  "subscribed_modules": ["invoice", "pos", "wifi"]
}
```

### 4.2 Resolution rules (src/routes/adminAuth.ts:238-252)

1. `tenant_id = admin_users.company_id` when the user is assigned to a company.
2. Otherwise `tenant_id` falls back to the **singleton profile company**: `SELECT id FROM companies ORDER BY created_at LIMIT 1`.
3. `subscribed_modules = SELECT module FROM subscriptions WHERE company_id = <resolved> AND status = 'active' ORDER BY module`.
   `subscriptions.module` is constrained to `('pos', 'invoice', 'wifi')`; `status` to `('active', 'suspended')`;
   `UNIQUE (company_id, module)`.
4. `requireCompany` (src/middleware/company.ts) performs the same resolution for `/api/pos/*` and exposes it as `req.company = { id, name, plan_tier, modules }`.

### 4.3 Invariants a future contributor must not break

- The tenant is **server-derived only**. Never accept a tenant/company id from a header, query string,
  or body for scoping decisions. `x-tenant-id` is unused and must stay that way.
- `tenant_id` and `subscribed_modules` are **response-time values, not JWT claims**. Anything that
  caches a session must re-read `/me`; do not bake them into a token.
- Module entitlements are **read-only** — there is no CRUD surface for `subscriptions` on `/api/admin`.
- Role ceilings are enforced in the signup path (1 CEO, 2 Managers); changing them means editing
  src/routes/adminAuth.ts, not configuration.

### 4.4 Company singleton today → multi-tenant RLS tomorrow

Today the system is a **single-tenant deployment wearing multi-tenant clothing**: one row in
`companies` acts as the profile for branding, currency, tax and document prefixes; every console user
resolves to it. The schema already carries the columns a real multi-tenant rollout needs
(`companies.slug`, `admin_users.company_id`, `subscriptions.company_id`).

Migration path, in dependency order:

1. **Column backfill** — add `company_id` to the operational tables that lack it (`vouchers`,
   `packages`, `pos_documents`, `ap_devices`, `pos_devices`, `staff_time_logs`, `sales`, …).
2. **Resolver change** — `requireCompany` and the `/me` fallback stop defaulting to `ORDER BY created_at LIMIT 1`
   and start resolving from `admin_users.company_id` (or the request subdomain, already scaffolded in
   `src/middleware/subdomain.ts` → `req.tenant`).
3. **Query scoping** — every statement gains `AND company_id = $n` with the id bound from
   `req.company`, never from client input. Use `pool.connect()` + `SET LOCAL app.tenant_id` where a
   transaction spans multiple tables (the POS checkout handler is the reference pattern).
4. **Database enforcement** — enable PostgreSQL RLS with `USING (company_id = current_setting('app.tenant_id')::uuid)`
   as the backstop so a missed `WHERE` clause cannot leak cross-tenant rows.
5. **Uniqueness** — convert single-column unique constraints (`vouchers.code`, `admin_users.email`) to
   composite `(company_id, …)` before the second tenant signs up.
6. **Entitlements** — gate console modules on `subscribed_modules` rather than hard-coding routes to
   `pos`/`invoice`/`wifi`.

---

## 5. Endpoint catalogue — `adminRouter` (102 routes, base `/api/admin`)

### 5.1 Staff & User Management (19)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/users` | any-authed | :15 | Portal users; Staff see only their own voucher sales. |
| GET | `/admin-users` | CEO/Manager | :458 | Admin console accounts. |
| GET | `/staff` | CEO/Manager | :704 | Approved staff list. |
| GET | `/staff-pending` | CEO/Manager | :712 | Awaiting approval. |
| POST | `/staff-approve/:id` | CEO/Manager | :720 | Approve; flips `admin_users.approved`, notifies the requestor. |
| POST | `/staff-reject/:id` | CEO/Manager | :733 | Reject + notify. |
| GET | `/staff-status` | CEO/Manager | :746 | Online/offline presence. |
| POST | `/staff-deactivate/:id` | CEO/Manager | :762 | Deactivate (takes effect on next request — JWT is re-checked). |
| POST | `/staff-activate/:id` | CEO/Manager | :773 | Reactivate. |
| POST | `/staff-remove/:id` | CEO/Manager | :784 | Remove account. |
| GET | `/staff/stats` | any-authed | :1590 | Staff dashboard stats (own data). |
| GET | `/managers` | CEO | :882 | Manager list. |
| POST | `/manager-promote/:id` | CEO | :890 | Staff → Manager. |
| POST | `/manager-demote/:id` | CEO | :909 | Manager → Staff. |
| POST | `/manager-remove/:id` | CEO | :920 | Remove Manager. |
| POST | `/clock-in` | any-authed | :607 | Open shift — prerequisite for selling. |
| POST | `/clock-out` | any-authed | :627 | Close shift. |
| GET | `/clock-status` | any-authed | :665 | Current clock state. |
| GET | `/time-logs` | any-authed | :673 | Shift/time logs. |

### 5.2 Vouchers, Packages & QoS (19)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| POST | `/vouchers` | any-authed | :48 | Create one voucher. Staff: clocked-in only. |
| GET | `/vouchers` | any-authed | :116 | List vouchers (role-scoped). |
| POST | `/vouchers/bulk` | any-authed | :1321 | Bulk create — Staff path requires an approved request. |
| POST | `/vouchers/request-approval` | any-authed | :1421 | Submit a bulk/restricted-tier request for CEO/Manager approval. |
| GET | `/vouchers/pending-approvals` | CEO/Manager | :1465 | Approval queue. |
| POST | `/vouchers/approvals/:id/approve` | CEO/Manager | :1473 | Approve; mints vouchers + notifies. |
| POST | `/vouchers/approvals/:id/reject` | CEO/Manager | :1552 | Reject + notify. |
| GET | `/vouchers/my-approvals` | any-authed | :1578 | Caller's own request history. |
| GET | `/voucher-redemptions` | any-authed | :797 | Redemption ledger. |
| GET | `/packages` | any-authed | :41 | Public package list (`price_amount` ASC). |
| GET | `/packages/manage` | CEO | :1955 | Management view. |
| POST | `/packages` | CEO | :1960 | Create package. |
| PUT | `/packages/:id` | CEO | :1974 | Update package. |
| DELETE | `/packages/:id` | CEO | :1990 | Delete package. |
| GET | `/qos-view` | any-authed | :1847 | QoS dashboard. |
| GET | `/bandwidth` | any-authed | :1118 | Bandwidth usage. |
| GET | `/bandwidth/top-users` | any-authed | :1155 | Top consumers. |
| POST | `/bandwidth/snapshot` | any-authed | :1938 | Force a usage snapshot. |
| GET | `/peak-hours` | CEO/Manager | :1173 | Peak usage pattern. |

### 5.3 AP Device Health & Monitoring (14)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/ap-devices` | any-authed | :1047 | AP inventory. |
| POST | `/ap-devices` | any-authed | :1054 | Register AP. |
| PUT | `/ap-devices/:id` | any-authed | :1067 | Update AP. |
| DELETE | `/ap-devices/:id` | any-authed | :1087 | Remove AP. |
| GET | `/ap-health` | any-authed | :1094 | AP health snapshot (gateway heartbeats). |
| GET | `/alerts` | any-authed | :1208 | Alerts, scoped to addressee. |
| POST | `/alerts/:id/acknowledge` | any-authed | :1237 | Acknowledge alert. |
| GET | `/blacklist` | any-authed | :1252 | MAC blacklist. |
| POST | `/blacklist` | any-authed | :1262 | Add entry. |
| DELETE | `/blacklist/:id` | any-authed | :1277 | Remove entry. |
| GET | `/whitelist` | any-authed | :1285 | MAC whitelist. |
| POST | `/whitelist` | any-authed | :1295 | Add entry. |
| DELETE | `/whitelist/:id` | any-authed | :1309 | Remove entry. |
| POST | `/kill-sessions` | CEO | :2137 | Force session teardown (portal-wide availability lever). |

### 5.4 Sales, Dashboards, Reporting & Cash Handovers (18)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/my-sales` | any-authed | :131 | Caller's own sales. |
| GET | `/my-sales/export` | any-authed | :310 | Excel export (ExcelJS). |
| GET | `/staff-sales` | CEO/Manager | :347 | Aggregated staff sales. |
| GET | `/staff-sales/export` | CEO/Manager | :376 | Excel export, aggregated. |
| GET | `/staff-sales/export/:staffId` | CEO/Manager | :414 | Excel export, per staff member. |
| GET | `/dashboard` | CEO/Manager | :469 | Consolidated dashboard (30 s cache). |
| GET | `/dashboard/sales` | CEO/Manager | :578 | Daily/weekly/monthly series. |
| GET | `/revenue` | CEO/Manager | :531 | Revenue series. |
| GET | `/revenue/export` | CEO | :984 | CSV export. |
| GET | `/charts` | CEO/Manager | :1004 | Chart series. |
| GET | `/customer-kpis` | CEO/Manager | :1793 | Customer KPIs. |
| GET | `/access-log` | any-authed | :33 | Access events, last 7 days, grouped by hour. |
| GET | `/cash-handovers/available-sales` | any-authed | :1626 | Sales eligible for handover. |
| POST | `/cash-handovers` | any-authed | :1640 | Submit handover. |
| GET | `/cash-handovers/pending` | CEO/Manager | :1696 | Pending handovers. |
| POST | `/cash-handovers/:id/approve` | CEO/Manager | :1716 | Approve handover. |
| POST | `/cash-handovers/:id/reject` | CEO/Manager | :1739 | Reject handover. |
| GET | `/cash-handovers/my` | any-authed | :1781 | Caller's handover history. |

### 5.5 Backups, Maintenance, Retention, Schedules & Commissions (12)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| POST | `/backup` | CEO | :2176 | Trigger a database backup. |
| GET | `/backup/logs` | CEO | :2198 | Backup history (`backup_logs`). |
| GET | `/maintenance` | CEO | :2002 | Maintenance-mode state. |
| PUT | `/maintenance` | CEO | :2011 | Toggle maintenance mode — **blocks portal routes while on**. |
| GET | `/retention` | CEO | :2033 | Retention policy. |
| PUT | `/retention` | CEO | :2038 | Update retention policy. |
| GET | `/report-schedules` | CEO | :2207 | Scheduled reports. |
| POST | `/report-schedules` | CEO | :2212 | Create schedule. |
| PUT | `/report-schedules/:id` | CEO | :2226 | Update schedule. |
| DELETE | `/report-schedules/:id` | CEO | :2241 | Remove schedule. |
| GET | `/commissions` | CEO | :2052 | Commission structure. |
| PUT | `/commissions/:staffId` | CEO | :2062 | Set a staff member's commission. |

### 5.6 Branding, Company Profile & POS Devices (10)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/branding` | CEO | :2157 | Branding settings. |
| PUT | `/branding` | CEO | :2162 | Update branding. |
| GET | `/company` | CEO | :2253 | Company profile (singleton `companies` row). |
| PUT | `/company` | CEO | :2258 | Update profile: name, tagline, address, email, support_phone, website, logo, currency, `tax_pct`, `invoice_prefix`, `quote_prefix`, receipt footer, terms. |
| GET | `/devices` | CEO/Manager | :2292 | POS endpoint devices (`pos_devices`). |
| POST | `/devices` | CEO/Manager | :2305 | Register device. |
| PUT | `/devices/:id` | CEO/Manager | :2329 | Update device. |
| POST | `/devices/:id/suspend` | CEO/Manager | :2349 | Suspend device. |
| POST | `/devices/:id/activate` | CEO/Manager | :2357 | Activate device. |
| DELETE | `/devices/:id` | CEO | :2365 | Delete device. |

### 5.7 Sessions, Broadcasts, Notifications, Settings & Audit (10)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/active-sessions` | any-authed | :817 | Live usage/sessions. |
| GET | `/notifications/count` | any-authed | :1882 | Unread count. |
| POST | `/notifications/acknowledge` | any-authed | :1923 | Acknowledge notification. |
| POST | `/broadcast` | CEO | :2084 | Create broadcast. |
| GET | `/broadcasts` | any-authed | :2096 | Broadcast list. |
| POST | `/broadcasts/:id/read` | any-authed | :2110 | Mark one read. |
| POST | `/broadcasts/read-all` | any-authed | :2120 | Mark all read. |
| GET | `/settings` | CEO | :938 | System settings. |
| PUT | `/settings` | CEO | :945 | Update system settings. |
| GET | `/audit-log` | CEO | :974 | `admin_audit_log` trail. |

**Route totals:** 19 + 19 + 14 + 18 + 12 + 10 + 10 = **102** ✔ matches the handler count in
`src/routes/admin.ts`. With the 7 `adminAuth` routes: **109 admin-facing endpoints.**

### 5.8 Subscriptions (tenancy read-out, in `posRouter`)

| Method | Endpoint | Access | src | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/pos/company` | any-authed + staff + company | pos.ts:158 | Read-only profile for receipts/invoices/support (`SELECT * FROM companies ORDER BY created_at LIMIT 1`). |
| GET | `/api/pos/company/subscriptions` | any-authed + staff + company | pos.ts:164 | `{ company: { id, name }, plan_tier, modules }` from `req.company`. |

---

## 6. Schema inventory

35 tables are created by `src/db/migrate.ts`. Grouped by workstream:

| Workstream | Tables |
| --- | --- |
| Tenancy / identity | `companies`, `subscriptions`, `admin_users`, `admin_audit_log`, `settings`, `branding` |
| Vouchers & packages | `vouchers`, `packages`, `voucher_approvals`, `voucher_redemptions` |
| Staff & shifts | `staff_time_logs`, `staff_commissions`, `cash_handovers` |
| AP / network | `ap_devices`, `ap_bandwidth_snapshots`, `gateway_heartbeats`, `alerts`, `mac_blacklist`, `mac_whitelist`, `wispr_profiles` |
| POS | `pos_documents`, `pos_document_items`, `pos_document_payments`, `pos_products`, `pos_customers`, `pos_devices`, `pos_shifts` |
| Portal users & commerce | `users`, `sales`, `payments`, `transactions`, `access_log` |
| Retention / reporting | `backup_logs`, `retention_policies`, `report_schedules`, `broadcast_notifications` |

### 6.1 Tenant-relevant columns (the ones to reason about)

**`companies`** — profile + future tenant root:

```
id UUID PK, name, tagline, address, email, support_phone, website, logo_path,
currency (default 'USD'), tax_pct, invoice_prefix, quote_prefix, receipt_footer, terms_text,
slug TEXT,                              -- added by ALTER (migrate.ts:569), unique partial index
updated_by -> admin_users(id), created_at, updated_at
```

**`admin_users`** — console identity:

```
id UUID PK, full_name, email UNIQUE, phone,
role CHECK IN ('CEO','Manager','Staff') DEFAULT 'Staff', password_hash,
approved BOOLEAN DEFAULT TRUE,           -- added by ALTER (migrate.ts:139)
reset_token, reset_token_expires_at,    -- ALTER (140-141)
email_verified, email_verification_token,-- ALTER (142-143)
pin_hash,                               -- ALTER (425) POS staff PIN
company_id -> companies(id) ON DELETE SET NULL  -- ALTER (574) TENANT FK
created_at
```

**`subscriptions`** — entitlements:

```
id UUID PK, company_id -> companies(id) ON DELETE CASCADE,
module CHECK IN ('pos','invoice','wifi'), plan_tier,
status CHECK IN ('active','suspended') DEFAULT 'active',
UNIQUE (company_id, module), created_at, updated_at
```

**`vouchers`** — codes stay **uppercase in the database**; only presentation is lowercased.
Relevant columns: `code`, `pin_hash`, `sold_by -> admin_users(id)`, `price_amount`,
`package_tier`, `duration_min`, `max_uses`, `used_count`, `expires_at`, `data_limit_gb`,
`is_uncapped`, `bandwidth_mbps_up`, `bandwidth_mbps_down`.
Redemption input is case-insensitive — `auth.ts` uppercases the submitted code before lookup — so a
lowercase PIN printed on a voucher card logs in fine.

---

## 7. Worked examples

```bash
# 1. Log in — returns a 7-day JWT and sets the SSO cookie
curl -X POST https://admin.preyone.com/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ceo@preyone.com","password":"…"}'
# → { "token": "<jwt>", "user": { … } }
#    Set-Cookie: preyone_token=<jwt>; Domain=.preyone.com; HttpOnly; Secure; SameSite=Lax; Max-Age=604800

# 2. Call a guarded business endpoint (Bearer is mandatory here)
curl https://admin.preyone.com/api/admin/dashboard \
  -H "Authorization: Bearer $TOKEN"
# → 200 dashboard payload   |   401 without the header

# 3. Bootstrap a session on another subdomain with the cookie alone
curl https://app.preyone.com/api/admin/auth/me -H "Cookie: preyone_token=$TOKEN"
# → { …user…, "tenant_id": "…", "subscribed_modules": ["invoice","pos","wifi"] }

# 4. CEO-only maintenance toggle (the portal-availability lever)
curl -X PUT https://admin.preyone.com/api/admin/maintenance \
  -H "Authorization: Bearer $CEO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

---

## 8. Deployment & Drift

**Deploy path (manual, `scp`):** build the SPA locally, then copy the artefact to the server; the
portal serves `/api/admin` from PM2 process `preyone-portal` (cwd `/opt/preyone-portal`) and the
admin SPA from `/opt/preyone-portal/admin/dist` (src/index.ts:130-136). Nginx terminates TLS and
proxies to `127.0.0.1:5000`. **Never `git push` to production — the server is not a git repo.**

Two drift warnings recorded on 2026-10-03, both material:

1. **`AGENTS.md` line 68 is stale** — it documents `scp -r dist/ root@173.249.7.190:/opt/preyone-portal/`.
   The live host is `158.220.118.91` (user `deploy`, `sudo -n` available) and the admin artefact is
   `admin/dist`, not `dist/`. Anyone following AGENTS.md verbatim will deploy to a dead host.
2. **The local repository has diverged from production `admin/src`.** Production additionally has
   **ContiPay payment-method/reference capture** on voucher creation (single + bulk), **QR + barcode
   rendering** (`TicketPreviewCard.tsx`, `qrcode`/`jsbarcode`), and the **older package-tier names**
   (`PreCore`, `PreBizPlus`, `PreFam`, `PreBizPro`, `PreMax`, `PreUltra`, `PreExecutive`). Local
   `main` has none of those and uses `PreBIZ`/`PreMAX`/`PreULTRA`/`PreEXECUTIVE`. **Do not ship a
   locally built `admin/dist` over production** — it deletes ContiPay and QR/barcode. Build from a
   copy of the server's own `admin/` source instead.

---

## 9. Repository isolation status

| Item | State |
| --- | --- |
| `main` working tree | **Clean** — safe as the reference for manual `scp` syncing |
| Experimental admin UI edits | Isolated on branch `local/admin-ui-experiments` (lowercase voucher PIN on card/PDF/WhatsApp + Montserrat canvas font) |
| Redesign branch | `feature/admin-console-redesign` (`d2c107b`) — **already merged** into `main` via `32158a9`; branch retained for reference |
| Unpushed commits | `main` is 6 commits ahead of `origin/main` — intentionally not pushed |
| Working-tree size | `admin/` ≈ 18 MB across 104 tracked files (excl. `node_modules`); git pack ≈ 14.8 MiB |

**Working rule:** experiments land on a branch, never as uncommitted noise on `main`. Keep `main`
clean so that "what is on disk locally" and "what is in git" can never disagree during a manual
production sync.
