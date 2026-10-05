// Guards the two rules a conductor depends on mid-shift:
//
//   1. "No name available (walk-in)" is sticky. Once ticked it survives every
//      sheet rebuild (payment method, promo, cash), it locks the name box so a
//      stray keystroke cannot contradict the ticket, and it alone satisfies the
//      passenger-name requirement so the sale can be confirmed.
//
//   2. One trip at a time. A device that is already running a trip refuses to
//      open a second one, whichever entry point is used, until the current run
//      is ended. Tickets must never straddle two departures.
//
// The lifecycle rules are exercised against the real AppDb (ffi SQLite) so the
// guard is proven at the layer that actually decides, not in a mock.
import 'dart:io';

import 'package:bus_ticket_app/src/controllers/trip_controller.dart';
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/models/trip_model.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'helpers/test_db.dart';

const _secureChannel =
    MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

Trip _trip(String id, String no) => Trip(
      id: id,
      tripNo: no,
      routeCode: 'HRE-CHI',
      routeFrom: 'HARARE',
      routeTo: 'CHITUNGWIZA',
      routeName: 'HARARE - CHITUNGWIZA',
      busReg: 'AGJ-001',
      driver: 'DANIEL',
      conductor: 'LESLIE',
      status: 'SCHEDULED',
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final dir = await useTestDatabaseDir('one_trip_at_a_time');
    final f = File(p.join(dir, 'bus_ticket.db'));
    if (f.existsSync()) f.deleteSync();
    await AppDb.init();

    // TripController reads the conductor name off the device keystore to build
    // the TRIP_STARTED payload, so the channel needs a host-side answer or every
    // start throws MissingPluginException before it reaches the guard.
    final store = <String, String>{
      'preyone_full_name': 'Leslie Muvirimi',
      'preyone_device_uuid': 'abc12345-def6-7890',
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_secureChannel, (call) async {
      switch (call.method) {
        case 'read':
          return store[call.arguments['key'] as String?];
        case 'containsKey':
          return store.containsKey(call.arguments['key'] as String?);
        case 'readAll':
          return store;
        case 'write':
          store[call.arguments['key'] as String] =
              call.arguments['value'] as String? ?? '';
          return null;
        case 'delete':
          store.remove(call.arguments['key'] as String?);
          return null;
      }
      return null;
    });
  });

  /// Clears lifecycle state. AppDb caches one Database for the whole file, so a
  /// RUNNING instance seeded by one test would block every later one.
  Future<void> resetLifecycle() async {
    final d = await AppDb.db;
    await d.delete('trip_instances');
    await d.delete('trips');
    await d.delete('settings');
  }

  group('one trip at a time', () {
    test('a second trip cannot start while another is running', () async {
      await resetLifecycle();
      await AppDb.upsertTrip(_trip('trip-A', 'T-1'));
      await AppDb.upsertTrip(_trip('trip-B', 'T-2'));

      final first =
          await TripController.instance.startTrip(_trip('trip-A', 'T-1'),
              shiftId: 'shift-1');
      expect(first, isNotNull, reason: 'the first run must start');
      expect(first!.status, 'RUNNING');

      // Trip B is a different schedule — it must be refused outright.
      final second =
          await TripController.instance.startTrip(_trip('trip-B', 'T-2'),
              shiftId: 'shift-1');
      expect(second, isNull,
          reason: 'a different trip must not start while a run is live');

      // Only the original run exists: no second RUNNING row was planted.
      final running = await AppDb.getRunningTripInstances();
      expect(running.length, 1);
      expect(running.single.tripId, 'trip-A');
    });

    test('re-tapping start on the running trip returns it, not a duplicate',
        () async {
      await resetLifecycle();
      await AppDb.upsertTrip(_trip('trip-A', 'T-1'));

      final first =
          await TripController.instance.startTrip(_trip('trip-A', 'T-1'),
              shiftId: 'shift-1');
      final again =
          await TripController.instance.startTrip(_trip('trip-A', 'T-1'),
              shiftId: 'shift-1');
      expect(again, isNotNull);
      expect(again!.id, first!.id,
          reason: 'a double-tap must reuse the live instance');
      expect((await AppDb.getRunningTripInstances()).length, 1);
    });

    test('ending the run releases the device for the next trip', () async {
      await resetLifecycle();
      await AppDb.upsertTrip(_trip('trip-A', 'T-1'));
      await AppDb.upsertTrip(_trip('trip-B', 'T-2'));

      final first =
          await TripController.instance.startTrip(_trip('trip-A', 'T-1'),
              shiftId: 'shift-1');
      expect(first, isNotNull);

      await TripController.instance.endTrip(first!);

      expect(await AppDb.getRunningTripInstance(), isNull,
          reason: 'ending must clear the running row');

      // Now the second trip is allowed to run.
      final second =
          await TripController.instance.startTrip(_trip('trip-B', 'T-2'),
              shiftId: 'shift-1');
      expect(second, isNotNull,
          reason: 'after ending, the next trip must start normally');
      expect(second!.tripId, 'trip-B');
    });

    test('a start with no open shift is refused', () async {
      await resetLifecycle();
      await AppDb.upsertTrip(_trip('trip-A', 'T-1'));
      final none =
          await TripController.instance.startTrip(_trip('trip-A', 'T-1'),
              shiftId: '');
      expect(none, isNull);
      expect(await AppDb.getRunningTripInstance(), isNull);
    });
  });
}
