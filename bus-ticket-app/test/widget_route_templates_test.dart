// Widget-level crash coverage for the Phase 4 admin screen, running against a
// real (ffi) SQLite database. flutter_test fails the test on any uncaught
// exception, render overflow or failed assertion while the tree is pumped, so
// this walks the paths an admin actually taps.
//
// Two harness notes:
//  * The Emerald widgets animate forever (pulse/drift), so pumpAndSettle can
//    never settle - pump fixed frames instead.
//  * sqflite_common_ffi executes in a background isolate, so real DB futures do
//    not complete inside the test's fake-async zone. Every DB round trip has to
//    be driven through tester.runAsync.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models/route_template.dart';
import 'package:bus_ticket_app/src/screens/route_templates_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'helpers/test_db.dart';

const _secureChannel =
    MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

/// Advances fake time (for route/dialog transitions) while giving the
/// background database isolate real time to deliver its replies.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 120));
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
}

/// SnackBars queue behind each other for ~4s, so a second one is invisible
/// until the first retires. Let it expire before asserting the next.
Future<void> clearSnack(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.pump(const Duration(seconds: 2));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final dir = await useTestDatabaseDir('widget_route_templates');
    final f = File(p.join(dir, 'bus_ticket.db'));
    if (f.existsSync()) f.deleteSync();
    await AppDb.init();

    final store = <String, String>{
      'preyone_role': 'admin',
      'preyone_device_uuid': 'dev-widget-test',
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
    // A typical modern handset rather than the 800x600 test default.
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(1170, 2532);
    view.devicePixelRatio = 3.0;
    addTearDown(() {
      view.resetPhysicalSize();
      view.resetDevicePixelRatio();
    });
  });

  testWidgets('admin creates a route template end to end, no crash',
      (tester) async {
    await tester.pumpWidget(const MaterialApp(home: RouteTemplatesScreen()));
    await settle(tester);

    expect(find.text('Route templates'), findsOneWidget);
    expect(find.text('Add first template'), findsOneWidget);

    // Open the editor.
    await tester.tap(find.byTooltip('New template'));
    await settle(tester);

    // Saving with no name must be refused, not written.
    await tester.tap(find.text('SAVE'));
    await settle(tester);
    expect(find.text('Name the template.'), findsOneWidget);
    await clearSnack(tester);

    // One stage is not enough to price a leg.
    await tester.enterText(
        find.widgetWithText(TextField, 'e.g. Harare - Chitungwiza'),
        'Test Loop');
    await tester.tap(find.text('Add stage'));
    await settle(tester);
    await tester.enterText(find.byType(TextField).last, 'RUWANKA');
    await tester.tap(find.text('Add'));
    await settle(tester);
    expect(find.text('RUWANKA'), findsOneWidget);
    await tester.tap(find.text('SAVE'));
    await settle(tester);
    expect(find.text('Add at least two stages so a leg can be priced.'),
        findsOneWidget);
    await clearSnack(tester);

    // Second stage: the fare matrix becomes priceable and the hint goes away.
    await tester.tap(find.text('Add stage'));
    await settle(tester);
    await tester.enterText(find.byType(TextField).last, 'CHITUNGWIZA');
    await tester.tap(find.text('Add'));
    await settle(tester);
    expect(
        find.text('Add two or more stages to price the legs.'), findsNothing);
    await tester.tap(find.text('SAVE'));
    await settle(tester);

    expect(find.text('Test Loop'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // It has to be really persisted, with both stages in order.
    final rows = await tester.runAsync(() => AppDb.getRouteTemplates());
    expect(rows, hasLength(1));
    expect(rows!.single.stages.map((s) => s.name).toList(),
        ['RUWANKA', 'CHITUNGWIZA']);

    // Re-open the editor: the fare matrix must render.
    await tester.tap(find.text('Test Loop'));
    await settle(tester);
    expect(find.text('Fare matrix'), findsOneWidget);
    expect(find.text('SAVE'), findsOneWidget);
    expect(tester.takeException(), isNull);

    // Delete it, confirming the dialog.
    await tester.pageBack();
    await settle(tester);
    await tester.tap(find.byTooltip('Delete'));
    await settle(tester);
    expect(find.text('Delete Test Loop?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await settle(tester);
    expect(await tester.runAsync(() => AppDb.getRouteTemplates()), isEmpty);
    expect(find.text('Add first template'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a long corridor template (12 stages, 66 priced legs) renders',
      (tester) async {
    final stages = [
      for (var i = 1; i <= 12; i++)
        RouteStage(templateId: 'seed', seq: i, name: 'STAGE $i')
    ];
    final fares = [
      for (var a = 1; a <= 12; a++)
        for (var b = a + 1; b <= 12; b++)
          RouteStageFare(
              templateId: 'seed', fromSeq: a, toSeq: b, priceCents: 100 * b)
    ];
    await tester.runAsync(() => AppDb.saveRouteTemplate(RouteTemplate(
          id: 'seed',
          name: 'Long Corridor',
          code: 'LONG-1',
          stages: stages,
          fares: fares,
        )));

    await tester.pumpWidget(const MaterialApp(home: RouteTemplatesScreen()));
    await settle(tester);
    expect(find.text('Long Corridor'), findsOneWidget);

    await tester.tap(find.text('Long Corridor'));
    await settle(tester);
    expect(tester.takeException(), isNull);

    // With 12 stages the fare matrix sits below the fold, so it is not built
    // until we scroll - walk down to it, watching for overflow the whole way.
    final matrix = find.text('Fare matrix');
    for (var i = 0; i < 10 && matrix.evaluate().isEmpty; i++) {
      await tester.drag(find.byType(ListView).last, const Offset(0, -500));
      await settle(tester);
      expect(tester.takeException(), isNull);
    }
    expect(matrix, findsOneWidget);

    // Keep scrolling through the 66 priced legs.
    for (var i = 0; i < 12; i++) {
      await tester.drag(find.byType(ListView).last, const Offset(0, -600));
      await settle(tester);
      expect(tester.takeException(), isNull);
    }
  });
}
