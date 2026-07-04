# Preyone UltraNet Captive Portal — Working State Snapshot (2026-07-04)

**This document captures the exact state of the system when internet access was confirmed working for the first time. Do NOT modify any auth flow, voucher logic, or gateway integration without reading this first.**

---

## System Architecture

```
[Phone] → [Ruijie AP (WiFi)] → [EG105G-P Gateway] → [VPS (173.249.7.190)]
                                         |
                                   FreeRADIUS 3.2.5
                                         |
                                   Node.js Portal (PM2: preyone-portal)
                                         |
                                   PostgreSQL (captive_portal DB)
```

### Components
- **Ruijie APs**: RAP-6262G-Outdoor, RAP-2262G — WiFi access points with ext_login on port 2060
- **EG105G-P Gateway**: Main router/gateway at LAN IP `192.168.1.216`, runs captive portal + FreeRADIUS client
- **VPS**: Hetzner VPS at `173.249.7.190`, runs Node.js portal + FreeRADIUS 3.2.5 + PostgreSQL
- **FreeRADIUS**: Handles RADIUS accounting (Acct-Port 1813) and auth (Auth-Port 1812) via REST module

---

## Auth Flow (WORKING — Do Not Modify)

### Step-by-step Flow

1. **Phone connects to WiFi** → AP allows DHCP, gateway intercepts HTTP (port 80)
2. **Gateway redirects to portal** → `http://wifi.preyone.com/login?client_mac=XX:XX:XX:XX:XX:XX&login_url=http://192.168.1.216:2060/ext_login&nas_ip=192.168.1.216&ssid=Preyone+UltraNet+Wi-Fi&url=http://google.com`
3. **Portal serves signup form** → user enters voucher code, full name, optional phone/email
4. **POST /api/auth/signup** → server validates voucher, creates user + session + WISPr profile in DB
5. **Server returns JSON** with `redirectUrl` = ext_login GET URL (built by `buildRuijieSuccessUrl`)
6. **Phone navigates to ext_login** → `http://192.168.1.216:2060/ext_login?client_mac=...&username=VOUCHER&password=VOUCHER&url=http://google.com`
7. **Gateway's ext_login** authorizes the MAC → adds to local whitelist → redirects to `url` param
8. **Gateway reboot / RADIUS auth** → FreeRADIUS calls `/api/radius/auth` → returns Accept with bandwidth attributes → gateway grants full internet access

### Critical Fix: CSP `formAction: "*"`

In `src/index.ts:38`, the CSP `formAction` was changed from `["'self'"]` to `["*"]`.

**Why**: The old `formAction: 'self'` silently blocked ALL form submissions to external origins (the AP's ext_login at `192.168.x.1:2060`). This is why internet never worked — the POST to ext_login was silently rejected by the browser.

### Critical Fix: Gateway Reboot Required

After configuring RADIUS auth settings on the EG105G-P gateway, a **reboot is required** for RADIUS auth to take effect. Without reboot, the gateway only does ext_login (MAC whitelist) but doesn't send RADIUS Access-Requests to authorize internet traffic.

---

## Key Files & Their Roles

### `src/index.ts`
- Express app setup, CSP config, subdomain routing
- `formAction: ["*"]` — CRITICAL: allows form POSTs to gateway ext_login
- WISPr XML endpoints for captive portal detection (`/generate_204`, `/hotspot-detect.html`, etc.)
- Subdomain routing: `admin.preyone.com`, `wifi.preyone.com`, `preyone.com`

### `src/utils/redirect.ts`
- `buildRuijieSuccessUrl()` — builds the ext_login redirect URL
- Redirects DIRECTLY to ext_login (not through `/api/auth/extauth`) to avoid frontend param corruption
- Sets `url`/`redirect` params to `originalUrl` (short URL user was trying to visit), NOT the long success.html URL
- Includes all required params: `client_mac`, `mac`, `nas_ip`, `nas_mac`, `ssid`, `username`, `password`, `url`, `redirect`

### `src/routes/auth.ts`
- `POST /api/auth/signup` — voucher validation, user/session/WISPr creation
- `GET /api/auth/extauth` — auto-POST form to ext_login (backup, currently bypassed by direct redirect)
- Account management (register, login, password reset, etc.)

### `src/routes/gateway.ts`
- `GET /api/radius/auth` — called by FreeRADIUS to check if MAC has active session
- Returns `control:Auth-Type: Accept` with bandwidth/quota attributes when session found
- `GET /api/radius/acct` — RADIUS accounting (tracks data usage)
- `GET /api/auth` — session verification by token or MAC
- `GET /ping` — gateway health check / heartbeat

### `public/success.html`
- Post-auth success page with WISPr timer/data display
- Contains iframe POST to ext_login as backup auth method (line 502-568)
- Now works because CSP formAction is `*`

### `public/js/portal.js`
- `redirectToSuccess()` function (line 154-176) — adds extra params to redirectUrl
- **WARNING**: This function corrupts ext_login URLs by overwriting query params. This is why the extauth approach failed. The direct ext_login redirect in `buildRuijieSuccessUrl` bypasses this issue.

---

## Gateway Config (EG105G-P)

| Setting | Value |
|---------|-------|
| LAN IP | `192.168.1.216` |
| Auth Mode | External Portal / Web Authentication |
| Portal URL | `http://wifi.preyone.com/login` |
| Success URL | `https://wifi.preyone.com/success.html` |
| RADIUS Auth | `173.249.7.190:1812`, secret `preyone@radius2024`, PAP |
| RADIUS Acct | `173.249.7.190:1813`, same secret |
| ext_login | `http://192.168.1.216:2060/ext_login` |
| DHCP DNS | `192.168.1.216` (gateway itself, NOT 8.8.8.8) |
| DNS Proxy | Enabled |
| HTTP Proxy | Enabled (intercepts port 80) |

---

## FreeRADIUS Config

### `/etc/freeradius/3.0/mods-enabled/rest`
```
rest {
    connect_uri = "http://127.0.0.1:3000/"
    authorize { uri = "${..connect_uri}api/radius/auth?mac=%{Calling-Station-Id}&username=%{User-Name}" }
    authenticate { uri = "${..connect_uri}api/radius/auth?mac=%{Calling-Station-Id}&username=%{User-Name}" }
    post-auth { uri = "${..connect_uri}api/radius/auth?mac=%{Calling-Station-Id}&username=%{User-Name}" }
    accounting { uri = "${..connect_uri}api/radius/acct?mac=%{Calling-Station-Id}&status=%{Acct-Status-Type}&input=%{Acct-Input-Octets}&output=%{Acct-Output-Octets}&session=%{Acct-Session-Id}" }
}
```

### `/etc/freeradius/3.0/clients.conf`
```
client preyone-gateway {
    ipaddr = 0.0.0.0/0
    secret = preyone@radius2024
    shortname = preyone-gateway
    nas_type = other
}
```

---

## Database Schema (relevant tables)

- `users` — id, full_name, phone, email, voucher_code, mac_address, session_token, session_expires_at
- `vouchers` — id, code, duration_min, max_uses, used_count, data_limit_gb, is_uncapped, bandwidth_mbps_up/down, package_tier
- `wispr_profiles` — user_id, mac_address, bandwidth_up_kbps, bandwidth_down_kbps, data_quota_bytes, data_used_bytes, is_uncapped, session_end
- `voucher_redemptions` — voucher_id, user_id, mac_address, ip_address
- `gateway_heartbeats` — gw_sn, gw_id, last_seen

---

## Deployment

- **VPS**: `173.249.7.190`, SSH key: `~/.ssh/id_opencode`
- **Process**: PM2 process `preyone-portal` (pid varies)
- **Build**: `npm run build` → uploads `dist/` to VPS via `scp -r`
- **Restart**: `pm2 restart preyone-portal`
- **DB**: PostgreSQL at `127.0.0.1:5432`, database `captive_portal`, user `postgres`

---

## Known Issues & Gotchas

1. **CSP formAction must be `*`** — `'self'` blocks form POSTs to gateway ext_login
2. **Gateway needs reboot after RADIUS config changes** — otherwise only ext_login works, not full internet
3. **`portal.js` `redirectToSuccess()` corrupts ext_login URLs** — it adds duplicate/overwriting params. This is why the `/api/auth/extauth` endpoint approach failed (received empty values → AP "params error")
4. **`url`/`redirect` in ext_login must be the ORIGINAL URL** (e.g., `http://google.com`), NOT our success.html URL
5. **Ruijie AP `login_url` varies per AP** — different IPs for different AP models (192.168.100.1, 192.168.144.1, etc.)
6. **FreeRADIUS auth requests are sent by the gateway** after ext_login + reboot, NOT by our portal
7. **RADIUS accounting works without auth** — gateway sends Start/Interim-Update but only after RADIUS auth is properly configured

---

## DO NOT MODIFY

The following flow is confirmed working and must not be changed:

- **Voucher redemption flow** (`POST /api/auth/signup`)
- **`buildRuijieSuccessUrl`** in `src/utils/redirect.ts` — redirect to ext_login with original URL
- **CSP `formAction: ["*"]`** in `src/index.ts`
- **FreeRADIUS REST module config** on VPS
- **Gateway RADIUS settings** on EG105G-P
