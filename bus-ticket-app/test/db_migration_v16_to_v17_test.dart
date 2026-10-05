// Exercises the REAL production migration for the shift close-sync column: a
// v16 device database (the schema of the currently-shipped 1.0.0+20 build) is
// opened by AppDb, which declares version 17, so sqflite runs the real
// onUpgrade(oldVersion: 16).
//
// This matters because a conductor terminal cannot be recovered from remotely.
// A migration that throws here means the app is DEAD on next launch for every
// user who updates, and a migration with a wrong default silently re-pushes
// historical closes to the server on the first sync.
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'helpers/test_db.dart';

void main() {
  late String dbPath;

  setUpAll(() async {
    final dir = await useTestDatabaseDir('migration_v16_v17');
    dbPath = p.join(dir, 'bus_ticket.db');
  });

  tearDown(() async {
    await AppDb.closeForTest();
  });


  /// A v16 database: driver_shifts exists but has no close_pushed column,
  /// exactly as the shipped build wrote it. [name] gives each test its own file
  /// so no test has to delete a database another test still holds open.
  Future<Database> makeV16(String name) async {
    final v16 = await databaseFactoryFfi.openDatabase(
      p.join(p.dirname(dbPath), name),
      options: OpenDatabaseOptions(
        version: 16,
        onCreate: (d, _) async {
          await d.execute('''
            CREATE TABLE driver_shifts (
              id TEXT PRIMARY KEY,
              driver_id TEXT NOT NULL DEFAULT '',
              driver_name TEXT NOT NULL DEFAULT '',
              driver_phone TEXT NOT NULL DEFAULT '',
              conductor_name TEXT NOT NULL DEFAULT '',
              conductor_phone TEXT NOT NULL DEFAULT '',
              vehicle_reg TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'OPEN',
              started_at TEXT NOT NULL DEFAULT '',
              closed_at TEXT NOT NULL DEFAULT '',
              synced INTEGER NOT NULL DEFAULT 0
            )
          ''');
          await d.execute('''
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
          ''');
          // AppDb._seedFares runs after open on every launch and reads this
          // table, so a partial fixture would fail for reasons unrelated to the
          // migration under test.
          await d.execute('''
            CREATE TABLE fares (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              price INTEGER NOT NULL,
              enabled INTEGER NOT NULL DEFAULT 1
            )
          ''');
          await d.execute(
              "INSERT INTO fares (name, price, enabled) VALUES ('Adult', 200, 1)");
        },
      ),
    );
    await v16.insert('driver_shifts', {
      'id': '11111111-1111-4111-8111-111111111111',
      'driver_id': 'd1',
      'driver_name': 'DANIEL MUVIRIMI',
      'driver_phone': '0771234567',
      'conductor_name': 'LESLIE MUVIRIMI',
      'conductor_phone': '0777654321',
      'vehicle_reg': 'AGJ 1234',
      'status': 'CLOSED',
      'started_at': '2026-09-01T06:00:00.000',
      'closed_at': '2026-09-01T18:00:00.000',
      'synced': 1,
    });
    await v16.close();
    return v16;
  }

  test('a v16 database upgrades to v17 without throwing', () async {
    await makeV16('v1.db');
    final d = await AppDb.initForTest(dbPath: 'v1.db');
    final version =
        (await d.rawQuery('PRAGMA user_version')).first.values.first;
    expect(version, 17);
  });

  test('the upgrade adds close_pushed', () async {
    await makeV16('v2.db');
    final d = await AppDb.initForTest(dbPath: 'v2.db');
    final cols = await d.rawQuery('PRAGMA table_info(driver_shifts)');
    expect(cols.map((c) => c['name']).toList(), contains('close_pushed'));
  });

  test('existing shift rows survive the upgrade intact', () async {
    await makeV16('v3.db');
    final d = await AppDb.initForTest(dbPath: 'v3.db');
    final rows = await d.query('driver_shifts');
    expect(rows.length, 1);
    expect(rows.first['driver_name'], 'DANIEL MUVIRIMI');
    expect(rows.first['vehicle_reg'], 'AGJ 1234');
    expect(rows.first['status'], 'CLOSED');
    expect(rows.first['closed_at'], '2026-09-01T18:00:00.000');
  });

  test('already-synced historical shifts are NOT re-queued for replay', () async {
    // The default for the new column must be 1 (already pushed). A default of 0
    // would make every existing closed shift look unpushed, and the first sync
    // after this update would re-POST every historical close to the server.
    await makeV16('v4.db');
    final d = await AppDb.initForTest(dbPath: 'v4.db');
    final rows = await d.query('driver_shifts');
    expect(rows.first['close_pushed'], 1);

    final pending = await AppDb.getUnpushedClosedShifts();
    expect(pending, isEmpty);
  });

  test('a fresh install declares v17 and creates close_pushed', () async {
    final d = await AppDb.initForTest(dbPath: 'fresh_v17.db');
    final version =
        (await d.rawQuery('PRAGMA user_version')).first.values.first;
    expect(version, 17);
    final cols = await d.rawQuery('PRAGMA table_info(driver_shifts)');
    expect(cols.map((c) => c['name']).toList(), contains('close_pushed'));
  });
}
