// Covers the serverâ†’device route-template mirror (AppDb.replaceRouteTemplates)
// and the capability gate that decides who may edit templates.
//
// Separate file on purpose: AppDb caches its open Database in a static, so each
// scenario needs its own isolate.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models/route_template.dart';
import 'package:bus_ticket_app/src/roles.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'helpers/test_db.dart';

/// A server-shaped template: uuid ids, camelCase JSON, a real createdAt.
RouteTemplate fromServer({
  required String id,
  required String name,
  List<RouteStage> stages = const [],
  List<RouteStageFare> fares = const [],
  bool active = true,
  DateTime? createdAt,
}) =>
    RouteTemplate(
      id: id,
      name: name,
      active: active,
      createdAt: createdAt,
      stages: stages,
      fares: fares,
    );

RouteTemplate simple(String id, String name) => fromServer(
      id: id,
      name: name,
      stages: [
        RouteStage(id: '$id-s1', templateId: id, seq: 1, name: 'Harare'),
        RouteStage(id: '$id-s2', templateId: id, seq: 2, name: 'Beitbridge'),
      ],
      fares: [
        RouteStageFare(
          id: '$id-f1',
          templateId: id,
          fromSeq: 1,
          toSeq: 2,
          priceCents: 4500,
        ),
      ],
    );

void main() {
  late String dbPath;

  setUpAll(() async {
    final dir = await useTestDatabaseDir('route_template_mirror');
    dbPath = p.join(dir, 'bus_ticket.db');
    for (final suffix in ['', '-wal', '-shm', '-journal']) {
      final f = File('$dbPath$suffix');
      if (f.existsSync()) f.deleteSync();
    }
    await AppDb.init();
  });

  group('JSON round-trip', () {
    test('preserves createdAt so a mirror does not reshuffle the order', () {
      final when = DateTime.utc(2026, 3, 4, 5, 6, 7);
      final t = RouteTemplate(
        id: 'tpl-1',
        name: 'Harare - Mutare',
        createdAt: when,
        stages: const [
          RouteStage(id: 's1', templateId: 'tpl-1', seq: 1, name: 'Harare'),
        ],
      );
      final back = RouteTemplate.fromJson(t.toJson());
      expect(back.createdAt, isNotNull);
      expect(
        back.createdAt!.toUtc().toIso8601String(),
        when.toIso8601String(),
      );
    });

    test('stays null rather than inventing a timestamp when there is none', () {
      const t = RouteTemplate(id: 'tpl-1', name: 'X');
      expect(t.toJson()['createdAt'], isNotNull); // toJson always emits one
      final back = RouteTemplate.fromJson({'id': 'tpl-1', 'name': 'X'});
      expect(back.createdAt, isNull);
    });

    test('round-trips stages and the fare matrix', () {
      final t = simple('tpl-1', 'Harare - Beitbridge');
      final back = RouteTemplate.fromJson(t.toJson());
      expect(back.name, 'Harare - Beitbridge');
      expect(back.stages.map((s) => s.name), ['Harare', 'Beitbridge']);
      expect(back.fareCentsBetween(1, 2), 4500);
      expect(back.isUsable, isTrue);
    });
  });

  group('replaceRouteTemplates mirrors the server set', () {
    test('inserts a new template with its stages and matrix', () async {
      await AppDb.replaceRouteTemplates([simple('srv-1', 'Harare - Mutare')]);
      final all = await AppDb.getRouteTemplates();
      final t = all.firstWhere((t) => t.id == 'srv-1');
      expect(t.name, 'Harare - Mutare');
      expect(t.stages.length, 2);
      expect(t.fareCentsBetween(1, 2), 4500);
    });

    test('is idempotent â€” mirroring twice does not duplicate anything',
        () async {
      await AppDb.replaceRouteTemplates([simple('srv-idem', 'Idempotent')]);
      await AppDb.replaceRouteTemplates([simple('srv-idem', 'Idempotent')]);
      final all = await AppDb.getRouteTemplates();
      expect(all.where((t) => t.id == 'srv-idem').length, 1);
      final t = all.firstWhere((t) => t.id == 'srv-idem');
      expect(t.stages.length, 2);
      expect(t.fares.length, 1);
    });

    test('a repriced template is updated, not duplicated', () async {
      await AppDb.replaceRouteTemplates([
        fromServer(
          id: 'srv-price',
          name: 'Repriced',
          stages: const [
            RouteStage(id: 'p1', templateId: 'srv-price', seq: 1, name: 'A'),
            RouteStage(id: 'p2', templateId: 'srv-price', seq: 2, name: 'B'),
          ],
          fares: const [
            RouteStageFare(id: 'pf1', templateId: 'srv-price', fromSeq: 1, toSeq: 2, priceCents: 1000),
          ],
        ),
      ]);
      await AppDb.replaceRouteTemplates([
        fromServer(
          id: 'srv-price',
          name: 'Repriced v2',
          stages: const [
            RouteStage(id: 'p1', templateId: 'srv-price', seq: 1, name: 'A'),
            RouteStage(id: 'p2', templateId: 'srv-price', seq: 2, name: 'B'),
          ],
          fares: const [
            RouteStageFare(id: 'pf1', templateId: 'srv-price', fromSeq: 1, toSeq: 2, priceCents: 2000),
          ],
        ),
      ]);
      final all = await AppDb.getRouteTemplates();
      expect(all.where((t) => t.id == 'srv-price').length, 1);
      final t = all.firstWhere((t) => t.id == 'srv-price');
      expect(t.name, 'Repriced v2');
      expect(t.fareCentsBetween(1, 2), 2000);
    });

    test('a template removed on the server disappears locally', () async {
      await AppDb.replaceRouteTemplates([
        simple('srv-keep', 'Keep'),
        simple('srv-drop', 'Drop'),
      ]);
      expect((await AppDb.getRouteTemplates()).any((t) => t.id == 'srv-drop'),
          isTrue);

      await AppDb.replaceRouteTemplates([simple('srv-keep', 'Keep')]);
      final all = await AppDb.getRouteTemplates();
      expect(all.any((t) => t.id == 'srv-keep'), isTrue);
      expect(all.any((t) => t.id == 'srv-drop'), isFalse);
    });

    test('a shrunk stage list does not leave orphan stages or fares', () async {
      await AppDb.replaceRouteTemplates([
        fromServer(
          id: 'srv-shrink',
          name: 'Shrink',
          stages: const [
            RouteStage(id: 'x1', templateId: 'srv-shrink', seq: 1, name: 'A'),
            RouteStage(id: 'x2', templateId: 'srv-shrink', seq: 2, name: 'B'),
            RouteStage(id: 'x3', templateId: 'srv-shrink', seq: 3, name: 'C'),
          ],
          fares: const [
            RouteStageFare(id: 'xf1', templateId: 'srv-shrink', fromSeq: 1, toSeq: 2, priceCents: 100),
            RouteStageFare(id: 'xf2', templateId: 'srv-shrink', fromSeq: 2, toSeq: 3, priceCents: 200),
            RouteStageFare(id: 'xf3', templateId: 'srv-shrink', fromSeq: 1, toSeq: 3, priceCents: 300),
          ],
        ),
      ]);
      // Server now has only two stages and one leg.
      await AppDb.replaceRouteTemplates([
        fromServer(
          id: 'srv-shrink',
          name: 'Shrink',
          stages: const [
            RouteStage(id: 'x1', templateId: 'srv-shrink', seq: 1, name: 'A'),
            RouteStage(id: 'x2', templateId: 'srv-shrink', seq: 2, name: 'B'),
          ],
          fares: const [
            RouteStageFare(id: 'xf1', templateId: 'srv-shrink', fromSeq: 1, toSeq: 2, priceCents: 100),
          ],
        ),
      ]);
      final t = (await AppDb.getRouteTemplates())
          .firstWhere((t) => t.id == 'srv-shrink');
      expect(t.stages.map((s) => s.name), ['A', 'B']);
      expect(t.fares.length, 1);
    });

    test('an empty server set clears the local set', () async {
      await AppDb.replaceRouteTemplates([simple('srv-wipe', 'Wipe')]);
      expect((await AppDb.getRouteTemplates()).isNotEmpty, isTrue);
      await AppDb.replaceRouteTemplates([]);
      expect(await AppDb.getRouteTemplates(), isEmpty);
    });

    test('a server row with no id is skipped, not written with a null key',
        () async {
      await AppDb.replaceRouteTemplates([
        simple('srv-good', 'Good'),
        fromServer(id: '', name: 'No id'),
      ]);
      final all = await AppDb.getRouteTemplates();
      expect(all.any((t) => t.id == 'srv-good'), isTrue);
      expect(all.any((t) => t.name == 'No id'), isFalse);
    });

    test('mirrored templates are visible to the conductor picker', () async {
      await AppDb.replaceRouteTemplates([
        simple('srv-active', 'Active'),
        fromServer(
          id: 'srv-inactive',
          name: 'Inactive',
          active: false,
          stages: const [
            RouteStage(id: 'i1', templateId: 'srv-inactive', seq: 1, name: 'A'),
            RouteStage(id: 'i2', templateId: 'srv-inactive', seq: 2, name: 'B'),
          ],
        ),
      ]);
      final active =
          (await AppDb.getActiveRouteTemplates()).map((t) => t.id).toList();
      expect(active, contains('srv-active'));
      expect(active, isNot(contains('srv-inactive')));
    });
  });

  group('Roles.canManageRouteTemplates', () {
    const cap = Roles.routeTemplatesManage;

    test('a CONDUCTOR granted the capability by their company can manage', () {
      expect(Roles.canManageRouteTemplates(Roles.conductor, [cap]), isTrue);
    });

    test('a CONDUCTOR without the capability cannot', () {
      expect(Roles.canManageRouteTemplates(Roles.conductor, []), isFalse);
      expect(
        Roles.canManageRouteTemplates(Roles.conductor, ['transit.field_app']),
        isFalse,
      );
    });

    test('the permission list is authoritative over the role', () {
      // An admin whose capability was explicitly revoked is denied...
      expect(Roles.canManageRouteTemplates(Roles.superAdmin, []), isFalse);
      // ...and a field role the server granted is allowed.
      expect(Roles.canManageRouteTemplates(Roles.conductor, [cap]), isTrue);
    });

    test('a missing list falls back to the role, never denies outright', () {
      // null = server did not send permissions. Falling back keeps an admin or
      // manager working; a plain conductor falls back to the old deny, which is
      // the safe direction.
      expect(Roles.canManageRouteTemplates(Roles.superAdmin, null), isTrue);
      expect(Roles.canManageRouteTemplates(Roles.companyAdmin, null), isTrue);
      expect(Roles.canManageRouteTemplates(Roles.manager, null), isTrue);
      expect(Roles.canManageRouteTemplates(Roles.conductor, null), isFalse);
    });

    test('COMPANY_ADMIN is treated as an admin (the old lockout bug)', () {
      expect(Roles.isAdmin(Roles.companyAdmin), isTrue);
      expect(Roles.isAdmin(Roles.superAdmin), isTrue);
      // MANAGER/OPERATIONS hold operations.manage, which is not admin.
      expect(Roles.isAdmin(Roles.manager), isFalse);
      expect(Roles.isAdmin(Roles.operations), isFalse);
    });
  });
}
