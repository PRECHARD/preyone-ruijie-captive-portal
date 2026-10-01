// End-of-shift must reach the admin trip schedule, not just the handset.
//
// The bug this protects against: ending a shift offline closed only the local
// SQLite row. The server was never told, so it kept reporting the shift as OPEN
// and admin saw a driver still on duty hours after the bus went off the road.
// There was no queue, so the close was simply lost — and worse, a later sync
// re-pushed the shift via /shifts/start, which flips status back to OPEN.
//
// AppDb now records close_pushed = 0 when a shift closes locally, and the sync
// service replays every unpushed close with the timestamp the conductor actually
// finished, then marks it pushed.
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers/test_db.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    await useTestDatabaseDir('shift_close_sync');
  });

  var seq = 0;
  setUp(() async {
    seq++;
    await AppDb.initForTest(dbPath: 'shift_close_$seq.db');
  });

  Future<DriverShift> openShift({String id = 'shift-1'}) async {
    await AppDb.startShift(
      id: id,
      driverId: 'd1',
      driverName: 'DANIEL MUVIRIMI',
      driverPhone: '0771234567',
      conductorName: 'LESLIE MUVIRIMI',
      conductorPhone: '0777654321',
      vehicleReg: 'AGJ 1234',
    );
    return (await AppDb.getActiveShift())!;
  }

  test('a newly opened shift is flagged as not yet synced', () async {
    await openShift();
    final shift = await AppDb.getActiveShift();
    expect(shift, isNotNull);
    expect(shift!.status, 'OPEN');
    expect(shift.synced, 0);
  });

  test('closing a shift queues the close for the server', () async {
    await openShift();
    await AppDb.closeActiveShift();

    // No open shift remains locally...
    expect(await AppDb.getActiveShift(), isNull);

    // ...and the close is pending, waiting for connectivity.
    final pending = await AppDb.getUnpushedClosedShifts();
    expect(pending.length, 1);
    expect(pending.first.id, 'shift-1');
  });

  test('a pushed close is not replayed again', () async {
    await openShift();
    await AppDb.closeActiveShift();
    expect((await AppDb.getUnpushedClosedShifts()).length, 1);

    await AppDb.markShiftClosePushed('shift-1');
    expect(await AppDb.getUnpushedClosedShifts(), isEmpty);
  });

  test('a close records when the conductor actually finished', () async {
    await openShift();
    final before = DateTime.now();
    await AppDb.closeActiveShift();
    final closed = (await AppDb.getUnpushedClosedShifts()).first;

    expect(closed.closedAt, isNotNull);
    // Sent verbatim to the server so an offline close is not re-stamped at
    // reconnection time.
    expect(
      !closed.closedAt!.isBefore(before.subtract(const Duration(seconds: 2))),
      isTrue,
    );
  });

  test('several offline closes are all queued, oldest first', () async {
    await openShift(id: 's1');
    await AppDb.closeActiveShift();
    await openShift(id: 's2');
    await AppDb.closeActiveShift();
    await openShift(id: 's3');
    await AppDb.closeActiveShift();

    final pending = await AppDb.getUnpushedClosedShifts();
    expect(pending.map((s) => s.id).toList(), ['s1', 's2', 's3']);
  });

  test('a still-open shift is never treated as a pending close', () async {
    await openShift();
    expect(await AppDb.getUnpushedClosedShifts(), isEmpty);
  });

  test('starting a new shift does not resurrect an old close', () async {
    await openShift(id: 's1');
    await AppDb.closeActiveShift();
    await AppDb.markShiftClosePushed('s1');
    await openShift(id: 's2');

    final pending = await AppDb.getUnpushedClosedShifts();
    expect(pending, isEmpty);
    expect((await AppDb.getActiveShift())!.id, 's2');
  });

  test('crew details are stored so they can be pushed to admin', () async {
    final shift = await openShift();
    expect(shift.driverName, 'DANIEL MUVIRIMI');
    expect(shift.driverPhone, '0771234567');
    expect(shift.conductorName, 'LESLIE MUVIRIMI');
    expect(shift.conductorPhone, '0777654321');
    expect(shift.vehicleReg, 'AGJ 1234');
  });
}
