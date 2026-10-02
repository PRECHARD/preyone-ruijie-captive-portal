# Admin API Handoff Interface

> Source of truth: `src/routes/admin.ts` (mounted at `/api/admin`) — mirrors the build shipped to production (`/opt/preyone-portal`).
> Generated from the **102** `adminRouter.*` route handlers, grouped by functional module.

## Scope

| Area | Router | Base path | Route count |
| --- | --- | --- | --- |
| Admin console API | `adminRouter` (`src/routes/admin.ts`) | `/api/admin` | 102 |
| Admin auth (login / me / logout / forgot / reset) | `adminAuthRouter` (`src/routes/adminAuth.ts`) | `/api/admin/auth` | 8 |
| Tenancy subscriptions (exposed to admin via `/me`) | `posRouter` (`src/routes/pos.ts`) | `/api/pos/company/subscriptions` | 1 |

## Required headers

| Header | Required | Purpose |
| --- | --- | --- |
| `Authorization: Bearer <token>` | **Yes — every `/api/admin/*` route** | HS256 JWT signed with `JWT_SECRET`. `adminRouter.use(requireAdminAuth)` rejects `401 Unauthorized` when missing/invalid. Payload: `{ id, email, role, fullName }` (24h legacy / **7d** since the SSO rollout). |
| `Content-Type: application/json` | Yes — for bodies | JSON request bodies (`express.json()`, 5 MB cap). |
| `x-tenant-id` | **Not consumed** | Documented for forward-compat only. Tenancy is **derived server-side** from the token's `admin_users.company_id` (transit tenant) and the singleton `companies` profile row (subscriptions). The API deliberately ignores client-supplied tenant headers so a caller can never switch tenant. |

## Auth & RBAC model

- JWT verified with `jsonwebtoken` (`algorithms: ['HS256']`) inside `src/middleware/adminAuth.ts`.
- Roles: `CEO` > `Manager` > `Staff`, enforced by `requireRole(...)` inline per route.
- `any-authed` = any authenticated admin (Staff included) — but data is **scoped to the caller**: e.g. `GET /users` returns only tills sold by a Staff account; Staff must be **clocked in** to sell vouchers; bulk-voucher creation requires an approval request.
- Shared session across subdomains: `POST /api/admin/auth/login` and `/api/admin/auth/me` accept the HTTP-Only wildcard cookie `preyone_token` (`Domain=.preyone.com`) as a fallback to the Bearer header (`resolveAuthToken` in `src/utils/ssoCookie.ts`).

## 1. Staff

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/users` | any-authed | Portal users; Staff scoped to own voucher sales |
| GET | `/api/admin/staff` | CEO/Manager | Staff list |
| GET | `/api/admin/staff-pending` | CEO/Manager | Unapproved staff |
| POST | `/api/admin/staff-approve/:id` | CEO/Manager | Approve staff |
| POST | `/api/admin/staff-reject/:id` | CEO/Manager | Reject staff |
| GET | `/api/admin/staff-status` | CEO/Manager | Online/offline status |
| POST | `/api/admin/staff-deactivate/:id` | CEO/Manager | Deactivate staff |
| POST | `/api/admin/staff-activate/:id` | CEO/Manager | Reactivate staff |
| POST | `/api/admin/staff-remove/:id` | CEO/Manager | Remove staff |
| GET | `/api/admin/staff/stats` | any-authed | Staff dashboard stats (own data) |
| GET | `/api/admin/clock-status` | any-authed | Current clock state |
| POST | `/api/admin/clock-in` | any-authed | Open shift (required before selling) |
| POST | `/api/admin/clock-out` | any-authed | Close shift |
| GET | `/api/admin/time-logs` | any-authed | Shift/time logs |
| GET | `/api/admin/managers` | CEO | Manager list |
| POST | `/api/admin/manager-promote/:id` | CEO | Promote to Manager |
| POST | `/api/admin/manager-demote/:id` | CEO | Demote Manager |
| POST | `/api/admin/manager-remove/:id` | CEO | Remove Manager |
| GET | `/api/admin/admin-users` | CEO/Manager | Admin console accounts |

## 2. Vouchers

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/vouchers` | any-authed | List vouchers (scoped by role) |
| POST | `/api/admin/vouchers` | any-authed | Create single voucher (Staff: clocked-in only) |
| POST | `/api/admin/vouchers/bulk` | any-authed | Bulk creation — Staff requires approval |
| POST | `/api/admin/vouchers/request-approval` | Staff→CEO/Mgr | Submit bulk/restricted-tier request |
| GET | `/api/admin/vouchers/pending-approvals` | CEO/Manager | Pending requests queue |
| POST | `/api/admin/vouchers/approvals/:id/approve` | CEO/Manager | Approve request |
| POST | `/api/admin/vouchers/approvals/:id/reject` | CEO/Manager | Reject request |
| GET | `/api/admin/vouchers/my-approvals` | any-authed | Requestor's own history |
| GET | `/api/admin/voucher-redemptions` | any-authed | Redemption ledger |

## 3. Sales, Dashboard & Reporting

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/my-sales` | any-authed | Own sales |
| GET | `/api/admin/my-sales/export` | any-authed | Own sales (Excel) |
| GET | `/api/admin/staff-sales` | CEO/Manager | Aggregated staff sales |
| GET | `/api/admin/staff-sales/export` | CEO/Manager | Aggregated (Excel) |
| GET | `/api/admin/staff-sales/export/:staffId` | CEO/Manager | Per-staff (Excel) |
| GET | `/api/admin/dashboard` | CEO/Manager | Consolidated dashboard (cached 30s) |
| GET | `/api/admin/dashboard/sales` | CEO/Manager | Daily/weekly/monthly |
| GET | `/api/admin/revenue` | CEO/Manager | Revenue series |
| GET | `/api/admin/revenue/export` | CEO | CSV export |
| GET | `/api/admin/charts` | CEO/Manager | Chart series |
| GET | `/api/admin/customer-kpis` | CEO/Manager | Customer KPIs |
| GET | `/api/admin/cash-handovers/available-sales` | any-authed | Sales eligible for handover |
| POST | `/api/admin/cash-handovers` | any-authed | Submit handover |
| GET | `/api/admin/cash-handovers/pending` | CEO/Manager | Pending handovers |
| POST | `/api/admin/cash-handovers/:id/approve` | CEO/Manager | Approve handover |
| POST | `/api/admin/cash-handovers/:id/reject` | CEO/Manager | Reject handover |
| GET | `/api/admin/cash-handovers/my` | any-authed | Own handover history |

## 4. AP Health & Network

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/ap-devices` | any-authed | AP device inventory |
| POST | `/api/admin/ap-devices` | any-authed | Register AP |
| PUT | `/api/admin/ap-devices/:id` | any-authed | Update AP |
| DELETE | `/api/admin/ap-devices/:id` | any-authed | Remove AP |
| GET | `/api/admin/ap-health` | any-authed | AP health snapshot |
| GET | `/api/admin/alerts` | any-authed | Alerts (scoped to addressee) |
| POST | `/api/admin/alerts/:id/acknowledge` | any-authed | Acknowledge alert |
| GET | `/api/admin/blacklist` | any-authed | Blacklist |
| POST | `/api/admin/blacklist` | any-authed | Add entry |
| DELETE | `/api/admin/blacklist/:id` | any-authed | Remove entry |
| GET | `/api/admin/whitelist` | any-authed | Whitelist |
| POST | `/api/admin/whitelist` | any-authed | Add entry |
| DELETE | `/api/admin/whitelist/:id` | any-authed | Remove entry |
| POST | `/api/admin/kill-sessions` | CEO | Force session teardown |

## 5. Packages & QoS

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/packages` | any-authed | Public package list (`price_amount` ASC) |
| GET | `/api/admin/packages/manage` | CEO | Manage view |
| POST | `/api/admin/packages` | CEO | Create package |
| PUT | `/api/admin/packages/:id` | CEO | Update package |
| DELETE | `/api/admin/packages/:id` | CEO | Delete package |
| GET | `/api/admin/qos-view` | any-authed | QoS dashboard |
| GET | `/api/admin/bandwidth` | any-authed | Bandwidth usage |
| GET | `/api/admin/bandwidth/top-users` | any-authed | Top consumers |
| POST | `/api/admin/bandwidth/snapshot` | any-authed | Force snapshot |
| GET | `/api/admin/peak-hours` | CEO/Manager | Peak usage pattern |

## 6. Backups, Maintenance & Retention

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| POST | `/api/admin/backup` | CEO | Trigger backup |
| GET | `/api/admin/backup/logs` | CEO | Backup history |
| GET | `/api/admin/maintenance` | CEO | Maintenance state |
| PUT | `/api/admin/maintenance` | CEO | Toggle maintenance |
| GET | `/api/admin/retention` | CEO | Retention policy |
| PUT | `/api/admin/retention` | CEO | Update retention |
| GET | `/api/admin/report-schedules` | CEO | Scheduled reports |
| POST | `/api/admin/report-schedules` | CEO | Create schedule |
| PUT | `/api/admin/report-schedules/:id` | CEO | Update schedule |
| DELETE | `/api/admin/report-schedules/:id` | CEO | Remove schedule |

## 7. Commissions

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/commissions` | CEO | Commission structure |
| PUT | `/api/admin/commissions/:staffId` | CEO | Set staff commission |

## 8. Branding, Company Profile & Devices

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/branding` | CEO | Branding settings |
| PUT | `/api/admin/branding` | CEO | Update branding |
| GET | `/api/admin/company` | CEO | Company profile (singleton `companies`) |
| PUT | `/api/admin/company` | CEO | Update company profile |
| GET | `/api/admin/devices` | CEO/Manager | POS endpoint devices |
| POST | `/api/admin/devices` | CEO/Manager | Register device |
| PUT | `/api/admin/devices/:id` | CEO/Manager | Update device |
| POST | `/api/admin/devices/:id/suspend` | CEO/Manager | Suspend device |
| POST | `/api/admin/devices/:id/activate` | CEO/Manager | Activate device |
| DELETE | `/api/admin/devices/:id` | CEO | Delete device |

## 9. Subscriptions (tenancy)

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/pos/company/subscriptions` | any-authed (POS chain) | `{ company, plan_tier, modules: [invoice,pos,wifi] }` for the singleton profile company |
| GET | `/api/admin/auth/me` | Bearer or SSO cookie | Returns `tenant_id` + `subscribed_modules` alongside the admin user |

Subscriptions are **not** CRUD-exposed on `/api/admin` — they are seeded/implicit (every profile company is subscribed to all three modules) and surfaced read-only. Plan `plan_tier` defaults to `enterprise`.

## 10. Sessions, Broadcasts, Settings & Audit

| Method | Endpoint | Access | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/active-sessions` | any-authed | Real-time usage/sessions |
| GET | `/api/admin/access-log` | any-authed | Access log events (last 7d, grouped by hour) |
| GET | `/api/admin/notifications/count` | any-authed | Unread count |
| POST | `/api/admin/notifications/acknowledge` | any-authed | Acknowledge |
| POST | `/api/admin/broadcast` | CEO | Create broadcast |
| GET | `/api/admin/broadcasts` | any-authed | Broadcast list |
| POST | `/api/admin/broadcasts/:id/read` | any-authed | Mark read |
| POST | `/api/admin/broadcasts/read-all` | any-authed | Mark all read |
| GET | `/api/admin/settings` | CEO | System settings |
| PUT | `/api/admin/settings` | CEO | Update settings |
| GET | `/api/admin/audit-log` | CEO | Admin audit trail |

**Totals:** 102 routes in `admin.ts` (grouped into the 9 sections above) + 8 `adminAuth` routes + the subscriptions surface **≈ 110+ endpoints** in the admin-facing API.

## Examples

Log in (sets Bearer token + SSO cookie):

```
POST /api/admin/auth/login
Content-Type: application/json

{ "email": "ceo@preyone.com", "password": "…" }

→ 200 { "token": "<jwt>", "user": { … } }
```

Call a guarded admin endpoint:

```
GET /api/admin/dashboard
Authorization: Bearer <jwt>

→ 200 { … dashboard payload … }
```

Inherit a session on another subdomain (no Bearer — cookie only):

```
GET /api/admin/auth/me
Cookie: preyone_token=<jwt>            # Domain=.preyone.com; HttpOnly; Secure

→ 200 { id, full_name, email, role, company_id, tenant_id, subscribed_modules: [ "invoice", "pos", "wifi" ] }
```