import 'package:barcode_widget/barcode_widget.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/receipt.dart';
import 'package:bus_ticket_app/src/widgets/ticket_preview_card.dart';

TicketData _data({
  List<SaleItem>? items,
  String routeName = 'Harare - Bulawayo',
  String routeCode = 'RT01',
  String ticketType = 'BUS TICKET',
  String seatNumber = '12',
  int tendered = 0,
  String paymentMethod = 'cash',
  String note = 'Valid for the selected trip only.',
  String driver = 'John Muvirimi',
  String conductor1 = 'Peter Nkomo',
  int total = 500,
}) {
  return TicketData(
    companyName: 'Mupota Bus Service',
    slogan: 'Travel Safe',
    ticketType: ticketType,
    receiptNo: 'R-0001',
    time: DateTime(2026, 9, 22, 14, 30),
    busReg: 'AFR 1234',
    tripNo: 'T-5678',
    website: '',
    customerCare: '',
    routeCode: routeCode,
    routeName: routeName,
    items: items ??
        [
          SaleItem(name: 'Adult', price: 500, qty: 1, total: 500),
        ],
    total: total,
    currency: 'USD',
    driver: driver,
    conductor1: conductor1,
    conductor2: '',
    seatNumber: seatNumber,
    departureTime: '06:30',
    paymentMethod: paymentMethod,
    tendered: tendered,
    note: note,
  );
}

Future<void> _pump(WidgetTester tester, TicketData data) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: TicketPreviewCard(data: data))),
    ),
  );
  await tester.pump();
}

void main() {
  testWidgets('renders full passenger ticket with items', (tester) async {
    await _pump(tester, _data());
    expect(find.text('MUPOTA BUS SERVICE'), findsOneWidget);
    expect(find.text('BUS TICKET'), findsOneWidget);
    expect(find.textContaining('R-0001'), findsWidgets);
    expect(find.text('HARARE'), findsOneWidget);
    expect(find.text('BULAWAYO'), findsOneWidget);
    expect(find.text('Adult'), findsOneWidget);
    expect(find.text('TOTAL FARE'), findsOneWidget);
    expect(find.text('PAYMENT METHOD'), findsOneWidget);
    expect(find.text('CASH'), findsWidgets);
    expect(find.text('-'), findsOneWidget);
    expect(find.text('Powered by'), findsOneWidget);
    expect(find.byType(BarcodeWidget), findsNWidgets(2));
  });

  testWidgets('renders sparse ticket with no items, route or staff',
      (tester) async {
    await _pump(
      tester,
      _data(
        items: const [],
        routeName: '',
        routeCode: '',
        seatNumber: '',
        driver: '',
        conductor1: '',
        note: '',
        total: 0,
      ),
    );
    expect(find.text('BUS TICKET'), findsOneWidget);
    expect(find.text('TOTAL FARE'), findsOneWidget);
    expect(find.text('-'), findsOneWidget);
    expect(find.byType(BarcodeWidget), findsNWidgets(2));
  });

  testWidgets('renders luggage ticket', (tester) async {
    await _pump(
      tester,
      _data(
        ticketType: 'LUGGAGE TICKET',
        items: [SaleItem(name: 'Trunk box', price: 2000, qty: 1, total: 2000)],
        total: 2000,
        tendered: 2000,
        seatNumber: '',
      ),
    );
    expect(find.text('LUGGAGE TICKET'), findsOneWidget);
    expect(find.text('Trunk box'), findsOneWidget);
  });
}
