# AGENTS.md — Preyone UltraNet Captive Portal

## Project Overview
Ruijie captive portal system for Preyone UltraNet Wi-Fi. Voucher-based internet access with gateway integration via RADIUS and ext_login.

## CRITICAL: DO NOT MODIFY

The following files and flows are confirmed working and MUST NOT be changed without explicit user approval:

### Voucher Redemption Flow
- **`src/routes/auth.ts`** — `POST /api/auth/signup` handler (lines 42-192)
  - Voucher validation, user creation, session creation, WISPr profile creation
  - Phone/email are optional for quick voucher signup
  - Returns JSON with `redirectUrl` pointing to ext_login

### Gateway Redirect Logic
- **`src/utils/redirect.ts`** — `buildRuijieSuccessUrl()` function (lines 38-112)
  - Redirects DIRECTLY to ext_login URL (not through /api/auth/extauth)
  - Sets `url`/`redirect` params to originalUrl (the URL user was trying to visit)
  - DO NOT change this to redirect to success.html or any other URL

### CSP Configuration
- **`src/index.ts`** — `formAction: ["*"]` (line 38)
  - CRITICAL: allows form POSTs to gateway ext_login at 192.168.x.1:2060
  - DO NOT change to `'self'` — it will silently break internet access

### FreeRADIUS Config (on VPS)
- **NOT WIRED UP (verified 2026-10-02).** The claims below were aspirational, not real:
  - ~~`/etc/freeradius/3.0/mods-enabled/rest` — REST module pointing to localhost:3000~~ — the `rest` module is **not enabled**; no `rest` reference exists in `sites-enabled` or `policy.d`
  - ~~`/etc/freeradius/3.0/clients.conf` — gateway client with secret `preyone@radius2024`~~ — `clients.conf` has only `localhost`/`localhost_ipv6` with secret `testing123`; **no gateway client**
- Container `preyone-radius` runs `/usr/sbin/freeradius` (not `radiusd`); its healthcheck calls `radiusd` and so reports `unhealthy` permanently — a false alarm, not a service fault
- `mods-available/rest` has `connect_uri = "http://127.0.0.1/"` with URIs like
  `/user/%{User-Name}/mac/%{Called-Station-ID}?action=authorize`, which do **not** match the
  portal's `GET /api/radius/auth?username=&mac=` — enabling it needs an nginx rewrite or new URIs
- Radiusd log shows only rejected internet-scanner requests; the gateway has never authenticated
- Portal is reachable from FreeRADIUS: nginx :80 → portal :5000
- Firewall `1812/udp` + `1813/udp` ALLOW — correct
- See `docs/EG105G-P-Gateway-Config.md` section 7 to wire it up
- DO NOT modify without testing RADIUS auth end-to-end

### Gateway Config (EG105G-P)
- Auth Mode: External Portal / Web Authentication
- RADIUS: 173.249.7.190:1812 (auth), :1813 (acct)
- ext_login: port 2060
- Gateway must be rebooted after RADIUS config changes

## Architecture

```
Phone → Ruijie AP (WiFi) → EG105G-P Gateway → VPS (173.249.7.190)
                                    |
                              FreeRADIUS 3.2.5
                                    |
                              Node.js Portal (PM2)
                                    |
                              PostgreSQL
```

## Auth Flow (Working)
1. Phone connects → gateway intercepts HTTP → redirects to portal
2. User enters voucher → POST /api/auth/signup → session + WISPr created
3. Server returns ext_login URL → phone navigates to it
4. Gateway ext_login authorizes MAC → redirects to original URL
5. Gateway reboot → RADIUS auth → FreeRADIUS returns Accept → internet works

## Key Gotchas
1. CSP `formAction: 'self'` silently blocks POST to gateway ext_login
2. Gateway needs reboot after RADIUS config changes
3. portal.js `redirectToSuccess()` corrupts ext_login URLs (adds duplicate params)
4. ext_login `url`/`redirect` must be the ORIGINAL URL, not success.html
5. Ruijie AP `login_url` varies per AP model
6. FreeRADIUS auth requests come from gateway, not our portal

## VPS Access (production)

- SSH: `ssh -i ~/.ssh/id_opencode deploy@158.220.118.91`
- User `deploy` (key auth only, root login disabled). NOPASSWD sudo — use `sudo` for privileged ops.
- Fail2Ban on sshd: if banned, add your IP ASAP with `fail2ban-client set sshd addignoreip <ip>`.
- Ports: 22 SSH, 80/443 HTTP(S) behind nginx, 1812/1813 UDP RADIUS.

### Services on the VPS
| Service | Runs where | Port |
|---------|------------|------|
| Portal (PM2 `preyone-portal`) | `/opt/preyone-portal` | 5000 |
| PostgreSQL | Docker `preyone-db` | 5432 |
| Redis | Docker `preyone-redis` | 6379 |
| FreeRADIUS | Docker `preyone-radius` | 1812/1813 UDP |
| nginx | host | 80/443 (HTTPS via Certbot) |

### Deploy checklist (this project)
1. Build locally: `npm run build` (tsc)
2. Build admin SPA: `cd admin && npm install && npm run build` (vite)
3. Build site SPA: `cd site && npm install && npm run build && npm run optimize` (vite; sharp generates WebP/AVIF images)
4. Upload tarball of repo (exclude `.git`, `node_modules`, `android`, `bus-ticket-app`) → `/opt/preyone-portal`, extract (preserve `.env` + `node_modules`)
5. On VPS: `cd /opt/preyone-portal && npm run build && cd site && npm install && npm run build && cd .. && pm2 restart preyone-portal`
6. Verify: `curl -I https://preyone.com`, `curl -I https://preyone.com/sitemap.xml`, `curl -I https://wifi.preyone.com`, `pm2 status`

> Note: preyone.com now serves the React SPA from `site/dist` (Express SPA fallback).
> `/sitemap.xml` and `/robots.txt` are generated by Express routes in `src/index.ts` —
> they are registered BEFORE the `app.get('*')` catch-all, do not move them below it.

### Server code conventions
- Migration: `npm run migrate` (src/db/migrate.ts) — NOT `npm run db:migrate`
- `.env` lives on the VPS at `/opt/preyone-portal/.env` — never print secrets, never commit
- DB: PostgreSQL `captive_portal`, user `postgres`, credentials only in `.env`
