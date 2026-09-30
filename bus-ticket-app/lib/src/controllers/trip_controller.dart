import 'dart:convert';

import '../app_state.dart';
import '../db/app_db.dart';
import '../models/trip_model.dart';
import '../security/secure_keystore.dart';
import '../services/transit_api.dart';
import '../uuid.dart';

/// Constant event types recorded on the offline replay queue.
abstract final class TripEvents {
  static const started = 'TRIP_STARTED';
  static const ended = 'TRIP_ENDED';
}

/// Owns the local trip lifecycle on a single device: starting and ending a
/// concrete run of a scheduled [Trip], persisting the running [TripInstance]
/// with real departure/arrival stamps, and queuing TRIP_STARTED / TRIP_ENDED
/// events for offline-first two-way replay with the admin backend.
///
/// The server trips are the reusable schedules (SCHEDULED / ACTIVE /
/// COMPLETED, driven by `transitRouter` start/complete endpoints); a `trip
/// instance` is this device's record of one actual run, so the same schedule
/// can ride again the next day while tickets stay attributable to a definite
/// departure via `sales.trip_instance_id`.
class TripController {
  TripController._();
  static final TripController instance = TripController._();

  /// Starts a run locally and (best-effort) flips the server schedule to ACTIVE.
  ///
  /// [shiftId] must be the device's open driver shift — the spec binds the
  /// run to its conductor/bus. When [actualDeparture] is omitted it falls back
  /// to now. The action is queued as TRIP_STARTED so an offline start replays
  /// on the next sync; the queue row is already marked synced when the live
  /// call wins. Returns the persisted instance (null on failure).
  Future<TripInstance?> startTrip(
    Trip trip, {
    required String shiftId,
    DateTime? actualDeparture,
  }) async {
    if (trip.id.isEmpty) return null;
    if (shiftId.isEmpty) return null;

    final departed = actualDeparture ?? DateTime.now();
    // One run per trip per device: reusing the existing RUNNING instance (or
    // rejecting a different trip) keeps a double-tap / re-entry from planting a
    // second RUNNING row for the same trip — the exact duplicate-start race that
    // left operators locked out with a "ghost" run no longer showing END.
    // Exactly one run per device. A trip that is already RUNNING is returned
    // as-is (a double-tap must not plant a second instance), and a DIFFERENT
    // trip already running blocks the start outright — the operator has to end
    // the current run first, so tickets can never straddle two departures.
    final forTrip = await AppDb.getRunningTripInstanceForTrip(trip.id);
    if (forTrip != null) {
      return forTrip;
    }
    final existing = await AppDb.getRunningTripInstance();
    if (existing != null) {
      return null;
    }

    final instance = TripInstance(
      id: uuidV4(),
      tripId: trip.id,
      tripNo: trip.tripNo,
      shiftId: shiftId,
      status: 'RUNNING',
      actualDeparture: departed.toUtc().toIso8601String(),
      startedAt: departed.toUtc(),
    );
    await AppDb.insertTripInstance(instance);

    final eventUuid = uuidV4();
    var synced = 0;
    // A local on-the-go trip has no server schedule to flip: the instance row
    // above is the whole record. Queueing TRIP_STARTED would replay forever
    // against a trip id the server has never seen.
    if (!trip.isLocal) {
      try {
        final fresh = await TransitApi.tripAction(trip.id, 'start');
        await AppDb.upsertTrip(fresh);
        synced = 1;
      } catch (_) {
        // Offline — the server is updated during the next sync.
        synced = 0;
      }
      await AppDb.queueEvent(
        eventType: TripEvents.started,
        eventUuid: eventUuid,
        tripId: trip.id,
        tripNo: trip.tripNo,
        shiftId: shiftId,
        payload: jsonEncode({
          'instanceId': instance.id,
          'actualDeparture': instance.actualDeparture,
          'conductor': (await SecureKeystore.instance.readFullName()) ?? '',
          'busReg': trip.busReg,
        }),
      );
      if (synced == 1) {
        final queued = await AppDb.getUnsyncedEvents();
        for (final e in queued) {
          if (e.eventUuid == eventUuid) await AppDb.markEventSynced(e.id!);
        }
      }
    }
    AppState.instance.refresh();
    return instance;
  }

  /// Ends the running run: stamps the actual arrival, queues TRIP_ENDED with a
  /// sales summary and best-effort completes the server schedule. When the
  /// trip was started locally the run is released (active selection cleared) so
  /// the operator can pick the next schedule immediately.
  Future<void> endTrip(TripInstance instance, {DateTime? arrivedAt}) async {
    final arrived = arrivedAt ?? DateTime.now();
    // End every RUNNING row for the trip, not just the one in memory — a
    // duplicate-start race can leave several, and leaving any behind resurrects
    // the "ghost running trip" lockout.
    await AppDb.endRunningInstancesForTrip(instance.tripId, arrivedAt: arrived);

    int sold = 0;
    int grossCents = 0;
    int cashCents = 0;
    try {
      final sales = await AppDb.getSalesByTrip(instance.tripId);
      sold = sales.length;
      grossCents = sales.fold<int>(0, (sum, s) => sum + s.total);
      cashCents = sales
          .where((s) => s.paymentMethod == 'cash')
          .fold<int>(0, (sum, s) => sum + s.cash);
    } catch (_) {}

    final eventUuid = uuidV4();
    var synced = 0;
    // Local on-the-go trips are not on the server board — see startTrip.
    final trip = await AppDb.getTrip(instance.tripId);
    if (trip == null || !trip.isLocal) {
      try {
        final fresh = await TransitApi.tripAction(instance.tripId, 'complete');
        await AppDb.upsertTrip(fresh);
        synced = 1;
      } catch (_) {
        synced = 0;
      }
      await AppDb.queueEvent(
        eventType: TripEvents.ended,
        eventUuid: eventUuid,
        tripId: instance.tripId,
        tripNo: instance.tripNo,
        shiftId: instance.shiftId,
        payload: jsonEncode({
          'instanceId': instance.id,
          'actualArrival': arrived.toUtc().toIso8601String(),
          'sold': sold,
          'grossCents': grossCents,
          'cashCents': cashCents,
        }),
      );
      if (synced == 1) {
        final queued = await AppDb.getUnsyncedEvents();
        for (final e in queued) {
          if (e.eventUuid == eventUuid) await AppDb.markEventSynced(e.id!);
        }
      }
    }

    // Release the run: the schedule is free again for the next departure and
    // the operator must pick (or create) their next trip before selling.
    final active = await AppDb.getActiveTrip();
    if (active != null && active.id == instance.tripId) {
      await AppDb.setActiveTrip(null);
    }
    AppState.instance.refresh();
  }

  /// Replays queued lifecycle events to the server. Called by [SyncService]
  /// after the ticket/shift push so an offline start or end catches up the
  /// moment connectivity returns. The start/complete endpoints are
  /// idempotent, so a replay after a failed batch is safe.
  ///
  /// Best-effort — a failure here never fails the overall sync.
  Future<void> syncQueuedEvents() async {
    final events = await AppDb.getUnsyncedEvents();
    if (events.isEmpty) return;
    final token = await SecureKeystore.instance.readDeviceToken();
    if (token == null || token.isEmpty) return;
    final base = await TransitApi.baseUrl();
    if (base.isEmpty) return;

    final done = <int>[];
    for (final e in events) {
      try {
        if (e.tripId.isEmpty) continue;
        if (e.eventType == TripEvents.started) {
          final trip = await TransitApi.tripAction(e.tripId, 'start');
          await AppDb.upsertTrip(trip);
          done.add(e.id!);
        } else if (e.eventType == TripEvents.ended) {
          final trip = await TransitApi.tripAction(e.tripId, 'complete');
          await AppDb.upsertTrip(trip);
          done.add(e.id!);
        }
      } catch (_) {
        // Leave it queued — retried on the next sync.
      }
    }
    if (done.isNotEmpty) {
      await AppDb.markEventsSynced(done);
      AppState.instance.refresh();
    }
  }

  /// The live running instance on this device (null when nothing is running).
  Future<TripInstance?> runningInstance() => AppDb.getRunningTripInstance();

  /// Self-heals "ghost" runs. Called right after a successful catalog pull so
  /// the local trip mirror is fresh: any RUNNING instance whose trip is now
  /// COMPLETED / CANCELLED (or no longer present in the schedule) can never be
  /// legitimately continued — the server already closed it. Once every sale
  /// attached to that trip has synced, the instance is flipped to ENDED so a
  /// leftover row can no longer badge the run and block the operator.
  ///
  /// Never clears while the trip still owns unsynced tickets (they reference
  /// this instance and must survive), and never throws — a cleanup failure must
  /// never break the launch path.
  Future<void> reconcileRunningInstances() async {
    try {
      final running = await AppDb.getRunningTripInstances();
      if (running.isEmpty) return;
      final unsyncedTrips =
          (await AppDb.getUnsyncedSales()).map((s) => s.tripId).toSet();
      var changed = false;
      for (final inst in running) {
        final trip = await AppDb.getTrip(inst.tripId);
        final closed = trip == null ||
            trip.status == 'COMPLETED' ||
            trip.status == 'CANCELLED';
        if (!closed) continue;
        if (unsyncedTrips.contains(inst.tripId)) continue;
        await AppDb.endTripInstance(inst.id);
        final active = await AppDb.getActiveTrip();
        if (active != null && active.id == inst.tripId) {
          await AppDb.setActiveTrip(null);
        }
        changed = true;
      }
      if (changed) AppState.instance.refresh();
    } catch (_) {}
  }

  /// Settings "Force End Stuck Run" valve. Ends every RUNNING instance on the
  /// device so a ghost can never seal the operator out. Sales rows are NEVER
  /// touched or deleted — they keep their trip reference and remain queued, so
  /// a forced end can never drop offline revenue. Returns a short human
  /// summary; the caller is expected to have drained the queue first.
  Future<String> forceEndStuckRun() async {
    final running = await AppDb.getRunningTripInstances();
    if (running.isEmpty) return 'No running trip on this device.';
    await AppDb.endAllRunningInstances();
    final active = await AppDb.getActiveTrip();
    if (active != null) await AppDb.setActiveTrip(null);
    AppState.instance.refresh();
    final trips = running.map((i) => i.tripNo).toSet().join(', ');
    return 'Ended stuck run(s): $trips.';
  }
}
