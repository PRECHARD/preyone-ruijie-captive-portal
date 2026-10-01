import 'package:flutter_test/flutter_test.dart';

import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/receipt.dart';

TicketData _ticket({
  String companyName = 'Mupota Bus Service',
  String routeCode = 'RT01',
  String routeName = 'Harare - Bulawayo',
  String busReg = 'AFR 1234',
  String tripNo = 'T-5678',
  String? departureTime = '06:30',
  String seatNumber = '12',
  String receiptNo = 'R-0001',
  String slogan = '',
  String ticketType = 'BUS FARE',
  String conductorPhone = '',
  int tendered = 0,
  String paymentMethod = 'cash',
  String website = '',
  String companyAddress = '',
  String customerCare = '',
  String customerName = '',
  String customerMobile = '',
  String note = kTicketValidityNote,
  List<SaleItem> items = const [],
}) {
  return TicketData(
    companyName: companyName,
    slogan: slogan,
    ticketType: ticketType,
    receiptNo: receiptNo,
    time: DateTime(2026, 9, 22, 14, 30),
    busReg: busReg,
    tripNo: tripNo,
    website: website,
    customerCare: customerCare,
    companyAddress: companyAddress,
    routeCode: routeCode,
    routeName: routeName,
    items: items,
    total: 500,
    currency: 'USD',
    driver: 'John Muvirimi',
    conductor1: 'Peter Nkomo',
    conductor2: '',
    departureTime: departureTime ?? '',
    paymentMethod: paymentMethod,
    tendered: tendered,
    conductorPhone: conductorPhone,
    customerName: customerName,
    customerMobile: customerMobile,
    note: note,
  );
}

bool listContains(List<int> list, List<int> needle) {
  if (needle.length > list.length) return false;
  for (var i = 0; i + needle.length <= list.length; i++) {
    if (list.sublist(i, i + needle.length).toString() == needle.toString()) {
      return true;
    }
  }
  return false;
}

void main() {
  test('route code appears before destination on same line, no label', () {
    final lines = buildTicketLines(_ticket());
    final routeLine =
        lines.firstWhere((l) => l.text.trim().contains('HARARE -> BULAWAYO'));
    expect(routeLine.text.trim(), 'RT01 HARARE -> BULAWAYO');
    expect(routeLine.text.trim().split('\n'), hasLength(1));
    for (final l in lines) {
      expect(l.text.contains('Route Code'), isFalse,
          reason: 'no "Route Code" label may be printed: ${l.text}');
      expect(l.text.contains('ROUTE:'), isFalse,
          reason: 'no "ROUTE:" label may be printed: ${l.text}');
    }
  });

  test('departure time and trip number are absent', () {
    final lines =
        buildTicketLines(_ticket(departureTime: '06:30', tripNo: 'T-5678'));
    for (final l in lines) {
      expect(l.text.contains('DEP'), isFalse,
          reason: 'departure time must not print: ${l.text}');
      expect(l.text.contains('TRIP'), isFalse,
          reason: 'trip number must not print: ${l.text}');
    }
  });

  test('company name centered, double-height when it fits the 58mm width', () {
    final lines = buildTicketLines(
        _ticket(companyName: 'Mupota Bus', slogan: 'Serving the nation'));
    expect(lines.first.text.trim(), 'MUPOTA BUS');
    expect(lines.first.big, isTrue,
        reason: 'names up to 16 columns stay double-height to span the paper');
    expect(lines.first.bold, isTrue);
    final tagline =
        lines.firstWhere((l) => l.text.trim() == 'SERVING THE NATION');
    expect(tagline.bold, isTrue, reason: 'tagline prints in standard bold');
  });

  test('long company name only steps to Font B double-height, never clipped',
      () {
    final lines = buildTicketLines(_ticket(companyName: 'Mupota Bus Service'));
    expect(lines.first.big, isTrue,
        reason: 'names up to ~21 columns stay double-height, just one size '
            'smaller than the original Font A double scale');
    expect(lines.first.small, isTrue,
        reason: 'the slightly-smaller step is Font B at double size');
    expect(lines.first.text.trim(), 'MUPOTA BUS SERVICE',
        reason: 'the complete name must stay on the 32-column line');
    expect(lines.first.text.split('\n'), hasLength(1),
        reason: 'the header must never wrap');
  });

  test('company address and customer care print under the name, in order', () {
    final lines = buildTicketLines(_ticket(
      companyAddress: '10 Kaguyu Street, Harare',
      customerCare: '0772111111',
    ));
    final texts = lines.map((l) => l.text.trim()).toList();
    final nameIdx = texts.indexOf('MUPOTA BUS SERVICE');
    final addrIdx = texts.indexWhere((t) => t == '10 KAGUYU STREET, HARARE');
    final careIdx = texts.indexWhere((t) => t == 'CUSTOMER CARE +263772111111');
    expect(nameIdx, greaterThanOrEqualTo(0));
    expect(addrIdx, greaterThan(nameIdx),
        reason: 'address prints directly under the company name');
    expect(careIdx, greaterThan(addrIdx),
        reason: 'customer care prints after the address');
    expect(lines[addrIdx].small, isTrue,
        reason: 'the contact strip prints in the smaller font');
    expect(lines[careIdx].small, isTrue);
    expect(texts.any((t) => t.length > 42), isFalse,
        reason: 'no contact line may overflow the Font B width');
  });

  test('no contact strip when address and care are empty', () {
    final lines =
        buildTicketLines(_ticket(companyAddress: '', customerCare: ''));
    for (final l in lines) {
      expect(l.text.contains('CUSTOMER CARE'), isFalse);
    }
  });

  test('metadata row shows BUS left / TKT right with equal bold typography',
      () {
    final lines =
        buildTicketLines(_ticket(receiptNo: 'R-0001', busReg: 'AFR 1234'));
    final texts = lines.map((l) => l.text.trim()).toList();
    final row = texts.firstWhere((t) => t.startsWith('BUS: AFR 1234'));
    expect(row, contains('TKT: #R-0001'));
    expect(row.length, lessThanOrEqualTo(32),
        reason: 'metadata row must fit exactly 32 printer columns');
    final metaIdx = texts.indexOf(row);
    final metaLine = lines[metaIdx];
    expect(metaLine.bold, isTrue,
        reason: 'bus registration must use the same bold as the ticket number');
    expect(texts.indexWhere((t) => t == 'BUS AFR 1234'), -1,
        reason: 'old BUS-only centered line must not print');
    expect(texts.indexWhere((t) => t.startsWith('TICKET NO')), -1,
        reason: 'legacy TICKET NO line must not duplicate when bus is present');
    final content =
        lines.where((l) => l.barcodeData == null && l.qrData == null).toList();
    expect(content.every((l) => l.text.trim().isNotEmpty), isTrue,
        reason: 'no blank text rows may remain (barcode/QR rows excepted)');
  });

  test('ticket number stays primary when no bus registration exists', () {
    final lines = buildTicketLines(_ticket(busReg: ''));
    final texts = lines.map((l) => l.text.trim()).toList();
    final first = texts.firstWhere((t) => t.startsWith('TICKET NO'));
    expect(first, 'TICKET NO  R-0001');
    expect(texts.where((t) => t.startsWith('TICKET NO')).length, 1,
        reason: 'ticket number must not be duplicated');
  });

  test('long route code + destination stays on one line (font B fallback)', () {
    final lines = buildTicketLines(_ticket(
      routeCode: 'RT-0001',
      routeName: 'Sunningdale - Chitungwiza',
    ));
    final routeLine =
        lines.firstWhere((l) => l.text.trim().contains('RT-0001'));
    expect(routeLine.text.trim(), 'RT-0001 SUNNINGDALE -> CHITUNGWIZA',
        reason: 'the complete route line must not be clipped');
    expect(routeLine.text.split('\n'), hasLength(1));
    expect(routeLine.small, isTrue,
        reason: 'long route lines should drop to font B instead of wrapping');
  });

  test('seat line is omitted when no seat was assigned', () {
    final lines = buildTicketLines(_ticket(seatNumber: ''));
    for (final l in lines) {
      expect(l.text.contains('SEAT'), isFalse,
          reason: 'seat must be skipped entirely when empty: ${l.text}');
    }
  });

  test('conductor row expands 08x numbers to +263 via formatZimPhone', () {
    final lines = buildTicketLines(_ticket(conductorPhone: '0812345678'));
    final texts = lines.map((l) => l.text.trim()).toList();
    final row = texts.firstWhere((t) => t.startsWith('Conductor:'));
    expect(row, contains('PETER NKOMO'));
    final mobile = texts.firstWhere((t) => t.startsWith('Mobile:'));
    expect(mobile, endsWith('+263812345678'),
        reason: 'the full normalized 08x number must never be truncated');
    expect(row.length, lessThanOrEqualTo(32));
    expect(mobile.length, lessThanOrEqualTo(32));
  });

  test('payment breakdown prints method, tendered and change from tendered',
      () {
    final lines =
        buildTicketLines(_ticket(paymentMethod: 'cash', tendered: 1000));
    final texts = lines.map((l) => l.text.trim()).toList();
    final method = texts.firstWhere((t) => t.startsWith('PAYMENT METHOD:'));
    expect(method, contains('CASH'));
    final tendered = texts.firstWhere((t) => t.startsWith('CASH TENDERED:'));
    expect(tendered, contains('USD 10.00'));
    final change = texts.firstWhere((t) => t.startsWith('CHANGE:'));
    expect(change, contains('USD 5.00'));
    expect(method.length, lessThanOrEqualTo(32));
    expect(tendered.length, lessThanOrEqualTo(32));
    expect(change.length, lessThanOrEqualTo(32));
  });

  test('exact payment yields zero change by default', () {
    final lines =
        buildTicketLines(_ticket(tendered: 0, paymentMethod: 'ecocash'));
    final change = lines.firstWhere((l) => l.text.trim().startsWith('CHANGE:'));
    expect(change.text.trim(), contains('USD 0.00'));
  });

  test('payment block underlined under change, then note, then footer', () {
    final lines = buildTicketLines(_ticket(tendered: 1000));
    final texts = lines.map((l) => l.text.trim()).toList();
    final totalIdx = texts.indexOf('TOTAL FARE  USD 5.00');
    expect(totalIdx, greaterThan(0));
    final methodIdx =
        texts.indexWhere((t) => t.startsWith('PAYMENT METHOD:'), totalIdx + 1);
    final tenderedIdx =
        texts.indexWhere((t) => t.startsWith('CASH TENDERED:'), methodIdx + 1);
    final changeIdx =
        texts.indexWhere((t) => t.startsWith('CHANGE:'), tenderedIdx + 1);
    expect(methodIdx, greaterThan(totalIdx),
        reason: 'payment method prints right under the total');
    expect(tenderedIdx, greaterThan(methodIdx));
    expect(changeIdx, greaterThan(tenderedIdx));
    expect(tenderedIdx, lessThan(totalIdx + 4),
        reason: 'tendered is directly under the total, not buried');
    final underlineIdx = texts.indexOf('-' * 32, changeIdx + 1);
    expect(underlineIdx, changeIdx + 1,
        reason: 'the underline sits right under the change figure');
    final noteIdx =
        texts.indexWhere((t) => t.startsWith('Please keep'), underlineIdx + 1);
    expect(noteIdx, greaterThan(underlineIdx),
        reason: 'the statement prints after the underline');
    final footerIdx = texts.indexWhere((t) => t == 'Powered by', noteIdx + 1);
    expect(footerIdx, greaterThan(noteIdx),
        reason: 'the footer follows the statement');
    final bytes = buildTicket(_ticket(tendered: 1000));
    expect(listContains(bytes, [0x1B, 0x64, 0x01]), isTrue,
        reason: 'a blank line is fed before the footer');
  });

  test('barcodeDataFor carries receipt, trip and total in cents', () {
    expect(barcodeDataFor(_ticket(receiptNo: 'R-0001', tripNo: 'T-5678')),
        'R-0001|T-5678|500');
    final lug = _ticket(ticketType: 'LUGGAGE TICKET', receiptNo: 'L-9000');
    expect(barcodeDataFor(lug), 'LUG|L-9000|500');
  });

  test('bus ticket prints its full statement, no trailing words dropped', () {
    final lines = buildTicketLines(_ticket(note: kTicketValidityNote));
    final texts = lines.map((l) => l.text.trim()).toList();
    final totalIdx = texts.indexOf('TOTAL FARE  USD 5.00');
    final changeIdx = texts.indexWhere((t) => t.startsWith('CHANGE:'));
    final underlineIdx = texts.indexOf('-' * 32, changeIdx + 1);
    expect(underlineIdx, changeIdx + 1,
        reason: 'the underline sits right under the change figure');
    final noteIdx = texts.indexWhere(
        (t) => t.startsWith('PLEASE KEEP') || t.startsWith('Please keep'));
    expect(noteIdx, greaterThan(underlineIdx),
        reason: 'statement prints under the payment underline');
    final footerIdx = texts.indexWhere((t) => t == 'Powered by', noteIdx + 1);
    final noteLines = texts
        .sublist(noteIdx, footerIdx)
        .join(' ')
        .replaceAll('  ', ' ')
        .trim();
    expect(noteLines, contains('Please keep your ticket safe.'));
    expect(noteLines, endsWith('Thank You!'),
        reason: 'the trailing words must never be dropped');
    expect(noteLines, isNotEmpty);
    for (final l in texts) {
      expect(l.length, lessThanOrEqualTo(42),
          reason: 'no statement line may exceed the Font B width');
    }
    expect(footerIdx, greaterThan(noteIdx));
    expect(totalIdx, greaterThan(0));
    final bytes = buildTicket(_ticket(note: kTicketValidityNote));
    final ascii = String.fromCharCodes(bytes.where((b) => b >= 32 && b < 127));
    expect(ascii, contains('Thank You!'),
        reason: 'the complete statement reaches the printer bytes');
  });

  test('luggage ticket prints its own statement, not the bus statement', () {
    final lines = buildTicketLines(
        _ticket(ticketType: 'LUGGAGE TICKET', note: kLuggageNote));
    final texts = lines.map((l) => l.text.trim()).toList();
    expect(texts.any((t) => t.startsWith('Please keep')), isFalse,
        reason: 'the bus statement must never print on a luggage ticket');
    final noteIdx = texts.indexWhere((t) => t.startsWith('Please check'));
    expect(noteIdx, greaterThanOrEqualTo(0),
        reason: 'the dedicated luggage statement prints instead');
    final footerIdx = texts.indexWhere((t) => t == 'Powered by', noteIdx + 1);
    expect(footerIdx, greaterThan(noteIdx));
    final noteUp = texts
        .sublist(noteIdx, footerIdx)
        .join(' ')
        .replaceAll('  ', ' ')
        .trim();
    expect(noteUp, contains('compartments'));
    expect(noteUp, endsWith('Thank You!'),
        reason: 'the luggage statement ends intact with no dropped words');
  });

  test('buildTicket no longer emits a QR code for the thermal printout', () {
    final bytes = buildTicket(_ticket());
    expect(listContains(bytes, [0x31, 0x41, 0x32]), isFalse,
        reason: 'GS ( k model-2 QR selection must not reach the printer');
    expect(listContains(bytes, [0x31, 0x50]), isFalse,
        reason: 'no QR store-data command is emitted');
    final lines = buildTicketLines(_ticket());
    expect(lines.every((l) => l.qrData == null), isTrue,
        reason: 'the thermal ticket layout keeps only the CODE128 barcode');
  });

  test(
      'footer prints exactly like the app preview: Powered by / brand / website',
      () {
    final lines = buildTicketLines(_ticket(website: 'preyone.co.zw'));
    final texts = lines.map((l) => l.text.trim()).toList();
    final byIdx = texts.indexOf('Powered by');
    final brandIdx = texts.indexOf('PREYONE TECHNOLOGIES');
    final webIdx = texts.indexOf('preyone.co.zw');
    expect(byIdx, greaterThanOrEqualTo(0),
        reason: '"Powered by" prints on its own line');
    expect(brandIdx, greaterThan(byIdx),
        reason: 'the brand prints right under "Powered by"');
    expect(lines[brandIdx].bold, isTrue,
        reason: 'the brand is emphasized, matching the preview weight');
    expect(webIdx, greaterThan(brandIdx),
        reason: 'the website prints last, exactly as the preview shows it');
  });

  test('buildTicket emits a Code128 barcode followed by a 3-line tear feed',
      () {
    final bytes = buildTicket(_ticket());

    expect(listContains(bytes, [0x1D, 0x6B, 0x49]), isTrue,
        reason: 'GS k m=73 selects CODE128');
    expect(listContains(bytes, [0x1D, 0x68, 0x1C]), isTrue,
        reason: 'barcode height set to 28 dots (< 1 cm)');
    expect(listContains(bytes, [0x1B, 0x64, 0x03]), isTrue,
        reason: 'tear-off feed of exactly 3 lines after the barcode');
    final ascii = String.fromCharCodes(bytes.where((b) => b >= 32 && b < 127));
    expect(ascii, contains('R-0001|T-5678|500'));
    expect(ascii.contains('Route Code'), isFalse);
  });

  test('website falls back to the platform URL when empty', () {
    final lines = buildTicketLines(_ticket(website: ''));
    final texts = lines.map((l) => l.text.trim()).toList();
    expect(texts, contains('www.preyone.com'));
    final explicit = buildTicketLines(_ticket(website: 'preyone.co.zw'));
    expect(explicit.map((l) => l.text.trim()), contains('preyone.co.zw'));
  });

  Sale mkSale({
    String receiptNo = 'R-0001',
    String driver = '',
    String driverPhone = '',
    String conductor1 = '',
    String conductorPhone = '',
  }) =>
      Sale(
        receiptNo: receiptNo,
        items: const [],
        total: 500,
        cash: 500,
        change: 0,
        driver: driver,
        driverPhone: driverPhone,
        conductor1: conductor1,
        conductorPhone: conductorPhone,
        createdAt: DateTime(2026, 9, 22, 9, 0),
      );

  Trip mkTrip({
    String tripNo = 'T-5678',
    String routeName = 'Harare - Bulawayo',
    String busReg = 'AFR 1234',
    String driver = 'John Muvirimi',
    String driverPhone = '0771111111',
    String conductor = 'Peter Nkomo',
    String conductorPhone = '0782222222',
  }) =>
      Trip(
        tripNo: tripNo,
        routeName: routeName,
        busReg: busReg,
        driver: driver,
        driverPhone: driverPhone,
        conductor: conductor,
        conductorPhone: conductorPhone,
        totalSeats: 40,
      );

  DriverShift mkShift() => DriverShift(
        id: 's1',
        driverName: 'John Muvirimi',
        driverPhone: '0771111111',
        conductorName: 'Peter Nkomo',
        conductorPhone: '0782222222',
        startedAt: DateTime(2026, 9, 22, 5, 30),
        closedAt: DateTime(2026, 9, 22, 18, 0),
      );

  group('trip manifest header', () {
    test(
        'long company name fits via the ticket font step, never forced double size',
        () {
      final lines = buildTripManifestLines(
        companyName: 'Mupota Bus Services Harare',
        currency: 'USD',
        trip: mkTrip(),
        tickets: [mkSale()],
        tagline: 'Famba Nyore Nyore',
        companyAddress: '10 Kaguyu Street, Harare',
        customerCare: '0772111111',
      );
      expect(lines.first.big, isFalse,
          reason: 'names over 21 columns must never be force-double-sized');
      expect(lines.first.text.trim(), 'MUPOTA BUS SERVICES HARARE');
      expect(lines.first.text.split('\n'), hasLength(1),
          reason:
              'the manifest header must fit the 58mm width like the ticket');
    });

    test('crew sits directly under company header, before TRIP MANIFEST', () {
      final lines = buildTripManifestLines(
        companyName: 'Mupota Bus',
        currency: 'USD',
        trip: mkTrip(),
        tickets: [mkSale()],
        tagline: 'Famba Nyore Nyore',
        companyAddress: '10 Kaguyu Street, Harare',
        customerCare: '0772111111',
      );
      final texts = lines.map((l) => l.text.trim()).toList();
      final headerIdx = texts.indexOf('MUPOTA BUS');
      final addressIdx = texts.indexOf('10 KAGUYU STREET, HARARE');
      final careIdx = texts.indexOf('CUSTOMER CARE +263772111111');
      final driverIdx = texts.indexWhere((t) => t.startsWith('DRIVER:'));
      final driverPhoneIdx = texts.indexWhere((t) => t == '+263771111111');
      final conductorIdx = texts.indexWhere((t) => t.startsWith('CONDUCTOR:'));
      final conductorPhoneIdx = texts.indexWhere((t) => t == '+263782222222');
      final manifestIdx = texts.indexOf('TRIP MANIFEST');
      expect(headerIdx, greaterThanOrEqualTo(0));
      expect(addressIdx, greaterThan(headerIdx),
          reason: 'address prints under the company name');
      expect(careIdx, greaterThan(addressIdx),
          reason: 'customer care prints in the company bracket, +263 form');
      expect(driverIdx, greaterThan(careIdx),
          reason: 'driver sits right under the company header');
      expect(driverPhoneIdx, greaterThan(driverIdx));
      expect(conductorIdx, greaterThan(driverPhoneIdx));
      expect(conductorPhoneIdx, greaterThan(conductorIdx));
      expect(manifestIdx, greaterThan(conductorPhoneIdx),
          reason: 'crew prints BEFORE the TRIP MANIFEST title');
    });
  });

  group('passenger row labelling', () {
    test('the label is "Passenger", not "Passenger Name"', () {
      final lines = buildTicketLines(
          _ticket(customerName: 'Tapiwa Moyo', customerMobile: '0773334444'));
      final texts = lines.map((l) => l.text).toList();

      expect(texts.any((t) => t.trimLeft().startsWith('Passenger:')), isTrue,
          reason: 'the passenger row must use the concise label');
      expect(texts.any((t) => t.contains('Passenger Name:')), isFalse,
          reason: 'the long label must be gone');
      // The mobile row is a separate label and is deliberately left alone.
      expect(
          texts.any((t) => t.trimLeft().startsWith('Passenger Mobile:')),
          isTrue);
    });

    test('the shorter label buys room so long names print unclipped', () {
      // 'Passenger:' is 10 characters against formatRow's 32-column budget, so
      // 21 remain for the value. A 21-character name must therefore survive
      // whole; under the old 15-character 'Passenger Name:' label this name was
      // cut mid-word.
      const longName = 'TSVANGIRAI MASANGWANA'; // exactly 21 characters
      expect(longName.length, 21);

      final lines =
          buildTicketLines(_ticket(customerName: longName, customerMobile: ''));
      final row = lines
          .map((l) => l.text)
          .firstWhere((t) => t.trimLeft().startsWith('Passenger:'));

      expect(row, contains(longName),
          reason: 'a 21-character name must print in full');
      expect(row.trimRight().length, lessThanOrEqualTo(32),
          reason: 'the row must still fit the 32-column ticket');
      expect(row.trimRight().length, 32,
          reason: 'and should use the space the shorter label freed');
    });

    test('a name longer than the budget is clipped, never wrapped', () {
      const absurd = 'CHRISTOPHER TATENDA MUVIRIMI JR';
      final lines =
          buildTicketLines(_ticket(customerName: absurd, customerMobile: ''));
      final row = lines
          .map((l) => l.text)
          .firstWhere((t) => t.trimLeft().startsWith('Passenger:'));

      expect(row.trimRight().length, lessThanOrEqualTo(32));
      expect(row, contains(absurd.substring(0, 21)),
          reason: 'the overflow is cut at the budget, not wrapped to a 2nd row');
      expect(row.contains(absurd), isFalse);
    });
  });

  group('trip manifest rows', () {
    test('walk-in rows print a world-standard dash, not WALK-IN PASSENGER', () {
      final lines = buildTripManifestLines(
        companyName: 'Mupota Bus',
        currency: 'USD',
        trip: mkTrip(),
        tickets: [mkSale(receiptNo: 'R-0001')],
        tagline: 'Famba Nyore Nyore',
      );
      final texts = lines.map((l) => l.text.trim()).toList();
      expect(texts.any((t) => t.contains('WALK-IN')), isFalse,
          reason: 'the manifest must not fabricate a WALK-IN PASSENGER name');
      final seatRow = texts.firstWhere((t) => t.startsWith('S--'));
      expect(seatRow, contains('-'),
          reason: 'an unnamed passenger prints a dash as the name');
      expect(seatRow, contains('USD 5.00'),
          reason: 'the fare stays on the passenger row');
      final tktRow = texts.firstWhere((t) => t.startsWith('#R-0001'));
      expect(tktRow, contains('R-0001'),
          reason: 'the ticket number prints as recorded');
    });

    test('named passengers print exactly as recorded, ticket number intact',
        () {
      final lines = buildTripManifestLines(
        companyName: 'Mupota Bus',
        currency: 'USD',
        trip: mkTrip(),
        tickets: [
          Sale(
            receiptNo: 'R-0007',
            customerName: 'Tapiwa Moyo',
            customerMobile: '0773334444',
            items: const [],
            total: 500,
            cash: 500,
            change: 0,
            seatNumber: '04',
            paymentMethod: 'ecocash',
            createdAt: DateTime(2026, 9, 22, 9, 0),
          ),
        ],
        tagline: 'Famba Nyore Nyore',
      );
      final texts = lines.map((l) => l.text.trim()).toList();
      final seatRow = texts.firstWhere((t) => t.startsWith('S04'));
      expect(seatRow, contains('TAPIWA MOYO'),
          reason: 'the recorded customer name is displayed uppercase');
      final tktRow = texts.firstWhere((t) => t.startsWith('#R-0007'));
      expect(tktRow, contains('R-0007'));
      expect(tktRow, contains('ECO'),
          reason: 'the payment short tag prints on the ticket row');
    });

    test('a missing customer name parses to empty, never a fake WALK-IN', () {
      final sale = Sale.fromJson(const {
        'receipt_no': 'R-0099',
        'total': 500,
        'cash': 500,
      });
      expect(sale.customerName, '',
          reason: 'no name must stay empty so manifests print the dash');
      final named = Sale.fromJson(const {
        'receipt_no': 'R-0100',
        'customer_name': 'Tapiwa Moyo',
        'total': 500,
        'cash': 500,
      });
      expect(named.customerName, 'Tapiwa Moyo');
    });
  });

  group('end-of-day report', () {
    test('header uses the full ticket bracket with the shift crew', () {
      final lines = buildReportLines(
        companyName: 'Mupota Bus',
        currency: 'USD',
        from: DateTime(2026, 9, 22),
        to: DateTime(2026, 9, 22, 23, 59),
        sales: [mkSale()],
        tagline: 'Famba Nyore Nyore',
        companyAddress: '10 Kaguyu Street, Harare',
        customerCare: '0772111111',
        shift: mkShift(),
      );
      final texts = lines.map((l) => l.text.trim()).toList();
      expect(lines.first.big, isTrue,
          reason: 'report name uses the same stepped header as the ticket');
      final headerIdx = texts.indexOf('MUPOTA BUS');
      final addressIdx = texts.indexOf('10 KAGUYU STREET, HARARE');
      final careIdx = texts.indexOf('CUSTOMER CARE +263772111111');
      final taglineIdx = texts.indexOf('FAMBA NYORE NYORE');
      expect(headerIdx, greaterThanOrEqualTo(0));
      expect(addressIdx, greaterThan(headerIdx),
          reason: 'the address prints beneath the report company name');
      expect(careIdx, greaterThan(addressIdx));
      expect(taglineIdx, greaterThan(careIdx));
      expect(lines[taglineIdx].bold, isTrue,
          reason: 'the report tagline prints in standard bold like the ticket');
      final driverIdx = texts.indexWhere((t) => t.startsWith('DRIVER:'));
      final driverPhoneIdx = texts.indexWhere((t) => t == '+263771111111');
      final conductorIdx = texts.indexWhere((t) => t.startsWith('CONDUCTOR:'));
      final conductorPhoneIdx = texts.indexWhere((t) => t == '+263782222222');
      final titleIdx = texts.indexOf('END OF DAY REPORT');
      expect(driverIdx, greaterThan(careIdx));
      expect(driverPhoneIdx, greaterThan(driverIdx));
      expect(conductorIdx, greaterThan(driverPhoneIdx));
      expect(conductorPhoneIdx, greaterThan(conductorIdx));
      expect(titleIdx, greaterThan(conductorPhoneIdx),
          reason: 'the day shift crew prints right under the company header');
    });

    test('no shift -> crew falls back to the day\'s sales', () {
      final lines = buildReportLines(
        companyName: 'Mupota Bus',
        currency: 'USD',
        from: DateTime(2026, 9, 22),
        to: DateTime(2026, 9, 22, 23, 59),
        sales: [
          mkSale(
              driver: 'Tendai Madondo',
              driverPhone: '0773111111',
              conductor1: 'Rudo',
              conductorPhone: '0784111111'),
        ],
      );
      final texts = lines.map((l) => l.text.trim()).toList();
      final driverIdx = texts.indexWhere((t) => t.startsWith('DRIVER:'));
      expect(driverIdx, greaterThanOrEqualTo(0));
      expect(texts, contains('+263773111111'),
          reason: 'the sale driver mobile is normalized to +263');
      final conductorIdx = texts.indexWhere((t) => t.startsWith('CONDUCTOR:'));
      expect(conductorIdx, greaterThan(driverIdx));
      expect(texts, contains('+263784111111'));
      expect(texts.indexOf('END OF DAY REPORT'), greaterThan(conductorIdx));
    });
  });

  group('trailing paper feed', () {
    test('long jobs get a strict 1-line feed before the cut', () {
      // A ticket long enough that the 12cm min-length guard produces no extra
      // padding must end with exactly ESC d 0x01 before the cut — the old
      // configurable 4/8-line default is gone.
      final longTicket = buildTicket(_ticket(items: [
        for (var i = 0; i < 12; i++)
          SaleItem(name: 'Fare line $i', price: 100, qty: 1, total: 100),
      ]));
      // A manifest with many tickets is likewise far past 12cm.
      final longManifest = buildTripManifest(
        companyName: 'Mupota Bus',
        currency: 'USD',
        trip: mkTrip(),
        tickets: List.generate(40, (_) => mkSale()),
      );
      expect(lastFeedCommand(longTicket), kTrailingFeedLines,
          reason: 'tickets end with a strict feed(1) then cut');
      expect(lastFeedCommand(longManifest), kTrailingFeedLines,
          reason: 'the manifest keeps the same strict feed(1)');
    });

    test('short jobs roll out past 12cm so the footer is never cut', () {
      // A minimal ticket (empty note, engineer-driver layout) is far under
      // 12cm; the min-length padding still engages so the cut never shears the
      // footer branding — but the padding is driven by length, not a bloaty
      // per-company feed.
      final bytes = buildReport(
        companyName: 'Mupota Bus',
        currency: 'USD',
        from: DateTime(2026, 9, 22),
        to: DateTime(2026, 9, 22, 23, 59),
        sales: [mkSale()],
      );
      expect(lastFeedCommand(bytes), greaterThan(kTrailingFeedLines));
    });
  });
}

/// Returns the trailing feed count of the final ESC d n command (the one right
/// before the cut) in [bytes].
int lastFeedCommand(List<int> bytes) {
  var last = 0;
  for (var i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] == 0x1B && bytes[i + 1] == 0x64) {
      last = bytes[i + 2];
    }
  }
  return last;
}
