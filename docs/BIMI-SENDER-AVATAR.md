# BIMI sender avatar — admin@preyone.com / support@preyone.com

Status: **assets and DNS plan prepared. Live DNS has not been changed.**

The emblem that appears in Preyone email footers cannot be turned into a sender
profile picture from the email HTML — Gmail and Apple Mail choose the avatar
themselves. The only supported route for a custom logo in Gmail is **BIMI with a
Verified Mark Certificate (VMC)**. This document covers everything that can be
prepared before the certificate is bought.

## 1. What is already in the repo

| File | Served at | Notes |
| --- | --- | --- |
| `public/images/bimi/preyone-bimi.svg` | `https://wifi.preyone.com/images/bimi/preyone-bimi.svg` | live as soon as the file is deployed |
| `site/public/images/bimi/preyone-bimi.svg` | `https://preyone.com/images/bimi/preyone-bimi.svg` | appears after a `site` build (Vite copies `site/public` into `site/dist`) |

Both copies are byte-identical and `tests/bimiAsset.test.ts` enforces the BIMI
rules that matter: SVG Tiny PS profile, square `viewBox`, ≤ 32 KB, no raster,
script, external reference or event handler.

The canonical logo URL is the apex-domain one:

```
https://preyone.com/images/bimi/preyone-bimi.svg
```

### How the SVG was produced

There is no vector master for the emblem in this repository —
`public/images/preyonelogomainzw.png` is a 2048×1140 raster. The BIMI file was
traced from it instead:

1. Cropped to the emblem, the faint drop shadow removed, emblem re-centred so it
   fills 80 % of a square canvas (the circular safe area used by mail clients).
2. Reduced to the brand palette (`#FFFFFF`, `#E9E4EC`, `#C9BCCE`, `#A885A0`,
   `#5C1650`, `#1E1940`) and traced with `vtracer` (colour, cutout, spline).
3. Compressed with `svgo --precision=1 --multipass` → **18.6 KB**.
4. Root element rewritten to `version="1.2" baseProfile="tiny-ps"`, square
   1024×1024 `viewBox`, with a `<title>` for accessibility.

This is a faithful flat rendition, not the original glossy artwork. When a
designer supplies a real vector master, replace both copies and re-run
`npx vitest run tests/bimiAsset.test.ts`; a new SVG also invalidates any VMC
already issued for the old file (the certificate is bound to the SVG hash).

## 2. Current DNS state (verified 2026-11-10)

```
preyone.com            TXT  "v=spf1 include:_spf.mail.hostinger.com ~all"
_dmarc.preyone.com     TXT  "v=DMARC1; p=none; rua=mailto:dmarc-reports@preyone.com;"
default._bimi.preyone.com   (no record)
preyone.com            MX   5 mx1.hostinger.com / 10 mx2.hostinger.com
```

DKIM: Hostinger (outbound) and Brevo (transactional) both sign as `preyone.com`.

## 3. Records to publish

All records are managed in Hostinger → DNS Zone for `preyone.com`.

### 3.1 DMARC enforcement (prerequisite)

BIMI is ignored while DMARC is `p=none`. Move it to quarantine first, then to
reject once the reports stay clean for a couple of weeks:

```
_dmarc.preyone.com  TXT  "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc-reports@preyone.com;"
```

Only do this after confirming both senders pass **aligned** DMARC
(`d=preyone.com`, SPF **or** DKIM aligned) — otherwise password-reset and OTP
mail starts landing in spam. Check with Gmail "Show original" and the DMARC
aggregate reports.

### 3.2 BIMI record

Self-asserted (no certificate — Apple Mail may show the logo, Gmail will not):

```
default._bimi.preyone.com  TXT  "v=BIMI1; l=https://preyone.com/images/bimi/preyone-bimi.svg;"
```

With a VMC (required for Gmail), add the certificate URL:

```
default._bimi.preyone.com  TXT  "v=BIMI1; l=https://preyone.com/images/bimi/preyone-bimi.svg; a=https://preyone.com/images/bimi/preyone-vmc.pem"
```

Host the `.pem` next to the SVG (`public/images/bimi/preyone-vmc.pem`, and the
`site/public` copy). One record covers every address on `preyone.com`, so
`admin@`, `support@` and any future mailbox all inherit it.

Requirements the logo host must satisfy:

- HTTPS only, no redirects, publicly reachable without authentication.
- `Content-Type: image/svg+xml`.
- No `robots.txt` block for the path.

### 3.3 Optional: subdomain senders

Records are per-domain. Mail sent as `@wifi.preyone.com` or
`@invoice.preyone.com` would need its own `default._bimi.<subdomain>` record
pointing at the same SVG (and its own DMARC policy).

## 4. Verified Mark Certificate (VMC)

Gmail requires a VMC; BIMI alone is not enough. What it takes:

- A **registered trademark** for the logo (the emblem must match the mark).
- A CA that issues VMCs — DigiCert or Entrust are the common ones.
- An annual fee per certificate, roughly 3–6 weeks for validation.
- A logo that matches the trademark exactly, in SVG Tiny PS format.

Until the VMC exists, the practical options are:

1. Publish the self-asserted record (helps Apple Mail, harmless elsewhere).
2. Move `admin@` and `support@` to Google Workspace, where the avatar is set in
   the Admin console and shows in Gmail without BIMI.
3. Leave the avatar as-is; the emblem still appears in the email header and
   footer of every message.

## 5. Rollout checklist

1. Deploy the SVG (already scripted in the normal deploy) and confirm:
   `curl -I https://preyone.com/images/bimi/preyone-bimi.svg` →
   `200`, `content-type: image/svg+xml`, no redirect.
2. Tighten DMARC to `p=quarantine; pct=100` and watch the reports.
3. Add the `default._bimi` TXT record.
4. Send a test message from `support@preyone.com` to a Gmail account and check
   "Show original" for `BIMI: pass` / the logo next to the sender.
5. After the VMC arrives: upload the `.pem`, add `a=` to the record, re-test.
6. Move DMARC to `p=reject` when everything is aligned.

## 6. Rollback

- Delete `default._bimi.preyone.com`.
- Restore `_dmarc` to `v=DMARC1; p=none; rua=mailto:dmarc-reports@preyone.com;`.
- No application code depends on either record.
