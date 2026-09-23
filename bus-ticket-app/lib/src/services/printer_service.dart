import 'dart:async';

import 'package:bluetooth_print_plus/bluetooth_print_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

import '../db/app_db.dart';
import '../models.dart';
import '../receipt.dart';

/// Hard ceiling for a single BLE printer operation so a dead or out-of-range
/// thermal printer can never freeze the sale UI. The BT stack can hang
/// silently when the printer loses power mid-connection.
const Duration kPrinterOpTimeout = Duration(seconds: 5);

/// Ceiling for a full discovery pass.
const Duration kPrinterScanTimeout = Duration(seconds: 10);

class PrinterService {
  PrinterService._();
  static final PrinterService instance = PrinterService._();

  /// Native side exposes the adapter's bonded (paired) Bluetooth set, which
  /// classic discovery deliberately hides on Android.
  static const MethodChannel _identityChannel =
      MethodChannel('preyone.device/identity');

  /// Guards against re-entrant native permission prompts. On some OEM builds
  /// (Vivo/Android 14) calling `Permission.bluetoothScan.request()` while a
  /// request is already in flight crashes the platform channel, so concurrent
  /// scan()+connect() paths must serialize on a single prompt chain.
  bool _isRequestingPermissions = false;

  bool _pluginInitialized = false;

  /// bluetooth_print_plus only opens its connect-state EventChannel
  /// (the native `sink` the bundled GPrinter SDK posts connection events
  /// through) the FIRST time something calls `startScan()` — `connect()` on its
  /// own never triggers it. Connecting to a bonded printer without ever having
  /// scanned (our autoReconnect / connectByAddress bond-first path) therefore
  /// leaves that sink null; when the RFCOMM socket finishes opening, the SDK's
  /// `BluetoothPort$1` Runnable posts the "connected" event on the main
  /// Handler against the null sink → `EventSink.success()` NullPointerException
  /// and the process dies. Run one near-no-op scan pass before any pure-connect
  /// call so the plugin wires its sink exactly once per process.
  Future<void> _ensurePluginInit() async {
    if (_pluginInitialized) return;
    _pluginInitialized = true;
    try {
      await BluetoothPrintPlus.startScan(
        timeout: const Duration(milliseconds: 500),
      ).timeout(const Duration(seconds: 2));
    } on Object catch (e, st) {
      debugPrint('PrinterService: plugin init scan failed -> $e\n$st');
    }
  }

  Future<void> _ensurePermissions() async {
    if (_isRequestingPermissions) return;
    _isRequestingPermissions = true;
    try {
      await Permission.bluetoothScan.request();
      await Permission.bluetoothConnect.request();
      // Fine location is still required by Android for classic BLE discovery.
      if (!await Permission.locationWhenInUse.isGranted) {
        await Permission.locationWhenInUse.request();
      }
    } finally {
      _isRequestingPermissions = false;
    }
  }

  /// Whether every runtime permission the classic RFCOMM path needs is
  /// already granted. Used by silent [autoReconnect] — that path must never
  /// open a permission dialog while the shell is booting, because on this
  /// device family (Vivo / Android 14) a request in flight during engine
  /// bootstrap crashes the process with a NullPointerException in the
  /// permission delegate (see MainActivity comment). Anything short of granted
  /// means "skip silently — the manual Settings flow still prompts normally".
  Future<bool> _permissionsReady() async {
    try {
      if (!await Permission.bluetoothScan.isGranted) return false;
      if (!await Permission.bluetoothConnect.isGranted) return false;
      if (!await Permission.locationWhenInUse.isGranted) return false;
      return true;
    } on Object catch (e, st) {
      debugPrint('PrinterService: permission probe failed -> $e\n$st');
      return false;
    }
  }

  /// Printers already paired/bonded with this phone. Android's classic
  /// discovery (`startDiscovery()`) deliberately omits bonded devices, so a
  /// printer paired once in the OS settings (e.g. during an earlier test) never
  /// reappears in a fresh scan and looks "not found" — this restores it.
  Future<List<BluetoothDevice>> bondedDevices() async {
    try {
      final raw = await _identityChannel
          .invokeMethod<List<dynamic>>('bondedDevices');
      if (raw == null) return [];
      final out = <BluetoothDevice>[];
      for (final item in raw) {
        if (item is! Map) continue;
        final name = (item['name'] as String? ?? '').trim();
        final address = (item['address'] as String? ?? '').trim();
        if (address.isEmpty) continue;
        final type = (item['type'] as int?) ?? 0;
        out.add(BluetoothDevice(name.isEmpty ? 'Paired printer' : name, address)
          ..type = type);
      }
      return out;
    } on Object catch (e, st) {
      debugPrint('PrinterService: bondedDevices failed -> $e\n$st');
      return [];
    }
  }

  Future<List<BluetoothDevice>> scan({
    Duration timeout = kPrinterScanTimeout,
    int attempts = 3,
  }) async {
    await _ensurePermissions();
    if (!BluetoothPrintPlus.isBlueOn) {
      // Radio off: short-circuit so the native discovery call never throws.
      debugPrint(
          'PrinterService: Bluetooth radio is disabled — scan returned empty.');
      return [];
    }
    final seen = <String, BluetoothDevice>{};
    final sub = BluetoothPrintPlus.scanResults.listen((devices) {
      for (final d in devices) {
        try {
          final name = d.name.toString().trim();
          final address = d.address.toString().trim();
          // Some stacks emit phantom devices with blank / "Unknown" names —
          // never surface those to the picker.
          if (name.isEmpty ||
              name.toLowerCase() == 'unknown' ||
              address.isEmpty) {
            continue;
          }
          seen[address] = d;
        } on Object catch (e) {
          // A malformed OEM record (null name/address, bad cast) must not
          // poison the stream for valid printers — drop it and carry on.
          debugPrint('PrinterService: dropped malformed device -> $e');
        }
      }
    });
    try {
      // A first discovery pass comes back empty on several OEM stacks
      // (Bluetooth just became fully on, radio warm-up, app just resumed).
      // Retry up to [attempts] passes before giving up.
      for (var attempt = 0; attempt < attempts && seen.isEmpty; attempt++) {
        if (attempt > 0) {
          await Future<void>.delayed(const Duration(milliseconds: 700));
        }
        try {
          await BluetoothPrintPlus.startScan(timeout: timeout)
              .timeout(timeout + const Duration(seconds: 2));
        } on TimeoutException {
          // Discovery window elapsed — return whatever was found so far.
        } on Object catch (e, st) {
          // "Discovering is already started", permission races, or unhandled
          // TypeErrors/StateErrors from the plugin must never become unhandled
          // zone crashes — report and return whatever was found.
          debugPrint('PrinterService: scan failed -> $e\n$st');
        }
      }
    } finally {
      await sub.cancel();
    }
    return seen.values.toList();
  }

  Future<bool> connect(BluetoothDevice device) async {
    await _ensurePermissions();
    await _ensurePluginInit();
    // The native connect() resolves immediately while the RFCOMM socket is
    // opened later on a worker thread — and for an unpaired printer Android
    // shows a system pairing dialog the user must accept first. Both take
    // several seconds, so poll the real connection state instead of checking
    // once a few hundred ms after the call.
    final lastState = <ConnectState?>[
      BluetoothPrintPlus.isConnected
          ? ConnectState.connected
          : ConnectState.disconnected
    ];
    final sub = BluetoothPrintPlus.connectState
        .listen((s) => lastState[0] = s);
    try {
      await BluetoothPrintPlus.connect(device).timeout(kPrinterOpTimeout);
      final deadline =
          DateTime.now().add(const Duration(seconds: 15));
      while (DateTime.now().isBefore(deadline)) {
        if (lastState[0] == ConnectState.connected) {
          // Cache the winning printer so a restart can silently reconnect
          // without re-pairing / re-selecting.
          await AppDb.setSetting('saved_printer_mac', device.address);
          return true;
        }
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
      return false;
    } on TimeoutException {
      return false;
    } catch (_) {
      return false;
    } finally {
      await sub.cancel();
    }
  }

  Future<bool> connectByAddress(String address) async {
    if (address.trim().isEmpty) return false;
    if (BluetoothPrintPlus.isConnected) return true;
    try {
      // Bonded printers are invisible to classic discovery on many OEM stacks,
      // but the RFCOMM socket connects straight to the MAC — try that first.
      final bonded = await bondedDevices();
      for (final d in bonded) {
        if (d.address == address) return await connect(d);
      }
    } on Object catch (e, st) {
      debugPrint('PrinterService: connectByAddress bonded lookup failed -> $e\n$st');
    }
    try {
      final devices = await scan();
      for (final d in devices) {
        if (d.address == address) return await connect(d);
      }
    } on Object catch (e, st) {
      debugPrint('PrinterService: connectByAddress scan failed -> $e\n$st');
    }
    return false;
  }

  /// Best-effort silent reconnect to the last successful printer at app start.
  /// Guaranteed non-throwing: a dead/out-of-range printer must never break the
  /// terminal bootstrap, it simply stays unconnected until a print triggers a
  /// fresh [connectByAddress].
  ///
  /// Never prompts for permissions and never runs during widget bootstrap —
  /// [main.dart] calls this from a post-first-frame callback, and here we wait
  /// a further beat so the activity is fully resumed; on this device family a
  /// BT channel call racing engine setup kills the process.
  Future<void> autoReconnect() async {
    try {
      // Silent path: if any needed permission is missing, do nothing. The
      // manual Settings connect still requests and can re-grant.
      if (!await _permissionsReady()) return;
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (BluetoothPrintPlus.isConnected) return;
      if (!BluetoothPrintPlus.isBlueOn) return;
      final mac =
          (await AppDb.getSetting('saved_printer_mac', ''))?.trim() ?? '';
      if (mac.isEmpty) return;
      // Bonded-direct first (no discovery churn at boot). connect() may still
      // call _ensurePermissions(), but all permissions are already granted here
      // so it resolves without dialogs.
      final bonded = await bondedDevices();
      for (final d in bonded) {
        if (d.address == mac) {
          await connect(d);
          return;
        }
      }
      if (await connectByAddress(mac)) return;
    } on Object catch (e, st) {
      debugPrint('PrinterService: autoReconnect skipped -> $e\n$st');
    }
  }

  Future<void> disconnect() async {
    await _ensurePluginInit();
    try {
      await BluetoothPrintPlus.disconnect();
    } catch (_) {}
  }

  Future<bool> write(List<int> bytes) async {
    if (!BluetoothPrintPlus.isConnected) return false;
    try {
      await BluetoothPrintPlus
          .write(Uint8List.fromList(bytes))
          .timeout(kPrinterOpTimeout);
      return true;
    } on TimeoutException {
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Single-ticket thermal print. Maps the provided (live) ticket data into a
  /// continuous 58mm job — connect + write in one call.
  ///
  /// When [fromSale] is supplied, any blank passenger/crew/vehicle field on
  /// [data] is back-filled from the sale so the ESC/POS output always carries
  /// the authoritative stored values (customer, driver, conductor, bus).
  Future<bool> printTicket({
    required String address,
    required TicketData data,
    Sale? fromSale,
  }) async {
    if (address.isEmpty) return false;
    if (!await connectByAddress(address)) return false;
    // A luggage ticket links back to its bus-fare ticket via
    // luggageLinkedTicketId (tx_id). Inherit the source's vehicle/crew/customer
    // so the printed luggage slip is complete even when issued offline.
    final linked = await _linkedBusSale(fromSale, data);
    return write(buildTicket(_backfillTicket(data, linked),
        feedLines: await _feedLines()));
  }

  /// Resolves the bus-fare ticket a luggage ticket links to (when the print
  /// data is missing the source's vehicle/crew) so backfill [TicketData] can
  /// inherit them. Returns [s] unchanged when there is nothing to resolve.
  Future<Sale?> _linkedBusSale(Sale? s, TicketData d) async {
    if (s == null || s.ticketType != 'luggage') return s;
    final missing =
        d.busReg.trim().isEmpty ||
        d.driver.trim().isEmpty ||
        d.conductor1.trim().isEmpty ||
        d.customerName.trim().isEmpty;
    if (!missing) return s;
    if (s.luggageLinkedTicketId.isEmpty) return s;
    final linked = await AppDb.getSaleByTxId(s.luggageLinkedTicketId);
    return linked ?? s;
  }

  /// Per-company trailing paper feed so the full print rolls out visible.
  /// Device-level setting `ticket_paper_feed` (default ~8 lines) applied to
  /// tickets, manifests and end-of-day reports. Defensive floor of 3 lines so
  /// a corrupted/blank setting can never produce a cut that shears the last
  /// printed line.
  Future<int> _feedLines() async {
    final v = await AppDb.getSetting('ticket_paper_feed', '8');
    final parsed = int.tryParse(v ?? '8') ?? 8;
    return parsed < 3 ? 3 : parsed;
  }

  /// Fills blank ticket fields with the matching field from [sale]. Used to
  /// keep printed receipts complete even when the live TicketData was built
  /// from a partially-hydrated local row.
  TicketData _backfillTicket(TicketData d, Sale? s) {
    if (s == null) return d;
    String pickT(String live, String alt) =>
        live.trim().isNotEmpty ? live : (alt.trim().isNotEmpty ? alt : live);
    return TicketData(
      companyName: d.companyName,
      slogan: d.slogan,
      ticketType: d.ticketType,
      receiptNo: d.receiptNo,
      time: d.time,
      busReg: pickT(d.busReg, s.busReg),
      tripNo: pickT(d.tripNo, s.tripNo),
      website: d.website,
      customerCare: d.customerCare,
      companyAddress: d.companyAddress,
      companyEmail: d.companyEmail,
      receiptHeader: d.receiptHeader,
      receiptFooter: d.receiptFooter,
      routeCode: pickT(d.routeCode, s.routeCode),
      routeName: pickT(d.routeName, s.routeName),
      items: d.items.isNotEmpty ? d.items : s.items,
      total: d.total,
      currency: d.currency,
      driver: pickT(d.driver, s.driver),
      driverPhone: pickT(d.driverPhone, s.driverPhone),
      conductor1: pickT(d.conductor1, s.conductor1),
      conductor2: pickT(d.conductor2, s.conductor2),
      conductorPhone: pickT(d.conductorPhone, s.conductorPhone),
      seatNumber: pickT(d.seatNumber, s.seatNumber),
      customerName: pickT(d.customerName, s.customerName),
      customerMobile: pickT(d.customerMobile, s.customerMobile),
      departureTime: pickT(d.departureTime, s.departureTime),
      paymentMethod: pickT(d.paymentMethod, s.paymentMethod),
      customFare:
          d.customFare > 0 ? d.customFare : (s.customFare > 0 ? s.customFare : 0),
      note: d.note,
      tendered: d.tendered > 0 ? d.tendered : (s.cash > 0 ? s.cash : d.tendered),
    );
  }

  /// Full trip manifest ("all tickets") thermal print: company banner, route /
  /// crew details, per-ticket rows and cash/mobile totals in one continuous job.
  Future<bool> printTripManifest({
    required String address,
    required String companyName,
    required String currency,
    String tagline = '',
    String companyAddress = '',
    String customerCare = '',
    required Trip trip,
    required List<Sale> tickets,
    DriverShift? shift,
  }) async {
    if (address.isEmpty) return false;
    if (!await connectByAddress(address)) return false;
    return write(buildTripManifest(
      companyName: companyName,
      currency: currency,
      trip: trip,
      tickets: tickets,
      tagline: tagline,
      companyAddress: companyAddress,
      customerCare: customerCare,
      shift: shift,
      feedLines: await _feedLines(),
    ));
  }

  /// End-of-day / per-day report thermal print.
  Future<bool> printReport({
    required String address,
    required String companyName,
    required String currency,
    required DateTime from,
    required DateTime to,
    required List<Sale> sales,
    String tagline = '',
    String companyAddress = '',
    String customerCare = '',
    DriverShift? shift,
  }) async {
    if (address.isEmpty) return false;
    if (!await connectByAddress(address)) return false;
    return write(buildReport(
      companyName: companyName,
      currency: currency,
      from: from,
      to: to,
      sales: sales,
      tagline: tagline,
      companyAddress: companyAddress,
      customerCare: customerCare,
      shift: shift,
      feedLines: await _feedLines(),
    ));
  }
}