import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../receipt.dart';
import '../security/secure_keystore.dart';
import '../services/pdf_service.dart';
import '../services/printer_service.dart';
import '../services/transit_api.dart';

/// Luggage upsell ticket issued right after a bus-fare sale.
///
/// Opens pre-filled from the passenger's bus-fare ticket (name, phone,
/// destination, driver, conductor, departure time) and links back to it via
/// [Sale.luggageLinkedTicketId] so the two tickets stay grouped on the server
/// and in reports.
class LuggageTicketScreen extends StatefulWidget {
  const LuggageTicketScreen({
    super.key,
    required this.sourceSale,
    this.passengerNameHint = '',
    this.passengerPhoneHint = '',
  });

  /// The completed bus-fare sale the passenger just paid for.
  final Sale sourceSale;

  /// The passenger name as the conductor typed it on the bus-fare ticket,
  /// captured before the sale was written.
  ///
  /// The saved [sourceSale] is the durable copy, but a device running offline
  /// (or one whose sync has not yet pushed the sale) has no server copy to
  /// re-read the name from, and a walk-in bus fare carries a placeholder rather
  /// than a real name. This hint lets the operator's real, already-typed name
  /// carry straight over instead of forcing a retype. Empty when the passenger
  /// answered "No" to the luggage prompt, or when the name was left blank /
  /// declared as a walk-in, in which case the field falls back to its previous
  /// behaviour.
  final String passengerNameHint;

  /// The passenger phone number as typed on the bus-fare ticket, cached on the
  /// same terms as [passengerNameHint] so the contact number is never retyped.
  /// Empty when the operator answered "No", in which case the phone falls back
  /// to whatever the saved sale carries.
  final String passengerPhoneHint;

  @override
  State<LuggageTicketScreen> createState() => _LuggageTicketScreenState();
}

class _LuggageTicketScreenState extends State<LuggageTicketScreen> {
  final _descCtrl = TextEditingController();
  final _priceCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();

  String _currency = 'USD';
  String _companyName = '';
  String _slogan = '';
  String _website = '';
  String _customerCare = '';
  String _companyAddress = '';
  String _companyEmail = '';
  String _receiptHeader = '';
  String _receiptFooter = '';
  bool _saving = false;

  /// The passenger's bus-fare sale, enriched from the server copy (the trip is
  /// the canonical vehicle/crew source) so the luggage ticket inherits bus,
  /// driver, conductor and departure even when the original sale was made with
  /// blanks. Falls back to [LuggageTicketScreen.sourceSale] when offline.
  Sale? _source;

  String get _destination {
    final parts = widget.sourceSale.routeName
        .split(' - ')
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty)
        .toList();
    if (parts.length > 1) return parts[1];
    return widget.sourceSale.routeName;
  }

  Sale get _src => _source ?? widget.sourceSale;

  /// True when a passenger name is just a walk-in placeholder (not a real,
  /// recorded passenger) so the luggage form asks the operator for the actual
  /// name instead of silently reusing the placeholder.
  static bool _isPlaceholderName(String name) {
    final n = name.trim().toUpperCase();
    return n.isEmpty ||
        n == 'WALK-IN' ||
        n == 'WALK IN' ||
        n == 'WALK-IN PASSENGER' ||
        n == 'WALK IN PASSENGER';
  }

  @override
  void initState() {
    super.initState();
    // Precedence for the passenger name, best source first:
    //   1. The hint the conductor typed on the bus-fare ticket. Survives
    //      offline, and is a real name even when the sale stored a walk-in
    //      placeholder.
    //   2. The name already on the bus-fare sale, unless that is a walk-in
    //      placeholder (which must not be copied onto a luggage ticket).
    //   3. Blank - the operator types the real name.
    final hint = widget.passengerNameHint.trim();
    if (hint.isNotEmpty && !_isPlaceholderName(hint)) {
      _nameCtrl.text = hint;
    } else {
      _nameCtrl.text = _isPlaceholderName(widget.sourceSale.customerName)
          ? ''
          : widget.sourceSale.customerName;
    }
    // Phone has no placeholder concept, so the hint simply wins when present.
    final phoneHint = widget.passengerPhoneHint.trim();
    _phoneCtrl.text =
        phoneHint.isNotEmpty ? phoneHint : widget.sourceSale.customerMobile;
    _load();
  }

  @override
  void dispose() {
    _descCtrl.dispose();
    _priceCtrl.dispose();
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final settings = await AppDb.getSettings(const [
      'currency',
      'company_name',
      'company_slogan',
      'website',
      'customer_care',
      'company_address',
      'company_email',
    ]);
    final profile = await AppDb.getCompanyProfile();
    if (!mounted) return;
    setState(() {
      _currency = settings['currency'] ?? 'USD';
      _companyName = settings['company_name'] ?? '';
      _slogan = settings['company_slogan'] ?? '';
      _website = settings['website'] ?? '';
      _customerCare = zimPhoneOrEmpty(settings['customer_care'] ?? '');
      _companyAddress = settings['company_address'] ?? '';
      _companyEmail = settings['company_email'] ?? '';
      if (profile != null) {
        if (profile.name.isNotEmpty) _companyName = profile.name;
        if (profile.slogan.isNotEmpty) _slogan = profile.slogan;
        if (profile.website.isNotEmpty) _website = profile.website;
        if (profile.customerCare.isNotEmpty) {
          _customerCare = zimPhoneOrEmpty(profile.customerCare);
        }
        if (profile.companyAddress.isNotEmpty) {
          _companyAddress = profile.companyAddress;
        }
        if (profile.companyEmail.isNotEmpty) {
          _companyEmail = profile.companyEmail;
        }
        if (profile.currency.isNotEmpty) _currency = profile.currency;
        _receiptHeader = profile.receiptHeader;
        _receiptFooter = profile.receiptFooter;
      }
    });
    final hydratedResult = await _hydrateSourceOrWarning();
    if (!mounted) return;
    final hydrated = hydratedResult.sale;
    _source = hydrated;
    if (hydratedResult.warning != null) {
      _snack(hydratedResult.warning!);
    }
    if (hydrated != null && hydrated.txId.isNotEmpty) {
      if (_nameCtrl.text.trim().isEmpty &&
          !_isPlaceholderName(hydrated.customerName)) {
        _nameCtrl.text = hydrated.customerName;
      }
      if (_phoneCtrl.text.trim().isEmpty &&
          hydrated.customerMobile.isNotEmpty) {
        _phoneCtrl.text = hydrated.customerMobile;
      }
    }
  }

  /// Internal result-bearing form of the source enrichment. Returns the sale
  /// (enriched when possible) plus a human-readable warning when the server
  /// copy could not be applied — so the caller can surface it instead of the
  /// failure being silently swallowed.
  Future<({Sale? sale, String? warning})> _hydrateSourceOrWarning() async {
    final s = widget.sourceSale;
    if (s.txId.isEmpty || s.id == null) return (sale: s, warning: null);

    // Only the network read is guarded. A local database failure was previously
    // caught by the same blanket catch and misreported as "server unreachable",
    // which sent operators looking for a network fault that never existed.
    Map<String, dynamic> t;
    try {
      t = await TransitApi.fetchTicket(s.txId);
    } catch (e) {
      debugPrint('Luggage source hydration skipped (offline?): $e');
      return (sale: s, warning: _offlineWarning(s));
    }

    if (t.isEmpty) {
      return (sale: s, warning: _offlineWarning(s));
    }

    try {
      await AppDb.hydrateSale(
        s.id!,
        customerName:
            (t['customerName'] ?? t['customer_name'] ?? '').toString(),
        customerMobile: (t['customerMobile'] ??
                t['customerPhone'] ??
                t['customer_mobile'] ??
                t['phone'] ??
                '')
            .toString(),
        busReg: (t['busReg'] ?? t['bus_reg'] ?? '').toString(),
        driver: (t['driverName'] ?? t['driver'] ?? '').toString(),
        driverPhone: (t['driverPhone'] ?? t['driver_phone'] ?? '').toString(),
        conductor1: (t['conductor1'] ?? t['conductor_name'] ?? '').toString(),
        conductor2: (t['conductor2'] ?? '').toString(),
        conductorPhone:
            (t['conductorPhone'] ?? t['conductor_phone'] ?? '').toString(),
        departureTime: formatDepartureTime(
            (t['departureTime'] ?? t['departure_time'] ?? '').toString()),
        paymentMethod:
            (t['paymentMethod'] ?? t['payment_method'] ?? '').toString(),
      );
      return (sale: await AppDb.getSaleById(s.id!) ?? s, warning: null);
    } catch (e) {
      // Persisting the enriched copy is a best-effort enhancement; the local
      // sale still carries everything the ticket needs to be issued, so this is
      // logged rather than surfaced as a warning.
      debugPrint('Luggage source enrichment not persisted: $e');
      return (sale: s, warning: null);
    }
  }

  /// Offline is a normal operating mode for this app, so it is only worth
  /// telling the operator about when the local copy is actually missing the
  /// trip details this screen exists to inherit. Silently using local data is
  /// correct behaviour, not an error.
  String? _offlineWarning(Sale s) {
    final hasTripContext = s.tripNo.trim().isNotEmpty &&
        (s.busReg.trim().isNotEmpty || s.driver.trim().isNotEmpty);
    return hasTripContext
        ? null
        : 'Offline — trip details on this luggage ticket may be incomplete.';
  }

  void _snack(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _save() async {
    final desc = _descCtrl.text.trim();
    final price = parseMoneyToCents(_priceCtrl.text);
    if (desc.isEmpty || price == null) {
      _snack('Enter a luggage description and price');
      return;
    }
    final allowed = await SecureKeystore.instance.canSellOffline();
    if (!allowed) {
      _snack('Selling is paused: sync this device to continue.');
      return;
    }

    if (_saving) return;
    setState(() => _saving = true);
    try {
      final src = _src;
      final sale = Sale(
        receiptNo: await AppDb.nextReceiptNo(busReg: src.busReg),
        ticketType: 'luggage',
        items: [
          SaleItem(name: desc, price: price, qty: 1, total: price),
        ],
        total: price,
        cash: price,
        change: 0,
        routeCode: src.routeCode,
        routeName: src.routeName,
        busReg: src.busReg,
        driver: src.driver,
        driverPhone: src.driverPhone,
        conductor1: src.conductor1,
        conductor2: src.conductor2,
        conductorPhone: src.conductorPhone,
        seatNumber: src.seatNumber,
        tripNo: src.tripNo,
        tripId: src.tripId,
        shiftId: src.shiftId,
        driverId: src.driverId,
        conductorId: src.conductorId,
        paymentMethod: 'cash',
        customerName: _nameCtrl.text.trim().toUpperCase(),
        customerMobile: zimPhoneOrEmpty(_phoneCtrl.text),
        departureTime: src.departureTime,
        luggageLinkedTicketId: widget.sourceSale.txId,
        createdAt: DateTime.now(),
      );

      final saleId = await AppDb.insertSale(sale);
      _writeBackPassenger(sale);
      String printMsg;
      try {
        printMsg = await _printReceipt(sale);
        if (printMsg == 'Printed successfully') {
          await AppDb.setPrinted(saleId);
        }
      } catch (e) {
        printMsg = 'Print error: $e. Ticket saved in offline history.';
      }
      if (!mounted) return;
      await _showResult(sale, printMsg);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Records the passenger name/phone from the luggage ticket onto the linked
  /// bus-fare ticket so both tickets can later be grouped. Write-back is a
  /// gap-filler only: a placeholder / empty / operator-edited name NEVER
  /// overwrites the passenger already recorded on the bus fare — the source
  /// sale's real name and phone always win when they exist.
  Future<void> _writeBackPassenger(Sale luggage) async {
    final src = widget.sourceSale;
    if (src.id == null || luggage.customerName.isEmpty) return;
    final backfillName = _isPlaceholderName(src.customerName) &&
        !_isPlaceholderName(luggage.customerName);
    final backfillPhone = src.customerMobile.trim().isEmpty &&
        luggage.customerMobile.trim().isNotEmpty;
    if (!backfillName && !backfillPhone) return;
    try {
      await AppDb.updateSaleCustomer(
        src.id,
        customerName: backfillName ? luggage.customerName : src.customerName,
        customerMobile:
            backfillPhone ? luggage.customerMobile : src.customerMobile,
      );
    } catch (e) {
      debugPrint('Passenger write-back skipped: $e');
    }
  }

  String _saleSummary(Sale sale) {
    final bus = (sale.busReg.isNotEmpty ? sale.busReg : _src.busReg).trim();
    final lines = <String>[
      if (bus.isNotEmpty) 'BUS ${bus.toUpperCase()}',
      if (sale.tripNo.isNotEmpty) 'TRIP ${sale.tripNo.toUpperCase()}',
      if (sale.departureTime.isNotEmpty) 'DEP ${sale.departureTime}',
      if (sale.driver.isNotEmpty) 'DRIVER ${sale.driver.toUpperCase()}',
      if (sale.conductor1.isNotEmpty)
        'CONDUCTOR ${sale.conductor1.toUpperCase()}',
    ];
    final customer = sale.customerName.trim().isEmpty
        ? ''
        : 'CUSTOMER ${sale.customerName.toUpperCase()}';
    return [...lines, if (customer.isNotEmpty) customer].join(' • ');
  }

  TicketData _ticketData(Sale sale) {
    return TicketData(
      companyName: _companyName,
      slogan: _slogan,
      ticketType: 'LUGGAGE TICKET',
      receiptNo: sale.receiptNo,
      time: sale.createdAt ?? DateTime.now(),
      busReg: sale.busReg,
      tripNo: sale.tripNo,
      website: _website,
      customerCare: _customerCare,
      companyAddress: _companyAddress,
      companyEmail: _companyEmail,
      receiptHeader: _receiptHeader,
      receiptFooter: _receiptFooter,
      routeCode: sale.routeCode,
      routeName: sale.routeName,
      items: sale.items,
      total: sale.total,
      currency: _currency,
      driver: sale.driver,
      driverPhone: sale.driverPhone,
      conductor1: sale.conductor1,
      conductor2: sale.conductor2,
      conductorPhone: sale.conductorPhone,
      seatNumber: sale.seatNumber,
      customerName: sale.customerName,
      customerMobile: sale.customerMobile,
      departureTime: sale.departureTime,
      paymentMethod: sale.paymentMethod,
      tendered: sale.cash,
      note: kLuggageNote,
    );
  }

  Future<String> _printReceipt(Sale sale) async {
    final address = await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) return 'No printer configured';
    final ok = await PrinterService.instance
        .printTicket(address: address, data: _ticketData(sale), fromSale: sale);
    return ok ? 'Printed successfully' : 'Print failed';
  }

  Future<void> _showResult(Sale sale, String printMsg) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Luggage ${sale.receiptNo}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Total   ${fmtMoney(sale.total, _currency)}'),
            const SizedBox(height: 10),
            Text(
              printMsg,
              style: TextStyle(
                color: printMsg == 'Printed successfully'
                    ? Theme.of(ctx).colorScheme.primary
                    : Colors.orange.shade800,
              ),
            ),
            if (_saleSummary(sale).isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  _saleSummary(sale),
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF334155),
                  ),
                ),
              ),
            if (sale.luggageLinkedTicketId.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Linked to ${sale.luggageLinkedTicketId}',
                  style:
                      const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
              ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              _sharePdf(sale);
            },
            child: const Text('Send PDF'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              Navigator.of(context).pop();
            },
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Future<void> _sharePdf(Sale sale) async {
    await PdfService.instance.shareTicket(_ticketData(sale));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Luggage ticket')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'For passenger on ${widget.sourceSale.receiptNo}',
            style: const TextStyle(color: Color(0xFF64748B)),
          ),
          const SizedBox(height: 16),
          // Matches the bus-fare ticket's handling of the same field: the same
          // all-caps input, and no extra length cap. The concise label is what
          // keeps the row from crowding the value on a narrow terminal, and a
          // hard cap here would have silently dropped the tail of a name the
          // conductor just typed and could already see in full on the bus-fare
          // sheet. The printed name is clipped separately in receipt.dart.
          TextField(
            controller: _nameCtrl,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(
              // Concise label, matching the printed "Passenger" wording. The
              // longer "Passenger name" left too little room for the value.
              labelText: 'Passenger',
              hintText: 'Full name',
              isDense: true,
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _phoneCtrl,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Phone',
              isDense: true,
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          InputDecorator(
            decoration: const InputDecoration(
              labelText: 'Destination',
              isDense: true,
              border: OutlineInputBorder(),
            ),
            child: Text(_destination),
          ),
          const SizedBox(height: 10),
          InputDecorator(
            decoration: const InputDecoration(
              labelText: 'Trip',
              isDense: true,
              border: OutlineInputBorder(),
            ),
            child: Text(saleContextLine()),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _descCtrl,
            decoration: const InputDecoration(
              labelText: 'Luggage description',
              hintText: 'e.g. 2 suitcases',
              isDense: true,
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _priceCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: 'Price ($_currency)',
              isDense: true,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _saving ? null : _save,
            icon: const Icon(Icons.confirmation_number),
            label: Text(_saving ? 'Saving…' : 'Save luggage ticket'),
          ),
        ],
      ),
    );
  }

  String saleContextLine() {
    final src = _src;
    final parts = <String>[
      if (src.tripNo.isNotEmpty) src.tripNo,
      if (src.driver.isNotEmpty) 'Driver: ${src.driver}',
      if (src.conductor1.isNotEmpty) 'Conductor: ${src.conductor1}',
      if (src.departureTime.isNotEmpty) 'Dep: ${src.departureTime}',
    ];
    return parts.join(' • ');
  }
}
