// Fare requests: the conductor-side escape hatch that replaced the Settings
// fare editor. A crew member who meets a tariff the device does not carry logs
// a request; an admin approves it into the real catalogue.
//
// These cover the store's contract, since it is persisted as a JSON blob in the
// settings table and a bad shape here would surface on the sell screen.
import 'dart:convert';
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'helpers/test_db.dart';

void main() {
  late String dbPath;

  setUpAll(() async {
    final dir = await useTestDatabaseDir('fare_requests');
    dbPath = p.join(dir, 'bus_ticket.db');
    for (final suffix in ['', '-wal', '-shm', '-journal']) {
      final f = File('$dbPath$suffix');
      if (f.existsSync()) f.deleteSync();
    }
    await AppDb.init();
  });

  // AppDb caches one open Database for the whole file, so the settings row has
  // to be reset per test or these leak into each other.
  setUp(() async {
    await AppDb.clearFareRequests();
  });

  test('a fresh device has no pending requests', () async {
    expect(await AppDb.getFareRequests(), isEmpty);
  });

  test('a request round-trips with its price, note and author', () async {
    await AppDb.addFareRequest(
      name: 'School',
      price: 100,
      note: 'term special',
      by: 'T. Moyo',
    );

    final pending = await AppDb.getFareRequests();
    expect(pending, hasLength(1));
    expect(pending.first['name'], 'School');
    expect(pending.first['price'], 100);
    expect(pending.first['note'], 'term special');
    expect(pending.first['by'], 'T. Moyo');
    expect(pending.first['at'], isA<String>());
  });

  test('a duplicate name is refused so repeated taps cannot pile up', () async {
    await AppDb.addFareRequest(name: 'Senior', price: 100);

    final added = await AppDb.addFareRequest(name: 'senior', price: 200);

    expect(added, isFalse, reason: 'match is case-insensitive');
    final pending = await AppDb.getFareRequests();
    expect(pending, hasLength(1));
    expect(pending.first['price'], 100,
        reason: 'the original request must not be overwritten');
  });

  test('a blank name is refused', () async {
    expect(await AppDb.addFareRequest(name: '   ', price: 100), isFalse);
    expect(await AppDb.getFareRequests(), isEmpty);
  });

  test('requests are persisted in the settings table, not just in memory',
      () async {
    await AppDb.addFareRequest(name: 'Luggage', price: 50, by: 'J. Dube');

    // Read the raw row with a separate connection. This proves the request is
    // on disk in `settings` and not sitting in a cached list, which is what
    // makes a queued request survive to the next shift.
    final d = await databaseFactoryFfi.openDatabase(dbPath,
        options: OpenDatabaseOptions(readOnly: true));
    addTearDown(d.close);

    final rows = await d.query('settings',
        columns: ['value'], where: 'key = ?', whereArgs: ['fare_requests']);

    expect(rows, hasLength(1));
    final decoded = jsonDecode(rows.first['value'] as String) as List;
    expect(decoded, hasLength(1));
    expect((decoded.first as Map)['name'], 'Luggage');
  });

  test('corrupt stored JSON degrades to empty instead of throwing', () async {
    await AppDb.setSetting('fare_requests', 'not json at all');
    expect(await AppDb.getFareRequests(), isEmpty);

    await AppDb.setSetting('fare_requests', '{"not":"a list"}');
    expect(await AppDb.getFareRequests(), isEmpty);

    await AppDb.setSetting('fare_requests', '');
    expect(await AppDb.getFareRequests(), isEmpty);
  });

  test('malformed rows inside a valid list are dropped, valid ones kept',
      () async {
    await AppDb.setSetting('fare_requests',
        '[{"name":"Adult","price":200},{"price":500},{"name":"","price":1}]');

    final pending = await AppDb.getFareRequests();

    expect(pending, hasLength(1),
        reason: 'rows without a usable name must not reach the admin list');
    expect(pending.first['name'], 'Adult');
  });

  test('clearing removes every pending request', () async {
    await AppDb.addFareRequest(name: 'A', price: 100);
    await AppDb.addFareRequest(name: 'B', price: 200);

    await AppDb.clearFareRequests();

    expect(await AppDb.getFareRequests(), isEmpty);
  });
}
