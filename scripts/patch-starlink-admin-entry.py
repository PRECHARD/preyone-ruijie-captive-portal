"""Insert the admin Starlink dashboard redirect into the deployed src/index.ts.

Idempotent. Does not touch unrelated host routing.
"""
from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "src/index.ts")
text = path.read_text(encoding="utf-8")

import_line = "import { starlinkAdminRedirect } from './utils/starlinkAdminEntry';\n"
anchor = "import { serveSpaBundle, spaDistDir } from './utils/spaHost';\n"
if import_line not in text:
    if anchor not in text:
        raise SystemExit("import anchor not found")
    text = text.replace(anchor, anchor + import_line, 1)

redirect = """  // Admin Starlink management must not fall through into the customer portal.
  // /starlink/portal on the admin host (and a signed-in manager on
  // starlink.preyone.com) used to boot the customer shell, which rewrote the
  // URL to /starlink/portal and hid the designed dashboard tabs.
  const starlinkAdminTarget = starlinkAdminRedirect(req);
  if (starlinkAdminTarget) {
    res.redirect(302, starlinkAdminTarget);
    return;
  }

"""
host_anchor = "  // admin.preyone.com → serve admin SPA static + fallback\n"
if "starlinkAdminRedirect(req)" not in text:
    if host_anchor not in text:
        raise SystemExit("host anchor not found")
    text = text.replace(host_anchor, redirect + host_anchor, 1)

path.write_text(text, encoding="utf-8")
print("patched", path)
