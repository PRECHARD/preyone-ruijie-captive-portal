// Luggage ticket screen: passenger-name hand-off from the bus-fare ticket.
//
// The bus-fare ticket's name is the operator's most expensive re-entry: it is
// typed once, then the sale is written and the luggage prompt appears. If the
// luggage form cannot adopt that name from local state, the conductor retypes
// it — or worse, the ticket prints a walk-in placeholder as the passenger.
//
// These tests drive the REAL screen so the precedence rules that decide which
// name wins are pinned, including the "No" answer, which must leave the field
// completely untouched by the bus-fare draft.
import 'dart:io';

import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/screens/luggage_ticket_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'helpers/test_db.dart';

const _secureChannel =
    MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

/// Pumps past the screen's async settings load without needing the
/// forever-animating widgets to settle.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
    await tester
        .runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
  }
}

Sale mkSource({
  String customerName = '',
  String customerMobile = '+263772717003',
  String txId = '',
}) {
  return Sale(
    receiptNo: 'R-1001',
    items: const [],
    total: 500,
    cash: 500,
    change: 0,
    ticketType: 'busFare',
    tripNo: 'T-101',
    busReg: 'AGJ-001',
    customerName: customerName,
    customerMobile: customerMobile,
    txId: txId,
    createdAt: DateTime(2026, 9, 30, 9, 0),
  );
}

String nameFieldText(WidgetTester tester) {
  final field = tester.widget<TextField>(
    find.descendant(
      of: find.byType(LuggageTicketScreen),
      matching: find.byType(TextField),
    ).first,
  );
  return (field.controller?.text ?? '').trim();
}

/// The luggage screen's second text field is the passenger phone number.
String phoneFieldText(WidgetTester tester) {
  final field = tester.widget<TextField>(
    find.descendant(
      of: find.byType(LuggageTicketScreen),
      matching: find.byType(TextField),
    ).at(1),
  );
  return (field.controller?.text ?? '').trim();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    final dir = await useTestDatabaseDir('widget_luggage');
    final f = File(p.join(dir, 'bus_ticket.db'));
    if (f.existsSync()) f.deleteSync();
    await AppDb.init();

    const store = <String, String>{};
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

  Future<void> pumpLuggage(
    WidgetTester tester, {
    required Sale source,
    String hint = '',
    String phoneHint = '',
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LuggageTicketScreen(
          sourceSale: source,
          passengerNameHint: hint,
          passengerPhoneHint: phoneHint,
        ),
      ),
    );
    await settle(tester);
  }

  testWidgets('the typed phone number is adopted alongside the name',
      (tester) async {
    // Requirement 1: the hand-off carries BOTH identity fields. The saved sale
    // holds the walk-in placeholder name, and a phone the conductor has since
    // corrected; both live drafts must win.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'WALK-IN', customerMobile: '+263000000000'),
      hint: 'RUDO MARUME',
      phoneHint: '0772717003',
    );

    expect(nameFieldText(tester), 'RUDO MARUME');
    expect(phoneFieldText(tester), '0772717003',
        reason: 'the typed phone must win over the saved sale copy');
    expect(tester.takeException(), isNull);
  });

  testWidgets('answering "No" leaves both fields on the sale copy only',
      (tester) async {
    // With no hand-off at all, both fields fall back to the saved sale.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'WALK-IN', customerMobile: '+263772717003'),
      hint: '',
      phoneHint: '',
    );

    expect(nameFieldText(tester), isEmpty);
    expect(phoneFieldText(tester), '+263772717003',
        reason: 'the saved sale phone must still be adopted');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a name hint without a phone hint does not blank the phone',
      (tester) async {
    // Guards against a partial hand-off wiping the contact number.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'WALK-IN', customerMobile: '+263772717003'),
      hint: 'RUDO MARUME',
      phoneHint: '',
    );

    expect(nameFieldText(tester), 'RUDO MARUME');
    expect(phoneFieldText(tester), '+263772717003');
    expect(tester.takeException(), isNull);
  });

  testWidgets('the typed bus-fare name is adopted on the luggage ticket',
      (tester) async {
    // The core of the hand-off: the operator answered "Yes", so the name they
    // already typed carries over even though the saved sale only holds the
    // walk-in placeholder.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'WALK-IN'),
      hint: 'RUDO MARUME',
    );

    expect(nameFieldText(tester), 'RUDO MARUME',
        reason: 'the typed name must win over a walk-in placeholder');
    expect(tester.takeException(), isNull);
  });

  testWidgets('answering "No" leaves the field on the sale name only',
      (tester) async {
    // "No" must never pass a draft through, so with no hint the pre-existing
    // rule still applies: a placeholder is blanked for re-entry.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'WALK-IN'),
      hint: '',
    );

    expect(nameFieldText(tester), isEmpty,
        reason: 'with no hand-off a walk-in placeholder must not be reused');
    expect(tester.takeException(), isNull);
  });

  testWidgets('with no hint the real saved name is still adopted',
      (tester) async {
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'TARIRO NYEMBO'),
      hint: '',
    );

    expect(nameFieldText(tester), 'TARIRO NYEMBO');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a placeholder hand-off is ignored in favour of the sale name',
      (tester) async {
    // Guards against the hint becoming a new source of placeholder leakage.
    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'TARIRO NYEMBO'),
      hint: 'WALK-IN',
    );

    expect(nameFieldText(tester), 'TARIRO NYEMBO');
    expect(tester.takeException(), isNull);
  });

  testWidgets('the passenger field matches the passenger ticket handling',
      (tester) async {
    // Task 1: the concise label keeps the row from crowding the value on a
    // narrow terminal. Capitalisation is pinned to match the bus-fare field so
    // the same name reads identically on both tickets, and the field is left
    // uncapped so it cannot silently drop the tail of a name the conductor just
    // typed in full on the bus-fare sheet.
    await pumpLuggage(tester, source: mkSource(), hint: 'RUDO MARUME');

    expect(find.widgetWithText(TextField, 'Passenger'), findsOneWidget,
        reason: 'the label must be the concise "Passenger"');
    expect(find.widgetWithText(TextField, 'Passenger name'), findsNothing,
        reason: 'the long label must be gone');

    final field = tester.widget<TextField>(
      find.descendant(
        of: find.byType(LuggageTicketScreen),
        matching: find.byType(TextField),
      ).first,
    );
    expect(field.textCapitalization, TextCapitalization.characters,
        reason: 'must match the bus-fare passenger field');
    expect(field.maxLength, isNull,
        reason: 'the luggage field must not truncate a name the conductor '
            'could already see in full on the bus-fare sheet');
    expect(tester.takeException(), isNull);
  });

  testWidgets('a long name from the bus-fare sheet is carried over in full',
      (tester) async {
    // The hand-off must not quietly clip the operator's work.
    const longName = 'MUBAI CHISOMBA JOHNSON';
    await pumpLuggage(tester, source: mkSource(), hint: longName);

    expect(nameFieldText(tester), longName);
    expect(tester.takeException(), isNull);
  });

  testWidgets('offline is not reported as a server fault when local data is usable',
      (tester) async {
    // The old blanket catch reported every failure as "Server unreachable",
    // including plain offline operation and local DB errors. With usable local
    // trip data the luggage ticket is issued silently.
    await tester.runAsync(() async {
      final d = await AppDb.db;
      await d.delete('sales');
    });

    await pumpLuggage(
      tester,
      source: mkSource(customerName: 'TARIRO NYEMBO', txId: 'tx-offline'),
      hint: '',
    );

    expect(find.textContaining('Server unreachable'), findsNothing,
        reason: 'offline must not be reported as a server fault');
    expect(nameFieldText(tester), 'TARIRO NYEMBO',
        reason: 'local data must still carry the name');
    expect(tester.takeException(), isNull);
  });
}
