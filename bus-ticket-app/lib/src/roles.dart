/// Transit app role constants. Roles are stored as opaque strings in the
/// secure keystore and mirror the server's `transit_users.role` values.
abstract final class Roles {
  static const String superAdmin = 'SUPER_ADMIN';
  static const String admin = 'ADMIN';
  static const String companyAdmin = 'COMPANY_ADMIN';
  static const String manager = 'MANAGER';
  static const String operations = 'OPERATIONS';
  static const String conductor = 'CONDUCTOR';
  static const String driver = 'DRIVER';
  static const String ticketSeller = 'TICKET_SELLER';

  /// Narrow capability: create/edit/delete company master route templates. Held
  /// by admin-ish roles by default, and grantable to a whole company so a
  /// field-staff owner can maintain their own routes without being an admin.
  static const String routeTemplatesManage = 'route.templates.manage';

  /// Server roles that count as company administration.
  ///
  /// Note `SUPER_ADMIN` and `COMPANY_ADMIN` are the two the server actually
  /// issues for transit staff; the legacy `ADMIN` string is still accepted for
  /// older sessions. `MANAGER` and `OPERATIONS` are deliberately NOT admin —
  /// they hold `operations.manage` on the server, which is not the same thing.
  static const Set<String> adminRoles = {
    superAdmin,
    admin,
    companyAdmin,
  };

  /// Users allowed to manage staff and administrative configuration.
  static bool isAdmin(String role) => adminRoles.contains(role);

  /// Field staff — denied staff-management and admin configuration.
  static bool isFieldStaff(String role) =>
      role == conductor || role == driver || role == ticketSeller;

  /// Users who can create/edit/delete conductors & drivers.
  static bool canManageStaff(String role) => isAdmin(role);

  /// Whether this user may manage master route templates.
  ///
  /// The server's effective permission list is authoritative when present, since
  /// it is the only thing that knows about company-wide grants. When it is
  /// absent (older server, session restored before the field existed) fall back
  /// to the role default so nobody is locked out of their own routes. Never
  /// treat "no list" as "no permission", and never let a missing list block a
  /// conductor from selling.
  static bool canManageRouteTemplates(
    String role, [
    List<String>? permissions,
  ]) {
    if (permissions != null) {
      return permissions.contains(routeTemplatesManage);
    }
    return isAdmin(role) || role == manager || role == operations;
  }

  /// Users allowed to view, override and edit Fares / Custom Fares in the POS
  /// during an active shift. Admins always can; field selling roles
  /// (CONDUCTOR, TICKET_SELLER) are explicitly privileged.
  static bool canEditFares(String role) =>
      role == superAdmin ||
      role == admin ||
      role == conductor ||
      role == ticketSeller;
}
