# Phase 1 — Preyone 360 Business Suite (marketing site)

Status: **IN PROGRESS** (started 2026-11-04)
Owner: Preyone
Source of truth: this file. If a new session picks this up, read this file first.

## Objective

Add a Diadyn-style "one suite, every part of your business" layer to **preyone.com**
without changing the existing genre, visual language, UI/UX, or backend.

Diadyn (https://diadyn.ai) sells 16 SaaS apps (CRM360, Project360, Billing360,
Finance360, HRM360, POS360…) plus servers, hosting and branding, priced app-by-app.
Preyone already runs most of the **real** products — the gap is packaging and
marketing them as one suite.

## Hard constraints

- Keep the existing dark theme, cyan/fuchsia accents, fonts, spacing and motion.
- Reuse existing components; do not introduce a new UI library.
- **Phase 1 is front-end only** — no API, DB, auth or backend changes.
- Do not touch the captive-portal voucher/RADIUS flows.
- Do not claim compliance/certifications Preyone does not hold (e.g. ZIMRA
  fiscalisation, ISO, PCI). Use "ready", "designed to support", or omit.

## Where the site lives

- Source: `preyone-ruijie-captive-portal/site`
- Routes: `site/src/App.tsx`
- Nav: `site/src/lib/data.ts` → `NAV_LINKS`
- Theme/utilities: `site/src/index.css` (`container-site`, `glass`, `mesh-card`,
  `chip`, `btn-primary`, `text-gradient`, `glow-cyan`)
- Existing components to reuse: `SectionHeading`, `Reveal`, `CountUp`, `TiltCard`,
  `ProjectCard`, `Logo`, `SocialLinks`
- Build: `cd site && npm run build && npm run optimize`
- Deploy: upload `site/dist` to `/opt/preyone-portal/site/dist` (see AGENTS.md)

## Phase 1 scope and status

| # | Item | Route | Status |
|---|------|-------|--------|
| 1 | "Preyone 360" suite page (hero, product grid, lead-to-cash panel, local-payments, pricing teaser, CTA) | `/business-apps` | **DONE (v1)** |
| 2 | Nav link "Business Apps" | — | **DONE** |
| 3 | Per-product detail pages (POS, Invoice, WiFi, Transit, Home, Console) | `/business-apps/:slug` | TODO |
| 4 | Pricing page with monthly/yearly toggle (static config) | `/pricing` | TODO |
| 5 | Partner programme page + application form (reuse contact flow) | `/partners` | TODO |
| 6 | Language switcher EN / SN / ND (front-end i18n) | — | TODO |
| 7 | Trust/metrics band + "Book a demo" CTA | home/suite | TODO |
| 8 | Optional: wire real subscription checkout via existing `/api/subscription` | — | TODO (needs backend review) |

## Product map (what is actually live)

| Product | Real system | Host |
|---|---|---|
| POS360 | Sales / stock / receipts / X-report | `pos.preyone.com` |
| Invoice360 | 12 document types, UBL export, AR aging | `invoice.preyone.com` |
| WiFi360 | Ruijie captive portal, vouchers, RADIUS | `wifi.preyone.com` |
| Transit360 | Bus ticketing / transit | app + `bus-ticket-app` |
| Home360 | IoT devices, telemetry, triggers | `homeautomate.preyone.com` |
| Console360 | Multi-tenant admin, billing, settings | `admin.preyone.com` |
| CRM360 / HR360 / Project360 | **Roadmap** — do not imply live | — |

## Design notes for the suite page

- Hero mirrors Diadyn's "One suite. Every part of your business." but in Preyone's
  voice and palette.
- Product cards show a **Live** badge for real systems and **Roadmap** for unbuilt ones.
- "Lead to cash" panel is **illustrative static data**, labelled as such.
- Pricing teaser says "priced per app, monthly or yearly" with a "Request pricing"
  CTA — no invented prices.
- "Built for Zimbabwe" section: USD/ZWG, EcoCash/ZimSwitch/Visa/Mastercard,
  Harare-based support, local hosting. No unverified compliance claims.
- All CTAs point to `/#contact` (existing contact section) or WhatsApp.

## Files created in v1

- `site/src/lib/suite.ts` — content model for the suite page
- `site/src/pages/BusinessAppsPage.tsx` — the page
- `site/src/App.tsx` — added `/business-apps` route
- `site/src/lib/data.ts` — added nav link

## Acceptance criteria (v1)

- [x] `npm run build` passes (tsc + vite) — 2026-11-04
- [ ] `/business-apps` renders on desktop and mobile (local preview: `http://127.0.0.1:4173/business-apps`)
- [ ] Nav link works and closes the mobile menu
- [ ] No console errors
- [ ] Existing pages unchanged
- [ ] `dist` deployed and live URL returns 200

## Next session checklist

1. Read this file and `AGENTS.md`.
2. Run `git -C preyone-ruijie-captive-portal status` to see what is uncommitted.
3. Continue at the first TODO in the table above (per-product pages).
4. Build, verify, then deploy only after the user approves the design.

## Open questions for the user

- Should the suite page live at `/business-apps` (Diadyn parity) or `/suite`?
- Which products should be shown as "Roadmap" vs hidden?
- Is there approved pricing to publish, or keep "Request pricing"?
- Should the AI assistant be a later phase (needs backend + LLM key)?
