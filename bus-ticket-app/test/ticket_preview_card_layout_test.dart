import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/receipt.dart';
import 'package:bus_ticket_app/src/widgets/ticket_preview_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

TicketData _data({String busReg = 'ABC-1234', String receiptNo = 'TKT-1'}) =>
    TicketData(
      companyName: 'Preyone UltraNet',
      slogan: 'Ride with us',
      ticketType: 'Bus Fare',
      receiptNo: receiptNo,
      time: DateTime(2026, 9, 27, 13, 45),
      busReg: busReg,
      tripNo: 'TRIP-x-1',
      website: '',
      customerCare: '',
      routeCode: 'HRE-CHI',
      routeName: 'Harare - Chitungwiza',
      items: [SaleItem(name: 'Adult', price: 500, qty: 1, total: 500)],
      total: 500,
      currency: 'USD',
      driver: 'Tatenda',
      conductor1: 'Rudo',
      conductor2: '',
      note: '',
    );

/// The real production parent in `home_screen.dart`'s payment sheet:
/// `SafeArea > SingleChildScrollView > Column(mainAxisSize.min)`. This hands the
/// card an UNBOUNDED height, which must stay legal.
Widget sheetBody(Widget card) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [const Text('Passenger details'), card],
        ),
      ),
    );

Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void _size(WidgetTester tester, double w, double h) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = Size(w, h);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  // Regression cover for the Crashlytics fatal:
  //   "RenderBox was not laid out: RenderConstrainedBox ... Failed assertion:
  //    'hasSize'" thrown during performLayout().
  // Root cause: the card forced `width: double.infinity` and its Columns use
  // `CrossAxisAlignment.stretch`, so any host giving it an unbounded width
  // produced `BoxConstraints(w=Infinity, ...)`, which cascades into the
  // "not laid out" assertion on every ancestor. `flutter analyze` cannot see
  // any of this — only actually rendering the widget does.
  testWidgets('lays out in the payment sheet (unbounded height)',
      (tester) async {
    _size(tester, 390, 844);
    await tester.pumpWidget(wrap(sheetBody(TicketPreviewCard(data: _data()))));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('lays out with BOTH axes unbounded (the reported crash)',
      (tester) async {
    _size(tester, 390, 844);
    await tester.pumpWidget(wrap(SingleChildScrollView(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: TicketPreviewCard(data: _data()),
      ),
    )));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('lays out as a non-flex Row child (unbounded width)',
      (tester) async {
    _size(tester, 390, 844);
    await tester.pumpWidget(wrap(SingleChildScrollView(
      child: Row(
        children: [TicketPreviewCard(data: _data())],
      ),
    )));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  for (final w in [240.0, 280.0, 320.0, 390.0, 412.0]) {
    testWidgets('no overflow at width $w', (tester) async {
      _size(tester, w, 1400);
      await tester
          .pumpWidget(wrap(sheetBody(TicketPreviewCard(data: _data()))));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  for (final scale in [1.5, 2.0, 3.0]) {
    testWidgets('no overflow at text scale $scale', (tester) async {
      _size(tester, 390, 1400);
      await tester.pumpWidget(MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(scale)),
        child: wrap(sheetBody(TicketPreviewCard(data: _data()))),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('no overflow with long values at a narrow width', (tester) async {
    _size(tester, 280, 1400);
    await tester.pumpWidget(wrap(sheetBody(TicketPreviewCard(
      data: _data(
        busReg: 'HRE-VERY-LONG-REGISTRATION-9999',
        receiptNo: 'TKT-2026-000000000042',
      ),
    ))));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
