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
- `/etc/freeradius/3.0/mods-enabled/rest` — REST module pointing to localhost:3000
- `/etc/freeradius/3.0/clients.conf` — gateway client with secret `preyone@radius2024`
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

## VPS Deployment
- SSH: `ssh -i ~/.ssh/id_opencode root@173.249.7.190`
- Build: `npm run build`
- Deploy: `scp -r dist/ root@173.249.7.190:/opt/preyone-portal/`
- Restart: `pm2 restart preyone-portal`
- DB: PostgreSQL at localhost:5432, database `captive_portal`, user `postgres`
