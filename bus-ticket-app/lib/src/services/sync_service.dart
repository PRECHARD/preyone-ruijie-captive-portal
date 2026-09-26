import 'dart:convert';

import 'package:http/http.dart' as http;

import '../db/app_db.dart';
import '../controllers/trip_controller.dart';
import '../security/secure_keystore.dart';
import 'session_guard.dart';
import 'transit_api.dart';

class SyncResult {
  const SyncResult({
    required this.ok,
    required this.message,
    this.critical = false,
    this.deviceDisabled = false,
    this.updateRequired = false,
    this.minAppVersion = '',
  });

  final bool ok;
  final String message;
  final bool critical;
  final bool deviceDisabled;
  final bool updateRequired;
  final String minAppVersion;
}

class SyncService {
  SyncService._();
  static final SyncService instance = SyncService._();

  Future<SyncResult> syncNow() async {
    try {
      final token = await SecureKeystore.instance.readDeviceToken();
      if (token == null || token.isEmpty) {
        return const SyncResult(
          ok: false,
          message: 'This device is not signed in. Please log in again.',
          critical: true,
        );
      }

      final base = await TransitApi.baseUrl();
      if (base.isEmpty) {
        return const SyncResult(
          ok: false,
          message: 'No sync server configured. Please update the app.',
        );
      }

      // Two-way admin replay: push any lifecycle events recorded offline
      // (TRIP_STARTED / TRIP_ENDED) so the server sees trips open before the
      // tickets that reference them. Idempotent + best-effort.
      try {
        await TripController.instance.syncQueuedEvents();
      } catch (_) {}

      // Best-effort: push any locally-started shift so the server can
      // attribute this device's sales to it. Never blocks or fails the sync.
      final activeShift = await AppDb.getActiveShift();
      if (activeShift != null && activeShift.synced == 0) {
        try {
          final shiftResp = await TransitApi.startShift(
            shiftId: activeShift.id,
            driverId: activeShift.driverId,
            driverName: activeShift.driverName,
            driverPhone: activeShift.driverPhone,
            conductorName: activeShift.conductorName,
            conductorPhone: activeShift.conductorPhone,
            vehicleReg: activeShift.vehicleReg,
          );
          if (shiftResp['shift'] != null) {
            await AppDb.markShiftSynced(activeShift.id);
          }
        } catch (_) {}
      }

      final pending = await AppDb.getUnsyncedSales();
      if (pending.isEmpty) {
        // Still heartbeat so the server renews our offline authorization.
        try {
          final payloads = <Map<String, Object?>>[];
          final resp = await TransitApi.sendSync(payloads, token);
          return _handleResp(resp);
        } catch (_) {
          return const SyncResult(
              ok: false, message: 'Nothing to sync, and server unreachable.');
        }
      }

      final companyId = (await SecureKeystore.instance.readCompanyId()) ?? '';
      final tickets = pending
          .map((s) => saleSyncPayload(s.toJson(), companyId: companyId))
          .toList();

      final resp = await TransitApi.sendSync(tickets, token);
      final result = _handleResp(resp);
      if (result.ok && tickets.isNotEmpty) {
        // Only mark rows synced=1 for ticket_ids the server ACTUALLY accepted
        // (its `ids` array). A seat-conflicted or otherwise rejected ticket
        // must stay pending so a later push retries it, instead of being
        // silently dropped as "synced" and lost forever.
        final accepted = <String>{};
        try {
          final body = (jsonDecode(utf8.decode(resp.bodyBytes)) as Map?)
                  ?.cast<String, dynamic>() ??
              const <String, dynamic>{};
          final idsList = body['ids'];
          if (idsList is List) {
            for (final id in idsList) {
              final tid = id?.toString().trim() ?? '';
              if (tid.isNotEmpty) accepted.add(tid);
            }
          }
        } catch (_) {}
        final ids = <int>[];
        for (var i = 0; i < pending.length; i++) {
          final ticketId = tickets[i]['ticket_id']?.toString().trim() ?? '';
          if (ticketId.isNotEmpty &&
              accepted.contains(ticketId) &&
              pending[i].id != null) {
            ids.add(pending[i].id!);
          }
        }
        await AppDb.markSalesSynced(ids);
      }
      return result;
    } on TransitApiException catch (e) {
      return SyncResult(
        ok: false,
        message: e.message,
        critical: SessionGuard.isRevoked(e.code) ||
            e.code == 'SESSION_EXPIRED' ||
            e.code == 'DEVICE_NOT_FOUND',
        deviceDisabled: SessionGuard.isRevoked(e.code),
        updateRequired: e.code == 'APP_UPDATE_REQUIRED',
        minAppVersion: '',
      );
    } catch (e) {
      return const SyncResult(
        ok: false,
        message: 'Sync failed. You can continue selling offline.',
      );
    }
  }

  /// Pulls the company's open trips + promotions and mirrors them locally.
  /// Best-effort — a failed pull never blocks selling (offline data wins).
  Future<void> refreshCatalog() async {
    try {
      final token = await SecureKeystore.instance.readDeviceToken();
      if (token == null || token.isEmpty) return;
      final base = await TransitApi.baseUrl();
      if (base.isEmpty) return;

      final tripResp = await TransitApi.fetchTrips(); // active trips only
      await AppDb.upsertTrips(tripResp);

      final promos = await TransitApi.fetchPromotions();
      await AppDb.upsertPromos(promos);

      // Mirror the company profile so receipts can be branded offline.
      try {
        final profile = await TransitApi.fetchCompany();
        await AppDb.upsertCompanyProfile(profile);
      } catch (_) {}

      // Mirror admin-managed drivers/conductors into the local picker tables.
      // Best-effort: a roster fetch failure must never break the catalog sync.
      try {
        final staff = await TransitApi.fetchStaff();
        await AppDb.upsertStaffRoster(staff);
      } catch (_) {}

      // Sync the currently-active local trip with the freshest server copy.
      final active = await AppDb.getActiveTrip();
      if (active != null && active.id.isNotEmpty) {
        final fresh = await AppDb.getTrip(active.id);
        if (fresh != null) {
          await AppDb.setActiveTrip(fresh);
        }
      }

      // Heal stale local runs against the freshly-pulled server mirror: a
      // RUNNING instance whose trip is COMPLETED/CANCELLED (or gone) is a ghost
      // that must not block the operator. Best-effort — never fails the pull.
      await TripController.instance.reconcileRunningInstances();
    } catch (_) {
      // Offline — keep the local snapshot.
    }
  }

  /// Pulls the freshest admin-managed staff roster (all roles) and upserts it
  /// into the local picker tables. `TransitApi.fetchStaff` sends
  /// `Cache-Control: no-cache` so a mid-flight phone change is picked up on the
  /// next shift start / pull-to-refresh. Best-effort — offline keeps the cache.
  Future<void> syncStaffRoster() async {
    try {
      final token = await SecureKeystore.instance.readDeviceToken();
      if (token == null || token.isEmpty) return;
      final base = await TransitApi.baseUrl();
      if (base.isEmpty) return;
      final staff = await TransitApi.fetchStaff();
      await AppDb.upsertStaffRoster(staff);
    } catch (_) {
      // Offline or roster endpoint blocked — keep the local snapshot.
    }
  }

  SyncResult _handleResp(http.Response resp) {
    Map<String, dynamic> body;
    try {
      body = (jsonDecode(utf8.decode(resp.bodyBytes)) as Map?)
              ?.cast<String, dynamic>() ??
          {};
    } catch (_) {
      body = {};
    }

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      String lease = '';
      final device = body['device'];
      if (device is Map) {
        lease = (device['licenseExpiresAt'] ?? device['serverTime'] ?? '')
            .toString();
      }
      if (lease.isNotEmpty) {
        try {
          final expiry = DateTime.parse(lease).toUtc().toIso8601String();
          SecureKeystore.instance.saveOfflineLease(expiry);
        } catch (_) {}
      }
      final synced = body['synced'] ?? 0;
      final duplicates = body['duplicates'] ?? 0;
      final conflicts = body['conflicts'] ?? 0;
      final rejected = (body['rejected'] as List?)?.length ?? 0;
      var msg = '$synced sale(s) synced';
      if (duplicates > 0) msg += ', $duplicates duplicate(s)';
      if (conflicts > 0) msg += ', $conflicts seat conflict(s)';
      if (rejected > 0) msg += ', $rejected rejected (invalid signature)';
      return SyncResult(ok: true, message: msg);
    }

    if (resp.statusCode == 401 || resp.statusCode == 403) {
      final code = (body['code'] ?? '').toString();
      final disabled = SessionGuard.isRevoked(code);
      return SyncResult(
        ok: false,
        critical:
            disabled || code == 'SESSION_EXPIRED' || code == 'DEVICE_NOT_FOUND',
        deviceDisabled: disabled,
        message: (body['error'] ?? 'Access denied by server').toString(),
      );
    }

    if (resp.statusCode == 426) {
      final minVersion = (body['minAppVersion'] ?? '').toString();
      return SyncResult(
        ok: false,
        updateRequired: true,
        minAppVersion: minVersion,
        message: (body['error'] ?? 'A newer version of the app is required.')
            .toString(),
      );
    }

    if (resp.statusCode == 404) {
      return const SyncResult(
          ok: false, message: 'Sync endpoint not found on the server.');
    }

    if (resp.statusCode >= 500) {
      return const SyncResult(
          ok: false, message: 'Server error. Try again later.');
    }

    return SyncResult(
      ok: false,
      message: (body['error'] ?? 'Sync failed (${resp.statusCode})').toString(),
    );
  }
}
