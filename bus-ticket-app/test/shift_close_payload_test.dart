// The end-of-shift close must be self-sufficient on the wire.
//
// A conductor who works a whole shift with no signal produces a close the server
// has never seen: the start was never pushed either. The server can only record
// the crew of that shift from what THIS request carries, and it can never
// recover it later. So the payload is business critical, and nothing server-side
// can tell us if a field is missing — it just stores an empty shift.
//
// This pins the exact body of POST /api/transit/shifts/close.
import 'dart:convert';

import 'package:bus_ticket_app/src/services/transit_api.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

/// Records the request and answers like the server does.
class _RecordingClient extends http.BaseClient {
  _RecordingClient(this.status, [this.body = '{"shift":{"id":"x"}}']);

  final int status;
  final String body;
  Uri? uri;
  Map<String, String> headers = {};
  String? payload;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    uri = request.url;
    headers = request.headers;
    if (request is http.Request) {
      payload = request.body;
    }
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(body)),
      status,
      request: request,
      headers: {'content-type': 'application/json'},
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const secureChannel =
      MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
  late _RecordingClient client;

  setUp(() {
    client = _RecordingClient(200);
    TransitApi.debugSetClient(client);
    // The device token is read from secure storage, which has no host
    // implementation under `flutter test`.
    final store = <String, String>{
      'preyone_device_uuid': 'dev-close-test',
      'preyone_device_token': 'test-device-token',
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(secureChannel, (call) async {
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
          store.remove(call.arguments['key'] as String);
          return null;
      }
      return null;
    });
  });

  tearDown(() {
    TransitApi.debugSetClient(null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(secureChannel, null);
  });

  /// The full-crew close, which is what the sync service sends for a replayed
  /// shift close.
  Future<void> close({String? closedAt}) {
    return TransitApi.closeShift(
      'shift-1',
      closedAt: closedAt,
      driverId: 'd1',
      driverName: 'DANIEL MUVIRIMI',
      driverPhone: '0771234567',
      conductorName: 'LESLIE MUVIRIMI',
      conductorPhone: '0777654321',
      vehicleReg: 'AGJ 1234',
    );
  }

  Map<String, dynamic> sent() => jsonDecode(client.payload ?? '{}') as Map<String, dynamic>;

  test('posts to the close endpoint with the shift id', () async {
    await close();
    expect(client.uri.toString(), endsWith('/api/transit/shifts/close'));
  });

  test('carries the crew so an offline-only shift is still attributable', () async {
    await close();
    final body = sent();
    expect(body['shiftId'], 'shift-1');
    expect(body['driverName'], 'DANIEL MUVIRIMI');
    expect(body['driverPhone'], '0771234567');
    expect(body['conductorName'], 'LESLIE MUVIRIMI');
    expect(body['conductorPhone'], '0777654321');
    expect(body['vehicleReg'], 'AGJ 1234');
  });

  test('carries the real finish time so admin sees the true end of shift', () async {
    await close(closedAt: '2026-09-28T14:35:00.000Z');
    expect(sent()['closedAt'], '2026-09-28T14:35:00.000Z');
  });

  test('omits blank and absent values instead of sending empty strings', () async {
    // The server treats '' as "not received" and falls back to what it knows,
    // so sending empty strings for fields the app does not have is harmless but
    // noisy; sending a null would break its NOT NULL columns outright.
    await TransitApi.closeShift('shift-1', driverName: 'ONLY NAME');
    final body = sent();
    expect(body['driverName'], 'ONLY NAME');
    expect(body.containsKey('driverId'), isFalse);
    expect(body.containsKey('conductorName'), isFalse);
    expect(body.containsKey('vehicleReg'), isFalse);
    expect(body.containsKey('closedAt'), isFalse);
  });

  test('trims surrounding whitespace off crew names', () async {
    await TransitApi.closeShift('shift-1', driverName: '  DANIEL  ');
    expect(sent()['driverName'], 'DANIEL');
  });

  test('raises a TransitApiException so the close stays queued for retry', () async {
    // A swallowed failure would mark the close as pushed and lose the shift
    // from admin permanently.
    client = _RecordingClient(500, '{"error":"boom"}');
    TransitApi.debugSetClient(client);
    await expectLater(
      TransitApi.closeShift('shift-1', driverName: 'X'),
      throwsA(isA<TransitApiException>()),
    );
  });
}
