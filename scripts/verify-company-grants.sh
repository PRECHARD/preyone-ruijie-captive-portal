#!/usr/bin/env bash
# Reports companies and all company_permissions rows, to confirm migration
# neither lost nor duplicated the route.templates.manage grant.
set -uo pipefail

echo "=== companies columns ==="
docker exec -i preyone-db psql -U postgres -d captive_portal -At <<'SQL'
SELECT column_name FROM information_schema.columns
WHERE table_name = 'companies' ORDER BY ordinal_position;
SQL

echo "=== companies ==="
docker exec -i preyone-db psql -U postgres -d captive_portal -At <<'SQL'
SELECT id || ' | ' || name FROM companies ORDER BY name;
SQL

echo "=== all company_permissions ==="
docker exec -i preyone-db psql -U postgres -d captive_portal -At <<'SQL'
SELECT cp.company_id || ' | ' || c.name || ' | ' || cp.permission_code || ' | ' || cp.granted_at
FROM company_permissions cp
LEFT JOIN companies c ON c.id = cp.company_id
ORDER BY c.name, cp.permission_code;
SQL
