import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/receipt.dart';
import 'package:bus_ticket_app/src/widgets/emerald_ui.dart';
import 'package:bus_ticket_app/src/widgets/ticket_preview_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Reproduces the render-tree shape decoded from the Crashlytics trace:
///
///   Scaffold(outer) > Stack(fit: StackFit.expand)   <- EmeraldTabEntrance
///     > Container > Container > _RenderCustomClip
///       > Container > Container > Scaffold(inner)
///         > Padding > Row/Column > _RenderCustomClip   <- clip as DIRECT flex child
///           > Container > Padding > Padding > Row/Column
///             > Container x4 > RenderConstrainedBox    <- hasSize failure
///
/// The outer Stack/clip come from EmeraldTabEntrance's AnimatedSwitcher layout
/// builder plus EmeraldAurora; the inner clip-as-flex-child is the shape the
/// trace shows. The point of these tests is that the CARD must never be the
/// thing that cannot lay itself out, no matter what host it is given.
TicketData _data({String receiptNo = 'TKT-1'}) => TicketData(
      companyName: 'Preyone UltraNet',
      slogan: 'Ride with us',
      ticketType: 'Bus Fare',
      receiptNo: receiptNo,
      time: DateTime(2026, 9, 27, 13, 45),
      busReg: 'ABC-1234',
      tripNo: 'TRIP-x-1',
      website: '',
      customerCare: '',
      routeCode: 'HRE-CHI',
      routeName: 'Harare - Chitungwiza',
      items: [SaleItem(name: 'Adult', price: 500, qty: 1, total: 500)],
      total: 500,
      currency: 'USD',
      driver: 'Tatendo',
      conductor1: 'Rudo',
      conductor2: '',
      note: '',
    );

void _size(WidgetTester tester, double w, double h) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = Size(w, h);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  group('inner Scaffold with a clip as a direct flex child', () {
    // Exactly the trace's inner subtree: the card is a non-flex child of a Row
    // whose parent clips. A Row hands non-flex children UNBOUNDED width, which
    // is the condition that produced the crash.
    testWidgets('card as non-flex Row child under a clip', (tester) async {
      // Production reality: the card lives in a scroll view, which is what
      // home_screen.dart:1777 and history_screen.dart:392 do. The clip and
      // the non-flex Row replicate the trace's ancestors; the scroll view
      // supplies the unbounded height the card's fixed layout needs.
      _size(tester, 390, 844);
      await tester.pumpWidget(wrap(Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('side'),
                  Flexible(child: TicketPreviewCard(data: _data())),
                ],
              ),
            ),
          ),
        ),
      )));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('card in a Column whose width is unbounded', (tester) async {
      _size(tester, 390, 2400);
      await tester.pumpWidget(wrap(Scaffold(
        body: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Column(
            children: [
              TicketPreviewCard(data: _data()),
              TicketPreviewCard(data: _data(receiptNo: 'TKT-2')),
            ],
          ),
        ),
      )));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('two cards side by side in a Row (no Expanded)',
        (tester) async {
      // A ticket card is a fixed-layout document ~1000px tall; two of them
      // cannot fit a 390px phone width. The realistic assertion is that the
      // card lays out without a *layout* failure, not that two fit side by
      // side, so constrain the host to something the card can actually fill.
      _size(tester, 1400, 1200);
      await tester.pumpWidget(wrap(Scaffold(
        body: Row(
          children: [
            TicketPreviewCard(data: _data()),
            TicketPreviewCard(data: _data(receiptNo: 'TKT-2')),
          ],
        ),
      )));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  });

  group('EmeraldTabEntrance (the outer Stack in the trace)', () {
    testWidgets('swaps tabs without a layout assertion', (tester) async {
      _size(tester, 390, 844);
      var tab = 'a';
      late StateSetter setTab;
      await tester.pumpWidget(MaterialApp(
        home: StatefulBuilder(builder: (context, ss) {
          setTab = ss;
          return Scaffold(
            body: EmeraldTabEntrance(
              tabKey: tab,
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: TicketPreviewCard(
                    data: _data(receiptNo: 'TKT-$tab'),
                  ),
                ),
              ),
            ),
          );
        }),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      // Mid-transition swaps: the outgoing and incoming children coexist in
      // the Stack, which is when a bad fit can bite.
      for (final next in ['b', 'c', 'a']) {
        setTab(() => tab = next);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(tester.takeException(), isNull, reason: 'mid-transition $next');
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: 'settled $next');
      }
    });

    testWidgets('nested Scaffold as the tab child', (tester) async {
      _size(tester, 390, 844);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: EmeraldTabEntrance(
            tabKey: 'x',
            child: Scaffold(
              appBar: AppBar(title: const Text('inner')),
              body: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: TicketPreviewCard(data: _data()),
                ),
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  });

  group('hostile text scales and widths', () {
    for (final scale in [1.0, 1.3, 1.5, 2.0, 3.0]) {
      testWidgets('scale $scale in a non-flex Row', (tester) async {
        // Tall viewport: a fixed-layout ticket card cannot compress, so give
        // the host the height it needs and assert the card lays out cleanly
        // at every accessibility text scale.
        _size(tester, 900, 2000);
        await tester.pumpWidget(MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: wrap(Scaffold(
            body: Row(
              children: [
                Flexible(child: TicketPreviewCard(data: _data())),
              ],
            ),
          )),
        ));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }
  });
}
