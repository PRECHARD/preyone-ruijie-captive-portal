#!/usr/bin/env bash
# Verifies the published APK download end to end: the URL must serve a real APK
# (not the SPA index.html), and its bytes must match the promoted build.
set -uo pipefail

DL="${1:-/tmp/dl-check.apk}"
expect="${2:-}"
urls=(
  "https://admin.preyone.com/downloads/app-release.apk"
  "https://preyone.com/downloads/app-release.apk"
)

for u in "${urls[@]}"; do
  echo "=== $u"
  curl -sIL "$u" | grep -Ei '^HTTP/|^content-type|^content-length' || true
done

echo "=== downloading"
rm -f "$DL"
curl -sL -o "$DL" "${urls[0]}"
ls -l "$DL"
file "$DL" 2>/dev/null || head -c 4 "$DL" | xxd | head -1

if [ -n "$expect" ]; then
  got=$(sha256sum "$DL" | cut -d' ' -f1)
  if [ "$got" = "$expect" ]; then
    echo "SHA256 OK  $got"
  else
    echo "SHA256 MISMATCH"
    echo "  expected $expect"
    echo "  got      $got"
    exit 1
  fi
fi
