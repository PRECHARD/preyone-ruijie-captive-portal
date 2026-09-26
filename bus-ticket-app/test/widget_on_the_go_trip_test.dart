// Widget-level crash coverage for the Phase 4 conductor screen. Drives the
// real on-the-go flow against a real (ffi) SQLite database: pick a template,
// flip direction, choose boarding/destination stages, override the fare and
// open the run. Any uncaught exception, failed assertion or render overflow
// fails the test.
//
// See widget_route_templates_test.dart for the two harness notes: the Emerald
// widgets animate forever (so pumpAndSettle never settles), and ffi DB work has
// to be driven through tester.runAsync.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/models/route_template.dart';
import 'package:bus_ticket_app/src/screens/on_the_go_trip_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'helpers/test_db.dart';

const _secureChannel =
    MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 120));
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
}

Future<void> clearSnack(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.pump(const Duration(seconds: 2));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final dir = await useTestDatabaseDir('widget_on_the_go');
    final f = File(p.join(dir, 'bus_ticket.db'));
    if (f.existsSync()) f.deleteSync();
    await AppDb.init();
    // Money must render in the CONFIGURED currency, not a hardcoded USD.
    await AppDb.setSetting('currency', 'ZWG');

    final store = <String, String>{
      'preyone_role': 'CONDUCTOR', // roles are stored uppercase
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

  setUp(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(1170, 2532);
    view.devicePixelRatio = 3.0;
    addTearDown(() {
      view.resetPhysicalSize();
      view.resetDevicePixelRatio();
    });
  });

  testWidgets('conductor opens an on-the-go run from a template, no crash',
      (tester) async {
    // An open shift is required: a run is always bound to crew and a bus.
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.insert('driver_shifts', {
        'id': 'shift-otg',
        'driver_id': '1',
        'driver_name': 'Tatenda',
        'conductor_name': 'Rudo',
        'vehicle_reg': 'ABC-123',
        'status': 'OPEN',
        'started_at': '2026-01-01T06:00:00Z',
      });
      await AppDb.saveRouteTemplate(const RouteTemplate(
        id: 'tpl-otg',
        name: 'HRE Corridor',
        code: 'HRE-CHI',
        stages: [
          RouteStage(templateId: 'tpl-otg', seq: 1, name: 'Harare'),
          RouteStage(templateId: 'tpl-otg', seq: 2, name: 'Ruwa'),
          RouteStage(templateId: 'tpl-otg', seq: 3, name: 'Chitungwiza'),
        ],
        fares: [
          RouteStageFare(
              templateId: 'tpl-otg', fromSeq: 1, toSeq: 2, priceCents: 500),
          RouteStageFare(
              templateId: 'tpl-otg', fromSeq: 2, toSeq: 3, priceCents: 700),
          RouteStageFare(
              templateId: 'tpl-otg', fromSeq: 1, toSeq: 3, priceCents: 1200),
        ],
      ));
    });

    Trip? opened;
    await tester.pumpWidget(MaterialApp(
      home: Builder(
          builder: (ctx) => TextButton(
                onPressed: () async {
                  opened = await Navigator.of(ctx).push<Trip>(
                    MaterialPageRoute(
                        builder: (_) => const OnTheGoTripScreen()),
                  );
                },
                child: const Text('open'),
              )),
    ));

    await tester.tap(find.text('open'));
    await settle(tester);
    expect(find.text('On-the-go trip'), findsOneWidget);
    expect(find.text('Master route'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // The shift line at the bottom must name the real crew, not a placeholder.
    final shiftLine = find.textContaining('RUDO · ABC-123');
    for (var i = 0; i < 6 && shiftLine.evaluate().isEmpty; i++) {
      await tester.drag(find.byType(ListView), const Offset(0, -400));
      await settle(tester);
    }
    expect(shiftLine, findsOneWidget);
    // Back to the top for the rest of the flow.
    for (var i = 0; i < 6; i++) {
      await tester.drag(find.byType(ListView), const Offset(0, 400));
      await settle(tester);
    }
    expect(tester.takeException(), isNull);

    // On load the first leg is preselected: Harare -> Ruwa at ZWG 5.00,
    // using the configured company currency.
    expect(find.text('Harare - Ruwa'), findsOneWidget);
    expect(find.textContaining('ZWG 5.00'), findsWidgets);
    expect(find.textContaining('USD'), findsNothing);
    expect(tester.takeException(), isNull);

    // Boarding and destination must differ.
    final board = find.byType(DropdownButtonFormField<int>).at(0);
    final drop = find.byType(DropdownButtonFormField<int>).at(1);

    await tester.tap(drop);
    await settle(tester);
    await tester.tap(find.text('HARARE').last);
    await settle(tester);
    await tester.tap(find.text('Open run & start selling'));
    await settle(tester);
    expect(find.text('Boarding and destination stage must differ.'),
        findsOneWidget);
    await clearSnack(tester);

    // Extend it to the full corridor: 1 -> 3 = 12.00.
    await tester.tap(drop);
    await settle(tester);
    await tester.tap(find.text('CHITUNGWIZA').last);
    await settle(tester);
    expect(find.text('Harare - Chitungwiza'), findsOneWidget);
    expect(find.textContaining('12.00'), findsWidgets);
    expect(tester.takeException(), isNull);

    // Flip to Return: stages reverse, and the SAME fare must be reused.
    await tester.tap(find.text('RETURN'));
    await settle(tester);
    expect(find.text('Chitungwiza - Ruwa'), findsOneWidget);
    expect(find.textContaining('7.00'), findsWidgets);
    expect(tester.takeException(), isNull);

    // Back to Forward, then out to Chitungwiza again for the run we open.
    await tester.tap(find.text('FORWARD'));
    await settle(tester);
    await tester.tap(drop);
    await settle(tester);
    await tester.tap(find.text('CHITUNGWIZA').last);
    await settle(tester);
    expect(find.text('Harare - Chitungwiza'), findsOneWidget);
    expect(board, findsOneWidget);

    // An override must be possible for a conductor; the field is prefilled
    // with the matrix fare and sits at the bottom of the form. It is the only
    // TextField in this form (the three pickers are DropdownButtonFormField).
    final overrideField = find.byType(TextField);
    for (var i = 0; i < 6 && overrideField.evaluate().isEmpty; i++) {
      await tester.drag(find.byType(ListView), const Offset(0, -400));
      await settle(tester);
    }
    expect(find.text('Fare override (optional)'), findsOneWidget);
    await tester.enterText(overrideField, '3.50');
    await settle(tester);

    // Open the run.
    await tester.tap(find.text('Open run & start selling'));
    await settle(tester);
    await settle(tester);

    // It pops with the created trip...
    expect(opened, isNotNull);
    expect(opened!.id, startsWith('TRIP-'));
    expect(opened!.isLocal, isTrue, reason: 'a device run must stay local');
    expect(opened!.tripNo, startsWith('OTG-'));
    expect(opened!.routeName, 'Harare - Chitungwiza');
    expect(opened!.busReg, 'ABC-123');
    expect(opened!.driver, 'TATENDA');
    expect(opened!.conductor, 'RUDO');
    // 3.50 override, not the 12.00 matrix fare.
    expect(opened!.baseFareCents, 350);

    // ...it is really in the database, and it is the active trip.
    final stored = await tester.runAsync(() async {
      final d = await AppDb.db;
      return d.query('trips', where: 'id = ?', whereArgs: [opened!.id]);
    });
    expect(stored, hasLength(1));
    final active = await tester.runAsync(() => AppDb.getActiveTrip());
    expect(active?.id, opened!.id);

    // A device-created run must never queue a server lifecycle event.
    final queued = await tester.runAsync(() async {
      final d = await AppDb.db;
      return d.query('sync_queue');
    });
    expect(queued, isEmpty,
        reason: 'a local TRIP-* run must not be replayed to the server');
    expect(tester.takeException(), isNull);
  });

  testWidgets('no templates yet shows the empty state instead of a broken form',
      (tester) async {
    // Deactivate the only template so the picker has nothing to show.
    await tester.runAsync(() async {
      final rows = await AppDb.getRouteTemplates();
      for (final t in rows) {
        await AppDb.saveRouteTemplate(RouteTemplate(
          id: t.id,
          name: t.name,
          code: t.code,
          active: false,
          stages: t.stages,
          fares: t.fares,
        ));
      }
    });

    await tester.pumpWidget(const MaterialApp(home: OnTheGoTripScreen()));
    await settle(tester);
    expect(find.text('No route templates yet'), findsOneWidget);
    expect(find.text('Open run & start selling'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
