# EG105G-P Gateway Settings & Real-Device Test Guide

Last verified against production: **2026-10-02**.

---

## 0. READ FIRST — RADIUS leg is NOT wired up

Verified on the VPS today:

| Check | Result |
|---|---|
| FreeRADIUS process | Running (`/usr/sbin/freeradius`), container `preyone-radius` |
| Container health | `unhealthy` — **false alarm**, healthcheck runs `radiusd` which does not exist (binary is `freeradius`). FailingStreak 89340 over 2 weeks |
| Firewall | `1812/udp` + `1813/udp` ALLOW — correct |
| `mods-enabled/rest` | **ABSENT** — the REST module is not enabled |
| Any `rest` reference in `sites-enabled` / `policy.d` | **NONE** |
| `clients.conf` | Only `localhost` / `localhost_ipv6`, secret `testing123`. **No gateway client** |
| Radiusd log | Every request is from an internet scanner and is rejected as `unknown client`. **Never a request from the gateway** |
| Portal reachable from FreeRADIUS | Yes — nginx:80 → portal:5000 |

**Consequence:** if the gateway is set to authenticate against RADIUS, every login
will be rejected. This is a server-side gap, not a gateway mistake.

There are two independent authorization paths on the gateway:

- **A. `ext_login` → Ruijie Cloud.** The portal redirects the phone to the
  gateway's `ext_login`, which authorizes against Ruijie. May work with our
  FreeRADIUS entirely out of the picture.
- **B. FreeRADIUS → our portal.** Intended by `AGENTS.md`, **not currently
  configured.**

Configure the gateway as below, then run the test. If auth fails and the gateway
is set to RADIUS mode, path B is the reason — ask me to wire it up (steps in
section 7).

---

## 1. LAN / Network

| Setting | Value |
|---------|-------|
| LAN IP | `192.168.1.216` |
| DHCP Server | Enabled |
| DHCP DNS Server | `192.168.1.216` (gateway LAN IP, NOT `8.8.8.8`) |
| DHCP Subnet | `192.168.1.0/24` |
| DNS Proxy | Enabled |
| HTTP Transparent Proxy | Enabled |

## 2. Captive Portal / Web Auth

| Setting | Value |
|---------|-------|
| SSID | `Preyone UltraNet Wi-Fi` |
| Auth Mode | External Portal / Web Authentication |
| Portal Type | External (not built-in) |
| Portal URL | `http://wifi.preyone.com/connect` ← **change from `/login`** |
| Success URL | `https://wifi.preyone.com/success.html` |
| Logout URL | `http://wifi.preyone.com/` |
| HTTP Redirect | Enabled |

`/connect` serves the voucher form and forwards the gateway's query parameters
to `POST /api/auth/signup`. `/login` shows the email/password account page, so
pointing the Portal URL there forces two taps for a voucher customer.

WISPr XML (`/hotspot-detect.html`) already advertises
`http://wifi.preyone.com/connect?gw=true`, so OS auto-popup is aligned.

## 3. RADIUS Authentication

| Setting | Value |
|---------|-------|
| RADIUS Server IP | `173.249.7.190` |
| Auth Port | `1812` |
| Shared Secret | `preyone@radius2024` |
| Protocol | PAP |
| Interim Update Interval | `300` seconds |

> Enter these on the gateway, but note section 0: the server does not yet
> recognise this gateway as a client.

## 4. RADIUS Accounting

| Setting | Value |
|---------|-------|
| Accounting Server IP | `173.249.7.190` |
| Acct Port | `1813` |
| Shared Secret | `preyone@radius2024` |
| Interim Update | Enabled, `300` seconds |

## 5. Gateway redirect params our portal reads

Verified in `src/routes/auth.ts` and `src/utils/redirect.ts`:

| Param | Used for | Example |
|-------|----------|---------|
| `login_url` | gateway `ext_login` base | `http://192.168.1.216:2060/ext_login` |
| `client_mac` (or `mac`, `clientMac`) | device MAC, used for WISPr + RADIUS binding | `AABBCCDDEEFF` |
| `nas_ip` | NAS IP | `192.168.1.216` |
| `nas_mac` | NAS MAC | gateway MAC |
| `ssid` | SSID | `Preyone UltraNet Wi-Fi` |
| `url` | original URL requested — **must not be replaced** (AGENTS.md gotcha #4) | `http://neverssl.com` |

Without `login_url` + `client_mac` the portal cannot authorize the device and
will only show the success page.

## 6. Real-device test procedure

Voucher to use: **`e7wj7w`** (PreLite, unused, Ruijie-minted). This is the exact
voucher that was unredeemable before commit `c11e039`, so redeeming it is also a
live regression test of the casing fix.

1. **Reboot the gateway** after changing any RADIUS/Portal setting (required —
   the gateway does not hot-reload these).
2. Confirm portal reachability from a device on mobile data:
   `https://wifi.preyone.com/connect` → expect the voucher form.
3. Connect a phone to SSID `Preyone UltraNet Wi-Fi`.
4. Open `http://neverssl.com` (plain HTTP — HTTPS is not intercepted).
   Expect a redirect to
   `http://wifi.preyone.com/connect?client_mac=...&login_url=...`.
5. Enter `e7wj7w` and submit.
6. **Expected:** the phone lands on the site it asked for. Code is lowercase, so
   it must be accepted — that is the regression test.
7. Verify server-side:

   ```bash
   # device got bound
   ssh -i ~/.ssh/id_opencode deploy@158.220.118.91 \
     "docker exec preyone-db psql -U postgres -d captive_portal -c \
      'SELECT mac_address,is_active,bound_at,last_seen_at FROM voucher_devices ORDER BY bound_at DESC LIMIT 5;'"

   # auth is being exercised
   ssh -i ~/.ssh/id_opencode deploy@158.220.118.91 "pm2 logs preyone-portal --lines 100 --nostream"
   ```

8. **Multi-device check:** connect a second device (laptop) to the same SSID.
   It gets its own captive redirect — open `http://neverssl.com` and enter
   `e7wj7w` again. It should bind a second MAC without the code being
   "already used". Device limit for PreLite comes from the Ruijie profile's
   `no_of_device`, then `vouchers.max_devices`, else 1.
9. **Unbind check (customer self-service):**

   ```
   GET    /api/auth/devices?token=<sessionToken>
   DELETE /api/auth/devices?token=<sessionToken>&mac=AA:BB:CC:DD:EE:FF
   ```

   `token` is the session token returned by signup (the same value
   `/api/auth/status?token=` accepts). Without a token the endpoint returns
   `400`.

## 7. If RADIUS auth is required (path B)

Tell me and I will implement it. The work is:

1. Add the gateway's **WAN public IP** to `clients.conf` with secret
   `preyone@radius2024` — I need that IP from you.
2. Enable the REST module (`ln -s ../mods-available/rest mods-enabled/rest`).
3. Point it at the portal and fix the URI shape. The shipped
   `mods-available/rest` uses
   `http://127.0.0.1/user/%{User-Name}/mac/%{Called-Station-ID}?action=authorize`,
   but the portal exposes `GET /api/radius/auth?username=&mac=`. Either add an
   nginx rewrite for `/user/...` or change the URIs to match the portal.
4. Enable it in the `authorize` / `authenticate` sections of `sites-enabled/default`.
5. Fix the container healthcheck to call `freeradius` instead of `radiusd`.

## 8. Troubleshooting

**No auto-popup on connect**
1. DHCP DNS must be `192.168.1.216`.
2. DNS proxy enabled.
3. HTTP intercept enabled — test with `http://neverssl.com` (not https).

**Portal loads but nothing authorizes**
1. Is the gateway in RADIUS mode? See section 0.
2. Do the redirect params include `login_url` and `client_mac`? Check section 5.
3. `pm2 logs preyone-portal` for a signup error.

**"Invalid Voucher code"**
1. Voucher must exist and not be expired/exhausted.
2. Codes are case-insensitive as of `c11e039` — but check the code is a Ruijie
   code and appears in `ruijie_vouchers`.

**Devices connect without authenticating**
1. SSID auth mode must be External Portal, not built-in or disabled.
2. RADIUS server reachable from the gateway (try from a LAN device:
   `nc -vzu 173.249.7.190 1812`).
3. Return `control:Auth-Type: Accept` from RADIUS, not just `Auth-Type: Accept`.