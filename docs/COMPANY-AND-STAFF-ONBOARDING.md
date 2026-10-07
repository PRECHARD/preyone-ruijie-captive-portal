# Company & Staff Onboarding (CEO Super User guide)

**Audience:** Prechard Muvirimi, CEO Super User (`admin@preyone.com`, role `CEO` with
`system.developer`). This document explains the two tenancy realms, how a company is created and
which services it uses, and how staff accounts are created and approved.

| Item | Value |
| --- | --- |
| Portal realm key | `companies` table + `subscriptions` (modules `pos` / `invoice` / `wifi`) |
| Transit realm key | `transit_companies` table + `transit_users` / `admin_users.company_id` |
| Realm split on admin accounts | `admin_users.company_id` → transit; `admin_users.portal_company_id` → portal (src/db/migrate.ts:776-782) |
| Super-admin badge | permission `system.developer` (role_permissions `CEO` + explicit `user_permissions`) |

---

## 1. The two realms

| | Portal (Preyone UltraNet WiFi / POS / invoices) | Transit (ticketing)
| --- | --- | --- |
| Company table | `companies` | `transit_companies` |
| "What it uses" | `subscriptions` rows (module + plan_tier) | gateways + `company_permissions`/feature config |
| Web console users | `admin_users.portal_company_id` | `admin_users.company_id` |
| Creating a company | seeded singleton — **Preyone already exists** | `POST /api/v1/admin/companies` (system.developer) |
| Staff | Signup + CEO approval | Provisioned via transit API (mobile/console roles) |

The portal realm intentionally has **one company (Preyone)**. Its row is seeded during migration
(`companies` name `Preyone`, `info@preyone.com`, `+263771327202`; migrate.ts:1140). The WiFi
vouchers, POS and invoices all operate for and on behalf of this company.

## 2. Company "Preyone" and the services it uses

"Services" = active `subscriptions` rows for the company. Current state (production):

```
company_id  8def8d43-662b-4ab5-8a05-087a36005f4f  (companies.name = 'Preyone')
module      plan_tier
pos         enterprise
invoice     enterprise
wifi        enterprise   ← what the UltraNet WiFi / Vouchers consoles gate on
```

Read it:

- UI/API for a signed-in user: `GET /api/admin/auth/me` → `subscribed_modules`, `tenant_id`.
- POS client: `GET /api/pos/company/subscriptions` (requires `requireCompany`, middleware `src/middleware/company.ts`).
- Check a module gate: `moduleAccess('wifi')` → 403 if that module has no active subscription (src/middleware/company.ts:92-105).

Enable/change a service (ops/SQL — there is no UI for editing portal subscriptions today):

```sql
INSERT INTO subscriptions (company_id, module, plan_tier, status)
VALUES ('8def8d43-...', 'wifi', 'enterprise', 'active')
ON CONFLICT (company_id, module) DO UPDATE SET plan_tier = EXCLUDED.plan_tier, status = 'active';
```

Voucher packages are the WiFi services inside the `wifi` module: tiers such as `PreLite`,
`PreCore`, `PreFam`, `PreMax`, `PreUltra` live in `packages`, mirrored 1:1 to Ruijie Cloud user
groups in `voucher_profiles` (12 profiles provisioned). Selling a package is enabled by the
`wifi` subscription — nothing else needs changing.

## 3. Creating a transit company (the "register a company" flow)

Transit is the only realm where a company is truly *created* at runtime. Endpoint:
`POST /api/v1/admin/companies` (src/routes/systemAdmin.ts:94), gated by `system.developer`.

```bash
curl -X POST https://api.preyone.com/api/v1/admin/companies \
  -H "Authorization: Bearer $CEO_JWT" -H "Content-Type: application/json" \
  -d '{
    "name": "Mupota Bus Service",
    "slug": "mupota-bus-service",
    "tagline": "…", "address": "…", "email": "…", "website": "…",
    "customer_care": "0771 327 202",
    "currency": "USD",
    "adminUsername": "mupota_admin", "adminPassword": "StrongPass1234",
    "adminName": "Prechard Muvirimi", "adminEmail": "admin@preyone.com", "adminPhone": "+263771327202"
  }'
```

What it does (one transaction):

1. Inserts `transit_companies` (name, slug, …; `ON CONFLICT (slug)` → 409).
2. Optionally seeds a `transit_users` `SUPER_ADMIN` for the mobile app (`adminUsername`/`adminPassword`).
3. Optionally seeds an `admin_users` web console **CEO** bound to the new company (`adminEmail`/`adminPassword`) — note this uses `company_id` (transit), *not* `portal_company_id`.

Lifecycle after creation (all `system.developer`): `GET /api/v1/admin/companies`,
`GET /api/v1/admin/companies/:id`, `PUT /api/v1/admin/companies/:id` (commission_rate,
payment_gateway, gateway_merchant_id, min_app_version, offline_lease_days, status, …; systemAdmin.ts:62).

> Preyone itself is a transit company too: **Preyone Freights** (`3b4a6254…`, slug
> `preyone-transit`). The CEO account is not bound to it (Prechard is transit-bound to
> `b599bd87…` Mupota), which is fine because `system.developer` unlocks every section regardless.

## 4. Creating staff

### 4a. The self-signup flow (recommended)

1. Staff member registers: `POST /api/admin/auth/signup`
   `{ fullName, email, phone, password, role: "Staff" }` (src/routes/adminAuth.ts:109).
   - Enforces 1 CEO / 2 Managers globally; `Staff` rows are created `approved = false`.
   - Auto-binds `portal_company_id` **iff exactly one** `companies` row exists (current state: yes → Preyone).
2. CEO/Manager approves: `POST /api/admin/staff-approve/:id` (requires `company.admin`, admin.ts:1191),
   or the **Admin Users** page in the console (Staff list is `GET /api/admin/staff-pending`, admin.ts:1183).
3. Approved staff can then sign in and use any `Staff`-role section.

Other lifecycle endpoints (all `GET`/`POST`, `company.admin`): `staff-pending`, `staff-reject`,
`staff-status`, `staff-activate`, `staff-deactivate`, `staff-remove` (admin.ts:1183-1264).

### 4b. The critical WiFi rule (what bit Lesly)

The UltraNet WiFi workspace is a **level-0 / platform** surface. `App.tsx sectionAllowed` and the
sidebar treat a non-super-admin user as portal-only **only when `admin_users.company_id` is NULL**:

- `Sidebar.tsx` WiFi groups are `mode: 'platform'` → hidden when `isCompany` (`company_id` set).
- `App.tsx` grants the UltraNet sections to roles `Staff`/`Manager`/`CEO` on the level-0 path.

So a portal WiFi staff member must have:

```
company_id         = NULL        ← do NOT bind them to a transit company
portal_company_id  = 8def8d43-…  ← Preyone (the portal company)
```

Production fix applied for Lesly Muvirimi (`a17b342b…`, Staff, muvirimileslie@gmail.com):

```sql
UPDATE admin_users SET company_id = NULL WHERE id = 'a17b342b-ab92-45e9-8e84-08d96ae106d2';
```

Verified live afterwards: `GET /api/admin/auth/me` ⇒ `company_id: null`,
`portal_company_id: 8def8d43…`, `subscribed_modules: ["invoice","pos","wifi"]`,
`permissions: ["finance.view"]`; `GET /api/admin/vouchers` ⇒ 200.

A transit-bound staff member (company_id set) *cannot* see WiFi sections by design. If a console
user needs both realms, they must carry `system.developer` (reserved for the CEO).

### 4c. What a WiFi Staff member can actually do

- **Scope:** sees and sells only vouchers they sold (`sold_by = self`, admin.ts:211-214,
  `scopeVoucherCondition`).
- **Clock-in:** Staff must clock in before selling (`Vouchers.tsx` gate — `needsClockIn` for any
  non-CEO role).
- **Restricted tiers:** Staff cannot sell `PreMax` / `PreUltra` / `PreExecutive` without a
  management approval request (admin.ts:120-127).
- **Role permissions:** Staff has `finance.view` by default; extra capability = per-user grant:

```sql
INSERT INTO user_permissions (user_id, permission_code) VALUES ('<staff uuid>', 'company.admin');
```

## 5. CEO Super User prerequisites (summary)

- `admin_users.role = 'CEO'` + `email_verified = true` + `approved = true` (Prechard: all set).
- Permission `system.developer` (granted by role_permissions `CEO` and explicitly in
  `user_permissions` for `7ca54ebe…`).
- `system.developer` unlocks: `/api/v1/admin/*` (companies CRUD, feature flags, gateway keys,
  platform audit) and every console section in both realms.

## 6. Production notes

- Server: `deploy@158.220.118.91`, app `/opt/preyone-portal`, Node on port 5000, `pm2` name `preyone-portal`.
- DB: Postgres `captive_portal` (vars in `/opt/preyone-portal/.env`).
- The server copy is not a git repo — apply SQL with `psql` and re-run `src/db/migrate.ts` via the
  existing deployment process after code changes (see docs/ADMIN_HANDOFF.md, *Deployment & Drift*).