-- company_permissions.company_id references transit_companies(id), NOT companies(id).
SELECT 'transit_company: ' || id || ' | ' || name || ' | ' || slug
FROM transit_companies ORDER BY name;

SELECT 'grant: ' || tc.name || ' | ' || cp.permission_code || ' | ' || cp.granted_at
FROM company_permissions cp
JOIN transit_companies tc ON tc.id = cp.company_id
ORDER BY tc.name, cp.permission_code;
