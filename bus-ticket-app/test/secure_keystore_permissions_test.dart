// Locks in how the server-delivered permission list is persisted and read back.
//
// The bug this guards: an explicitly EMPTY list was stored by deleting the key,
// so readPermissions() returned null. Every gate treats null as "server never
// sent one" and falls back to role defaults, which silently re-granted
// capabilities the server had just revoked. An empty list is a real answer and
// has to survive the round-trip as [].
import 'package:bus_ticket_app/src/roles.dart';
import 'package:bus_ticket_app/src/security/secure_keystore.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late SecureKeystore store;

  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    store = SecureKeystore.instance;
  });

  group('SecureKeystore permission round-trip', () {
    test('null before the server has ever sent a list', () async {
      expect(await store.readPermissions(), isNull);
    });

    test('a granted capability survives the round-trip', () async {
      await store.writePermissions(['route.templates.manage']);
      expect(await store.readPermissions(), ['route.templates.manage']);
    });

    test('an EMPTY list reads back as empty, not null', () async {
      await store.writePermissions(const []);
      final back = await store.readPermissions();
      expect(back, isNotNull,
          reason: 'empty means "server granted nothing", not "unknown"');
      expect(back, isEmpty);
    });

    test('duplicates/whitespace are normalised', () async {
      await store.writePermissions(
          [' route.templates.manage ', 'route.templates.manage', '  ']);
      expect(await store.readPermissions(), ['route.templates.manage']);
    });

    test('a revocation is honoured - empty list denies a super admin',
        () async {
      // The role fallback is only correct when the server sent nothing. An
      // explicit empty list must not re-open the gate for a role default.
      await store.writePermissions(const []);
      final perms = await store.readPermissions();
      expect(Roles.canManageRouteTemplates(Roles.superAdmin, perms), isFalse);
    });

    test('a grant is honoured through the stored value', () async {
      await store.writePermissions(['route.templates.manage']);
      final perms = await store.readPermissions();
      expect(
          Roles.canManageRouteTemplates(Roles.conductor, perms), isTrue,
          reason: 'company grant must unlock a field role');
    });

    test('null still falls back to role defaults', () async {
      final perms = await store.readPermissions();
      expect(perms, isNull);
      expect(Roles.canManageRouteTemplates(Roles.superAdmin, perms), isTrue);
      expect(Roles.canManageRouteTemplates(Roles.conductor, perms), isFalse);
    });

    test('clearing the session drops the list back to null', () async {
      await store.writePermissions(['route.templates.manage']);
      expect(await store.readPermissions(), isNotNull);
      await store.clearTokens();
      expect(await store.readPermissions(), isNull,
          reason: 'the next operator must not inherit the last one');
    });
  });
}
