import 'esc/esc_pos.dart';
import 'format.dart';
import 'models.dart';

class TicketData {
  const TicketData({
    required this.companyName,
    required this.slogan,
    required this.ticketType,
    required this.receiptNo,
    required this.time,
    required this.busReg,
    required this.tripNo,
    required this.website,
    required this.customerCare,
    required this.routeCode,
    required this.routeName,
    required this.items,
    required this.total,
    required this.currency,
    required this.driver,
    required this.conductor1,
    required this.conductor2,
    this.companyAddress = '',
    this.companyEmail = '',
    this.receiptHeader = '',
    this.receiptFooter = '',
    this.driverPhone = '',
    this.conductorPhone = '',
    this.seatNumber = '',
    this.customerName = '',
    this.customerMobile = '',
    this.departureTime = '',
    this.paymentMethod = '',
    this.customFare = 0,
    this.tendered = 0,
    required this.note,
  });

  final String companyName;
  final String slogan;
  final String ticketType;
  final String receiptNo;
  final DateTime time;
  final String busReg;
  final String tripNo;
  final String website;
  final String customerCare;
  final String companyAddress;
  final String companyEmail;
  final String receiptHeader;
  final String receiptFooter;
  final String routeCode;
  final String routeName;
  final List<SaleItem> items;
  final int total;
  final String currency;
  final String driver;
  final String driverPhone;
  final String conductor1;
  final String conductor2;
  final String conductorPhone;
  final String seatNumber;
  final String customerName;
  final String customerMobile;

  /// Scheduled departure time (e.g. "06:30"). When non-empty it is printed on
  /// the thermal receipt right after the boarding-time line.
  final String departureTime;

  /// Payment method: 'cash' or 'ecocash' (legacy 'one_money'/'mobile' rows
  /// may still exist in history). Printed on the thermal receipt.
  final String paymentMethod;

  /// Total cents of manually-overridden fare lines (0 = standard pricing).
  /// Printed as a "MANUAL PRICE OVERRIDE" line on the thermal receipt.
  final int customFare;

  /// Cash actually tendered (cents). 0 means the exact fare was tendered.
  /// Drives the "CASH TENDERED" / "CHANGE" payment-breakdown rows.
  final int tendered;

  /// Effective tendered amount — never below the fare total.
  int get tenderedCents => tendered > 0 ? tendered : total;

  /// Change to return to the passenger (cents). Never printed as a negative
  /// value: exact payment (ecocash) yields 0.00.
  int get changeCents => tenderedCents - total;

  final String note;
}

/// Statement printed under the total fare on every BUS ticket — the exact
/// text shown in the live preview, wrapped to the full 58mm width in the
/// smaller font so it reads cleanly without clipping or dropping words.
const String kTicketValidityNote = 'Please keep your ticket safe. '
    'Ticket is valid for the stated journey and date only. Thank You!';

/// Dedicated safety statement printed on LUGGAGE tickets instead of the bus
/// statement — luggage tickets never reuse the passenger note. Short enough
/// to sit on exactly two 42-column Font B lines.
const String kLuggageNote = 'Please check luggage taken out of compartments '
    'at every destination stop. Thank You!';

class PreviewLine {
  const PreviewLine(
    this.text, {
    this.center = false,
    this.bold = false,
    this.big = false,
    this.small = false,
    this.qrData,
    this.barcodeData,
    this.feedAfter = 0,
  });

  final String text;
  final bool center;
  final bool bold;
  final bool big;
  final bool small;

  /// When set, emits an EPSON QR-Code instead of the text payload.
  final String? qrData;

  /// When set, emits a CODE128 barcode (`EscPos.barcode`) instead of the text
  /// payload. The line's text/center/bold fields are ignored for the barcode.
  final String? barcodeData;

  /// Extra blank feed lines advanced right AFTER this line (used for the tear
  /// buffer after the ticket barcode).
  final int feedAfter;
}

/// Splits a route string like "MUTARE - CHITUNGWIZA" into [origin, destination].
List<String> routeParts(String routeName) {
  final parts = routeName
      .split(RegExp(r'\s*[-–—:]\s*'))
      .map((p) => p.trim())
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.length > 1) {
    return [parts.first, parts.sublist(1).join(' - ')];
  }
  return [routeName];
}

List<String> wrap(String text, int width) {
  final words = text.split(RegExp(r'\s+'));
  final out = <String>[];
  var cur = '';
  for (final w in words) {
    if (cur.isEmpty) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur = '$cur $w';
    } else {
      out.add(cur);
      cur = w;
    }
  }
  if (cur.isNotEmpty) out.add(cur);
  // Pad (and clip, when the caller chose a narrower width than expected) to
  // the SAME width used for wrapping — Font B lines must never be re-clipped
  // to the 32-column Font A width, which would drop trailing words.
  return out.map((l) => EscPos.center(l, width: width)).toList();
}

/// Font B (down-emphasized `ESC M 1`) prints ~42 columns on 58mm stock versus
/// 32 for Font A. Cap used by [_fitCenteredLine] before falling back.
const int _fontBCols = 42;

/// Builds a single printed line that always fits the physical 58mm width.
/// Text of up to 32 columns uses Font A; longer text switches to the smaller
/// Font B (42 columns) so the whole line stays on ONE horizontal row and never
/// wraps, overflows or gets clipped at the ticket edge.
PreviewLine _fitCenteredLine(String text, {bool bold = false}) {
  if (text.length <= EscPos.paperCols) {
    return PreviewLine(EscPos.center(text), center: true, bold: bold);
  }
  final fit = clipText(text, _fontBCols);
  return PreviewLine(EscPos.center(fit, width: _fontBCols),
      center: true, small: true, bold: bold);
}

/// Render a money value exactly as the spec dictates — "<CUR> 12.34".
String _ticketMoney(int cents, String currency) {
  final cc = currency.trim().toUpperCase();
  return '${cc.isEmpty ? 'USD' : cc} ${(cents / 100).toStringAsFixed(2)}';
}

/// Shared company bracket: company name (fit-stepped exactly like the ticket),
/// company address, customer-care number (normalized +263) and tagline — the
/// identical layout and typography on tickets, trip manifests and end-of-day
/// reports so every printed document carries the same branding.
List<PreviewLine> companyHeaderLines({
  required String companyName,
  String companyAddress = '',
  String customerCare = '',
  String tagline = '',
}) {
  final lines = <PreviewLine>[];
  final header = up(companyName);
  if (header.isNotEmpty) {
    if (header.length <= EscPos.paperCols ~/ 2) {
      lines.add(PreviewLine(header, center: true, bold: true, big: true));
    } else if (header.length <= _fontBCols ~/ 2) {
      lines.add(PreviewLine(header,
          center: true, bold: true, small: true, big: true));
    } else {
      lines.add(_fitCenteredLine(header, bold: true));
    }
  }
  final address = up(companyAddress).trim();
  if (address.isNotEmpty) {
    for (final l in wrap(address, _fontBCols)) {
      lines.add(PreviewLine(l, center: true, small: true));
    }
  }
  final care = formatZimPhone(customerCare);
  if (care != 'N/A') {
    lines.add(PreviewLine(
        EscPos.center('CUSTOMER CARE $care', width: _fontBCols),
        center: true,
        small: true));
  }
  if (tagline.trim().isNotEmpty) {
    lines
        .add(PreviewLine(EscPos.center(up(tagline)), center: true, bold: true));
  }
  return lines;
}

/// Shared crew block printed directly under the company header on trip
/// manifests and end-of-day reports — DRIVER / CONDUCTOR names with the
/// normalized +263 mobile beneath each.
List<PreviewLine> crewLines({
  required String driverName,
  required String driverPhone,
  required String conductorName,
  required String conductorPhone,
}) {
  final lines = <PreviewLine>[];
  if (driverName.trim().isNotEmpty) {
    lines.add(PreviewLine(EscPos.center('DRIVER: ${up(driverName)}'),
        center: true, small: true));
    if (driverPhone.trim().isNotEmpty) {
      lines.add(PreviewLine(EscPos.center(formatZimPhone(driverPhone)),
          center: true, small: true));
    }
  }
  if (conductorName.trim().isNotEmpty) {
    lines.add(PreviewLine(EscPos.center('CONDUCTOR: ${up(conductorName)}'),
        center: true, small: true));
    if (conductorPhone.trim().isNotEmpty) {
      lines.add(PreviewLine(EscPos.center(formatZimPhone(conductorPhone)),
          center: true, small: true));
    }
  }
  return lines;
}

/// First non-empty value picked from [sales] (shift crew fallback when no
/// driver shift was opened for a report day).
String _firstNonEmpty(List<Sale> sales, String Function(Sale) pick) {
  for (final s in sales) {
    final v = pick(s).trim();
    if (v.isNotEmpty) return v;
  }
  return '';
}

/// CODE128 payload for the ticket edge. Passenger tickets carry
/// "<receiptNo>|<tripNo>|<totalCent>" and luggage tickets "LUG|<receiptNo>|
/// <totalCent>" — deterministic so a scan can look the sale up by receipt.
String barcodeDataFor(TicketData d) {
  final isLuggage = up(d.ticketType) == 'LUGGAGE TICKET';
  return isLuggage
      ? 'LUG|${d.receiptNo}|${d.total}'
      : '${d.receiptNo}|${d.tripNo}|${d.total}';
}

/// Renders the canonical printable ticket layout (1:1 with the mobile and
/// admin previews) with strict 32-column alignment. Company name spans the
/// full width, centered — double-height bold while it fits, then only a
/// slightly smaller double-height Font B step for names up to ~21 columns,
/// and single-size fallbacks beyond that so the whole name still spans the
/// line without wrapping or clipping. The company address and customer-care
/// number print directly beneath the name (address first, then customer care,
/// both centered in the smaller font). The tagline prints beneath them, the
/// metadata row pairs Bus Registration (left) with Ticket Number (right) at
/// the same bold weight. The payment breakdown (Payment Method / Cash
/// Tendered / Change) is computed live from [TicketData.tendered] and prints
/// DIRECTLY under the total fare — matching the app and admin previews. The
/// ticket's own statement prints after it: the bus statement on bus tickets,
/// the dedicated luggage statement on luggage tickets, each wrapped to the full
/// width in the smaller font with no trailing words dropped. Under the
/// statement a divider feeds one blank line before the footer, which prints
/// ONLY the platform disclaimer + website. The website is the last thing on
/// the ticket; the job then ends with the single trailing feed before the cut.
/// No hardcoded address / customer-care / sample text is ever printed.
List<PreviewLine> buildTicketLines(TicketData d) {
  final lines = <PreviewLine>[];
  final route = routeParts(up(d.routeName));

  // Company header — the full width of the 58mm line, centered. Double-size
  // bold sits on the paper for names that fit the 16 double-width columns;
  // names up to ~21 columns step only as far as Font B double-height (just
  // slightly smaller than the original scale), and anything longer falls back
  // to single-size. At double size the text is intentionally unpadded — the
  // ESC a centering algorithm positions it, manual padding would double over
  // the paper edge. The address, customer-care number and tagline print
  // directly beneath the name, exactly as the preview shows it.
  lines.addAll(companyHeaderLines(
    companyName: d.companyName,
    companyAddress: d.companyAddress,
    customerCare: d.customerCare,
    tagline: d.slogan,
  ));
  // Ticket type (BUS TICKET / LUGGAGE TICKET).
  if (d.ticketType.isNotEmpty) {
    lines.add(PreviewLine(EscPos.center(up(d.ticketType)), center: true));
  }
  // Metadata row — bus registration left, ticket number right, SAME bold
  // typography. When no bus registration is known, the ticket number stays in
  // the primary slot so the first identity on the ticket is never blank.
  final hasBus = d.busReg.trim().isNotEmpty;
  if (hasBus) {
    lines.add(PreviewLine(
        formatRow('BUS: ${up(d.busReg)}', 'TKT: #${up(d.receiptNo)}'),
        bold: true));
  } else {
    lines.add(PreviewLine(EscPos.center('TICKET NO  ${up(d.receiptNo)}'),
        center: true, bold: true));
  }
  // Route line — the route code is printed immediately before the trip text on
  // the same horizontal line (no "Route Code" label):
  //   RT01 HARARE -> BULAWAYO
  // Font size shrinks to font B only when the line would exceed 32 columns.
  final tripLabel =
      route.length >= 2 ? '${route[0]} -> ${route[1]}' : up(d.routeName);
  final routeText = <String>[
    if (d.routeCode.trim().isNotEmpty) up(d.routeCode),
    if (tripLabel.isNotEmpty) tripLabel,
  ].join(' ');
  if (routeText.trim().isNotEmpty) {
    lines.add(_fitCenteredLine(routeText, bold: true));
  }
  // Date / time of issue — one compact line (scheduled departure removed).
  lines.add(PreviewLine(
      EscPos.center(
          'DATE ${fmtDate(d.time)}  ${two(d.time.hour)}:${two(d.time.minute)}'),
      center: true));
  // Seat — printed ONLY when a seat number was actually entered.
  final seat = d.seatNumber.trim();
  if (seat.isNotEmpty) {
    lines.add(
        PreviewLine(formatRow('SEAT:', clipText(up(seat), 26)), bold: true));
  }
  // Divider — exactly 32 dashes.
  lines.add(PreviewLine(EscPos.divider(), center: true));
  // Crew — compact rows, right-aligned to column 32.
  if (d.driver.isNotEmpty) {
    lines.add(PreviewLine(formatRow('Driver:', clipText(up(d.driver), 24))));
  }
  final conductor = d.conductor1.isNotEmpty ? d.conductor1 : d.conductor2;
  if (conductor.isNotEmpty) {
    final phone = d.conductorPhone.trim();
    final combined = phone.isEmpty
        ? up(conductor)
        : '${up(conductor)} (${formatZimPhone(phone)})';
    if (combined.length <= 21) {
      lines.add(PreviewLine(formatRow('Conductor:', combined)));
    } else {
      // The phone is the actionable detail on a 32-column ticket — when the
      // name + phone can't share one row, print them on separate rows so the
      // normalized number is never truncated.
      lines.add(
          PreviewLine(formatRow('Conductor:', clipText(up(conductor), 21))));
      if (phone.isNotEmpty) {
        lines.add(PreviewLine(formatRow('Mobile:', formatZimPhone(phone))));
      }
    }
  }
  // Passenger — label/value rows across the full 32 columns.
  final pax = d.customerName.trim().isEmpty ? '-' : up(d.customerName.trim());
  // The label is "Passenger:", not "Passenger Name:", and that is what buys the
  // name room: formatRow lays the pair across 32 columns with at least one
  // separating space, so the 15-character label left only 16 for the value and
  // forced the aggressive 15-character clip. The 10-character label leaves 21,
  // so long names now print in full instead of being truncated mid-word.
  // 'Passenger:' (10) + 1 space + 21 = 32 exactly.
  lines.add(
      PreviewLine(formatRow('Passenger:', clipText(pax, 21)), bold: true));
  lines.add(PreviewLine(
      formatRow('Passenger Mobile:', formatZimPhone(d.customerMobile))));
  // Divider.
  lines.add(PreviewLine(EscPos.divider(), center: true));
  // Items / allowed luggage — printed for both ticket types, one row per item
  // with the quantity (pcs) beside the line total.
  if (d.items.isNotEmpty) {
    for (final i in d.items) {
      lines.add(PreviewLine(formatRow('ITEM:', clipText(up(i.name), 27))));
      lines.add(PreviewLine(
          formatRow('QTY: ${i.qty} pcs', fmtMoney(i.total, d.currency))));
    }
  }
  // Total fare — prominent centered line.
  lines.add(PreviewLine(
      EscPos.center('TOTAL FARE  ${_ticketMoney(d.total, d.currency)}'),
      center: true,
      bold: true));
  // Payment breakdown — computed from the tendered amount / change. Prints
  // DIRECTLY beneath the total, exactly as the app and admin previews show it.
  lines.add(PreviewLine(
      formatRow('PAYMENT METHOD:', paymentMethodLabel(d.paymentMethod))));
  lines.add(PreviewLine(
      formatRow('CASH TENDERED:', _ticketMoney(d.tenderedCents, d.currency))));
  lines.add(PreviewLine(
      formatRow('CHANGE:', _ticketMoney(d.changeCents, d.currency))));
  // Underline the change figure directly beneath the payment info, then the
  // statement, then one blank line before the footer.
  lines.add(PreviewLine(EscPos.divider(), center: true));
  final noteLines = wrap(d.note.trim(), _fontBCols);
  for (final note in noteLines) {
    lines.add(PreviewLine(note, center: true, small: true));
  }
  // Footer — exactly the app preview: "Powered by" / brand (bold) / website.
  lines.add(PreviewLine(EscPos.center('Powered by'), center: true));
  lines.add(PreviewLine(EscPos.center(up(kPlatformProvider)),
      center: true, bold: true));
final website = d.website.trim().isEmpty ? kPlatformUrl : d.website.trim();
  lines.add(PreviewLine(EscPos.center(website), center: true));
  // The website is the last thing on the ticket. The CODE128 that used to sit
  // below it (and its 3-line tear-off feed) has been removed at the operator's
  // request, so the job now runs website -> the single trailing feed -> cut.

  return lines;
}

List<PreviewLine> buildReportLines({
  required String companyName,
  required String currency,
  required DateTime from,
  required DateTime to,
  required List<Sale> sales,
  String tagline = '',
  String companyAddress = '',
  String customerCare = '',
  DriverShift? shift,
}) {
  final lines = <PreviewLine>[];
  // Company bracket identical to the ticket, then crew for the report day.
  lines.addAll(companyHeaderLines(
    companyName: companyName,
    companyAddress: companyAddress,
    customerCare: customerCare,
    tagline: tagline,
  ));
  // Crew covering the report day: the shift opened that day wins, falling
  // back to the pair recorded on the day's sales when no shift exists.
  final driver = shift != null && shift.driverName.trim().isNotEmpty
      ? shift.driverName
      : _firstNonEmpty(sales, (s) => s.driver);
  final driverPhone = shift != null && shift.driverPhone.trim().isNotEmpty
      ? shift.driverPhone
      : _firstNonEmpty(sales, (s) => s.driverPhone);
  final conductor = shift != null && shift.conductorName.trim().isNotEmpty
      ? shift.conductorName
      : _firstNonEmpty(sales, (s) => s.conductor1);
  final conductorPhone = shift != null && shift.conductorPhone.trim().isNotEmpty
      ? shift.conductorPhone
      : _firstNonEmpty(sales, (s) => s.conductorPhone);
  lines.addAll(crewLines(
    driverName: driver,
    driverPhone: driverPhone,
    conductorName: conductor,
    conductorPhone: conductorPhone,
  ));
  lines.add(PreviewLine(EscPos.center('END OF DAY REPORT'),
      center: true, bold: true));
  lines.add(PreviewLine(
      EscPos.center('${from.year}-${two(from.month)}-${two(from.day)}'),
      center: true));
  lines.add(PreviewLine(EscPos.divider()));

  if (sales.isEmpty) {
    lines.add(PreviewLine(EscPos.center('No sales'), center: true));
  }
  for (final s in sales) {
    final time = s.createdAt != null
        ? '${two(s.createdAt!.hour)}:${two(s.createdAt!.minute)}'
        : '';
    final summary = s.items
        .map((i) => i.qty > 1 ? '${i.name} x${i.qty}' : i.name)
        .join(', ');
    final detail = '${s.receiptNo}  $time  $summary  ${fmtMoney(s.total, '')}';
    lines.add(PreviewLine(EscPos.center(detail), center: true));
  }
  lines.add(PreviewLine(EscPos.divider()));
  final total = sales.fold(0, (sum, s) => sum + s.total);
  final totalLine =
      'Tickets: ${sales.length}   TOTAL  ${fmtMoney(total, currency)}';
  lines.add(PreviewLine(EscPos.center(totalLine), center: true, bold: true));
  lines.add(PreviewLine(EscPos.divider()));
  lines.add(PreviewLine(EscPos.center('Powered By $kPlatformProvider'),
      center: true, bold: true));
  lines.add(PreviewLine(EscPos.center(kPlatformUrl), center: true));

  return lines;
}

/// Short payment tag for the compact manifest line, e.g. CASH / ECO.
String _manifestPayShort(String method) {
  switch (method.trim().toLowerCase()) {
    case 'cash':
      return 'CASH';
    case 'ecocash':
      return 'ECO';
    case 'mobile':
    case 'momo':
      return 'MOMO';
    default:
      return 'CASH';
  }
}

/// Fixed trailing blank feed before the cut — strictly one line, after all
/// printing has finished. The old configurable 8-line per-company default was
/// wasteful on the roll, and the 12 cm min-length padding that briefly replaced
/// it has now been dropped as well: every job simply ends with this single
/// feed, then the cut.
const int kTrailingFeedLines = 1;

List<int> _toBytes(List<PreviewLine> lines) {
  final b = <int>[];
  b.addAll(EscPos.init());
  for (final l in lines) {
    if (l.qrData != null) {
      b.addAll(EscPos.alignCenter());
      b.addAll(EscPos.qr(l.qrData!));
      b.addAll(EscPos.alignLeft());
      continue;
    }
    if (l.barcodeData != null) {
      b.addAll(EscPos.alignCenter());
      b.addAll(EscPos.barcode(l.barcodeData!));
      b.addAll(EscPos.alignLeft());
      if (l.feedAfter > 0) b.addAll(EscPos.feed(l.feedAfter));
      continue;
    }
    b.addAll(l.center ? EscPos.alignCenter() : EscPos.alignLeft());
    b.addAll(EscPos.bold(l.bold));
    if (l.small) b.addAll(EscPos.fontB(true));
    if (l.big) b.addAll(EscPos.doubleSize(true, true));
    b.addAll(EscPos.text('${l.text}\n'));
    if (l.big) b.addAll(EscPos.doubleSize(false, false));
    if (l.small) b.addAll(EscPos.fontB(false));
    b.addAll(EscPos.bold(false));
    if (l.feedAfter > 0) b.addAll(EscPos.feed(l.feedAfter));
  }
  b.addAll(EscPos.feed(kTrailingFeedLines));
  b.addAll(EscPos.cut());
  return b;
}

List<int> buildTicket(TicketData d) => _toBytes(buildTicketLines(d));

List<int> buildReport({
  required String companyName,
  required String currency,
  required DateTime from,
  required DateTime to,
  required List<Sale> sales,
  String tagline = '',
  String companyAddress = '',
  String customerCare = '',
  DriverShift? shift,
}) =>
    _toBytes(buildReportLines(
        companyName: companyName,
        currency: currency,
        from: from,
        to: to,
        sales: sales,
        tagline: tagline,
        companyAddress: companyAddress,
        customerCare: customerCare,
        shift: shift));

List<PreviewLine> buildTripManifestLines({
  required String companyName,
  required String currency,
  required Trip trip,
  required List<Sale> tickets,
  String tagline = '',
  String companyAddress = '',
  String customerCare = '',
  DriverShift? shift,
}) {
  final lines = <PreviewLine>[];
  // Company bracket identical to the ticket — the name is fit-stepped to the
  // paper width instead of being forced double-size, so long company names
  // print without clipping, and the customer-care +263 line sits with the
  // address directly under the name.
  lines.addAll(companyHeaderLines(
    companyName: companyName,
    companyAddress: companyAddress,
    customerCare: customerCare,
    tagline: tagline,
  ));
  // Crew sits directly beneath the company header on the manifest.
  final conductor =
      trip.conductor.isNotEmpty ? trip.conductor : (shift?.conductorName ?? '');
  final conductorPhone = trip.conductorPhone.isNotEmpty
      ? trip.conductorPhone
      : (shift?.conductorPhone ?? '');
  lines.addAll(crewLines(
    driverName: trip.driver,
    driverPhone: trip.driverPhone,
    conductorName: conductor,
    conductorPhone: conductorPhone,
  ));
  lines.add(
      PreviewLine(EscPos.center('TRIP MANIFEST'), center: true, bold: true));
  lines.add(
      PreviewLine(EscPos.center(up(trip.tripNo)), center: true, bold: true));
  final route = trip.routeName.isNotEmpty
      ? up(trip.routeName)
      : [up(trip.routeFrom), up(trip.routeTo)]
          .where((s) => s.isNotEmpty)
          .join(' - ');
  if (route.isNotEmpty) {
    lines.add(PreviewLine(EscPos.center(route), center: true));
  }
  if (trip.busReg.isNotEmpty) {
    lines.add(
        PreviewLine(EscPos.center('BUS: ${up(trip.busReg)}'), center: true));
  }
  if (trip.departureTime.isNotEmpty) {
    lines.add(
        PreviewLine(EscPos.center('DEP: ${trip.departureTime}'), center: true));
  }

  final ticketCount = tickets.where((s) => s.ticketType == 'busFare').length;
  final grand = tickets.fold(0, (a, s) => a + s.total);
  lines.add(PreviewLine(EscPos.left('TICKETS SOLD: $ticketCount'), bold: true));
  lines.add(PreviewLine(
      EscPos.left('TOTAL REVENUE: ${fmtMoney(grand, currency)}'),
      bold: true));
  lines.add(PreviewLine(EscPos.divider()));

  final sorted = [...tickets]..sort((a, b) {
      final sa = int.tryParse(a.seatNumber) ?? 0;
      final sb = int.tryParse(b.seatNumber) ?? 0;
      return sa.compareTo(sb);
    });
  if (sorted.isEmpty) {
    lines.add(PreviewLine(EscPos.center('No tickets sold'), center: true));
  }
  for (final s in sorted) {
    final seat = s.seatNumber.isEmpty ? '--' : s.seatNumber;
    final name = s.customerName.isEmpty ? '-' : up(s.customerName);
    final fare = fmtMoney(s.total, currency);
    final payment = _manifestPayShort(s.paymentMethod);
    final phone = s.customerMobile.isEmpty ? '-' : s.customerMobile;
    lines.add(PreviewLine(
        EscPos.left('S${seat.padLeft(2, '0')} $name', width: 22) +
            EscPos.right(fare, width: 10)));
    lines.add(PreviewLine(
        EscPos.left('#${s.receiptNo} $payment', width: 18) +
            EscPos.right(phone, width: 14),
        small: true));
    if (s.ticketType == 'luggage') {
      lines.add(PreviewLine(EscPos.left('* LUGGAGE TICKET *'), small: true));
    }
  }
  lines.add(PreviewLine(EscPos.divider()));

  final cashTotal = tickets
      .where((s) => s.paymentMethod == 'cash')
      .fold(0, (a, s) => a + s.total);
  final mobileTotal = tickets
      .where((s) => s.paymentMethod != 'cash')
      .fold(0, (a, s) => a + s.total);
  lines.add(PreviewLine(
      EscPos.left('PASSENGERS $ticketCount/${trip.totalSeats}'),
      bold: true));
  lines.add(PreviewLine(EscPos.left('Cash: ${fmtMoney(cashTotal, currency)}')));
  lines.add(
      PreviewLine(EscPos.left('Mobile: ${fmtMoney(mobileTotal, currency)}')));
  lines.add(PreviewLine(
      EscPos.left('GRAND TOTAL: ${fmtMoney(grand, currency)}'),
      bold: true));
  lines.add(PreviewLine(EscPos.divider()));

  if (shift != null) {
    if (shift.startedAt != null) {
      lines.add(PreviewLine(
          EscPos.left('SHIFT START: ${fmtDateTime(shift.startedAt!)}')));
    }
    if (shift.closedAt != null) {
      lines.add(PreviewLine(
          EscPos.left('SHIFT END: ${fmtDateTime(shift.closedAt!)}')));
    } else {
      lines.add(PreviewLine(EscPos.left('SHIFT END: OPEN')));
    }
  }
  lines
      .add(PreviewLine(EscPos.left('PRINTED: ${fmtDateTime(DateTime.now())}')));
  lines.add(PreviewLine(EscPos.divider()));
  lines.add(PreviewLine(EscPos.center('CONDUCTOR SIGNATURE'),
      center: true, bold: true));
  lines.add(
      PreviewLine(EscPos.center('________________________'), center: true));
  lines.add(PreviewLine(EscPos.divider()));
  lines.add(PreviewLine(EscPos.center('Powered By $kPlatformProvider'),
      center: true, bold: true));
  lines.add(PreviewLine(EscPos.center(kPlatformUrl), center: true));

  return lines;
}

List<int> buildTripManifest({
  required String companyName,
  required String currency,
  required Trip trip,
  required List<Sale> tickets,
  String tagline = '',
  String companyAddress = '',
  String customerCare = '',
  DriverShift? shift,
}) =>
    _toBytes(buildTripManifestLines(
        companyName: companyName,
        currency: currency,
        trip: trip,
        tickets: tickets,
        tagline: tagline,
        companyAddress: companyAddress,
        customerCare: customerCare,
        shift: shift));
