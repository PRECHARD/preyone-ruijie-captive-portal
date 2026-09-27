// Renders the REAL Ticketing screen (HomeScreen) - the production sell widget
// with its Emerald shell, fare list and ticket preview - against a real ffi
// SQLite database, at the viewport of the field terminal that was crashing.
//
// This is deliberately not another TicketPreviewCard-in-a-harness test. The
// card tests prove the card survives hostile constraints; this proves the
// assembled screen, with the card inside it, lays out at a real device size
// and real font scale. Any uncaught exception, failed assertion or render
// overflow fails the test.
//
// Harness notes (same as widget_on_the_go_trip_test.dart): the Emerald widgets
// animate forever so pumpAndSettle never settles, and ffi DB work has to be
// driven through tester.runAsync.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/screens/home_screen.dart';
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final dir = await useTestDatabaseDir('widget_ticketing');
    final f = File(p.join(dir, 'bus_ticket.db'));
    if (f.existsSync()) f.deleteSync();
    await AppDb.init();

    final store = <String, String>{
      'preyone_role': 'CONDUCTOR',
      'preyone_username': 'LESLIE',
      'preyone_full_name': 'Leslie',
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

  /// The ACTUAL field terminal (Vivo V2207, 10AD1G088U002DE), measured with
  /// `adb shell wm size` / `wm density` / `settings get system font_scale`:
  ///   720x1612 physical, density override 270 => 426.7x955.4 logical, font
  ///   scale 0.85, Android 14.
  /// These tests deliberately use the real numbers rather than a guess: the
  /// earlier 360x800 harness missed the DropdownButton assertion that was
  /// actually red-screening the device.
  void useFieldViewport(WidgetTester tester) {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(720, 1612);
    view.devicePixelRatio = 270 / 160;
    tester.platformDispatcher.textScaleFactorTestValue = 0.85;
    addTearDown(() {
      view.resetPhysicalSize();
      view.resetDevicePixelRatio();
      tester.platformDispatcher.clearTextScaleFactorTestValue();
    });
  }

  /// The tightest width the fleet ships: 360x800 logical.
  void useTightViewport(WidgetTester tester) {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(1080, 2400);
    view.devicePixelRatio = 3.0;
    addTearDown(() {
      view.resetPhysicalSize();
      view.resetDevicePixelRatio();
    });
  }

  /// Resets catalogue and shift state. AppDb caches one Database for the whole
  /// file, so seeded rows would otherwise leak between tests and re-seeding the
  /// fixed shift id would violate the UNIQUE constraint.
  Future<void> resetDb(WidgetTester tester) async {
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.delete('fares');
      await d.delete('driver_shifts');
      await d.delete('drivers');
      await d.delete('settings');
    });
  }

  /// The exact roster shape that red-screened the real terminal: the saved
  /// driver is upper-cased by up(), the roster keeps mixed case. The dropdown
  /// value then matches ZERO items and DropdownButton asserts during build.
  Future<void> seedMixedCaseRoster(WidgetTester tester) async {
    await tester.runAsync(() async {
      await AppDb.addDriver('Daniel Muvirimi', '0771234567');
      await AppDb.setSetting('driver_name', 'DANIEL MUVIRIMI');
    });
  }

  /// The other way to trip the same assert: the roster holds the driver twice
  /// under the same upper-cased name, so the value matches TWO items.
  /// AppDb.addDriver does not de-duplicate, so this is reachable in the field.
  Future<void> seedDuplicateRoster(WidgetTester tester) async {
    await tester.runAsync(() async {
      await AppDb.addDriver('DANIEL MUVIRIMI', '0771234567');
      await AppDb.addDriver('DANIEL MUVIRIMI', '0779999999');
      await AppDb.setSetting('driver_name', 'DANIEL MUVIRIMI');
    });
  }

  Future<void> seed(WidgetTester tester) async {
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.insert('driver_shifts', {
        'id': 'shift-ticketing',
        'driver_id': '1',
        'driver_name': 'Tatenda',
        'conductor_name': 'Rudo',
        'vehicle_reg': 'BD0222-BD266491',
        'status': 'OPEN',
        'started_at': '2026-01-01T06:00:00Z',
      });
      for (final f in <List<Object>>[
        ['Adult', 200],
        ['School', 100],
        ['Luggage', 50],
      ]) {
        await AppDb.addFare(f[0] as String, f[1] as int);
      }
    });
  }

  /// Pumps the real Ticketing screen and fails if the driver DropdownButton
  /// raises its "exactly one item" assert. Installs the error collector before
  /// the first pump, because the assert is thrown during build and is never
  /// surfaced by a later `takeException`.
  Future<void> expectNoDropdownAssert(WidgetTester tester) async {
    final errors = <String>[];
    final prior = FlutterError.onError;
    FlutterError.onError = (d) {
      errors.add('${d.exception}');
      prior?.call(d);
    };
    addTearDown(() => FlutterError.onError = prior);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    expect(errors.where((e) => e.contains('DropdownButton')), isEmpty,
        reason: 'the driver dropdown value must match exactly one item');
    // Guard against a false pass: the roster must actually have reached the
    // dropdown, otherwise nothing was exercised.
    expect(find.byType(DropdownButtonFormField<String>), findsWidgets,
        reason: 'the driver roster should render as a dropdown');
    expect(find.text('Adult'), findsWidgets);
  }

  testWidgets('Ticketing renders at field-terminal size, no layout errors',
      (tester) async {
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    // The fare list must actually be present. Without this the test could pass
    // on a blank screen without ever laying out the crashing card.
    expect(find.text('Adult'), findsWidgets,
        reason: 'the seeded fare list should be on screen');

    expect(tester.takeException(), isNull);
  });

  testWidgets('Ticketing renders with a mixed-case duplicated driver roster',
      (tester) async {
    // Regression for the red screen on the real terminal:
    //   "There should be exactly one item with [DropdownButton]'s value:
    //    DANIEL MUVIRIMI."
    // `_driver` is upper-cased by up(), the roster stored "Daniel Muvirimi",
    // so the value matched ZERO items and DropdownButton asserted during
    // build, which red-screened the whole ticketing tab in debug.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedMixedCaseRoster(tester);

    await expectNoDropdownAssert(tester);
  });

  testWidgets('Ticketing renders with the same driver listed twice',
      (tester) async {
    // Same assert, opposite cause: two roster rows share the name, so the
    // value matches TWO items instead of exactly one.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedDuplicateRoster(tester);

    await expectNoDropdownAssert(tester);
  });

  testWidgets('Ticketing survives a large accessibility font scale',
      (tester) async {
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);

    // Capture from the first frame: an overflow raised during the initial
    // pump has no attribution in the summary, so install the collector before
    // the widget is ever laid out.
    final overflows = <String>[];
    final prior = FlutterError.onError;
    FlutterError.onError = (d) {
      overflows.add('${d.exception}\n'
          '${d.informationCollector?.call().map((n) => n.toString()).join('\n')}');
      prior?.call(d);
    };
    addTearDown(() => FlutterError.onError = prior);

    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    expect(find.text('Adult'), findsWidgets);
    expect(overflows, isEmpty, reason: overflows.join('\n=====\n'));
  });

  testWidgets('Ticketing renders at the tightest fleet width, 360dp',
      (tester) async {
    useTightViewport(tester);
    await resetDb(tester);
    await seed(tester);

    final overflows = <String>[];
    final prior = FlutterError.onError;
    FlutterError.onError = (d) {
      overflows.add('${d.exception}');
      prior?.call(d);
    };
    addTearDown(() => FlutterError.onError = prior);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    expect(find.text('Adult'), findsWidgets);
    expect(overflows, isEmpty, reason: overflows.join('\n=====\n'));
  });

  testWidgets('Ticketing handles an empty fare catalogue', (tester) async {
    useFieldViewport(tester);
    await resetDb(tester);
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.insert('driver_shifts', {
        'id': 'shift-empty',
        'driver_id': '1',
        'driver_name': 'Tatenda',
        'conductor_name': 'Rudo',
        'vehicle_reg': 'BD0222-BD266491',
        'status': 'OPEN',
        'started_at': '2026-01-01T06:00:00Z',
      });
    });

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    // The request CTA is what a conductor sees when no fare exists; it must
    // render rather than hit the old "Add them in Settings" dead end.
    expect(find.textContaining('Request a fare'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
