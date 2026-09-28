// Proves the live ticket preview's payment block is RIGHT-ALIGNED as a single
// column, and that the shift banner's trailing pill sits at the right edge of
// its block.
//
// Why geometry and not just "it renders": the rows are built with two flex
// children, so a plausible-looking `Flexible + Spacer` pair silently gives
// every value its own half of the row and leaves it stranded at that half's
// left edge. Nothing overflows, no test fails, and the column just looks
// ragged on the terminal. Only measuring the right edges catches that.
//
// The printed ticket is a different renderer (receipt.dart / buildTicketLines)
// and is deliberately NOT exercised here - the printed layout must stay
// untouched while the on-screen feed is aligned.
import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/receipt.dart';
import 'package:bus_ticket_app/src/widgets/emerald_ui.dart';
import 'package:bus_ticket_app/src/widgets/ticket_preview_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Distinct amounts so each value Text is unambiguous to find.
TicketData _paidData() => TicketData(
      companyName: 'Mupota Bus Service',
      slogan: 'Your Satisfaction Is Our Honour !',
      ticketType: 'Bus Fare',
      receiptNo: 'AGJ0001',
      time: DateTime(2026, 9, 27, 15, 43),
      busReg: 'BD0222-BD266491',
      tripNo: 'TKT',
      website: 'www.preyone.com',
      customerCare: '+263772717003',
      routeCode: 'HRE-CHI',
      routeName: 'Harare - Chitungwiza',
      items: [SaleItem(name: 'Adult', price: 500, qty: 1, total: 500)],
      total: 500,
      currency: 'USD',
      driver: 'Daniel Muvirimi',
      conductor1: 'Leslie Muvirimi',
      conductor2: '',
      paymentMethod: 'cash',
      tendered: 2000,
      note: '',
    );

/// `find.descendant`/`find.ancestor` take a Finder, not an Element.
Finder _asFinder(Element e) => find.byElementPredicate((x) => x == e);

/// Right edge of the value box inside the row that owns [label].
double valueRight(WidgetTester tester, String label) {
  for (final row in find
      .ancestor(of: find.text(label), matching: find.byType(Row))
      .evaluate()) {
    final value =
        find.descendant(of: _asFinder(row), matching: find.byType(FittedBox));
    if (value.evaluate().isEmpty) continue;
    return _right(tester, value.first);
  }
  throw StateError('no value row found for "$label"');
}

/// Right edge of the row that owns [label].
double rowRight(WidgetTester tester, String label) {
  for (final row in find
      .ancestor(of: find.text(label), matching: find.byType(Row))
      .evaluate()) {
    final value =
        find.descendant(of: _asFinder(row), matching: find.byType(FittedBox));
    if (value.evaluate().isEmpty) continue;
    return _right(tester, _asFinder(row));
  }
  throw StateError('no value row found for "$label"');
}

double _right(WidgetTester tester, Finder f) {
  final box = tester.renderObject<RenderBox>(f);
  return box.localToGlobal(Offset.zero).dx + box.size.width;
}

Widget _host(Widget card, {double width = 387}) => MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: SizedBox(width: width, child: card),
        ),
      ),
    );

void main() {
  // The real terminal's content width: 426.7dp screen minus the ticketing
  // list's horizontal padding.
  const deviceWidth = 387.0;

  testWidgets('every payment value is flush right in its row', (tester) async {
    await tester.pumpWidget(
        _host(TicketPreviewCard(data: _paidData()), width: deviceWidth));
    await tester.pumpAndSettle();

    for (final label in const [
      'TOTAL FARE',
      'PAYMENT METHOD',
      'CASH TENDERED',
      'CHANGE',
    ]) {
      final gap = rowRight(tester, label) - valueRight(tester, label);
      expect(gap, closeTo(0, 0.5),
          reason: '"$label" value must sit flush against the right edge of '
              'its row, but it is $gap px short of it');
    }
  });

  testWidgets('the four payment values share one right edge', (tester) async {
    await tester.pumpWidget(
        _host(TicketPreviewCard(data: _paidData()), width: deviceWidth));
    await tester.pumpAndSettle();

    final edges = <String, double>{
      for (final l in const [
        'TOTAL FARE',
        'PAYMENT METHOD',
        'CASH TENDERED',
        'CHANGE',
      ])
        l: valueRight(tester, l),
    };
    final target = edges['TOTAL FARE']!;
    edges.forEach((label, edge) {
      expect(edge, closeTo(target, 0.5),
          reason: '"$label" is ${(edge - target).toStringAsFixed(1)}px out of '
              'line with TOTAL FARE; the payment column must be one edge');
    });
  });

  testWidgets('payment labels share one left edge', (tester) async {
    await tester.pumpWidget(
        _host(TicketPreviewCard(data: _paidData()), width: deviceWidth));
    await tester.pumpAndSettle();

    double labelLeft(String label) => tester
        .renderObject<RenderBox>(find.text(label).first)
        .localToGlobal(Offset.zero)
        .dx;

    final target = labelLeft('TOTAL FARE');
    for (final label in const [
      'PAYMENT METHOD',
      'CASH TENDERED',
      'CHANGE',
    ]) {
      expect(labelLeft(label), closeTo(target, 0.5),
          reason: '"$label" label should line up with TOTAL FARE');
    }
  });

  testWidgets('shift banner trailing pill is flush right', (tester) async {
    const pillKey = Key('end-view-pill');
    const shiftBanner = EmeraldBanner(
      leading: Icons.radio_button_checked,
      trailing: SizedBox(key: pillKey, width: 70, height: 20),
      child: Text('SHIFT: DANIEL MUVIRIMI . BD0222-BD266491'),
    );
    await tester.pumpWidget(_host(shiftBanner, width: deviceWidth));
    // The banner pulses forever, so pumpAndSettle never returns.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final pill = _right(tester, find.byKey(pillKey));
    final banner = _right(
      tester,
      find
          .ancestor(
            of: find.byKey(pillKey),
            matching: find.byType(EmeraldBanner),
          )
          .first,
    );
    // 14px of the banner's own horizontal padding, so the pill's right edge
    // should sit exactly 14px inside the banner's right edge.
    expect(banner - pill, closeTo(14, 0.5),
        reason: 'the END / VIEW pill must hug the right edge of the banner');
  });

  testWidgets('shift banner still lays out in an unbounded host',
      (tester) async {
    // A Spacer/Expanded here is what used to throw 'hasSize'. Keep it legal.
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: Row(
              children: [
                EmeraldBanner(
                  leading: Icons.radio_button_checked,
                  trailing: Text('END / VIEW'),
                  child: Text('SHIFT: DANIEL'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull);
    expect(find.text('END / VIEW'), findsOneWidget);
  });
}
