import 'package:flutter_test/flutter_test.dart';

import 'package:bus_ticket_app/src/receipt.dart';

void main() {
  test('v19 buildTicket emits +263 care and a clean feed(1)', () {
    final d = TicketData(
      companyName: 'MUPOTA BUS SERVICE',
      slogan: 'Your Satisfaction Is Our Honour !',
      ticketType: 'BUS TICKET',
      receiptNo: 'AGJ-0001',
      time: DateTime(2026, 9, 24, 8, 30),
      busReg: 'AFR 1234',
      tripNo: '12345',
      website: 'www.preyone.com',
      customerCare: '+363772717003',
      companyAddress: '5080 Tameside Close, Nyakamete Ind Site',
      companyEmail: '',
      receiptHeader: '',
      receiptFooter: '',
      routeCode: 'RT01',
      routeName: 'NYANGA - CHITUNGWIZA',
      items: [],
      total: 1000,
      currency: 'USD',
      driver: 'JOHN',
      driverPhone: '+263771234567',
      conductor1: 'PETER',
      conductor2: '',
      conductorPhone: '+263772717003',
      seatNumber: '12',
      customerName: 'WALK-IN PASSENGER',
      customerMobile: '+363773717003',
      departureTime: '14:00',
      paymentMethod: 'cash',
      customFare: 0,
      note: 'Keep this ticket as proof of payment',
      tendered: 1000,
    );

    final bytes = buildTicket(d);
    final ascii = String.fromCharCodes(bytes);

    // No build/version string may ever reach the paper any more.
    expect(ascii, isNot(contains('BUILD')));
    expect(ascii, isNot(contains('1.0.0')));

    final careIdx = ascii.indexOf('CUSTOMER CARE');
    final slice =
        ascii.substring(careIdx, careIdx + 'CUSTOMER CARE '.length + 16);
    expect(slice, contains('+263'));

    // The old cached +363 must never reach the paper.
    expect(ascii, isNot(contains('+363')));

    // Footer branding present.
    expect(ascii, contains('PREYONE TECHNOLOGIES'));
    expect(ascii, contains('www.preyone.com'));

    // The cut must only fire after the strict feed(1) trailing roll-out. The
    // old 8-line default, the 12cm padding and the barcode's 3-line tear-off
    // feed are all gone, so feed(1) is now the only feed command in the job.
    final lastFeed = _lastFeedCmd(bytes);
    expect(_allFeedCmds(bytes), [1],
        reason: 'exactly one feed command, of one line, precedes the cut');
    expect(lastFeed, greaterThanOrEqualTo(1));
    expect(lastFeed, lessThan(8),
        reason: 'the old 8-line per-company default must not come back');
  });

  test('short tickets also emit only the single feed before the cut', () {
    final d = TicketData(
      companyName: 'MUPOTA BUS SERVICE',
      slogan: 'Your Satisfaction Is Our Honour !',
      ticketType: 'BUS TICKET',
      receiptNo: 'AGJ-0001',
      time: DateTime(2026, 9, 24, 8, 30),
      busReg: 'AFR 1234',
      tripNo: '12345',
      website: 'www.preyone.com',
      customerCare: '+363772717003',
      companyAddress: '5080 Tameside Close, Nyakamete Ind Site',
      companyEmail: '',
      receiptHeader: '',
      receiptFooter: '',
      routeCode: 'RT01',
      routeName: 'NYANGA - CHITUNGWIZA',
      items: [],
      total: 1000,
      currency: 'USD',
      driver: 'JOHN',
      driverPhone: '+263771234567',
      conductor1: 'PETER',
      conductor2: '',
      conductorPhone: '+263772717003',
      seatNumber: '12',
      customerName: 'WALK-IN PASSENGER',
      customerMobile: '+363773717003',
      departureTime: '14:00',
      paymentMethod: 'cash',
      customFare: 0,
      note: '',
      tendered: 1000,
    );

    // Minimal environment (company header + ticket type + metadata + total +
    // footer) is short, and still emits only feed(1) then the cut — the 12cm
    // padding and the note's own feed are both removed.
    final bytes = buildTicket(d);
    expect(_allFeedCmds(bytes), [1]);
    expect(_lastFeedCmd(bytes), kTrailingFeedLines);
  });
}

int _lastFeedCmd(List<int> bytes) {
  var last = 0;
  for (var i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] == 0x1B && bytes[i + 1] == 0x64) {
      last = bytes[i + 2];
    }
  }
  return last;
}

/// Every ESC d n in the job, in emission order.
List<int> _allFeedCmds(List<int> bytes) {
  final out = <int>[];
  for (var i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] == 0x1B && bytes[i + 1] == 0x64) out.add(bytes[i + 2]);
  }
  return out;
}
