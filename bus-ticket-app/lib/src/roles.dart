/// Transit app role constants. Roles are stored as opaque strings in the
/// secure keystore and mirror the server's `transit_users.role` values.
abstract final class Roles {
  static const String superAdmin = 'SUPER_ADMIN';
  static const String admin = 'ADMIN';
  static const String conductor = 'CONDUCTOR';
  static const String driver = 'DRIVER';
  static const String ticketSeller = 'TICKET_SELLER';

  /// Users allowed to manage staff and administrative configuration.
  static bool isAdmin(String role) => role == superAdmin || role == admin;

  /// Field staff — denied staff-management and admin configuration.
  static bool isFieldStaff(String role) =>
      role == conductor || role == driver || role == ticketSeller;

  /// Users who can create/edit/delete conductors & drivers.
  static bool canManageStaff(String role) => isAdmin(role);

  /// Users allowed to view, override and edit Fares / Custom Fares in the POS
  /// during an active shift. Admins always can; field selling roles
  /// (CONDUCTOR, TICKET_SELLER) are explicitly privileged.
  static bool canEditFares(String role) =>
      role == superAdmin || role == admin || role == conductor || role == ticketSeller;
}