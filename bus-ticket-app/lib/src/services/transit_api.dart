import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:http/http.dart' as http;

import '../config/env.dart';
import '../db/app_db.dart';
import '../models.dart';
import '../models/route_template.dart';
import '../receipt.dart';
import '../security/secure_keystore.dart';
import '../version.dart';

export '../version.dart';

class TransitApiException implements Exception {
  TransitApiException(this.message, {this.code, this.statusCode});
  final String message;
  final String? code;
  final int? statusCode;
  @override
  String toString() => message;
}

class TransitAccount {
  const TransitAccount({
    required this.userId,
    required this.username,
    required this.fullName,
    required this.role,
    required this.companyId,
    this.companySlug = '',
    this.sessionToken = '',
    this.deviceToken = '',
    this.needsDeviceRegistration = false,
    this.deviceMismatch = false,
    this.deviceDisabled = false,
    this.offlineLease,
    this.minAppVersion = '',
    this.permissions,
  });

  final String userId;
  final String username;
  final String fullName;
  final String role;
  final String companyId;
  final String companySlug;
  final String sessionToken;
  final String deviceToken;
  final bool needsDeviceRegistration;
  final bool deviceMismatch;
  final bool deviceDisabled;
  final String? offlineLease;
  final String minAppVersion;

  /// Effective permission codes from the server. Null when the server did not
  /// send the field (older backend) — callers must fall back to role checks.
  final List<String>? permissions;
}

class TransitApi {
  TransitApi._();
  static final TransitApi instance = TransitApi._();

  static String? _baseUrl;
  static String? _deviceModel;

  /// Test seam. Shift-close replay is the one path whose PAYLOAD is business
  /// critical: the server can only record the crew of a shift that began and
  /// ended offline if the handset sends those details, and nothing on the
  /// server can recover them. Without an injectable client the payload cannot
  /// be asserted at all, because every call is a real network request.
  static http.Client? _clientOverride;

  /// Installs a client for tests. Pass null to restore the real one.
  @visibleForTesting
  static void debugSetClient(http.Client? client) => _clientOverride = client;

  static http.Client get _client =>
      _clientOverride ?? (http.Client());

  /// The production endpoint is hardcoded — field staff never configure a
  /// server URL. Legacy keystore/db overrides are ignored so every device
  /// talks to the same backend.
  static Future<String> baseUrl() async {
    if (_baseUrl != null && _baseUrl!.isNotEmpty) {
      return _baseUrl!;
    }
    _baseUrl = kDefaultApiBaseUrl;
    return _baseUrl!;
  }

  static void invalidateBaseUrl() {
    _baseUrl = null;
  }

  static Future<String> deviceModel() async {
    if (_deviceModel != null) return _deviceModel!;
    _deviceModel = 'Android';
    return _deviceModel!;
  }

  static Future<Map<String, String>> _headers({String? token}) async {
    final h = <String, String>{
      'Content-Type': 'application/json',
      'X-App-Version': kAppVersion,
    };
    if (token != null && token.isNotEmpty) {
      h['Authorization'] = 'Bearer $token';
    }
    return h;
  }

  static Map<String, Object?> _jsonBody(http.Response resp) {
    try {
      final decoded = jsonDecode(utf8.decode(resp.bodyBytes));
      return decoded is Map<String, dynamic> ? decoded : {};
    } catch (_) {
      return {};
    }
  }

  /// Server sign-in. Returns an account bound to this device if the device
  /// was already registered; otherwise flags needsDeviceRegistration.
  static Future<TransitAccount> login(String username, String password) async {
    final base = await baseUrl();
    if (base.isEmpty) {
      throw TransitApiException(
          'No sync server configured. Please update the app.');
    }
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/auth/login'),
          headers: await _headers(),
          body: jsonEncode({
            'username': username.trim(),
            'password': password,
            'deviceUuid': await SecureKeystore.instance.readDeviceUuid(),
            'devicePublicKey': await SecureKeystore.instance.publicKeyB64u(),
            'deviceModel': await deviceModel(),
            'appVersion': kAppVersion,
          }),
        )
        .timeout(const Duration(seconds: 25));

    final body = _jsonBody(resp);

    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      final user = (body['user'] as Map?) ?? const {};
      return TransitAccount(
        userId: (user['id'] ?? '').toString(),
        username: (user['username'] ?? '').toString(),
        fullName: (user['fullName'] ?? (user['full_name'] ?? '')).toString(),
        role: (user['role'] ?? '').toString(),
        companyId: ((body['company'] as Map?)?['id'] ?? '').toString(),
        companySlug: ((body['company'] as Map?)?['slug'] ?? '').toString(),
        sessionToken: (body['sessionToken'] ?? '').toString(),
        deviceToken: (body['deviceToken'] ?? '').toString(),
        needsDeviceRegistration: body['needsDeviceRegistration'] == true,
        deviceMismatch: body['deviceMismatch'] == true,
        deviceDisabled: body['deviceDisabled'] == true,
        offlineLease: (body['licenseExpiresAt'] ?? '').toString(),
        minAppVersion: (body['minAppVersion'] ?? '').toString(),
        permissions: _permissionList(user['permissions']),
      );
    }

    throw TransitApiException(
      (body['error'] ?? 'Login failed').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Extract a permission list from a response field, preserving the difference
  /// between "server sent an empty list" (no capabilities) and "server did not
  /// send the field" (unknown — fall back to role checks).
  static List<String>? _permissionList(Object? raw) {
    if (raw is! List) return null;
    return raw.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
  }

  /// Registers this device to the logged-in account (one-user-one-device).
  static Future<TransitAccount> registerDevice(TransitAccount account) async {
    final base = await baseUrl();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/devices/register'),
          headers: await _headers(token: account.sessionToken),
          body: jsonEncode({
            'deviceUuid': await SecureKeystore.instance.readDeviceUuid(),
            'devicePublicKey': await SecureKeystore.instance.publicKeyB64u(),
            'deviceModel': await deviceModel(),
            'appVersion': kAppVersion,
          }),
        )
        .timeout(const Duration(seconds: 25));

    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return TransitAccount(
        userId: account.userId,
        username: account.username,
        fullName: account.fullName,
        role: account.role,
        companyId: account.companyId,
        companySlug: account.companySlug,
        sessionToken: account.sessionToken,
        deviceToken: (body['deviceToken'] ?? '').toString(),
        needsDeviceRegistration: false,
        offlineLease: (body['licenseExpiresAt'] ?? '').toString(),
        minAppVersion:
            (body['minAppVersion'] ?? account.minAppVersion).toString(),
        permissions: _permissionList(
                (body['user'] as Map?)?['permissions'] ?? body['permissions']) ??
            account.permissions,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Device registration failed').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Requests a password-reset email for a registered portal account. The
  /// endpoint accepts an email or phone and always answers the same
  /// non-revealing message, so this never leaks whether an account exists.
  static Future<void> requestPasswordReset({
    String email = '',
    String phone = '',
  }) async {
    final base = await baseUrl();
    if (base.isEmpty) {
      throw TransitApiException('No server configured. Please update the app.');
    }
    final resp = await http
        .post(
          Uri.parse('$base/api/auth/request-password-reset'),
          headers: await _headers(),
          body: jsonEncode({
            if (email.isNotEmpty) 'email': email.trim(),
            if (phone.isNotEmpty) 'phone': phone.trim(),
          }),
        )
        .timeout(const Duration(seconds: 25));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return;
    throw TransitApiException(
      (body['error'] ?? 'Password reset request failed').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Server heartbeat — refreshes offline authorization and picks up
  /// revocation / required-version signals.
  static Future<Map<String, dynamic>> check() async {
    final base = await baseUrl();
    final token = await SecureKeystore.instance.readDeviceToken();
    if (token == null || token.isEmpty) {
      throw TransitApiException('Not signed in', code: 'NO_TOKEN');
    }
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/devices/check'),
          headers: await _headers(token: token),
          body: jsonEncode({'appVersion': kAppVersion}),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      // The heartbeat re-delivers the effective permission list, so a grant or
      // revocation made while this terminal is in the field takes effect without
      // a re-login. Absent on an older server → leave whatever we stored.
      final permissions = _permissionList(body['permissions']);
      if (permissions != null) {
        await SecureKeystore.instance.writePermissions(permissions);
      }
      return body;
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Check failed').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<http.Response> sendSync(
      List<Map<String, Object?>> tickets, String deviceToken) async {
    final base = await baseUrl();
    return http
        .post(
          Uri.parse('$base/api/transit/tickets/sync'),
          headers: await _headers(token: deviceToken),
          body: jsonEncode({'tickets': tickets, 'appVersion': kAppVersion}),
        )
        .timeout(const Duration(seconds: 40));
  }

  /// Fetches the server-side copy of one ticket by its `ticket_id` (local
  /// tx_id). Used to backfill missing customer/crew fields on older offline
  /// sales after they sync. Returns the raw `ticket` map (camelCase).
  static Future<Map<String, dynamic>> fetchTicket(String ticketId) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/tickets/$ticketId'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return (body['ticket'] as Map?)?.cast<String, dynamic>() ?? const {};
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load ticket').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<String> _deviceToken() async {
    final token = await SecureKeystore.instance.readDeviceToken();
    if (token == null || token.isEmpty) {
      throw TransitApiException('Not signed in', code: 'NO_TOKEN');
    }
    return token;
  }

  // ── Trip module ─────────────────────────────────────────────────────

  static Future<List<Trip>> fetchTrips({bool active = true}) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/trips/active'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return Trip.listFromJson(body['trips']);
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load trips').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<Trip> createTrip(Map<String, dynamic> payload) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/trips'),
          headers: await _headers(token: token),
          body: jsonEncode(payload),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return Trip.fromJson(
          (body['trip'] as Map?)?.cast<String, dynamic>() ?? const {});
    }
    if (resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Admin access required').toString(),
        code: 'FORBIDDEN',
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not create trip').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<Trip> tripAction(String id, String action) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/trips/$id/$action'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return Trip.fromJson(
          (body['trip'] as Map?)?.cast<String, dynamic>() ?? const {});
    }
    throw TransitApiException(
      (body['error'] ?? 'Trip action failed').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Reference manifest (trip + per-seat reconciliation order).
  static Future<Map<String, dynamic>> fetchManifest(String tripId) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/trips/$tripId/manifest'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 25));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return body;
    throw TransitApiException(
      (body['error'] ?? 'Could not load manifest').toString(),
      statusCode: resp.statusCode,
    );
  }

  // ── Company profile ─────────────────────────────────────────────────

  static Future<CompanyProfile> fetchCompany() async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/company'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return CompanyProfile.fromJson(
          (body['company'] as Map?)?.cast<String, dynamic>() ?? const {});
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load company profile').toString(),
      statusCode: resp.statusCode,
    );
  }

  // ── Staff roster (admin-managed drivers & conductors) ─────────────────

  /// Fetches admin-managed DRIVER / CONDUCTOR profiles for the device's company.
  /// Supplied to the local drivers/conductors tables via upsertStaffRoster.
  /// `Cache-Control: no-cache` forces a revalidation so a stale HTTP cache can
  /// never hand the terminals an outdated phone roster.
  static Future<List<StaffProfile>> fetchStaff({String? role}) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final q = (role == 'DRIVER' || role == 'CONDUCTOR') ? '?role=$role' : '';
    final headers = await _headers(token: token);
    headers['Cache-Control'] = 'no-cache';
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/staff$q'),
          headers: headers,
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return StaffProfile.listFromJson(body['staff']);
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load staff roster').toString(),
      statusCode: resp.statusCode,
    );
  }

  // ── Driver shifts module ────────────────────────────────────────────

  /// Pushes a shift started offline. Idempotent server-side (upserts on the
  /// same shift UUID), so re-syncs are safe.
  static Future<Map<String, dynamic>> startShift({
    required String shiftId,
    String driverId = '',
    String driverName = '',
    String driverPhone = '',
    String conductorName = '',
    String conductorPhone = '',
    String vehicleReg = '',
    String notes = '',
  }) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/shifts/start'),
          headers: await _headers(token: token),
          body: jsonEncode({
            'shiftId': shiftId,
            'driverId': driverId,
            'driverName': driverName,
            'driverPhone': driverPhone,
            'conductorName': conductorName,
            'conductorPhone': conductorPhone,
            'vehicleReg': vehicleReg,
            'notes': notes,
          }),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return body;
    throw TransitApiException(
      (body['error'] ?? 'Could not start shift').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Ends a shift. [closedAt] is the moment the conductor actually finished;
  /// it is sent so an offline close is recorded on the server with the real
  /// time rather than the time the handset reconnected.
  ///
  /// The crew details travel with the close because a shift that began and ended
  /// while the handset was offline never reached the server at all; the server
  /// upserts it as already closed rather than rejecting an unknown shift.
  static Future<Map<String, dynamic>> closeShift(
    String shiftId, {
    String? closedAt,
    String? driverId,
    String? driverName,
    String? driverPhone,
    String? conductorName,
    String? conductorPhone,
    String? vehicleReg,
  }) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final payload = <String, Object?>{'shiftId': shiftId};
    void put(String key, String? value) {
      if (value != null && value.trim().isNotEmpty) payload[key] = value.trim();
    }

    put('closedAt', closedAt);
    put('driverId', driverId);
    put('driverName', driverName);
    put('driverPhone', driverPhone);
    put('conductorName', conductorName);
    put('conductorPhone', conductorPhone);
    put('vehicleReg', vehicleReg);

    final resp = await _client
        .post(
          Uri.parse('$base/api/transit/shifts/close'),
          headers: await _headers(token: token),
          body: jsonEncode(payload),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return body;
    throw TransitApiException(
      (body['error'] ?? 'Could not close shift').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Open shifts for the company — used to reconcile a local shift.
  static Future<List<DriverShift>> fetchActiveShifts() async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/shifts/active'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      final list = body['shifts'] as List? ?? [];
      return list
          .whereType<Map>()
          .map((e) => DriverShift.fromJson(Map<String, dynamic>.from(e)))
          .toList();
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load shifts').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  // ── Promotions module ───────────────────────────────────────────────

  static Future<List<Promo>> fetchPromotions() async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .get(
          Uri.parse('$base/api/transit/promotions'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return Promo.listFromJson(body['promotions']);
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load promotions').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<Map<String, dynamic>> createPromotion(
      Map<String, dynamic> payload) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/promotions'),
          headers: await _headers(token: token),
          body: jsonEncode(payload),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return body;
    if (resp.statusCode == 403 || resp.statusCode == 409) {
      throw TransitApiException(
        (body['error'] ?? 'Could not create promotion').toString(),
        code: (body['code'] ?? '').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not create promotion').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<Map<String, dynamic>> updatePromotion(
      String id, Map<String, dynamic> payload) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .put(
          Uri.parse('$base/api/transit/promotions/$id'),
          headers: await _headers(token: token),
          body: jsonEncode(payload),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return body;
    if (resp.statusCode == 403 || resp.statusCode == 409) {
      throw TransitApiException(
        (body['error'] ?? 'Could not update promotion').toString(),
        code: (body['code'] ?? '').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not update promotion').toString(),
      statusCode: resp.statusCode,
    );
  }

  // ── Master route templates ──────────────────────────────────────────
  // Readable by every device (all conductors need them to open an on-the-go
  // run offline). Writes need `route.templates.manage`, which the company may
  // be granted even when its owner is field staff.

  static Future<List<RouteTemplate>> fetchRouteTemplates() async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final headers = await _headers(token: token);
    // Same reasoning as fetchStaff: a stale HTTP cache would silently serve an
    // old fare matrix to a terminal that is about to sell against it.
    headers['Cache-Control'] = 'no-cache';
    final resp = await http
        .get(Uri.parse('$base/api/transit/route-templates'), headers: headers)
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return (body['routeTemplates'] as List? ?? const [])
          .whereType<Map>()
          .map((e) => RouteTemplate.fromJson(Map<String, dynamic>.from(e)))
          .toList();
    }
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      throw TransitApiException(
        (body['error'] ?? 'Access denied').toString(),
        code: (body['code'] ?? 'FORBIDDEN').toString(),
        statusCode: resp.statusCode,
      );
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not load route templates').toString(),
      statusCode: resp.statusCode,
    );
  }

  /// Body shape shared by create and update. The server re-validates and
  /// renumbers, so sending [template] verbatim is safe.
  static Map<String, dynamic> _routeTemplatePayload(RouteTemplate template) => {
        'name': template.name,
        'code': template.code,
        'description': template.description,
        'active': template.active,
        'stages': [
          for (final s in template.stages)
            {'seq': s.seq, 'name': s.name}
        ],
        'fares': [
          for (final f in template.fares)
            {
              'fromSeq': f.fromSeq,
              'toSeq': f.toSeq,
              'priceCents': f.priceCents,
            }
        ],
      };

  static Future<RouteTemplate> createRouteTemplate(
      RouteTemplate template) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .post(
          Uri.parse('$base/api/transit/route-templates'),
          headers: await _headers(token: token),
          body: jsonEncode(_routeTemplatePayload(template)),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return RouteTemplate.fromJson(
          Map<String, dynamic>.from(body['routeTemplate'] as Map));
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not create route template').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<RouteTemplate> updateRouteTemplate(
      String id, RouteTemplate template) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .put(
          Uri.parse('$base/api/transit/route-templates/$id'),
          headers: await _headers(token: token),
          body: jsonEncode(_routeTemplatePayload(template)),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return RouteTemplate.fromJson(
          Map<String, dynamic>.from(body['routeTemplate'] as Map));
    }
    throw TransitApiException(
      (body['error'] ?? 'Could not update route template').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }

  static Future<void> deleteRouteTemplate(String id) async {
    final base = await baseUrl();
    final token = await _deviceToken();
    final resp = await http
        .delete(
          Uri.parse('$base/api/transit/route-templates/$id'),
          headers: await _headers(token: token),
        )
        .timeout(const Duration(seconds: 20));
    final body = _jsonBody(resp);
    if (resp.statusCode >= 200 && resp.statusCode < 300) return;
    throw TransitApiException(
      (body['error'] ?? 'Could not delete route template').toString(),
      code: (body['code'] ?? '').toString(),
      statusCode: resp.statusCode,
    );
  }
}

/// Builds the offline-sync payload for one sale, keyed by the app-generated
/// `ticket_id` (the local tx_id) so the backend can upsert idempotently.
///
/// Every value is coerced to a clean, self-consistent type and duplicate-key
/// fallbacks (snake_case + camelCase) are honoured so a stale or partial local
/// row can never produce an invalid JSON payload that rejects the whole batch.
Map<String, Object?> saleSyncPayload(Map<String, Object?> saleJson,
    {String companyId = ''}) {
  String s(Object? v, [String fallback = '']) {
    final t = v == null ? '' : v.toString().trim();
    return t.isEmpty ? fallback : t;
  }

  int numInt(Object? v) => v is num ? v.round() : 0;

  final routeName = s(saleJson['route_name']);
  final route = routeParts(routeName);
  final from = route.length > 1 ? route.first : '';
  final to = route.length > 1 ? route[1] : '';

  final paymentMethod =
      s(saleJson['payment_method'] ?? saleJson['paymentMethod'], 'cash')
          .toLowerCase();
  final items = saleJson['items'];
  final itemsList = items is List
      ? items.whereType<Map>().map((e) => e.cast<String, Object?>()).toList()
      : const <Map<String, Object?>>[];

  return {
    'ticket_id': s(saleJson['tx_id']),
    'company_id': companyId,
    'receipt_no': s(saleJson['receipt_no'] ?? saleJson['clientReceiptNo']),
    'trip_no': s(saleJson['trip_no'] ?? saleJson['tripNo']),
    'trip_id': s(saleJson['trip_id'] ?? saleJson['tripId']),
    'trip_instance_id':
        s(saleJson['trip_instance_id'] ?? saleJson['tripInstanceId']),
    'shift_id': s(saleJson['shift_id'] ?? saleJson['shiftId']),
    'bus_reg': s(saleJson['bus_reg'] ?? saleJson['busReg']),
    'driver_id': s(saleJson['driver_id'] ?? saleJson['driverId']),
    'conductor_id': s(saleJson['conductor_id'] ?? saleJson['conductorId']),
    'payment_method': paymentMethod.isEmpty ? 'cash' : paymentMethod,
    'route_from': from,
    'route_to': to,
    'route_code': s(saleJson['route_code'] ?? saleJson['routeCode']),
    'seat_number': s(saleJson['seat_number'] ?? saleJson['seatNumber']),
    'customer_name': s(saleJson['customer_name'] ?? saleJson['customerName']),
    'customer_phone': s(saleJson['customer_phone'] ??
        saleJson['customer_mobile'] ??
        saleJson['customerMobile']),
    'driver_name': s(saleJson['driver_name'] ?? saleJson['driver']),
    'driver_phone': s(saleJson['driver_phone'] ?? saleJson['driverPhone']),
    'conductor_name': s(saleJson['conductor_name'] ?? saleJson['conductor1']),
    'conductor2': s(saleJson['conductor2']),
    'conductor_phone':
        s(saleJson['conductor_phone'] ?? saleJson['conductorPhone']),
    'items': itemsList,
    'custom_fare': numInt(saleJson['custom_fare'] ?? saleJson['customFare']),
    'departure_time':
        s(saleJson['departure_time'] ?? saleJson['departureTime']),
    'luggage_linked_ticket_id': s(saleJson['luggage_linked_ticket_id'] ??
        saleJson['luggageLinkedTicketId']),
    'amount': numInt(saleJson['total']),
    'cash_cents': numInt(saleJson['cash'] ?? saleJson['cash_cents']),
    'change_cents': numInt(saleJson['change'] ?? saleJson['change_cents']),
    'created_at': s(saleJson['created_at'] ?? saleJson['saleTime'],
        DateTime.now().toUtc().toIso8601String()),
  };
}

/// Exposed for the sync service to build payloads.
Future<String> transitBaseUrl() => TransitApi.baseUrl();
Future<List<Map<String, Object?>>> transitSignSaleToJson() async {
  final pending = await AppDb.getUnsyncedSales();
  final companyId = (await SecureKeystore.instance.readCompanyId()) ?? '';
  return pending
      .map((s) => saleSyncPayload(s.toJson(), companyId: companyId))
      .toList();
}
