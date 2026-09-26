// Exercises the REAL production migration: a v15 device database (the exact
// on-disk schema of the released 1.0.0+20 build) is opened by AppDb, which
// declares version 16, so sqflite runs the real onUpgrade(oldVersion: 15).
//
// What this protects against, on a device that cannot be recovered from:
//   * a migration that throws (app dead on next launch for every user)
//   * a migration that silently drops or rewrites existing rows
//   * route-template tables/indexes missing or half-created after upgrade
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models/route_template.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'fixtures/v15_schema.dart';
import 'helpers/test_db.dart';

const v15Tables = <String>[
  'fares',
  'sales',
  'drivers',
  'conductors',
  'trips',
  'promotions',
  'company_profile',
  'driver_shifts',
  'vehicles',
  'settings',
  'sync_queue',
  'trip_instances',
];

void main() {
  late String dbPath;

  setUpAll(() async {
    final dir = await useTestDatabaseDir('migration_v15_v16');
    dbPath = p.join(dir, 'bus_ticket.db');
  });

  Future<void> wipe() async {
    for (final suffix in ['', '-wal', '-shm', '-journal']) {
      final f = File('$dbPath$suffix');
      if (f.existsSync()) f.deleteSync();
    }
  }

  Future<Database> raw({bool readOnly = false}) => databaseFactoryFfi
      .openDatabase(dbPath, options: OpenDatabaseOptions(readOnly: readOnly));

  Future<Map<String, List<Map<String, Object?>>>> snapshot(
      Database d, List<String> tables) async {
    final out = <String, List<Map<String, Object?>>>{};
    for (final t in tables) {
      out[t] = await d.query(t, orderBy: 'rowid');
    }
    return out;
  }

  test('a v15 field database upgrades to v16 keeping every row', () async {
    await wipe();

    // ---- Build a realistic v15 device database -----------------------------
    final v15 = await raw();
    for (final sql in v15SchemaSql) {
      await v15.execute(sql);
    }
    await v15.insert('fares', {'name': 'Adult', 'price': 200, 'enabled': 1});
    await v15.insert('drivers', {'name': 'Tatenda', 'phone': '0771111111'});
    await v15.insert('conductors', {'name': 'Rudo', 'phone': '0772222222'});
    await v15.insert('vehicles', {'registration': 'ABC-123'});
    await v15.insert('promotions', {
      'id': 'promo-1',
      'code': 'SAVE10',
      'description': 'Ten percent off',
      'type': 'PERCENT',
      'value': 10
    });
    await v15.insert('company_profile', {
      'id': 'co-1',
      'name': 'Preyone Bus',
      'currency': 'USD',
      'updated_at': '2026-01-01T00:00:00Z'
    });
    await v15.insert('driver_shifts', {
      'id': 'shift-1',
      'driver_id': '1',
      'driver_name': 'Tatenda',
      'conductor_name': 'Rudo',
      'vehicle_reg': 'ABC-123',
      'status': 'OPEN',
      'started_at': '2026-01-01T06:00:00Z'
    });
    await v15.insert('trips', {
      'id': 'trip-1',
      'trip_no': 'T-1',
      'route_code': 'HRE-CHI',
      'route_from': 'Harare',
      'route_to': 'Chitungwiza',
      'route_name': 'Harare - Chitungwiza',
      'bus_reg': 'ABC-123',
      'driver': 'Tatenda',
      'conductor': 'Rudo',
      'status': 'SCHEDULED',
      'base_fare_cents': 500,
      'total_seats': 60,
      'seats_sold': 0
    });
    await v15.insert('trip_instances', {
      'id': 'ti-1',
      'trip_id': 'trip-1',
      'trip_no': 'T-1',
      'shift_id': 'shift-1',
      'status': 'RUNNING',
      'started_at': '2026-01-01T06:05:00Z'
    });
    await v15.insert('sales', {
      'receipt_no': 'R-0001',
      'company_id': 'co-1',
      'route_code': 'HRE-CHI',
      'route_name': 'Harare - Chitungwiza',
      'bus_reg': 'ABC-123',
      'driver': 'Tatenda',
      'conductor1': 'Rudo',
      'trip_no': 'T-1',
      'trip_id': 'trip-1',
      'trip_instance_id': 'ti-1',
      'shift_id': 'shift-1',
      'payment_method': 'cash',
      'customer_name': 'JOYCE',
      'customer_mobile': '0773333333',
      'custom_fare': 0,
      'details': '[{"name":"Adult","qty":1,"price":500}]',
      'total': 500,
      'cash': 500,
      'change': 0,
      'created_at': '2026-01-01T06:10:00Z',
      'synced': 1,
      'printed': 1
    });
    await v15.insert('sync_queue', {
      'event_uuid': 'evt-1',
      'event_type': 'TRIP_START',
      'trip_id': 'trip-1',
      'trip_no': 'T-1',
      'shift_id': 'shift-1',
      'created_at': '2026-01-01T06:05:00Z',
      'synced': 0
    });
    await v15.insert('settings', {'key': 'logged_in', 'value': '1'});
    await v15.insert('settings', {'key': 'device_id', 'value': 'DEV-9'});
    await v15.execute('PRAGMA user_version = 15');

    final before = await snapshot(v15, v15Tables);
    expect((await v15.rawQuery('PRAGMA user_version')).first.values.first, 15,
        reason: 'fixture must start at schema 15');
    expect(before['sales'], hasLength(1));
    await v15.close();

    // ---- Open with the real AppDb (declares version 16) -------------------
    await AppDb.init();

    // ---- The upgrade ran, and did it correctly ----------------------------
    final after = await raw(readOnly: true);
    addTearDown(after.close);

    expect((await after.rawQuery('PRAGMA user_version')).first.values.first, 16,
        reason: 'sqflite must stamp the migrated database as v16');

    final tables = (await after
            .rawQuery("SELECT name FROM sqlite_master WHERE type='table'"))
        .map((r) => r['name'] as String)
        .toSet();
    for (final t in [
      'route_templates',
      'route_template_stages',
      'route_template_fares'
    ]) {
      expect(tables, contains(t), reason: '$t must exist after the upgrade');
    }

    final indexes = (await after.rawQuery(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_rt%'"))
        .map((r) => r['name'] as String)
        .toSet();
    expect(indexes, containsAll(['idx_rts_template', 'idx_rtf_template']));

    // Every pre-existing table must be byte-for-byte unchanged.
    final afterRows = await snapshot(after, v15Tables);
    for (final t in v15Tables) {
      expect(afterRows[t], before[t],
          reason: '$t rows must survive v15 -> v16');
    }

    // ---- New tables start empty; the real CRUD works on the upgraded file --
    expect(await after.rawQuery('SELECT * FROM route_templates'), isEmpty);

    const tpl = RouteTemplate(
      name: 'Harare - Chitungwiza',
      code: 'HRE-CHI',
      description: 'Main route',
      stages: [
        RouteStage(templateId: 'x', seq: 1, name: 'Harare'),
        RouteStage(templateId: 'x', seq: 2, name: 'Ruwa'),
        RouteStage(templateId: 'x', seq: 3, name: 'Chitungwiza'),
      ],
      fares: [
        RouteStageFare(templateId: 'x', fromSeq: 1, toSeq: 2, priceCents: 500),
        RouteStageFare(templateId: 'x', fromSeq: 2, toSeq: 3, priceCents: 700),
        RouteStageFare(templateId: 'x', fromSeq: 1, toSeq: 3, priceCents: 1200),
      ],
    );
    await AppDb.saveRouteTemplate(tpl);

    final loaded = await AppDb.getRouteTemplates();
    expect(loaded, hasLength(1));
    expect(loaded.single.name, 'Harare - Chitungwiza');
    expect(loaded.single.stages.map((s) => s.name).toList(),
        ['Harare', 'Ruwa', 'Chitungwiza']);
    // Bidirectional lookup survives the round trip through SQLite.
    expect(loaded.single.fareCentsBetween(1, 3), 1200);
    expect(loaded.single.fareCentsBetween(3, 1), 1200);
    expect(loaded.single.fareCentsBetween(2, 3), 700);

    final active = await AppDb.getActiveRouteTemplates();
    expect(active.map((t) => t.code).toList(), ['HRE-CHI']);

    // Renaming + re-pricing replaces children instead of duplicating them.
    final prev = loaded.single;
    final edit = RouteTemplate(
      id: prev.id,
      name: 'Harare - Ruwa',
      code: prev.code,
      description: prev.description,
      createdAt: prev.createdAt,
      stages: prev.stages.sublist(0, 2),
      fares: const [
        RouteStageFare(templateId: 'x', fromSeq: 1, toSeq: 2, priceCents: 450)
      ],
    );
    await AppDb.saveRouteTemplate(edit);
    final reloaded = (await AppDb.getRouteTemplates()).single;
    expect(reloaded.name, 'Harare - Ruwa');
    expect(reloaded.stages, hasLength(2));
    expect(reloaded.fareCentsBetween(1, 2), 450);
    expect(
        (await after.rawQuery('SELECT COUNT(*) c FROM route_templates'))
            .first['c'],
        1,
        reason: 'an edit must update in place, never insert a second row');
    expect(
        (await after.rawQuery('SELECT COUNT(*) c FROM route_template_fares'))
            .first['c'],
        1,
        reason: 'stale fares must be replaced, not accumulated');

    await AppDb.deleteRouteTemplate(reloaded.id);
    expect(await AppDb.getRouteTemplates(), isEmpty);
    expect(
        (await after.rawQuery('SELECT COUNT(*) c FROM route_template_stages'))
            .first['c'],
        0,
        reason: 'deleting a template must not leave orphan stages');

    // The upgrade must not have disturbed the v15 data written above.
    final final_ = await snapshot(after, v15Tables);
    for (final t in v15Tables) {
      expect(final_[t], before[t], reason: '$t changed after CRUD ran');
    }
  });
}
