// Companion to db_migration_v15_to_v16_test.dart: covers the OTHER half of the
// v16 change - a brand-new install, where onCreate (not onUpgrade) must build
// the route-template schema and the standard fare seed.
//
// Separate file on purpose: AppDb caches its open Database in a static, so each
// scenario needs its own isolate.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'helpers/test_db.dart';

void main() {
  late String dbPath;

  setUpAll(() async {
    final dir = await useTestDatabaseDir('fresh_install_v16');
    dbPath = p.join(dir, 'bus_ticket.db');
    for (final suffix in ['', '-wal', '-shm', '-journal']) {
      final f = File('$dbPath$suffix');
      if (f.existsSync()) f.deleteSync();
    }
  });

  test('a fresh install creates the complete v16 schema', () async {
    await AppDb.init();

    final d = await databaseFactoryFfi.openDatabase(dbPath,
        options: OpenDatabaseOptions(readOnly: true));
    addTearDown(d.close);

    // The app has since moved past v16 (that step is covered by
    // db_migration_v16_to_v17_test.dart). This suite still guards that a
    // brand-new install runs the FULL onCreate chain, so it asserts the current
    // declared version rather than the one the file was written for.
    expect((await d.rawQuery('PRAGMA user_version')).first.values.first, 17);

    final tables =
        (await d.rawQuery("SELECT name FROM sqlite_master WHERE type='table'"))
            .map((r) => r['name'] as String)
            .toSet();
    expect(
        tables,
        containsAll([
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
          'route_templates',
          'route_template_stages',
          'route_template_fares',
        ]),
        reason: 'a fresh install must have every table, old and new');

    final indexes = (await d.rawQuery(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_rt%'"))
        .map((r) => r['name'] as String)
        .toSet();
    expect(indexes, containsAll(['idx_rts_template', 'idx_rtf_template']));

    // The default tariff must be seeded on a fresh device.
    final fares = await d.query('fares', orderBy: 'price');
    expect(fares.map((f) => f['name']).toList(),
        ['Child', 'Luggage', 'Senior', 'Adult']);

    // No leftover rows in the new tables.
    expect(await d.rawQuery('SELECT * FROM route_templates'), isEmpty);
    expect(await d.rawQuery('SELECT * FROM route_template_stages'), isEmpty);
    expect(await d.rawQuery('SELECT * FROM route_template_fares'), isEmpty);
  });
}
