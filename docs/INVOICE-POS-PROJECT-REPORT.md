# Preyone Invoice & POS — Project Report & Development Plan

_Generated 2026-10-08 from the live systems and working trees. Companion to `docs/PROJECT-REPORT.md` (whole-ecosystem report, 2026-09-27); this document is the **planning baseline for the Invoice + POS workstream**._

---

## 1. Executive summary

Two customer-facing products share one financial data spine:

- **Preyone Enterprise Invoice & Quotation System** (`invoice.preyone.com`) — office document engine: drafts invoices/quotations, records part-payments, renders branded HTML + PDF (headless Chrome), client & catalogue management, per-role permissions.
- **Preyone Web POS** (`pos.preyone.com`) — browser till: PIN login, shifts (X-report), quick sales, invoices & quotations from the counter, stock tracking, receipt PDF/WhatsApp sharing.

Both read and write the **same PostgreSQL database (`captive_portal`)** and the **same tables** (`pos_documents`, `pos_document_items`, `pos_document_payments`, `pos_customers`, `pos_products`), share the **document-number sequence** (`pos_doc_number_seq` → `INV-/RCP-/QUO-####`) and the **same user directory** (`admin_users`, SSO session cookie on `.preyone.com`). An invoice issued in the office appears on the till and vice-versa; a payment taken at either end settles the same document.

**Status:** data unification is complete and live (see §8). The remaining work is product polish, branding consolidation, automated tests, and payment/reminder features (see §10).

---

## 2. Component inventory

| Component | Location | Stack | Served at |
|---|---|---|---|
| **Invoice web app** | `Invoice Preyone enterprise/Invoice Preyone enterprise/preyone-invoice-system/` (own git repo) | React 18 + Vite 5 (client `src/`), Express + `pg` + puppeteer-core (server `server/`) | `invoice.preyone.com` → nginx → `127.0.0.1:4000` (pm2 `preyone-invoice`, cwd `/opt/preyone-invoice`) |
| **POS web app** | `preyone-ruijie-captive-portal/pos/` (this repo) | React 19 + TypeScript + Vite 8, jspdf receipts | `pos.preyone.com` → nginx → portal Express `:5000` → `pos/dist` |
| **Portal backend (monolith)** | `preyone-ruijie-captive-portal/src/` | Node + TS + Express + pg | All `*.preyone.com` APIs; POS API under `/api/pos/*` (`src/routes/pos.ts`, 1213 lines) |
| **Admin console** | `preyone-ruijie-captive-portal/admin/` | React 19 + Vite | POS reports, shifts, vouchers (`admin.preyone.com`) |
| **Enterprise gateway** | `preyone-ruijie-captive-portal/app/` | React 19 + Vite | `app.preyone.com` — SSO launcher with Invoice/POS/WiFi/Admin modules |

Invoice app internal structure:

```
preyone-invoice-system/
├── server/
│   ├── index.js          # Express app: auth, clients, items, documents, PDF, settings
│   ├── store.js          # ALL data access — shared Postgres (pos_* tables)
│   ├── auth.js           # session cookie (.preyone.com SSO), roles, audit log, company scope
│   ├── renderDocument.js # print page HTML (shared with client docLayout)
│   ├── pdf.js            # puppeteer-core → PDF download
│   ├── browsers.js       # headless Chrome discovery
│   └── data/             # settings.json only (gitignored; db.json = legacy, read once for migration)
├── src/
│   ├── App.jsx           # shell + views: dashboard | editor | clients | settings | login
│   ├── api.js            # fetch wrapper (credentials: include)
│   ├── components/       # Dashboard, Editor, Clients, DocumentSheet, Settings, Login
│   ├── lib/              # calc.js (totals), docLayout.js, format.js
│   └── styles/           # tokens.css, app.css, document.css, fonts.css
└── scripts/dev.mjs       # vite + server concurrently
```

POS app internal structure: `src/components/` — `Terminal` (cart + doc type: sale/invoice/quotation), `CheckoutModal` (multi-part payments, Pesepay rails), `HistoryView` (all documents + take-payment), `PaymentModal`, `StockManager`, `ShiftGate`/`XReportModal`, `PinLogin`, `ReceiptModal`; `src/api.ts` = typed client for `/api/pos/*`.

---

## 3. Architecture

```
                    ┌────────────────────────── nginx (TLS) ──────────────────────────┐
 invoice.preyone.com│─→ 127.0.0.1:4000        pos.preyone.com│─→ 127.0.0.1:5000     │
                    └───────────┬─────────────────────────────┬───────────────────────┘
                                │                             │
                     pm2 preyone-invoice              pm2 preyone-portal ×4 (cluster)
                     (Express, /opt/preyone-invoice)  (Express, /opt/preyone-portal)
                                │                             │
                                └──────────┬──────────────────┘
                                           ▼
                            PostgreSQL :5432  db=captive_portal
                            pos_documents · pos_document_items · pos_document_payments
                            pos_customers · pos_products · pos_shifts
                            pos_doc_number_seq · companies · admin_users · pesepay_intents
```

- One Node process per app; no message queue, no cache — Postgres is the single source of truth.
- Pesepay online payments: portal `src/routes/payments.ts` accepts `targetType: 'invoice'` and settles **`pos_documents` rows directly** (amount_paid/status update) — invoices can be paid online today via the portal gateway.
- Dev: `node scripts/dev-pos.mjs` (portal repo) boots a throwaway Postgres on **:5433, db `preyone_pos`, data in `.pgdata-dev`**; the invoice app's `store.js` defaults to exactly that, so both dev servers share it.

---

## 4. Data model (the shared spine)

| Table | Role | Key columns |
|---|---|---|
| `pos_documents` | All documents: sale, invoice, quotation | `doc_number` (UNIQUE, from `pos_doc_number_seq`), `doc_type`, `channel` (`till`/`office`/`online`), `status` (`draft`/`unpaid`/`sent`/`partial`/`paid`/`void`), `company_id` **NOT NULL** → `companies`, `customer_id`, `cashier_id`, `shift_id`, `subtotal`, `discount_pct`, `tax_pct`, `total`, `amount_paid`, `issue_date`, `due_date` |
| `pos_document_items` | Line items | `document_id`, `product_id` (nullable link to catalogue), `description`, `price`, `qty`, `line_total`, `position` |
| `pos_document_payments` | Payment ledger (installments) | `document_id`, `amount`, `method`, `reference`, `recorded_by`, `paid_at`, `shift_id` |
| `pos_customers` | Shared customer book | `company_id` **nullable** — NULL = shared/legacy visible to every tenant; app-created rows are tenant-stamped |
| `pos_products` | Shared catalogue | `price`, `track_stock`, `stock_qty` (decremented by BOTH checkout and office invoice creation), `active` |
| `pos_shifts` | Till shifts | opened/closed by cashier, `expected_cash`/`counted_cash`/`variance`; X-report |
| `companies` | Tenancy root | one row today: **Preyone** (`8def8d43-662b-4ab5-8a05-087a36005f4f`) |
| `admin_users` | Identity for everything | `role` (`CEO`/`Manager`/`Staff` + portal roles), `portal_company_id`, PIN (till login), `password_hash` (invoice/admin login) |
| `pesepay_intents` | Online payments | `target_type` ∈ `invoice`/`shift`/`subscription` |

**Status derivation:** `statusForPaid()` (pos.ts:596) — paid ≥ total → `paid`; paid > 0 → `partial`; else `unpaid` (`sent` for quotations). Invoice app's `mapStatus` accepts `draft/unpaid/sent/partial/paid`.

**Payment methods** (portal): `cash, card, ecocash, innbucks, paygo, omari, bank, pesepay, other`. Pesepay rails actually enabled at the till (verified against gateway): EcoCash, InnBucks, PayGo, Omari.

---

## 5. Auth & tenancy

- **Invoice app:** `POST /api/auth/login` (email + password against `admin_users`, bcrypt) → signed session cookie **scoped to `.preyone.com` in production** (SSO shared with portal/admin), `requireAuth` on everything below `/api/auth/me`. Roles: `CEO`/`Manager` can void, delete clients, manage catalogue, edit settings; `Staff` may draft.
- **Company scope:** `requireCompanyScope(req.user)` → `portal_company_id`; `companyIdFor()` order = per-user scope → `INVOICE_COMPANY_ID` env override → single-company fallback (throws 403 when several companies exist and no scope). **Never** taken from request body/query.
- **POS:** PIN login (`POST /api/pos/auth/pin`) → JWT Bearer (localStorage) + cookie; `tenantId(req)` from the JWT, always the first SQL predicate.
- **Audit:** invoice app writes `auditLog` entries (login, create, update, void).

---

## 6. API surface

**Invoice app (Express, `/api/*`, port 4000):**

| Method & path | Notes |
|---|---|
| `GET /api/health`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | health + SSO session |
| `GET/POST/PUT/DELETE /api/clients[/:id]` | `pos_customers`, tenant-scoped; DELETE refuses shared rows |
| `GET/POST/PUT/DELETE /api/items[/:id]` | `pos_products`, shared catalogue, Manager+ writes |
| `GET/POST /api/documents`, `GET/PUT/DELETE /api/documents/:id` | list excludes `sale` + `void`; DELETE = void (Manager+); duplicate `POST /documents/:id/duplicate` |
| `GET /api/documents/:id/pdf` | puppeteer renders `/print/:id` with per-boot token |
| `GET/PUT /api/settings` | branding JSON file (⚠ not the portal `companies` row — see §9.2) |
| `GET /print/:id` | print page (session or render token) |

**POS (portal, `/api/pos/*`, port 5000):** `auth/operators|pin|set-pin`, `products` CRUD + `:id/stock`, `customers` CRUD + `:id/statement`, `shifts` (current/open/close/list), `documents` (list with `type/status/q/from/to/cashier/limit`, get, `convert-to-invoice`), `checkout` (creates any doc_type, stock-checked, shift-aware), `documents/:id/payments` (installment), `documents/:id/void` (Manager+, restocks), `dashboard`, `reports/summary|sales|sales`.

---

## 7. Environments

| | Development | Production |
|---|---|---|
| Postgres | `localhost:5433`, db `preyone_pos` (throwaway, `.pgdata-dev`) | `localhost:5432`, db `captive_portal`, user `postgres` |
| Invoice app | `npm run dev` (vite + server); store.js defaults match dev DB | pm2 `preyone-invoice` ×cluster, `/opt/preyone-invoice`, `--env-file=.env` (`PORT=4000`, `DB_*`, `NODE_ENV=production`) |
| POS | via portal `npm run dev` (serves `pos/dist` build or vite dev) | pm2 `preyone-portal` ×4, `/opt/preyone-portal`, `pos/dist` |
| Deploy | — | build → `tar` → `scp` → extract; **no pm2 restart needed for static dists** (Express reads from disk); backend changes need `pm2 restart preyone-portal` |

Production facts (verified 2026-10-08): 1 company (**Preyone**); 2 documents exist (both office invoices from 2026-10-05); `admin@preyone.com` (CEO) and one Staff account assigned to the company.

---

## 8. Current state — what is unified (baseline)

Already in place before this session (invoice repo, commits `c45ccff`, `ddd73bc`):

- ✅ Invoice app moved from file store to the **shared Postgres** (`server/store.js` — all `pos_*` tables).
- ✅ Shared auth: `admin_users` + `.preyone.com` SSO cookie + tenant scope (`portal_company_id`).
- ✅ Shared document sequence — no number collisions between office and till.
- ✅ Stock: office invoices decrement `pos_products.stock_qty` at creation, same as checkout.
- ✅ Payments made in the invoice app land in `pos_document_payments` (visible to the till).
- ✅ Pesepay online payment of invoices (`targetType='invoice'` → settles `pos_documents`).
- ✅ Quote → invoice conversion (portal `convert-to-invoice`; invoice app converts via `PUT type` re-issue).

Delivered **this session** (POS frontend, uncommitted at time of writing — see git):

- 🔧 **History shows every document type** — was hard-filtered to `type='sale'`, so *no invoice ever appeared on the till*. Now tabs **All / Sales / Invoices / Quotations** with type badges and per-row `due` amounts (`pos/src/components/HistoryView.tsx`, `api.ts documents(type?)`).
- 🔧 **Take payment at the till** — new `PaymentModal.tsx` + `api.recordPayment()` finally exercises the existing backend `POST /documents/:id/payments` (office invoices can be settled at the counter).
- 🔧 **Balance bug fixed** — opening an unpaid invoice from history rendered *"PAID IN FULL"* (`balanceDue` was `NaN`; server list/get endpoints don't compute it). Now `total − amount_paid` client-side.

Verified: `tsc` clean, POS build green, portal tests **280/280**, deployed to `pos.preyone.com` (bundle `index-CA3JaZnw.js`).

---

## 9. Known gaps & issues

1. **Two branding sources.** Invoice PDFs read `server/data/settings.json` (local file, per-server); POS receipts read the `companies` row (`GET /api/pos/company` — name, address, currency, `tax_pct`, prefixes, terms). Editing one does not update the other → invoices and receipts can drift.
2. **Tax default drift.** Invoice editor hardcodes `taxRate: 15.5` (`src/App.jsx` `blankDoc`); portal `companies.tax_pct` is the till's truth. No single VAT source.
3. **No tests on either new app.** Portal has 280 vitest tests; `preyone-invoice-system` has **no test script at all**, POS has none either. `store.js` (606 lines of financial SQL) is the highest-risk untested code.
4. **History list caps at 500 rows** (`LIMIT` clamped in pos.ts:639), no pagination/infinite scroll; invoice list caps at 500 too.
5. **Invoice UI doesn't distinguish source** — a till-issued invoice and an office invoice look identical (no `channel`/cashier shown); `channel` is written but never rendered on the invoice side.
6. **`pos/dist` is gitignored** (unlike `admin/dist`, which is force-tracked). Production POS builds exist only on the server; a server loss loses the exact artifact (sources are safe — rebuild is deterministic).
7. **No README in the invoice repo** and (until this report) no remote — bus-factor risk for collaborators.
8. **Single-company assumption is load-bearing.** Adding a second tenant requires every unassigned `admin_users` row to get `portal_company_id` before the invoice app will accept writes (it throws 403 by design rather than guess).
9. **Void asymmetry.** Voids restock products on the portal side; the invoice app's `deleteDocument` only sets `status='void'` — it does **not** restock or check Manager-originated stock implications (documents created there never decremented stock for non-catalogue lines, but catalogue-matched lines did decrement).

---

## 10. Development roadmap (proposal)

### Phase 0 — Done (this session)
- POS history for all document types, till-side installment payments, balance-due fix; this report; repos in git (§11).

### Phase 1 — Consolidate (small, high value)
- **Single source of truth for branding/tax:** point invoice `GET/PUT /api/settings` at the `companies` row (keep `settings.json` only as offline fallback); remove `taxRate: 15.5` hardcode → load `tax_pct` from settings.
- **Source badges:** render `channel` + cashier in the invoice document list/detail ("Till · cashier X" vs "Office").
- **Restock-on-void parity:** invoice-app void calls the same restock logic as portal void (extract shared SQL or call portal endpoint).
- **Tests:** vitest + supertest for `store.js` (create/update/void/payment/tenant-isolation) against the throwaway dev DB; a smoke test per POS component.
- **Pagination:** keyset pagination on both document lists.

### Phase 2 — Payments & collection
- **Payment links:** expose Pesepay checkout for an office invoice (portal already supports `targetType='invoice'` — build the "Send payment link" button + WhatsApp share of the link from the invoice app).
- **Reminders:** overdue list (`due_date < today AND status ∈ unpaid/partial`) with WhatsApp/e-mail nudge templates.
- **Receipts for office payments:** print an acknowledgment from the invoice app using the shared receipt layout.
- **Reconciliation report:** payments by method/day across till + office (admin console already has an Accounting tab — extend to invoice-channel docs).

### Phase 3 — Product polish
- Client statements in the invoice app (`/customers/:id/statement` exists on portal — reuse or mirror).
- Recurring invoices & quote templates; saved line-item presets (shared `pos_products` — add categories/images).
- Deposit/down-payment terms, late fees, multi-currency display (portal `companies.currency`).
- PWA/offline draft support for the invoice editor (documents queue → sync).
- Unify launcher UX: `app.preyone.com` gateway tile opens invoice/POS with SSO (already cookie-shared — verify + polish).

### Phase 4 — Hardening & ops
- README + deploy script for the invoice repo (`build → tar → scp → /opt/preyone-invoice → pm2 restart preyone-invoice`), mirroring portal conventions.
- CI on both repos (typecheck + tests + build).
- Track or explicitly document `pos/dist` artifact policy; add smoke check (live asset hash) to deploys.
- Multi-tenant dry-run: second company + scope matrix test.

---

## 11. Repos & file map

| Repo | Remote | Contains |
|---|---|---|
| `preyone-ruijie-captive-portal` | `https://github.com/PRECHARD/preyone-ruijie-captive-portal.git` (origin, main) | Portal backend, admin console, POS app, gateway, site, captive portal + **this report** (`docs/INVOICE-POS-PROJECT-REPORT.md`) |
| `preyone-invoice-system` | `https://github.com/PRECHARD/preyone-invoice-system.git` (created with this report) | Invoice web app (client + server) + copy of this report (`docs/INVOICE-POS-PROJECT-REPORT.md`) |

**Working trees (local):**
- Portal: `D:\My Properties\Work Station\Dev Projects\Web Development Projects\preyone-ruijie-captive-portal`
- Invoice: `D:\My Properties\Work Station\Preyone Branding\Preyone Photo & Documents Editing\Preyone Invoice\Invoice Preyone enterprise\Invoice Preyone enterprise\preyone-invoice-system`

**Deployment paths (server `deploy@158.220.118.91`):** `/opt/preyone-portal` (backend + admin/dist + pos/dist + app/dist), `/opt/preyone-invoice` (invoice app + its `.env`).

---

_This document is the planning baseline. Update §8/§9 as phases complete; keep the companion ecosystem report (`docs/PROJECT-REPORT.md`) for cross-project context._
