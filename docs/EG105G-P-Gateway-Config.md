# EG105G-P Gateway Settings Summary

## 1. LAN / Network

| Setting | Value |
|---------|-------|
| LAN IP | `192.168.1.216` |
| DHCP Server | Enabled |
| DHCP DNS Server | `192.168.1.216` (gateway LAN IP, NOT `8.8.8.8`) |
| DHCP Subnet | `192.168.1.0/24` |
| DNS Proxy | Enabled (intercept DNS for all unauthenticated clients) |
| HTTP Transparent Proxy | Enabled (intercept port 80 from unauthenticated MACs) |

## 2. Captive Portal / Web Auth

| Setting | Value |
|---------|-------|
| SSID | `Preyone UltraNet Wi-Fi` |
| Auth Mode | External Portal / Web Authentication |
| Portal Type | External (not built-in) |
| Portal URL | `http://wifi.preyone.com/login` |
| Success URL | `https://wifi.preyone.com/success.html` |
| Logout URL | `http://wifi.preyone.com/` |
| HTTP Redirect | Enabled — all port 80 traffic redirected to portal |

## 3. RADIUS Authentication

| Setting | Value |
|---------|-------|
| RADIUS Server IP | `173.249.7.190` |
| Auth Port | `1812` |
| Shared Secret | `preyone@radius2024` |
| Protocol | PAP |
| Interim Update Interval | `300` seconds (5 min) |

## 4. RADIUS Accounting

| Setting | Value |
|---------|-------|
| Accounting Server IP | `173.249.7.190` |
| Acct Port | `1813` |
| Shared Secret | `preyone@radius2024` |
| Interim Update | Enabled |
| Update Interval | `300` seconds (5 min) |

## 5. Gateway Redirect Params (sent to portal)

| Param | Example |
|-------|---------|
| `login_url` | `http://192.168.1.216:2060/ext_login` |
| `client_mac` | `AABBCCDDEEFF` |
| `nas_ip` | `192.168.1.216` |
| `nas_mac` | Gateway MAC address |
| `ssid` | `Preyone UltraNet Wi-Fi` |
| `url` | Original URL user tried to visit |

## 6. Firewall / ACL

- **Unauthenticated clients**: Only HTTP (80) to any — gateway intercepts and redirects to portal
- **Authenticated clients**: Full access (as authorized by RADIUS)
- **HTTPS (443) not intercepted** — gateway only sees HTTP (this is normal)

## 7. Critical Checklist

```
☐ DHCP DNS = 192.168.1.216 (not 8.8.8.8)
☐ DNS proxy enabled for unauthenticated clients
☐ HTTP transparent proxy enabled
☐ SSID auth = External Portal → http://wifi.preyone.com/login
☐ RADIUS auth: 173.249.7.190:1812, secret: preyone@radius2024
☐ RADIUS acct: 173.249.7.190:1813, same secret
☐ ext_login port 2060 accessible on LAN interface
☐ Portal success URL: https://wifi.preyone.com/success.html
☐ Interim-Update enabled (300s) for data usage tracking
```

## 8. Troubleshooting

### Portal doesn't auto-popup on connect
1. **Check DHCP DNS**: Client must get `192.168.1.216` as DNS server. Verify on a connected device.
2. **Check DNS proxy**: Gateway must resolve DNS for unauthenticated clients (return gateway IP).
3. **Check HTTP intercept**: Open `http://neverssl.com` on a test device — should redirect to `http://wifi.preyone.com/login?client_mac=...&nas_ip=...&login_url=...`.

### Devices connect without authentication
1. Verify SSID auth mode is set to **External Portal**, not built-in or disabled.
2. Check that RADIUS server at `173.249.7.190:1812` is reachable from gateway.
3. Verify `control:Auth-Type: Accept` is returned by RADIUS (not just `Auth-Type: Accept`).
