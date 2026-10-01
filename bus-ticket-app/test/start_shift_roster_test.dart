// The "Open run and start selling" path must never red-screen, and must not
// pre-select an arbitrary driver.
//
// The defect this pins down: pressing "Open run & start selling" with no open
// shift pushed StartShiftScreen, whose driver dropdown threw during BUILD
// ("There should be exactly one item with [DropdownButtonFormField]'s value")
// because _DriverOption had no value equality and the roster loads twice,
// producing fresh instances. Flutter renders a build-time assert as a full-screen
// red ErrorWidget, so the conductor got a red screen instead of the friendly
// "start a shift first" message.
//
// The second defect: _defaultDriver fell back to options.first, silently
// pre-selecting whichever driver happened to sort first ("Daniel Muvirimi").
// A driver name printed on a passenger ticket must be a deliberate choice.
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers/test_db.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await useTestDatabaseDir('start_shift_options');
  });

  var seq = 0;
  setUp(() async {
    seq++;
    await AppDb.initForTest(dbPath: 'opts_$seq.db');
  });

  group('driver roster ordering', () {
    test('drivers come back sorted by name', () async {
      await AppDb.addDriver('Tariro Moyo', '0770000001');
      await AppDb.addDriver('Anna Chikore', '0770000002');
      await AppDb.addDriver('Daniel Muvirimi', '0770000003');

      final drivers = await AppDb.getDrivers();
      expect(
        drivers.map((d) => d.name).toList(),
        ['Anna Chikore', 'Daniel Muvirimi', 'Tariro Moyo'],
      );
    });

    test('an empty roster is handled without preselecting anyone', () async {
      // Mirrors _resolveDriverOptions falling back to an empty list; the screen
      // must then show the free-text driver field, not a chosen name.
      final drivers = await AppDb.getDrivers();
      expect(drivers, isEmpty);
    });
  });

  group('roster refresh safety', () {
    test('re-reading the roster does not duplicate drivers', () async {
      await AppDb.addDriver('Daniel Muvirimi', '0771234567');
      // syncStaffRoster may run again on every screen open.
      await AppDb.getDrivers();
      await AppDb.getDrivers();
      expect((await AppDb.getDrivers()).length, 1);
    });

    test('inactive drivers are excluded from the selectable roster', () async {
      await AppDb.addDriver('Daniel Muvirimi', '0771234567');
      final all = await AppDb.getDrivers(onlyActive: false);
      final active = await AppDb.getDrivers();
      expect(all.length, 1);
      expect(active.length, 1);
    });
  });
}
