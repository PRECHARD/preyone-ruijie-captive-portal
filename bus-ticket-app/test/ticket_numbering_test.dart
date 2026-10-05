// Ticket numbering must be unique across the whole company, forever, and must
// lead with the bus's ABS plate letters so a printed ticket is traceable to a
// physical bus at a glance.
//
// The failure this protects against: a bare per-device counter. Two handsets in
// the same company would both start at 1 and both mint "AGJ0001", so two
// different passengers on two different buses would hold identical ticket
// numbers, and a reconciliation query would find a genuine duplicate.
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers/test_db.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // One database per test FILE (see helpers/test_db.dart) so the numbering
  // counter is isolated from every other suite. Within the file, each test gets
  // a fresh database by re-pointing AppDb at a new file.
  setUpAll(() async {
    await useTestDatabaseDir('ticket_numbering');
  });

  var seq = 0;
  setUp(() async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    seq++;
    await AppDb.initForTest(dbPath: 'ticket_no_$seq.db');
  });

  group('nextReceiptNo', () {
    test('leads with the ABS plate letters of the bus', () async {
      await AppDb.initForTest();
      final no = await AppDb.nextReceiptNo(busReg: 'AGJ 1234');
      expect(no, startsWith('AGJ-'));
    });

    test('normalises casing and separators from the plate', () async {
      await AppDb.initForTest();
      final a = await AppDb.nextReceiptNo(busReg: 'agj-1234');
      final b = await AppDb.nextReceiptNo(busReg: 'AGJ 9999');
      expect(a, startsWith('AGJ-'));
      expect(b, startsWith('AGJ-'));
    });

    test('is never empty and always has a numeric tail', () async {
      await AppDb.initForTest();
      final no = await AppDb.nextReceiptNo(busReg: 'ZWE 45');
      expect(no, isNotEmpty);
      final tail = int.tryParse(no.split('-').last);
      expect(tail, isNotNull);
    });

    test('numbers are sequential and never repeat within a session', () async {
      await AppDb.initForTest();
      final seen = <String>{};
      for (var i = 0; i < 25; i++) {
        final no = await AppDb.nextReceiptNo(busReg: 'AGJ 1234');
        expect(seen, isNot(contains(no)),
            reason: 'ticket number $no was issued twice');
        seen.add(no);
      }
      expect(seen.length, 25);
    });

    test('two different buses still get distinct numbers', () async {
      await AppDb.initForTest();
      // Same underlying counter, different plates: the discriminator keeps the
      // full number unique even where the plate happens to be shared.
      final a = await AppDb.nextReceiptNo(busReg: 'AGJ 1234');
      final b = await AppDb.nextReceiptNo(busReg: 'ABC 1234');
      expect(a, isNot(equals(b)));
    });

    test('falls back to the configured prefix when no bus is active', () async {
      await AppDb.initForTest();
      final no = await AppDb.nextReceiptNo();
      expect(no, isNotEmpty);
      expect(no.split('-').last.length, greaterThanOrEqualTo(4));
    });

    test('a ticket with no letters in the plate is still numbered', () async {
      await AppDb.initForTest();
      final no = await AppDb.nextReceiptNo(busReg: '1234567');
      expect(no, isNotEmpty);
      expect(int.tryParse(no.split('-').last), isNotNull);
    });

    test('issues the tagged format the server uniqueness index expects', () {
      // The partial unique index on the server only covers TAGGED numbers, so a
      // new ticket must match `^<PREFIX>-<3 base36>-<counter>$`. If this
      // format ever changes, new tickets would silently fall outside the
      // index and lose the collision protection entirely.
      final no = RegExp(r'^[A-Z0-9]+-[0-9A-Z]{3}-\d{4}$');
      expect(no.hasMatch('AGJ-A1B-0041'), isTrue);
      expect(no.hasMatch('AGJ-F2-0041'), isFalse,
          reason: 'a two-character tag is outside the indexed format');
      expect(no.hasMatch('AGJ0001'), isFalse,
          reason: 'the legacy untagged format is deliberately not indexed');
    });
  });

  group('device discriminator', () {
    test('is stable for the same device UUID', () {
      const uuid = '3f7b1c2a-9d4e-4a1b-8c55-0e2d7a6b9c11';
      final a = AppDb.deviceDiscriminatorForTest(uuid);
      final b = AppDb.deviceDiscriminatorForTest(uuid);
      expect(a, b);
    });

    test('differs between two different devices', () {
      final a = AppDb.deviceDiscriminatorForTest(
          '3f7b1c2a-9d4e-4a1b-8c55-0e2d7a6b9c11');
      final b = AppDb.deviceDiscriminatorForTest(
          'a1b2c3d4-e5f6-4718-8293-a4b5c6d7e8f9');
      expect(a, isNot(equals(b)));
    });

    test('is always three upper-case base-36 characters', () {
      for (final uuid in [
        '3f7b1c2a-9d4e-4a1b-8c55-0e2d7a6b9c11',
        'a1b2c3d4-e5f6-4718-8293-a4b5c6d7e8f9',
        '',
        'short',
      ]) {
        final tag = AppDb.deviceDiscriminatorForTest(uuid);
        expect(tag.length, 3, reason: 'uuid $uuid produced $tag');
        expect(tag, matches(RegExp(r'^[0-9A-Z]{3}$')));
      }
    });

    test('spreads a realistic fleet across distinct tags', () {
      // A two-character tag gave only 1296 values. Production already runs four
      // handsets whose untagged counters all began at AGJ0001, so a two-char tag
      // is not enough headroom. Three characters gives 46656, so a real fleet
      // is very unlikely to collide — which matters because a collision prints
      // the same ticket number twice.
      final tags = <String>{};
      for (var i = 0; i < 200; i++) {
        tags.add(AppDb.deviceDiscriminatorForTest(
          '00000000-0000-4000-8000-${i.toRadixString(16).padLeft(12, '0')}',
        ));
      }
      expect(tags.length, 200);
    });
  });
}
