#!/usr/bin/env bash
# Confirms the transit_shifts columns the conductor app depends on exist, and
# reports the company grant state after migration.
set -uo pipefail

docker exec -i preyone-db psql -U postgres -d captive_portal -At <<'SQL'
SELECT 'column: ' || column_name
FROM information_schema.columns
WHERE table_name = 'transit_shifts'
  AND column_name IN ('driver_name','driver_phone','conductor_name','conductor_phone','closed_at')
ORDER BY column_name;

SELECT 'grant: ' || c.name || ' -> ' || cp.permission_code
FROM company_permissions cp
JOIN companies c ON c.id = cp.company_id
WHERE cp.permission_code = 'route.templates.manage'
ORDER BY c.name;
SQL
