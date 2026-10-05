import '../models.dart' show Trip;

export '../models.dart' show Trip;

/// A concrete run of a scheduled [Trip] on this device. The server trip is the
/// reusable schedule; the instance is a single departure stamped with the real
/// departure/arrival times and the shift that crewed it. One device runs at
/// most one instance at a time (like one open shift).
class TripInstance {
  TripInstance({
    this.id = '',
    this.tripId = '',
    this.tripNo = '',
    this.shiftId = '',
    this.status = 'RUNNING',
    this.actualDeparture = '',
    this.actualArrival = '',
    this.startedAt,
    this.endedAt,
  });

  final String id;
  final String tripId;
  final String tripNo;
  final String shiftId;

  /// RUNNING until the run is ended, then ENDED. Mirrors the device state only
  /// — the server trip lifecycle (ACTIVE / COMPLETED) is driven separately via
  /// the queued TRIP_STARTED / TRIP_ENDED events.
  final String status;

  /// ISO-8601 timestamp of the actual departure (stamped at startTrip).
  final String actualDeparture;

  /// ISO-8601 timestamp of the actual arrival (stamped at endTrip).
  final String actualArrival;

  final DateTime? startedAt;
  final DateTime? endedAt;

  Map<String, Object?> toMap() => {
        'id': id,
        'trip_id': tripId,
        'trip_no': tripNo,
        'shift_id': shiftId,
        'status': status,
        'actual_departure': actualDeparture,
        'actual_arrival': actualArrival,
        'started_at': startedAt?.toIso8601String() ?? '',
        'ended_at': endedAt?.toIso8601String() ?? '',
      };

  factory TripInstance.fromMap(Map<String, Object?> map) => TripInstance(
        id: (map['id'] as String?) ?? '',
        tripId: (map['trip_id'] as String?) ?? '',
        tripNo: (map['trip_no'] as String?) ?? '',
        shiftId: (map['shift_id'] as String?) ?? '',
        status: (map['status'] as String?) ?? 'RUNNING',
        actualDeparture: (map['actual_departure'] as String?) ?? '',
        actualArrival: (map['actual_arrival'] as String?) ?? '',
        startedAt: DateTime.tryParse((map['started_at'] as String?) ?? ''),
        endedAt: DateTime.tryParse((map['ended_at'] as String?) ?? ''),
      );
}

/// One row of the offline persist/replay queue. Every lifecycle action that
/// happened offline (TRIP_STARTED / TRIP_ENDED) is recorded here with a
/// transaction UUID and pushed to the server during the next sync. The server
/// endpoints are naturally idempotent, so a replay after a partial failure is
/// safe. TICKET_SOLD is intentionally NOT queued here — offline sales already
/// ride the existing `sales.synced` flag with per-ticket tx_id idempotency.
class SyncQueueEvent {
  SyncQueueEvent({
    this.id,
    this.eventUuid = '',
    required this.eventType,
    this.tripId = '',
    this.tripNo = '',
    this.shiftId = '',
    this.payload = '',
    this.createdAt,
    this.synced = 0,
  });

  final int? id;
  final String eventUuid;
  final String eventType;
  final String tripId;
  final String tripNo;
  final String shiftId;
  final String payload;
  final DateTime? createdAt;
  final int synced;

  Map<String, Object?> toMap() => {
        'id': id,
        'event_uuid': eventUuid,
        'event_type': eventType,
        'trip_id': tripId,
        'trip_no': tripNo,
        'shift_id': shiftId,
        'payload': payload,
        'created_at': createdAt?.toIso8601String() ?? '',
        'synced': synced,
      };

  factory SyncQueueEvent.fromMap(Map<String, Object?> map) => SyncQueueEvent(
        id: map['id'] as int?,
        eventUuid: (map['event_uuid'] as String?) ?? '',
        eventType: (map['event_type'] as String?) ?? '',
        tripId: (map['trip_id'] as String?) ?? '',
        tripNo: (map['trip_no'] as String?) ?? '',
        shiftId: (map['shift_id'] as String?) ?? '',
        payload: (map['payload'] as String?) ?? '',
        createdAt: DateTime.tryParse((map['created_at'] as String?) ?? ''),
        synced: (map['synced'] as int?) ?? 0,
      );
}
