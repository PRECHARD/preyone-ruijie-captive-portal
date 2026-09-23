import 'package:flutter/material.dart';

import '../app_state.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../receipt.dart';
import '../services/pdf_service.dart';
import '../services/printer_service.dart';
import '../services/session_guard.dart';
import '../services/transit_api.dart';
import '../widgets/ticket_preview_card.dart';
import '../services/sync_service.dart';

class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  static const _pageSize = 200;
  List<Sale> _sales = [];
  int _offset = 0;
  bool _hasMore = true;
  String _currency = 'USD';
  String _company = '';
  String _slogan = '';
  String _busReg = '';
  String _website = '';
  String _customerCare = '';
  String _companyAddress = '';
  String _companyEmail = '';
  bool _loading = true;
  bool _loadingMore = false;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    _reload();
    AppState.instance.addListener(_reload);
  }

  @override
  void dispose() {
    AppState.instance.removeListener(_reload);
    super.dispose();
  }

  Future<void> _reload() async {
    final settings = await AppDb.getSettings(const [
      'currency',
      'company_name',
      'company_slogan',
      'bus_reg',
      'website',
      'customer_care',
      'company_address',
      'company_email',
    ]);
    _offset = 0;
    _hasMore = true;
    final sales = await _hydrateGapSales(await AppDb.getSales(
        limit: _pageSize, offset: _offset));
    // Mirror the sell screen: prefer the cached server company profile (kept
    // fresh by every sync via refreshCatalog) over the local settings so the
    // Tickets screen is branded identically to live tickets — online or off.
    final profile = await AppDb.getCompanyProfile();
    if (!mounted) return;
    setState(() {
      _sales = sales;
      _currency = profile?.currency.isNotEmpty == true
          ? profile!.currency
          : settings['currency'] ?? 'USD';
      _company = profile?.name.isNotEmpty == true
          ? profile!.name
          : settings['company_name'] ?? '';
      _slogan = profile?.slogan.isNotEmpty == true
          ? profile!.slogan
          : settings['company_slogan'] ?? '';
      _busReg = settings['bus_reg'] ?? '';
      _website = profile?.website.isNotEmpty == true
          ? profile!.website
          : settings['website'] ?? '';
      _customerCare =
          zimPhoneOrEmpty(profile?.customerCare.isNotEmpty == true
              ? profile!.customerCare
              : settings['customer_care'] ?? '');
      _companyAddress = profile?.companyAddress.isNotEmpty == true
          ? profile!.companyAddress
          : settings['company_address'] ?? '';
      _companyEmail = profile?.companyEmail.isNotEmpty == true
          ? profile!.companyEmail
          : settings['company_email'] ?? '';
      _loading = false;
    });
  }

  /// Appends the next page of sales (newest-first) for the "load more" footer.
  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore || _loading) return;
    setState(() => _loadingMore = true);
    final nextOffset = _offset + _pageSize;
    final more = await _hydrateGapSales(await AppDb.getSales(
        limit: _pageSize, offset: nextOffset));
    if (!mounted) return;
    setState(() {
      _sales = [..._sales, ...more];
      _offset = nextOffset;
      _hasMore = more.length == _pageSize;
      _loadingMore = false;
    });
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg)));
  }

  /// Best-effort batch: backfills missing bus/driver/conductor/customer on
  /// every gap sale at list-load time (trip is the canonical vehicle source on
  /// the server). Failures are silent so history stays usable offline.
  /// Concurrency is CAPPED (4 in flight at a time) so a large offline queue
  /// never hammers the server or the device with an unbounded fan-out.
  Future<List<Sale>> _hydrateGapSales(List<Sale> sales) async {
    final gaps = <({int index, Sale sale})>[];
    for (var i = 0; i < sales.length; i++) {
      final s = sales[i];
      if (s.txId.isNotEmpty &&
          (s.customerName.trim().isEmpty ||
              s.customerMobile.trim().isEmpty ||
              s.busReg.trim().isEmpty ||
              s.driver.trim().isEmpty ||
              s.conductor1.trim().isEmpty ||
              s.conductorPhone.trim().isEmpty)) {
        gaps.add((index: i, sale: s));
      }
    }
    if (gaps.isEmpty) return sales;
    var posted = 0;
    await Future.wait(List<int>.filled(4, 0).map((_) async {
      while (posted < gaps.length) {
        final g = gaps[posted++];
        sales[g.index] = await _maybeHydrate(g.sale);
      }
    }));
    return sales;
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
                  icon: const Icon(Icons.receipt_long),
                  tooltip: "Print today's report",
                  onPressed: _printTodayReport,
                ),
                IconButton(
                  icon: const Icon(Icons.share),
                  tooltip: 'Send report PDF',
                  onPressed: _shareTodayReport,
                ),
                IconButton(
                  icon: const Icon(Icons.sync),
                  tooltip: 'Sync now',
                  onPressed: _syncing ? null : _syncNow,
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _reload,
              child: _loading
                  ? const Center(
                      child: CircularProgressIndicator())
                  : _sales.isEmpty
                      ? ListView(
                          physics:
                              const AlwaysScrollableScrollPhysics(),
                          children: const [
                            SizedBox(height: 160),
                            Icon(Icons.receipt_long,
                                size: 64, color: Colors.grey),
                            SizedBox(height: 12),
                            Center(
                                child: Text('No sales yet',
                                    style: TextStyle(
                                        color: Colors.grey))),
                          ],
                        )
                      : ListView.separated(
                    physics:
                        const AlwaysScrollableScrollPhysics(),
                    itemCount: _sales.length + (_hasMore ? 1 : 0),
                    separatorBuilder: (_, __) =>
                        const Divider(height: 1),
                    itemBuilder: (_, i) {
                      if (i >= _sales.length) {
                        return _loadMoreFooter();
                      }
                      return _saleTile(_sales[i]);
                    },
                  ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _loadMoreFooter() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: _loadingMore
            ? const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2))
            : OutlinedButton.icon(
                onPressed: _loadMore,
                icon: const Icon(Icons.expand_more, size: 18),
                label: const Text('Load more'),
              ),
      ),
    );
  }

  Widget _saleTile(Sale sale) {
    final synced = sale.synced == 1;
    final printed = sale.printed == 1;
    final bus = (sale.busReg.isNotEmpty ? sale.busReg : _busReg).trim();
    final meta = <String>[
      if (bus.isNotEmpty) 'BUS ${bus.toUpperCase()}',
      if (sale.tripNo.isNotEmpty) 'TRIP ${sale.tripNo.toUpperCase()}',
      if (sale.departureTime.isNotEmpty) 'DEP ${sale.departureTime}',
    ].join('  ·  ');
    final crew = <String>[
      if (sale.driver.isNotEmpty) 'DRIVER ${sale.driver.toUpperCase()}',
      if (sale.conductor1.isNotEmpty)
        'CONDUCTOR ${sale.conductor1.toUpperCase()}',
      if (sale.customerName.isNotEmpty)
        'CUSTOMER ${sale.customerName.toUpperCase()}',
    ].join('  ·  ');
    return ListTile(
      onTap: () => _showSale(sale),
      leading:
          const Icon(Icons.confirmation_number, size: 32),
      title: Text(
          '${sale.receiptNo}  •  ${fmtMoney(sale.total, _currency)}'),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${_summary(sale)} • ${fmtDateTime(sale.createdAt!)}',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          if (meta.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                meta,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          if (crew.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                crew,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w500,
                  color: Color(0xFF6E7B8A),
                ),
              ),
            ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
              synced
                  ? Icons.cloud_done
                  : Icons.cloud_upload,
              size: 18,
              color: synced ? Colors.green : Colors.orange),
          const SizedBox(width: 6),
          Icon(Icons.print,
              size: 18,
              color: printed
                  ? Colors.black54
                  : Colors.grey.shade300),
        ],
      ),
    );
  }

  String _summary(Sale sale) => sale.items
      .map((i) => '${i.name} x${i.qty}')
      .join(', ');

  /// Backfills missing fields (customer, crew, bus reg) on an older offline
  /// sale using the server-side ticket copy. Silent on failure so history
  /// stays usable offline. Returns the re-read (hydrated) sale.
  Future<Sale> _maybeHydrate(Sale sale) async {
    final hasGaps =
        sale.customerName.trim().isEmpty ||
        sale.customerMobile.trim().isEmpty ||
        sale.busReg.trim().isEmpty ||
        sale.driver.trim().isEmpty ||
        sale.conductor1.trim().isEmpty ||
        sale.conductorPhone.trim().isEmpty;
    if (!hasGaps || sale.txId.isEmpty) return sale;
    try {
      final t = await TransitApi.fetchTicket(sale.txId);
      if (t.isEmpty) return sale;
      await AppDb.hydrateSale(
        sale.id,
        customerName: (t['customerName'] ?? t['customer_name'] ?? '').toString(),
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
        conductorPhone: (t['conductorPhone'] ?? t['conductor_phone'] ?? '').toString(),
        departureTime: formatDepartureTime(
            (t['departureTime'] ?? t['departure_time'] ?? '').toString()),
        paymentMethod: (t['paymentMethod'] ?? t['payment_method'] ?? '').toString(),
      );
      return await AppDb.getSaleById(sale.id) ?? sale;
    } on TransitApiException catch (e) {
      if (SessionGuard.shouldIntercept(e) && mounted) {
        await SessionGuard.forceLogout(
          context,
          deactivated: SessionGuard.isRevoked(e.code),
        );
      }
      return sale;
    } catch (_) {
      return sale;
    }
  }

  Future<void> _showSale(Sale sale) async {
    final hydrated = await _maybeHydrate(sale);
    // Reflect hydrated crew/customer/vehicle fields in the list behind the
    // preview modal. _reload keeps the spinner hidden once loaded.
    await _reload();
    final address =
        await AppDb.getSetting('printer_address', null);
    if (!mounted) return;
    final data = await _buildLuggageTicketData(hydrated);
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFFF2EEE6),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 16, 12, 12),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding:
                      const EdgeInsets.only(bottom: 12, left: 4, right: 4),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          hydrated.receiptNo,
                          style:
                              Theme.of(ctx).textTheme.titleMedium,
                        ),
                      ),
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () => Navigator.of(ctx).pop(),
                      ),
                    ],
                  ),
                ),
                TicketPreviewCard(data: data),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: address == null
                            ? null
                            : () {
                                Navigator.of(ctx).pop();
                                _printSale(hydrated);
                              },
                        icon: const Icon(Icons.print),
                        label: const Text('Print'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: FilledButton.tonal(
                        onPressed: () {
                          Navigator.of(ctx).pop();
                          _sharePdf(hydrated);
                        },
                        child: const Text('Send PDF'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextButton(
                        onPressed: () => Navigator.of(ctx).pop(),
                        child: const Text('Close'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

TicketData _buildTicketData(Sale sale) => TicketData(
      companyName: _company,
      slogan: _slogan,
      ticketType: sale.ticketType == 'luggage'
          ? 'LUGGAGE TICKET'
          : 'BUS TICKET',
      receiptNo: sale.receiptNo,
      time: sale.createdAt ?? DateTime.now(),
      busReg: sale.busReg.isNotEmpty ? sale.busReg : _busReg,
      tripNo: sale.tripNo,
      website: _website,
      customerCare: _customerCare,
      companyAddress: _companyAddress,
      companyEmail: _companyEmail,
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
      departureTime: sale.departureTime,
      customerName: sale.customerName,
      customerMobile: sale.customerMobile,
      paymentMethod: sale.paymentMethod,
      tendered: sale.cash,
      note: sale.ticketType == 'luggage' ? kLuggageNote : kTicketValidityNote,
    );

  /// Backfills a luggage ticket's blank vehicle/crew/passenger from the linked
  /// bus-fare ticket (via `luggageLinkedTicketId` = the source's tx_id) so a
  /// reprinted luggage slip is complete even though the luggage sale itself
  /// stored fewer fields. Falls back to [_saleToTicketData]'s normal pass.
  Future<TicketData> _buildLuggageTicketData(Sale sale) async {
    final data = _buildTicketData(sale);
    if (sale.ticketType != 'luggage' || sale.luggageLinkedTicketId.isEmpty) {
      return data;
    }
    final hasGaps = data.busReg.trim().isEmpty ||
        data.driver.trim().isEmpty ||
        data.conductor1.trim().isEmpty ||
        data.customerName.trim().isEmpty;
    if (!hasGaps) return data;
    final linked = await AppDb.getSaleByTxId(sale.luggageLinkedTicketId);
    if (linked == null) return data;
    return TicketData(
      companyName: data.companyName,
      slogan: data.slogan,
      ticketType: data.ticketType,
      receiptNo: data.receiptNo,
      time: data.time,
      busReg: data.busReg.isNotEmpty ? data.busReg : linked.busReg,
      tripNo: data.tripNo.isEmpty ? linked.tripNo : data.tripNo,
      website: data.website,
      customerCare: data.customerCare,
      companyAddress: data.companyAddress,
      companyEmail: data.companyEmail,
      receiptHeader: data.receiptHeader,
      receiptFooter: data.receiptFooter,
      routeCode: data.routeCode.isEmpty ? linked.routeCode : data.routeCode,
      routeName: data.routeName.isEmpty ? linked.routeName : data.routeName,
      items: data.items,
      total: data.total,
      currency: data.currency,
      driver: data.driver.isEmpty ? linked.driver : data.driver,
      driverPhone:
          data.driverPhone.isEmpty ? linked.driverPhone : data.driverPhone,
      conductor1: data.conductor1.isEmpty ? linked.conductor1 : data.conductor1,
      conductor2: data.conductor2.isEmpty ? linked.conductor2 : data.conductor2,
      conductorPhone: data.conductorPhone.isNotEmpty
          ? data.conductorPhone
          : linked.conductorPhone,
      seatNumber: data.seatNumber.isEmpty ? linked.seatNumber : data.seatNumber,
      departureTime: data.departureTime.isNotEmpty
          ? data.departureTime
          : linked.departureTime,
      customerName: data.customerName.isEmpty ? linked.customerName : data.customerName,
      customerMobile: data.customerMobile.isEmpty
          ? linked.customerMobile
          : data.customerMobile,
      paymentMethod: data.paymentMethod,
      customFare: data.customFare,
      tendered: data.tendered,
      note: data.note,
    );
  }

  Future<void> _printSale(Sale sale) async {
    final address =
        await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) {
      _snack('No printer configured');
      return;
    }
    final ok = await PrinterService.instance
        .printTicket(address: address, data: await _buildLuggageTicketData(sale), fromSale: sale);
    _snack(ok ? 'Ticket printed' : 'Print failed');
  }

  Future<void> _sharePdf(Sale sale) async {
    await PdfService.instance.shareTicket(await _buildLuggageTicketData(sale));
  }

  Future<void> _printTodayReport() async {
    final address =
        await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) {
      _snack('No printer configured');
      return;
    }
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day);
    final end =
        DateTime(now.year, now.month, now.day, 23, 59, 59);
    final sales = await AppDb.getSalesBetween(start, end);
    final shift = await AppDb.getShiftForDay(now);
    final ok = await PrinterService.instance.printReport(
      address: address,
      companyName: _company,
      currency: _currency,
      from: start,
      to: end,
      sales: sales,
      tagline: _slogan,
      companyAddress: _companyAddress,
      customerCare: _customerCare,
      shift: shift,
    );
    _snack(ok
        ? 'Report printed (${sales.length} ticket${sales.length == 1 ? '' : 's'})'
        : 'Print failed');
  }

  Future<void> _shareTodayReport() async {
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day);
    final end =
        DateTime(now.year, now.month, now.day, 23, 59, 59);
    final sales = await AppDb.getSalesBetween(start, end);
    final shift = await AppDb.getShiftForDay(now);
    await PdfService.instance.shareReport(
      companyName: _company,
      currency: _currency,
      from: start,
      to: end,
      sales: sales,
      tagline: _slogan,
      companyAddress: _companyAddress,
      customerCare: _customerCare,
      shift: shift,
    );
  }

  Future<void> _syncNow() async {
    setState(() => _syncing = true);
    final result = await SyncService.instance.syncNow();
    if (!mounted) return;
    setState(() => _syncing = false);
    _snack(result.message);
    await _reload();
    if (result.critical) {
      if (!mounted) return;
      await SessionGuard.forceLogout(
        context,
        deactivated: result.deviceDisabled,
      );
    }
  }
}