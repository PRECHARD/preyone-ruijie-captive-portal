import 'dotenv/config';
import { pool } from '../src/db/pool';
import { loadPermissions, PERMISSIONS } from '../src/middleware/rbac';

const RT = PERMISSIONS.ROUTE_TEMPLATES_MANAGE;

async function main() {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name IN ('transit_route_templates','transit_route_template_stages',
                          'transit_route_template_fares','company_permissions')
     ORDER BY table_name`,
  );
  console.log('tables:', tables.rows.map((r) => r.table_name).join(', '));

  const perms = await pool.query('SELECT code FROM permissions WHERE code = $1', [RT]);
  console.log('permission code present:', perms.rows.length === 1);

  const roleGrants = await pool.query(
    `SELECT role FROM role_permissions WHERE permission_code = $1 ORDER BY role`,
    [RT],
  );
  console.log('roles with default grant:', roleGrants.rows.map((r) => r.role).join(', '));
  const fieldLeak = roleGrants.rows.filter((r) =>
    ['CONDUCTOR', 'DRIVER', 'TICKET_SELLER'].includes(r.role),
  );
  console.log('field-staff role leak (must be empty):', fieldLeak.length === 0 ? 'none' : 'LEAK');

  const companyGrants = await pool.query(
    `SELECT c.slug, cp.permission_code FROM company_permissions cp
     JOIN transit_companies c ON c.id = cp.company_id ORDER BY c.slug`,
  );
  console.log(
    'company grants:',
    companyGrants.rows.map((r) => `${r.slug}=${r.permission_code}`).join(', ') || '(none)',
  );

  // The decisive check for the real scenario: the product owner is a CONDUCTOR.
  // A field role must resolve the capability PURELY from the company grant, and
  // must NOT resolve it when the company has no grant. A random uuid stands in
  // for the user id so the per-user branch contributes nothing.
  const company = await pool.query(`SELECT id, slug FROM transit_companies WHERE slug = $1`, [
    process.env.TRANSIT_COMPANY_SLUG || 'preyone-transit',
  ]);
  const grantedCompany = company.rows[0];
  const fakeUserId = '00000000-0000-4000-8000-000000000001';

  const conductorCompanyScoped = await loadPermissions('CONDUCTOR', fakeUserId, grantedCompany.id);
  const conductorRoleOnly = await loadPermissions('CONDUCTOR', fakeUserId, null);
  console.log(
    `CONDUCTOR of "${grantedCompany.slug}": manages templates = ${conductorCompanyScoped.includes(RT)}`,
  );
  console.log(
    `CONDUCTOR with no company grant: manages templates = ${conductorRoleOnly.includes(RT)}`,
  );
  if (!conductorCompanyScoped.includes(RT)) {
    throw new Error('a conductor in the granted company cannot manage templates');
  }
  if (conductorRoleOnly.includes(RT)) {
    throw new Error('role-only conductor wrongly has the capability (grant is not company-scoped)');
  }

  // And a company with no grant must not inherit it.
  const otherCompany = await pool.query(
    `SELECT c.id, c.slug FROM transit_companies c
     LEFT JOIN company_permissions cp ON cp.company_id = c.id AND cp.permission_code = $1
     WHERE cp.company_id IS NULL LIMIT 1`,
    [RT],
  );
  if (otherCompany.rows.length > 0) {
    const oc = otherCompany.rows[0];
    const p = await loadPermissions('CONDUCTOR', fakeUserId, oc.id);
    console.log(
      `CONDUCTOR of ungranted company "${oc.slug}": manages templates = ${p.includes(RT)}`,
    );
    if (p.includes(RT)) throw new Error('grant leaked to another company');
  } else {
    console.log('ungranted-company isolation: no second company to test against');
  }

  const conductors = await pool.query(
    `SELECT u.id, u.username, u.role, u.company_id FROM transit_users u
     WHERE u.role = 'CONDUCTOR' AND u.deleted_at IS NULL ORDER BY u.username`,
  );
  if (conductors.rows.length === 0) {
    console.log('no CONDUCTOR users exist yet to test against');
  }
  for (const u of conductors.rows) {
    const permsList = await loadPermissions(u.role, u.id, u.company_id);
    const withCompany = permsList.includes(RT);
    const withoutCompany = (await loadPermissions(u.role, u.id, null)).includes(RT);
    console.log(
      `conductor ${u.username}: with company grant = ${withCompany}, role-only = ${withoutCompany}`,
    );
    if (!withCompany) throw new Error(`conductor ${u.username} cannot manage templates`);
  }

  const other = await pool.query(
    `SELECT u.id, u.username, u.role, u.company_id FROM transit_users u
     WHERE u.role NOT IN ('CONDUCTOR') AND u.deleted_at IS NULL ORDER BY u.role LIMIT 3`,
  );
  for (const u of other.rows) {
    const p = await loadPermissions(u.role, u.id, u.company_id);
    console.log(`role ${u.role} (${u.username}): manages templates = ${p.includes(RT)}`);
  }

  console.log('\nOK');
}

main()
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
