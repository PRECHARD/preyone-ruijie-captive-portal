import 'package:flutter_test/flutter_test.dart';

import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/models/trip_model.dart';
import 'package:bus_ticket_app/src/services/transit_api.dart';
import 'package:bus_ticket_app/src/uuid.dart';

void main() {
  group('uuidV4', () {
    test('produces RFC-4122 v4 formatted ids', () {
      final a = uuidV4();
      final b = uuidV4();
      expect(a, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
      expect(a, isNot(b));
    });
  });

  group('TripInstance', () {
    test('round-trips through the DB row shape', () {
      final instance = TripInstance(
        id: 'inst-1',
        tripId: 'trip-1',
        tripNo: 'T-88',
        shiftId: 'shift-1',
        status: 'RUNNING',
        actualDeparture: '2026-09-22T06:30:00.000Z',
        actualArrival: '',
        startedAt: DateTime.utc(2026, 9, 22, 6, 30),
      );
      final back = TripInstance.fromMap(instance.toMap());
      expect(back.id, 'inst-1');
      expect(back.tripId, 'trip-1');
      expect(back.tripNo, 'T-88');
      expect(back.shiftId, 'shift-1');
      expect(back.status, 'RUNNING');
      expect(back.actualDeparture, '2026-09-22T06:30:00.000Z');
      expect(back.startedAt, DateTime.utc(2026, 9, 22, 6, 30));
    });

    test('ended instance keeps the arrival stamp', () {
      final instance = TripInstance.fromMap({
        'id': 'inst-2',
        'trip_id': 'trip-2',
        'trip_no': 'T-99',
        'shift_id': 'shift-2',
        'status': 'ENDED',
        'actual_departure': '2026-09-22T06:30:00.000Z',
        'actual_arrival': '2026-09-22T17:40:00.000Z',
        'started_at': '2026-09-22T06:30:00.000Z',
        'ended_at': '2026-09-22T17:40:00.000Z',
      });
      expect(instance.status, 'ENDED');
      expect(instance.actualArrival, '2026-09-22T17:40:00.000Z');
      expect(instance.endedAt, DateTime.utc(2026, 9, 22, 17, 40));
    });
  });

  group('SyncQueueEvent', () {
    test('round-trips through the queue row shape', () {
      final event = SyncQueueEvent(
        id: 7,
        eventUuid: uuidV4(),
        eventType: 'TRIP_STARTED',
        tripId: 'trip-1',
        tripNo: 'T-88',
        shiftId: 'shift-1',
        payload: '{"instanceId":"inst-1"}',
        createdAt: DateTime.utc(2026, 9, 22, 6, 30),
        synced: 0,
      );
      final back = SyncQueueEvent.fromMap(event.toMap());
      expect(back.id, 7);
      expect(back.eventType, 'TRIP_STARTED');
      expect(back.tripId, 'trip-1');
      expect(back.shiftId, 'shift-1');
      expect(back.synced, 0);
      expect(back.createdAt, DateTime.utc(2026, 9, 22, 6, 30));
    });
  });

  group('Sale sync payload', () {
    test('carries trip_instance_id next to trip_id', () {
      final sale = Sale(
        receiptNo: 'AGJ0001',
        items: const [],
        total: 500,
        cash: 500,
        change: 0,
        tripId: 'trip-1',
        tripInstanceId: 'inst-1',
        shiftId: 'shift-1',
        routeName: 'Harare - Bulawayo',
        createdAt: DateTime.utc(2026, 9, 22, 6, 30),
      );
      final payload = saleSyncPayload(sale.toJson(), companyId: 'c1');
      expect(payload['trip_id'], 'trip-1');
      expect(payload['trip_instance_id'], 'inst-1');
      expect(payload['shift_id'], 'shift-1');
    });
  });
}