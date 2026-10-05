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
import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/screens/home_screen.dart';
import 'package:bus_ticket_app/src/widgets/emerald_ui.dart';
import 'package:bus_ticket_app/src/widgets/ticket_preview_card.dart';
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
      await d.delete('trips');
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

  /// A bus fare needs a selected trip before the sell button is live, so the
  /// walk-in sheet tests have to give the screen a real schedule to sell on.
  /// The screen reads it through getActiveTrip (a settings-backed JSON blob),
  /// so both the row and the selection are needed.
  Future<void> seedActiveTrip(WidgetTester tester) async {
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.delete('trips');
      final trip = Trip(
        id: 'trip-walkin',
        tripNo: 'T-101',
        routeCode: 'HRE-CHI',
        routeFrom: 'HARARE',
        routeTo: 'CHITUNGWIZA',
        routeName: 'HARARE - CHITUNGWIZA',
        busReg: 'AGJ-001',
        driver: 'TATENDA',
        conductor: 'RUDO',
        status: 'SCHEDULED',
      );
      await AppDb.upsertTrip(trip);
      await AppDb.setActiveTrip(trip);
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

  testWidgets('the walk-in toggle locks both fields and still allows the sale',
      (tester) async {
    // "No name available" has to be sticky: it must survive the sheet
    // rebuilding for payment method / promo / cash, lock BOTH the name and the
    // phone box so a stray keystroke cannot contradict the ticket, and on its
    // own satisfy the passenger-name requirement so the conductor can confirm
    // and move on.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedActiveTrip(tester);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    // The fare rows and the sell button live at the bottom of one long scroll
    // view. Take an Adult fare with its + button so the total is non-zero and
    // the sell button comes alive. The screen has no ListView — it is a
    // SingleChildScrollView — so the drag targets the first Scrollable.
    final add = find.byIcon(Icons.add_circle_outline).first;
    for (var i = 0; i < 12; i++) {
      await tester.ensureVisible(add);
      await settle(tester);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -400));
      await settle(tester);
    }
    await tester.tap(add);
    await settle(tester);

    final sell = find.text('Sell & Print');
    await tester.ensureVisible(sell);
    await settle(tester);
    await tester.tap(sell);
    await settle(tester);
    expect(find.text('Passenger details'), findsOneWidget,
        reason: 'the passenger sheet must open for a bus fare');

    final nameBox = find.widgetWithText(TextField, 'Customer name & surname');
    final phoneBox = find.widgetWithText(TextField, 'Phone number');
    expect(nameBox, findsOneWidget);
    expect(phoneBox, findsOneWidget);

    // Untoggled, both boxes are editable and the requirement is enforced.
    expect(tester.widget<TextField>(nameBox).readOnly, isFalse);
    expect(tester.widget<TextField>(phoneBox).readOnly, isFalse);
    final confirm = find.widgetWithText(FilledButton, 'Confirm & Print');
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull,
        reason: 'a bus fare with no name and no walk-in toggle cannot confirm');

    // Tender the cash so the ONLY thing still holding the sale back is the
    // missing passenger name. From here on the button state is a clean read on
    // the walk-in toggle.
    final cashField = find.widgetWithText(TextField, 'Cash tendered');
    await tester.enterText(cashField, '5.00');
    await settle(tester);
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull,
        reason: 'cash alone is not enough: the name is still required');

    // The control must be a toggle switch, not a checkbox.
    final walkIn = find.byType(Switch);
    expect(find.byType(Checkbox), findsNothing,
        reason: 'the walk-in control is specified as a toggle switch');
    expect(walkIn, findsOneWidget);

    // Placed directly underneath the phone input it governs.
    await tester.ensureVisible(walkIn);
    await settle(tester);
    expect(tester.getTopLeft(walkIn).dy,
        greaterThan(tester.getTopLeft(phoneBox).dy),
        reason: 'the walk-in toggle must sit below the phone number field');
    expect(
        tester.getTopLeft(walkIn).dy - tester.getBottomLeft(phoneBox).dy,
        lessThan(72),
        reason: 'and directly beneath it, not pushed far down the sheet');

    // Active state wears the app's signature emerald green.
    expect(tester.widget<Switch>(walkIn).activeThumbColor, kEmeraldJade);
    expect(tester.widget<Switch>(walkIn).activeTrackColor, kEmeraldJade);

    // Toggle it on. Both boxes must lock and the button must come alive.
    await tester.tap(walkIn);
    await settle(tester);
    expect(tester.widget<TextField>(nameBox).readOnly, isTrue,
        reason: 'toggling the walk-in on must lock the name box');
    expect(tester.widget<TextField>(phoneBox).readOnly, isTrue,
        reason: 'toggling the walk-in on must lock the phone box too');
    expect(
        find.descendant(
            of: nameBox, matching: find.byIcon(Icons.lock_outline)),
        findsOneWidget,
        reason: 'the locked box must say so');
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull,
        reason: 'the walk-in toggle alone satisfies the name requirement');

    // Now change the inputs further down the sheet. The toggle must survive:
    // switching to EcoCash, typing cash-equivalent text elsewhere and applying
    // a promo all rebuild the sheet.
    await tester.tap(find.text('EcoCash'));
    await settle(tester);
    expect(tester.widget<Switch>(walkIn).value, isTrue,
        reason: 'switching payment method must not drop the walk-in toggle');
    expect(tester.widget<TextField>(nameBox).readOnly, isTrue);
    expect(tester.widget<TextField>(phoneBox).readOnly, isTrue);
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull,
        reason: 'EcoCash needs no cash tendered, so the sale stays confirmable');

    await tester.enterText(find.byType(TextField).last, 'SAVE10');
    await settle(tester);
    await tester.tap(find.text('Apply'));
    await settle(tester);

    expect(tester.widget<Switch>(walkIn).value, isTrue,
        reason: 'applying a promo must not drop the walk-in toggle');
    expect(tester.widget<TextField>(nameBox).readOnly, isTrue);
    expect(tester.widget<TextField>(phoneBox).readOnly, isTrue);
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull,
        reason: 'the walk-in sale must remain confirmable after a promo');

    // Switching it back off is the ONLY thing that may unlock the boxes.
    await tester.tap(walkIn);
    await settle(tester);
    expect(tester.widget<Switch>(walkIn).value, isFalse);
    expect(tester.widget<TextField>(nameBox).readOnly, isFalse,
        reason: 'switching off must unlock the box for a real name');
    expect(tester.widget<TextField>(phoneBox).readOnly, isFalse,
        reason: 'switching off must unlock the phone box too');

    expect(tester.takeException(), isNull);
  });

  testWidgets('Sell & Print hides the live preview by default and toggles it',
      (tester) async {
    // On the real terminal the always-on preview pushed Confirm & Print off the
    // bottom of the sheet. The preview is now opt-in, so the ticket that is
    // about to be printed is checked deliberately rather than by accident.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedActiveTrip(tester);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    // The main screen carries its own preview; the sheet's is the extra one.
    expect(find.byType(TicketPreviewCard), findsOneWidget,
        reason: 'only the main screen preview should be on screen to start');

    final add = find.byIcon(Icons.add_circle_outline).first;
    for (var i = 0; i < 12; i++) {
      await tester.ensureVisible(add);
      await settle(tester);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -400));
      await settle(tester);
    }
    await tester.tap(add);
    await settle(tester);

    final sell = find.text('Sell & Print');
    await tester.ensureVisible(sell);
    await settle(tester);
    await tester.tap(sell);
    await settle(tester);
    expect(find.text('Passenger details'), findsOneWidget);

    // Hidden by default: opening the sheet must not add a second preview.
    expect(find.byType(TicketPreviewCard), findsOneWidget,
        reason: 'the sheet preview must be hidden by default');

    final toggle = find.widgetWithText(TextButton, 'Live preview');
    expect(toggle, findsOneWidget,
        reason: 'a control to show the preview must exist');

    await tester.ensureVisible(toggle);
    await settle(tester);
    await tester.tap(toggle);
    await settle(tester);

    expect(find.byType(TicketPreviewCard), findsNWidgets(2),
        reason: 'tapping Live preview must reveal the sheet preview');

    // And the toggle must put it away again, otherwise the operator cannot get
    // back the room the hidden-by-default state just gave them.
    final hideToggle = find.widgetWithText(TextButton, 'Hide preview');
    expect(hideToggle, findsOneWidget);
    await tester.ensureVisible(hideToggle);
    await settle(tester);
    await tester.tap(hideToggle);
    await settle(tester);

    expect(find.byType(TicketPreviewCard), findsOneWidget,
        reason: 'the toggle must hide the preview again');

    expect(tester.takeException(), isNull);
  });

  testWidgets('Cancel, Live preview and Confirm & Print share one row',
      (tester) async {
    // Three separate lines meant the operator had to hunt for Confirm, and at
    // the tightest fleet width the three fixed-width buttons overflowed.
    useTightViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedActiveTrip(tester);

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

    final add = find.byIcon(Icons.add_circle_outline).first;
    for (var i = 0; i < 12; i++) {
      await tester.ensureVisible(add);
      await settle(tester);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -400));
      await settle(tester);
    }
    await tester.tap(add);
    await settle(tester);

    final sell = find.text('Sell & Print');
    await tester.ensureVisible(sell);
    await settle(tester);
    await tester.tap(sell);
    await settle(tester);

    final cancel = find.widgetWithText(TextButton, 'Cancel');
    final preview = find.widgetWithText(TextButton, 'Live preview');
    final confirm = find.widgetWithText(FilledButton, 'Confirm & Print');
    expect(cancel, findsOneWidget);
    expect(preview, findsOneWidget);
    expect(confirm, findsOneWidget);

    // All three must resolve to the same Row rather than three stacked rows.
    Row? rowOf(Finder f) =>
        tester.element(f).findAncestorWidgetOfExactType<Row>();
    final cancelRow = rowOf(cancel);
    expect(cancelRow, isNotNull);
    expect(rowOf(preview), same(cancelRow),
        reason: 'Live preview must sit in the same row as Cancel');
    expect(rowOf(confirm), same(cancelRow),
        reason: 'Confirm & Print must sit in the same row as Cancel');

    // They must be laid out on one horizontal line, not merely in one Row
    // that wraps.
    final cancelY = tester.getTopLeft(cancel).dy;
    final previewY = tester.getTopLeft(preview).dy;
    final confirmY = tester.getTopLeft(confirm).dy;
    expect((cancelY - previewY).abs(), lessThan(1.0));
    expect((cancelY - confirmY).abs(), lessThan(1.0));

    expect(overflows, isEmpty, reason: overflows.join('\n=====\n'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('the walk-in toggle survives the keyboard opening on any field',
      (tester) async {
    // Regression for the field being usable at all: tapping a TEXT input opens
    // the soft keyboard, which changes MediaQuery viewInsets and rebuilds the
    // bottom-sheet route. The toggle state used to be declared inside the
    // showModalBottomSheet builder closure, so every route rebuild re-ran that
    // body and reset it to false — the switch silently turned itself off the
    // moment the conductor reached for the cash or promo box.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedActiveTrip(tester);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    final add = find.byIcon(Icons.add_circle_outline).first;
    for (var i = 0; i < 12; i++) {
      await tester.ensureVisible(add);
      await settle(tester);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -400));
      await settle(tester);
    }
    await tester.tap(add);
    await settle(tester);

    final sell = find.text('Sell & Print');
    await tester.ensureVisible(sell);
    await settle(tester);
    await tester.tap(sell);
    await settle(tester);

    final walkIn = find.byType(Switch);
    final nameBox = find.widgetWithText(TextField, 'Customer name & surname');
    final phoneBox = find.widgetWithText(TextField, 'Phone number');

    await tester.ensureVisible(walkIn);
    await settle(tester);
    await tester.tap(walkIn);
    await settle(tester);
    expect(tester.widget<Switch>(walkIn).value, isTrue);

    // Focus each text field in turn. Each tap is what opens the keyboard on a
    // real device, and therefore what used to reset the toggle.
    for (final label in ['Cash tendered', 'Code e.g. SAVE10']) {
      final field = find.widgetWithText(TextField, label);
      expect(field, findsOneWidget, reason: '$label must be on the sheet');
      await tester.ensureVisible(field);
      await settle(tester);
      await tester.tap(field);
      // Flutter's test harness has no soft keyboard, so tapping alone would not
      // move viewInsets and the route would never rebuild — which is precisely
      // what let the original bug hide from the earlier tests. Raising the view
      // inset by hand is the same MediaQuery change a real keyboard produces.
      tester.view.viewInsets = const FakeViewPadding(bottom: 320);
      addTearDown(tester.view.reset);
      await settle(tester);

      expect(tester.widget<Switch>(walkIn).value, isTrue,
          reason: 'tapping $label must not switch the walk-in toggle off');
      expect(tester.widget<TextField>(nameBox).readOnly, isTrue,
          reason: 'the name box must stay locked after touching $label');
      expect(tester.widget<TextField>(phoneBox).readOnly, isTrue,
          reason: 'the phone box must stay locked after touching $label');

      // Closing the keyboard is the other half of the same round trip.
      tester.view.viewInsets = FakeViewPadding.zero;
      await settle(tester);
      expect(tester.widget<Switch>(walkIn).value, isTrue,
          reason: 'dismissing the keyboard must not drop the walk-in toggle');
    }

    // The preview toggle lives in the same sheet state and was vulnerable to
    // the identical reset, so pin it too.
    await tester.tap(find.widgetWithText(TextButton, 'Live preview'));
    await settle(tester);
    expect(find.widgetWithText(TextButton, 'Hide preview'), findsOneWidget);
    final promoField = find.widgetWithText(TextField, 'Code e.g. SAVE10');
    await tester.ensureVisible(promoField);
    await settle(tester);
    await tester.tap(promoField);
    await settle(tester);
    expect(find.widgetWithText(TextButton, 'Hide preview'), findsOneWidget,
        reason: 'tapping a field must not close the preview the operator opened');

    expect(tester.takeException(), isNull);
  });

  testWidgets('the walk-in toggle resets for the next sale', (tester) async {
    // The flip side of holding the state at method scope: it must still start
    // fresh for the following passenger, or one walk-in would leak into every
    // ticket after it.
    useFieldViewport(tester);
    await resetDb(tester);
    await seed(tester);
    await seedActiveTrip(tester);

    await tester.pumpWidget(
      const MaterialApp(home: HomeScreen()),
    );
    await settle(tester);

    final add = find.byIcon(Icons.add_circle_outline).first;
    for (var i = 0; i < 12; i++) {
      await tester.ensureVisible(add);
      await settle(tester);
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -400));
      await settle(tester);
    }
    await tester.tap(add);
    await settle(tester);

    for (var pass = 0; pass < 2; pass++) {
      final sell = find.text('Sell & Print');
      await tester.ensureVisible(sell);
      await settle(tester);
      await tester.tap(sell);
      await settle(tester);

      final walkIn = find.byType(Switch);
      expect(tester.widget<Switch>(walkIn).value, isFalse,
          reason: 'pass ${pass + 1} must open with the toggle already off');
      await tester.ensureVisible(walkIn);
      await settle(tester);
      await tester.tap(walkIn);
      await settle(tester);
      expect(tester.widget<Switch>(walkIn).value, isTrue);

      // Close the sheet without selling.
      final cancel = find.widgetWithText(TextButton, 'Cancel');
      await tester.ensureVisible(cancel);
      await settle(tester);
      await tester.tap(cancel);
      await settle(tester);
    }

    expect(tester.takeException(), isNull);
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
