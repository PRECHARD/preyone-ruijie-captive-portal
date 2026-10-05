import 'package:flutter/material.dart';

import '../app_state.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../services/pdf_service.dart';
import '../services/printer_service.dart';

class ReportsScreen extends StatefulWidget {
  const ReportsScreen({super.key});

  @override
  State<ReportsScreen> createState() => _ReportsScreenState();
}

class _ReportsScreenState extends State<ReportsScreen> {
  List<Sale> _sales = [];
  List<Trip> _trips = [];
  String _currency = 'USD';
  String _company = '';
  String _tagline = '';
  String _companyAddress = '';
  String _customerCare = '';
  DriverShift? _dayShift;
  bool _loading = true;
  DateTime _day = DateTime.now();

  @override
  void initState() {
    super.initState();
    _load();
    AppState.instance.addListener(_load);
  }

  @override
  void dispose() {
    AppState.instance.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final currency = await AppDb.getSetting('currency', 'USD') ?? 'USD';
    final company = await AppDb.getSetting('company_name', '') ?? '';
    final profile = await AppDb.getCompanyProfile();
    final sales = await AppDb.getSalesBetween(
      DateTime(_day.year, _day.month, _day.day),
      DateTime(_day.year, _day.month, _day.day, 23, 59, 59),
    );
    final trips = await AppDb.getTrips(
        statuses: const ['SCHEDULED', 'OPEN', 'ACTIVE', 'COMPLETED']);
    final dayShift = await AppDb.getShiftForDay(_day);
    if (!mounted) return;
    setState(() {
      _sales = sales;
      _trips = trips;
      _currency = currency;
      _company = (profile?.name.isNotEmpty ?? false) ? profile!.name : company;
      _tagline = profile?.slogan ?? '';
      _companyAddress = profile?.companyAddress ?? '';
      _customerCare = zimPhoneOrEmpty(profile?.customerCare ?? '');
      _dayShift = dayShift;
      _loading = false;
    });
  }

  Future<void> _pickDay() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: DateTime(2023),
      lastDate: DateTime(2100),
    );
    if (picked != null) {
      setState(() {
        _day = picked;
        _loading = true;
      });
      await _load();
    }
  }

  int get _total => _sales.fold(0, (s, x) => s + x.total);
  int get _passengers =>
      _sales.fold(0, (s, x) => s + x.items.fold(0, (a, i) => a + i.qty));
  int get _luggageCount =>
      _sales.where((s) => s.ticketType == 'luggage').length;

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _printReport() async {
    final address = await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) {
      _snack('No printer configured');
      return;
    }
    final ok = await PrinterService.instance.printReport(
      address: address,
      companyName: _company,
      currency: _currency,
      from: DateTime(_day.year, _day.month, _day.day),
      to: DateTime(_day.year, _day.month, _day.day, 23, 59, 59),
      sales: _sales,
      tagline: _tagline,
      companyAddress: _companyAddress,
      customerCare: _customerCare,
      shift: _dayShift,
    );
    _snack(ok ? 'Report printed' : 'Print failed');
  }

  Future<void> _printManifest(Trip trip) async {
    final address = await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) {
      _snack('No printer configured');
      return;
    }
    final shift = await AppDb.getActiveShift();
    final tripTickets = await AppDb.getSalesByTrip(trip.id);
    // Include every ticket sold this shift — even ones not yet synced — so a
    // manifest printed mid-shift never misses an offline sale.
    var tickets = tripTickets;
    if (shift != null && shift.id.isNotEmpty) {
      final shiftTickets = await AppDb.getSalesByShift(shift.id);
      final tripIds = tripTickets.map((s) => s.id).toSet();
      tickets = [
        ...tripTickets,
        ...shiftTickets.where((s) => !tripIds.contains(s.id))
      ];
    }
    final ok = await PrinterService.instance.printTripManifest(
      address: address,
      companyName: _company,
      currency: _currency,
      tagline: _tagline,
      companyAddress: _companyAddress,
      customerCare: _customerCare,
      trip: trip,
      tickets: tickets,
      shift: shift,
    );
    _snack(ok
        ? 'Manifest printed (${tickets.length} ticket${tickets.length == 1 ? '' : 's'})'
        : 'Print failed');
  }

  /// "Print Trip Manifest / All Tickets": prints every ticket sold on the
  /// current active trip as one continuous thermal job.
  Future<void> _printActiveTripManifest() async {
    final trip = await AppDb.getActiveTrip();
    if (trip == null) {
      _snack('No active trip. Select a trip in Ticketing first.');
      return;
    }
    await _printManifest(trip);
  }

  Future<void> _sharePdf() async {
    await PdfService.instance.shareReport(
      companyName: _company,
      currency: _currency,
      from: DateTime(_day.year, _day.month, _day.day),
      to: DateTime(_day.year, _day.month, _day.day, 23, 59, 59),
      sales: _sales,
      tagline: _tagline,
      companyAddress: _companyAddress,
      customerCare: _customerCare,
      shift: _dayShift,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
            child: Row(
              children: [
                IconButton(
                  tooltip: 'Change date',
                  onPressed: _pickDay,
                  icon: const Icon(Icons.date_range_outlined),
                ),
                IconButton(
                  tooltip: 'Print report',
                  onPressed: _printReport,
                  icon: const Icon(Icons.print_outlined),
                ),
                IconButton(
                  tooltip: 'Send report PDF',
                  onPressed: _sharePdf,
                  icon: const Icon(Icons.share_outlined),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Card(
                    elevation: 0,
                    color: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                      side: const BorderSide(color: Color(0xFFE2E8F0)),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Row(
                        children: [
                          const Icon(Icons.calendar_today_outlined,
                              color: Color(0xFF1B5E20)),
                          const SizedBox(width: 10),
                          Text(
                            fmtDate(_day),
                            style: const TextStyle(
                                fontSize: 16, fontWeight: FontWeight.w700),
                          ),
                          const Spacer(),
                          FilledButton.tonal(
                            onPressed: _pickDay,
                            child: const Text('Change'),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: _statCard('Tickets', '${_sales.length}',
                            const Color(0xFF1B5E20)),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _statCard('Revenue', fmtMoney(_total, _currency),
                            const Color(0xFFB45309)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _statCard('Passengers', '$_passengers',
                            const Color(0xFF7C3AED)),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: _statCard('Luggage', '$_luggageCount',
                            const Color(0xFF0369A1)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Trips',
                          style: Theme.of(context)
                              .textTheme
                              .titleMedium
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                      FilledButton.tonal(
                        onPressed: _printActiveTripManifest,
                        style: FilledButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                        ),
                        child: const Text('Print Trip Manifest'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (_trips.isEmpty)
                    const Card(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(
                            child: Text('No trips fetched yet. Create one in '
                                'Ticketing to print a full trip manifest.')),
                      ),
                    )
                  else
                    for (final t in _trips) _tripCard(t),
                  const SizedBox(height: 20),
                  Text(
                    'Sales for ${fmtDate(_day)}',
                    style: Theme.of(context)
                        .textTheme
                        .titleMedium
                        ?.copyWith(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 8),
                  if (_loading)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (_sales.isEmpty)
                    const Card(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: Text('No sales for this day')),
                      ),
                    )
                  else
                    for (final s in _sales) _saleLine(s),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String label, String value, Color color) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(fontSize: 12, color: Color(0xFF64748B)),
          ),
        ],
      ),
    );
  }

  Widget _tripCard(Trip t) {
    final occupancy =
        t.totalSeats > 0 ? '${t.seatsSold}/${t.totalSeats}' : '${t.seatsSold}';
    final statusColor = switch (t.status) {
      'ACTIVE' => const Color(0xFF14B8A6),
      'COMPLETED' => const Color(0xFF64748B),
      'CLOSED' => const Color(0xFFB91C1C),
      'OPEN' => const Color(0xFF1B5E20),
      _ => const Color(0xFFB45309),
    };
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE2E8F0)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Text(
                        t.status,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: statusColor,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'Seats: $occupancy',
                        style: const TextStyle(
                            fontSize: 12, color: Color(0xFF64748B)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Print full trip manifest',
              visualDensity: VisualDensity.compact,
              onPressed: () => _printManifest(t),
              icon: const Icon(Icons.receipt_long_outlined, size: 20),
            ),
          ],
        ),
      ),
    );
  }

  Widget _saleLine(Sale s) {
    final items = s.items
        .map((i) => i.qty > 1 ? '${i.name}  ×${i.qty}' : i.name)
        .join(', ');
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE2E8F0)),
      ),
      child: ListTile(
        dense: true,
        title: Text(s.receiptNo,
            style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(
          items,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12),
        ),
        trailing: Text(
          fmtMoney(s.total, _currency),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
