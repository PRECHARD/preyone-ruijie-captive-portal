# Preyone desktop

One window for Windows and Mac. Sign in once, then open **Preyone POS** and **Invoice & Quotation** when the company plan includes them. The app does not ship a database or a server. Sales and invoices stay on the live Preyone sites.

| Plan | What you see |
|---|---|
| PreTill | POS only |
| PreBiz, PrePro, PreUnlimited | POS and Invoice |

The tiles come from `GET https://app.preyone.com/api/admin/auth/me` (`subscribed_modules` and `plan_name`). POS loads `https://pos.preyone.com`. Invoice loads `https://invoice.preyone.com`. Other links open in the system browser only when they are `http` or `https`. `file:`, `smb:`, and custom app links are ignored.

## Develop

```bash
cd desktop
npm install
npm test
npm run dev
```

`npm run dev` starts the shell at `http://127.0.0.1:5176` and opens Electron against the live sites. You need a network connection and a Preyone staff login.

## Build installers

Unsigned test builds are the default. No certificate is required.

```bash
cd desktop
npm install
npm run dist:win    # Windows NSIS installer, from Windows or a Windows CI runner
npm run dist:mac    # Mac .dmg for Intel and Apple silicon, from a Mac
```

Installers are written to `desktop/release/`:

- `Preyone Setup 1.0.0.exe` on Windows
- `Preyone-1.0.0.dmg` and `Preyone-1.0.0-arm64.dmg` on Mac
- `latest.yml` and `latest-mac.yml`, which the auto-updater reads

This repository’s GitHub Actions workflow (`.github/workflows/desktop.yml`) builds both when you run it by hand, or when you push a tag named `desktop-v*` (for example `desktop-v1.0.0`). A tag also publishes a GitHub Release. A manual run only uploads the installers as workflow artifacts.

## Updates

Packaged builds check GitHub Releases of `PRECHARD/preyone-ruijie-captive-portal` with `electron-updater`. They do not use `preyone.com/downloads` (that folder publishes the bus-ticket APK, not the desktop `latest.yml` files). The dev app skips the check. If no release exists yet, the app logs the failure and keeps running.

## Optional code signing

Leave these unset for unsigned test builds. Fill them in later as GitHub Actions secrets, or export them in the shell before `npm run dist:win` / `npm run dist:mac`.

Windows (Authenticode `.pfx`):

- `CSC_LINK` — path or HTTPS URL of the certificate, or a base64 string of the file
- `CSC_KEY_PASSWORD` — password for that certificate

Mac (Developer ID plus notarization):

- `CSC_LINK` and `CSC_KEY_PASSWORD` — Developer ID Application certificate
- `APPLE_ID` — Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password
- `APPLE_TEAM_ID` — 10-character team id

The workflow sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a Mac runner does not fail when the keychain has no certificate. If `CSC_LINK` is present, electron-builder signs with it. Notarization runs only when the Apple variables are present.

Unsigned Mac builds can be opened with a right-click, then Open. Auto-update installs are more reliable after the app is signed.
