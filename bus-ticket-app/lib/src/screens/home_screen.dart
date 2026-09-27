import 'package:flutter/material.dart';

import '../app_state.dart';
import '../controllers/trip_controller.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../models/trip_model.dart';
import '../receipt.dart';
import '../roles.dart';
import '../security/secure_keystore.dart';
import '../route_codes.dart';
import '../services/pdf_service.dart';
import '../services/printer_service.dart';
import '../services/sync_service.dart';
import '../services/transit_api.dart';
import '../widgets/emerald_ui.dart';
import '../widgets/ticket_preview_card.dart';
import 'luggage_ticket_screen.dart';
import 'on_the_go_trip_screen.dart';
import 'start_shift_screen.dart';

enum TicketType { busFare, luggage }

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  TicketType _type = TicketType.busFare;

  List<Fare> _fares = [];
  final Map<int, int> _cart = {};
  final Map<int, int> _priceOverrides = {};
  final List<SaleItem> _luggage = [];

  final _lugDescCtrl = TextEditingController();
  final _lugPriceCtrl = TextEditingController();
  final _cashCtrl = TextEditingController();
  final _routeCodeCtrl = TextEditingController();
  final _routeFromCtrl = TextEditingController();
  final _routeToCtrl = TextEditingController();
  final _seatCtrl = TextEditingController();
  final _driverCtrl = TextEditingController();
  final _conductor1Ctrl = TextEditingController();
  final _conductor2Ctrl = TextEditingController();
  final _customerNameController = TextEditingController();
  final _customerPhoneController = TextEditingController();

  String _currency = 'USD';
  String _companyName = '';
  String _slogan = '';
  String _website = '';
  String _customerCare = '';
  String _companyAddress = '';
  String _companyEmail = '';
  String _receiptHeader = '';
  String _receiptFooter = '';
  String _routeCode = '';
  String _routeFrom = '';
  String _routeTo = '';
  String _busReg = '';
  String _tripNo = '';
  String _seat = '';
  String _driver = '';
  String _driverPhone = '';
  String _conductor1 = '';
  String _conductor2 = '';
  String _conductorPhone = '';
  String _ticketPrefix = 'AGJ';
  List<Driver> _drivers = [];
  Trip? _activeTrip;
  DriverShift? _activeShift;
  TripInstance? _runningInstance;
  bool _catalogLoaded = false;
  bool _loading = true;
  bool _allowFareOverride = true;
  bool _canEditFares = false;
  String _departureTime = '';
  bool _startingTrip = false;

  /// Whether the role may actually override fares right now: permission AND the
  /// operator's `allow_fare_override` setting. Always tappable — a tap without
  /// permission shows the explanatory toast instead of a dead/greyed control.
  bool get _fareEditable => _allowFareOverride && _canEditFares;

  @override
  void initState() {
    super.initState();
    _reload();
    AppState.instance.addListener(_reload);
  }

  /// Combined route string saved to state, DB, receipts and sync payloads
  /// in the canonical 'FROM - TO' format.
  String get _routeName {
    if (_routeFrom.isEmpty && _routeTo.isEmpty) return '';
    return [_routeFrom, _routeTo].where((p) => p.isNotEmpty).join(' - ');
  }

  /// True when the operator typed a manual route (From + To) instead of
  /// picking a scheduled trip — the "start a new shift on-the-fly" path.
  bool get _hasManualRoute =>
      _routeFrom.trim().isNotEmpty && _routeTo.trim().isNotEmpty;

  /// Primary (Adult) tariff row used when an admin-scheduled trip seeds its
  /// base fare onto the ticket build screen.
  Fare? _adultFare() {
    for (final f in _fares) {
      if (f.name.trim().toUpperCase().startsWith('ADULT')) return f;
    }
    return _fares.isEmpty ? null : _fares.first;
  }

  /// Local trip number used when no scheduled trip is selected and the
  /// operator sells on a manual route. Keeps receipts, the local DB and server
  /// sync records valid without requiring a pre-scheduled trip.
  String get _manualTripNo {
    final now = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return 'LOCAL-${now.year}${two(now.month)}${two(now.day)}';
  }

  @override
  void dispose() {
    AppState.instance.removeListener(_reload);
    _lugDescCtrl.dispose();
    _lugPriceCtrl.dispose();
    _cashCtrl.dispose();
    _routeCodeCtrl.dispose();
    _routeFromCtrl.dispose();
    _routeToCtrl.dispose();
    _seatCtrl.dispose();
    _driverCtrl.dispose();
    _conductor1Ctrl.dispose();
    _conductor2Ctrl.dispose();
    _customerNameController.dispose();
    _customerPhoneController.dispose();
    super.dispose();
  }

  Future<void> _reload() async {
    final fares = await AppDb.getFares();
    final drivers = await AppDb.getDrivers();
    // One round-trip for every device setting this screen needs, instead of
    // sixteen sequential Future.wait lookups.
    final settings = await AppDb.getSettings(const [
      'currency',
      'company_name',
      'company_slogan',
      'website',
      'customer_care',
      'company_address',
      'company_email',
      'route_code',
      'route_name',
      'bus_reg',
      'trip_no',
      'driver_name',
      'conductor1',
      'conductor2',
      'receipt_prefix',
      'allow_fare_override',
    ]);
    if (!mounted) return;
    setState(() {
      _fares = fares;
      _drivers = drivers;
      _currency = settings['currency'] ?? 'USD';
      _companyName = settings['company_name'] ?? '';
      _slogan = settings['company_slogan'] ?? '';
      _website = settings['website'] ?? '';
      _customerCare = zimPhoneOrEmpty(settings['customer_care'] ?? '');
      _companyAddress = settings['company_address'] ?? '';
      _companyEmail = settings['company_email'] ?? '';
      _routeCode = up(settings['route_code'] ?? '');
      final parts = up(settings['route_name'] ?? '').split(' - ');
      _routeFrom = parts.isNotEmpty ? parts[0].trim() : '';
      _routeTo = parts.length > 1 ? parts[1].trim() : '';
      _busReg = up(settings['bus_reg'] ?? '');
      _tripNo = up(settings['trip_no'] ?? '');
      _driver = up(settings['driver_name'] ?? '');
      _conductor1 = up(settings['conductor1'] ?? '');
      _conductor2 = up(settings['conductor2'] ?? '');
      _ticketPrefix = settings['receipt_prefix'] ?? 'AGJ';
      _allowFareOverride = (settings['allow_fare_override'] ?? '1') == '1';
      _routeCodeCtrl.text = _routeCode;
      _routeFromCtrl.text = _routeFrom;
      _routeToCtrl.text = _routeTo;
      _driverCtrl.text = _driver;
      _conductor1Ctrl.text = _conductor1;
      _conductor2Ctrl.text = _conductor2;
      if (_drivers.isNotEmpty && _driver.isEmpty) {
        _driver = up(_drivers.first.name);
        _driverPhone = _drivers.first.phone;
      }
      _loading = false;
    });
    final profile = await AppDb.getCompanyProfile();
    final activeShift = await AppDb.getActiveShift();
    final role = (await SecureKeystore.instance.readRole()) ?? '';
    final operatorName =
        (await SecureKeystore.instance.readFullName())?.trim() ?? '';
    // The signed-in operator is the conductor on this device. Resolve their
    // profile once (staff-roster record → own name) and freeze it — trips and
    // the admin conductor list never override who is actually logging in here.
    final operatorConductor = await AppDb.findConductorByFullName(operatorName);
    final conductorName = (operatorConductor?.name.isNotEmpty == true
            ? up(operatorConductor!.name)
            : operatorName.isNotEmpty
                ? up(operatorName)
                : _conductor1)
        .trim();
    final conductorPhone = (operatorConductor?.phone ?? _conductorPhone).trim();
    if (!mounted) return;
    setState(() {
      _canEditFares = Roles.canEditFares(role);
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
      _activeShift = activeShift;
      // Lock the logged-in operator as the conductor (read-only everywhere).
      if (conductorName.isNotEmpty) {
        _conductor1 = conductorName;
        _conductor1Ctrl.text = conductorName;
      }
      if (conductorPhone.isNotEmpty) _conductorPhone = conductorPhone;
      // Open shift backs the crew block: prefill the driver so it shows up
      // even when no trip or settings carry crew info. A later trip pick
      // overrides the driver only — the conductor stays frozen to the operator.
      final shift = activeShift;
      if (shift != null) {
        if (_driver.isEmpty && shift.driverName.isNotEmpty) {
          _driver = up(shift.driverName);
          _driverPhone = shift.driverPhone;
          _driverCtrl.text = _driver;
        }
        if (_conductor1.isEmpty && shift.conductorName.isNotEmpty) {
          _conductor1 = up(shift.conductorName);
          _conductorPhone = shift.conductorPhone;
          _conductor1Ctrl.text = _conductor1;
        }
      }
    });
    final activeTrip = await AppDb.getActiveTrip();
    if (activeTrip != null && mounted) {
      setState(() => _activeTrip = activeTrip);
      if (_activeTrip!.id.isNotEmpty && _activeTrip!.tripNo.isNotEmpty) {
        _applyTripToFields(_activeTrip!);
      }
    }
    final runningInstance = await AppDb.getRunningTripInstance();
    if (runningInstance != null && mounted) {
      setState(() => _runningInstance = runningInstance);
    }
    _ensureCatalog();
  }

  /// Pulls open trips + promotions from the server once, mirroring them
  /// locally so sales stay attached to a definite trip even offline.
  Future<void> _ensureCatalog() async {
    if (_catalogLoaded) return;
    _catalogLoaded = true;
    try {
      await SyncService.instance.refreshCatalog();
      final active = await AppDb.getActiveTrip();
      if (active != null) {
        final fresh = await AppDb.getTrip(active.id) ?? active;
        if (mounted) {
          setState(() {
            _activeTrip = fresh;
            _applyTripToFields(fresh);
          });
          await AppDb.setActiveTrip(fresh);
        }
      }
    } catch (_) {}
  }

  /// When the operator edits the route, auto-fill the route code from
  /// FROM/TO (e.g. "Harare"/"Bulawayo" -> "HRE-BYO") unless they already
  /// entered a custom code.
  void _onRouteFieldChanged() {
    setState(() {});
    if (_routeCode.isEmpty &&
        _routeFrom.trim().isNotEmpty &&
        _routeTo.trim().isNotEmpty) {
      final auto = autoRouteCode(_routeFrom.trim(), _routeTo.trim());
      if (auto.isNotEmpty) {
        _routeCode = auto;
        _routeCodeCtrl.text = auto;
      }
    }
  }

  Future<void> _pickDepartureTime() async {
    if (_activeTrip == null || _activeTrip!.departureTime.isEmpty) {
      _showToast('Active trip has no departure time set.');
      return;
    }
    final picked = await showTimePicker(
      context: context,
      initialTime: const TimeOfDay(
        hour: 5,
        minute: 0,
      ),
      helpText: 'Departure time (default ${_activeTrip!.departureTime})',
    );
    if (picked != null && mounted) {
      final formatted = picked.format(context);
      setState(() {
        _departureTime = formatted;
      });
    }
  }

  void _applyTripToFields(Trip t) {
    if (t.tripNo.isNotEmpty) _tripNo = up(t.tripNo);
    if (t.routeFrom.isNotEmpty) _routeFrom = up(t.routeFrom);
    if (t.routeTo.isNotEmpty) _routeTo = up(t.routeTo);
    if (t.routeCode.isNotEmpty) _routeCode = up(t.routeCode);
    if (t.departureTime.isNotEmpty) _departureTime = t.departureTime;
    if (t.busReg.isNotEmpty) _busReg = up(t.busReg);
    if (t.driver.isNotEmpty) {
      _driver = up(t.driver);
      _driverPhone = t.driverPhone;
    }
    // The conductor is deliberately NOT taken from the trip: the logged-in
    // operator is the conductor and their profile stays frozen on this device.
    _routeCodeCtrl.text = _routeCode;
    _routeFromCtrl.text = _routeFrom;
    _routeToCtrl.text = _routeTo;
    _driverCtrl.text = _driver;
    // Auto-seed the scheduled trip's admin-set base fare onto the primary
    // Adult fare. Manual-route sales (no trip) keep the locally cached tariffs.
    if (t.baseFareCents > 0) {
      final adult = _adultFare();
      if (adult != null && adult.id != null) {
        _priceOverrides[adult.id!] = t.baseFareCents;
      }
    }
  }

  List<SaleItem> _currentItems() {
    final out = <SaleItem>[];
    if (_type == TicketType.busFare) {
      for (final f in _fares) {
        final q = _cart[f.id] ?? 0;
        if (q > 0) {
          final price = _priceOverrides[f.id] ?? f.price;
          out.add(
              SaleItem(name: f.name, price: price, qty: q, total: price * q));
        }
      }
    } else {
      out.addAll(_luggage);
    }
    return out;
  }

  int get _totalCents => _currentItems().fold(0, (sum, i) => sum + i.total);

  /// Total cents charged on fare lines whose price was manually overridden.
  /// 0 means standard pricing was used for the whole cart.
  int get _customFareTotal {
    if (_type != TicketType.busFare) return 0;
    var total = 0;
    for (final f in _fares) {
      final q = _cart[f.id] ?? 0;
      if (q > 0 && _priceOverrides.containsKey(f.id)) {
        total += _priceOverrides[f.id]! * q;
      }
    }
    return total;
  }

  /// Crew fields backstopped by the open shift, so tickets always carry the
  /// assigned driver and the logged-in conductor even when no trip is active
  /// or the operator clears a field.
  String get _effectiveDriver =>
      _driver.isEmpty ? up(_activeShift?.driverName ?? '') : _driver;
  String get _effectiveDriverPhone => _driverPhone.isNotEmpty
      ? _driverPhone
      : (_activeShift?.driverPhone ?? '');
  String get _effectiveConductor1 =>
      _conductor1.isEmpty ? up(_activeShift?.conductorName ?? '') : _conductor1;
  String get _effectiveConductorPhone => _conductorPhone.isNotEmpty
      ? _conductorPhone
      : (_activeShift?.conductorPhone ?? '');

  /// Actual vehicle printed on the ticket: the bus the operator opened the
  /// CURRENT shift on always wins, falling back to the trip/settings value
  /// (the shift vehicle is the ground truth of the hardware in the seat).
  String get _effectiveBusReg {
    final shiftReg = up(_activeShift?.vehicleReg ?? '');
    return shiftReg.isNotEmpty ? shiftReg : _busReg;
  }

  TicketData _ticketData({
    String receiptNo = '',
    DateTime? time,
    int tendered = 0,
    String paymentMethod = 'cash',
    int? total,
    String customerName = '',
    String customerMobile = '',
  }) {
    final items = _currentItems();
    return TicketData(
      companyName: _companyName,
      slogan: _slogan,
      ticketType: _type == TicketType.luggage ? 'LUGGAGE TICKET' : 'BUS TICKET',
      receiptNo: receiptNo.isEmpty ? '${_ticketPrefix}0000' : receiptNo,
      time: time ?? DateTime.now(),
      busReg: _effectiveBusReg,
      tripNo: _tripNo,
      website: _website,
      customerCare: _customerCare,
      companyAddress: _companyAddress,
      companyEmail: _companyEmail,
      receiptHeader: _receiptHeader,
      receiptFooter: _receiptFooter,
      routeCode: _routeCode,
      routeName: _routeName,
      items: items,
      total: total ?? _totalCents,
      currency: _currency,
      driver: _effectiveDriver,
      driverPhone: _effectiveDriverPhone,
      conductor1: _effectiveConductor1,
      conductor2: _conductor2,
      conductorPhone: _effectiveConductorPhone,
      seatNumber: _seat,
      departureTime: _departureTime,
      customFare: _customFareTotal,
      note: _type == TicketType.luggage ? kLuggageNote : kTicketValidityNote,
      tendered: tendered,
      paymentMethod: paymentMethod,
      customerName: customerName,
      customerMobile: customerMobile,
    );
  }

  void _setQty(int fareId, int qty) {
    setState(() {
      if (qty <= 0) {
        _cart.remove(fareId);
      } else {
        _cart[fareId] = qty;
      }
    });
  }

  Future<void> _editFarePrice(Fare fare) async {
    if (!_canEditFares) {
      _showToast('You do not have permission to override fares.');
      return;
    }
    if (_activeShift == null) {
      _showToast('Start a driver shift before overriding fares.');
      return;
    }
    if (!_allowFareOverride) {
      _showToast('Manual fare override is disabled. '
          'Ask an admin to enable it in Settings.');
      return;
    }
    final ctrl = TextEditingController(
        text: ((_priceOverrides[fare.id] ?? fare.price) / 100)
            .toStringAsFixed(2));
    final saved = await showDialog<double>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Price for ${fare.name}'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: 'Price'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              final cents = parseMoneyToCents(ctrl.text);
              if (cents == null) return;
              Navigator.of(ctx).pop(cents / 100);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (saved != null) {
      setState(() {
        _priceOverrides[fare.id!] = (saved * 100).round();
      });
    }
  }

  void _addLuggage() {
    final desc = _lugDescCtrl.text.trim();
    final price = parseMoneyToCents(_lugPriceCtrl.text);
    if (desc.isEmpty || price == null) return;
    setState(() {
      _luggage.add(SaleItem(name: desc, price: price, qty: 1, total: price));
    });
    _lugDescCtrl.clear();
    _lugPriceCtrl.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF2EEE6),
      body: SafeArea(
        child: Column(
          children: [
            _header(),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: SegmentedButton<TicketType>(
                segments: const [
                  ButtonSegment(
                    value: TicketType.busFare,
                    label: Text('BUS FARE'),
                    icon: Icon(Icons.directions_bus),
                  ),
                  ButtonSegment(
                    value: TicketType.luggage,
                    label: Text('LUGGAGE'),
                    icon: Icon(Icons.luggage),
                  ),
                ],
                selected: {_type},
                onSelectionChanged: (s) => setState(() => _type = s.first),
                style: const ButtonStyle(
                  visualDensity: VisualDensity.compact,
                ),
              ),
            ),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: _reload,
                      child: SingleChildScrollView(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                        child: Column(
                          children: [
                            _ticketPreview(),
                            const SizedBox(height: 12),
                            _tripDetailsCard(),
                            const SizedBox(height: 12),
                            _itemsSection(),
                          ],
                        ),
                      ),
                    ),
            ),
            _cartBar(),
          ],
        ),
      ),
    );
  }

  Widget _header() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
      child: Column(
        children: [
          Text(
            _companyName,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: Color(0xFF14253A),
            ),
          ),
          if (_slogan.isNotEmpty)
            Text(
              _slogan,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 11,
                fontStyle: FontStyle.italic,
                color: Color(0xFFCA9A2D),
              ),
            ),
        ],
      ),
    );
  }

  Widget _ticketPreview() {
    return TicketPreviewCard(data: _ticketData());
  }

  Widget _tripDetailsCard() {
    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Trip details', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 10),
            _tripSelectorBar(),
            const SizedBox(height: 8),
            _onTheGoButton(),
            const SizedBox(height: 10),
            _tripRunBar(),
            const SizedBox(height: 10),
            _shiftBar(),
            const SizedBox(height: 10),
            Material(
              color: _departureTime.isEmpty
                  ? const Color(0xFFEEF2FF)
                  : const Color(0xFFE8F5E9),
              borderRadius: BorderRadius.circular(8),
              child: InkWell(
                onTap: _pickDepartureTime,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(
                    children: [
                      const Icon(Icons.schedule,
                          size: 18, color: Color(0xFF1B5E20)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _departureTime.isEmpty
                              ? 'Tap to set departure time'
                              : 'Departure $_departureTime',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Icon(Icons.edit_outlined,
                          size: 16,
                          color: _departureTime.isEmpty
                              ? const Color(0xFF64748B)
                              : const Color(0xFF1B5E20)),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  flex: 2,
                  child: TextField(
                    controller: _routeCodeCtrl,
                    textCapitalization: TextCapitalization.characters,
                    onChanged: (v) => setState(() => _routeCode = up(v)),
                    decoration: const InputDecoration(
                      labelText: 'Route code',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 5,
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _routeFromCtrl,
                          textCapitalization: TextCapitalization.characters,
                          onChanged: (v) {
                            _routeFrom = up(v);
                            _onRouteFieldChanged();
                          },
                          decoration: const InputDecoration(
                            labelText: 'From',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                      const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 4),
                        child: Icon(Icons.arrow_forward, size: 18),
                      ),
                      Expanded(
                        child: TextField(
                          controller: _routeToCtrl,
                          textCapitalization: TextCapitalization.characters,
                          onChanged: (v) {
                            _routeTo = up(v);
                            _onRouteFieldChanged();
                          },
                          decoration: const InputDecoration(
                            labelText: 'To',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: _driverDropdown(),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _conductorLockCard(),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _seatCtrl,
                    onChanged: (v) => setState(() => _seat = v.trim()),
                    decoration: const InputDecoration(
                      labelText: 'Seat number',
                      hintText: 'e.g. 45 or A12',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                if (_seat.isNotEmpty)
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFE8F5E9),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.event_seat,
                              size: 16, color: Color(0xFF1B5E20)),
                          const SizedBox(width: 6),
                          Text(
                            'SEAT $_seat',
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w800,
                              color: Color(0xFF1B5E20),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _tripSelectorBar() {
    final hasTrip = _activeTrip != null && _activeTrip!.id.isNotEmpty;
    final manual = _type == TicketType.busFare && !hasTrip && _hasManualRoute;
    final ready = hasTrip || manual;
    // Amber signals "selling on a manual route" (no scheduled trip).
    final accent = manual
        ? const Color(0xFFCA9A2D)
        : (ready ? const Color(0xFF1B5E20) : const Color(0xFFB91C1C));
    final bg = manual
        ? const Color(0xFFFFF8E1)
        : (ready ? const Color(0xFFE8F5E9) : const Color(0xFFFEF2F2));
    final label = hasTrip
        ? up(_activeTrip!.displayName)
        : (manual
            ? 'Manual route (no scheduled trip)'
            : (_type == TicketType.busFare
                ? 'No active trip selected'
                : 'No trip selected (luggage)'));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: _pickTrip,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              border: Border.all(
                color: accent,
                width: 1.5,
              ),
              borderRadius: BorderRadius.circular(8),
              color: bg,
            ),
            child: Row(
              children: [
                Icon(
                  manual
                      ? Icons.alt_route
                      : (hasTrip
                          ? Icons.directions_bus_filled
                          : Icons.error_outline),
                  size: 18,
                  color: accent,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: accent,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Text('CHANGE',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      color: accent,
                    )),
                const Icon(Icons.chevron_right,
                    size: 18, color: Color(0xFF94A3B8)),
              ],
            ),
          ),
        ),
        if (!hasTrip && _type == TicketType.busFare && !_hasManualRoute)
          const Padding(
            padding: EdgeInsets.only(top: 6, left: 4),
            child: Text(
              'Select a scheduled trip or enter a manual route before selling bus fares.',
              style: TextStyle(
                  fontSize: 12,
                  color: Color(0xFFB91C1C),
                  fontWeight: FontWeight.w600),
            ),
          ),
      ],
    );
  }

  /// "On-the-go trip" launcher: opens an unscheduled run from a master route
  /// template when the bus is rolling and no admin schedule exists. The created
  /// trip lands in the same trip selector as a scheduled departure, so everything
  /// downstream (manifest, seat lock, reports) treats it identically.
  Widget _onTheGoButton() {
    if (_type != TicketType.busFare) return const SizedBox.shrink();
    return EmeraldGlassButton(
      icon: Icons.alt_route,
      label: 'On-the-go trip (open an unscheduled run)',
      onPressed: _openOnTheGoTrip,
    );
  }

  Future<void> _openOnTheGoTrip() async {
    final running = _runningInstance;
    if (running != null) {
      _showToast('Trip ${running.tripNo} is running. '
          'End it before opening another run.');
      return;
    }
    final created = await Navigator.of(context).push<Trip>(
      emeraldPageRoute<Trip>(const OnTheGoTripScreen()),
    );
    if (created == null || !mounted) return;
    setState(() {
      _activeTrip = created;
      _applyTripToFields(created);
    });
    _showToast('Run ${created.tripNo} opened for departure.');
  }

  Future<void> _pickTrip() async {
    final picked = await showModalBottomSheet<Trip?>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => _TripPickerSheet(),
    );
    if (picked == null) return;
    // One run at a time: switching schedules while a trip is live could orphan
    // its tickets, so the operator must end the running trip first.
    final running = _runningInstance;
    if (running != null && running.tripId != picked.id) {
      if (!mounted) return;
      _showToast('Trip ${running.tripNo} is running. '
          'End it before switching schedules.');
      return;
    }
    if (!mounted) return;
    setState(() {
      _activeTrip = picked;
      _applyTripToFields(picked);
    });
    await AppDb.setActiveTrip(picked);
    setState(() {});
  }

  /// Bar between the trip selector and the shift bar. When the selected
  /// schedule is open (RUNNING instance exists) it shows the stamped departure
  /// and an END TRIP action; otherwise it offers to open the schedule for
  /// departure. This is the device-side lifecycle that writes the actual
  /// departure/arrival stamps and queues the TRIP_STARTED / TRIP_ENDED replay
  /// events — the server schedule flips ACTIVE/COMPLETED either live or on the
  /// next sync.
  Widget _tripRunBar() {
    final running = _runningInstance;
    final hasTrip = _activeTrip != null && _activeTrip!.id.isNotEmpty;
    final runningThisTrip =
        running != null && running.tripId == _activeTrip?.id;
    // Any RUNNING instance — even one whose trip is no longer the active
    // selection (a "ghost" left by a duplicate-start race or a completed run) —
    // must still surface an END action. Hiding it was what sealed operators
    // out: a ghost with a mismatched/null active trip rendered no bar at all.
    if (running != null) {
      final dep = DateTime.tryParse(running.actualDeparture)?.toLocal();
      final label = runningThisTrip
          ? 'TRIP RUNNING · departed '
              '${dep != null ? fmtDateTime(dep) : '—'}'
          : 'Unfinished run — trip ${running.tripNo}';
      final warning = !runningThisTrip;
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: warning ? const Color(0xFFFEF3C7) : const Color(0xFFE8F5E9),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
              color:
                  warning ? const Color(0xFFB45309) : const Color(0xFF1B5E20),
              width: 1),
        ),
        child: Row(
          children: [
            Icon(warning ? Icons.warning_amber_rounded : Icons.play_circle_fill,
                size: 18,
                color: warning
                    ? const Color(0xFFB45309)
                    : const Color(0xFF1B5E20)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: warning
                      ? const Color(0xFFB45309)
                      : const Color(0xFF1B5E20),
                ),
              ),
            ),
            TextButton.icon(
              onPressed: _endTrip,
              icon: const Icon(Icons.stop_circle_outlined, size: 16),
              label: const Text('END TRIP',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              style: TextButton.styleFrom(
                foregroundColor: const Color(0xFFB91C1C),
              ),
            ),
          ],
        ),
      );
    }
    if (!hasTrip) return const SizedBox.shrink();
    return OutlinedButton.icon(
      onPressed: _startingTrip ? null : _startTrip,
      icon: _startingTrip
          ? const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2))
          : const Icon(Icons.play_arrow, size: 18),
      label: Text(
          _startingTrip ? 'Opening trip…' : 'Start trip (open this schedule)'),
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(40),
        backgroundColor: const Color(0xFFE8F5E9),
        foregroundColor: const Color(0xFF1B5E20),
        side: const BorderSide(color: Color(0xFF1B5E20)),
      ),
    );
  }

  Future<void> _startTrip() async {
    if (_startingTrip) return;
    final trip = _activeTrip;
    if (trip == null || trip.id.isEmpty) return;
    if (_activeShift == null) {
      _showToast('Start a driver shift before opening a trip.');
      return;
    }
    final existing = _runningInstance;
    if (existing != null && existing.tripId != trip.id) {
      _showToast('Trip ${existing.tripNo} is already running. '
          'End it before opening another.');
      return;
    }
    setState(() => _startingTrip = true);
    TripInstance? instance;
    try {
      instance = await TripController.instance.startTrip(
        trip,
        shiftId: _activeShift!.id,
        actualDeparture: DateTime.now(),
      );
    } finally {
      if (mounted) setState(() => _startingTrip = false);
    }
    if (!mounted) return;
    if (instance == null) {
      _showToast('Could not open the trip. '
          'Another trip may still be running.');
      return;
    }
    if (_runningInstance?.id != instance.id) {
      setState(() => _runningInstance = instance);
    }
    _showToast('Trip ${trip.tripNo} opened for departure.');
  }

  Future<void> _endTrip() async {
    final running = _runningInstance;
    if (running == null) return;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('End trip?'),
        content: const Text(
            'Stamp the arrival, release this schedule, and hand the run '
            'summary to the server?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('End trip'),
          ),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    await TripController.instance.endTrip(running);
    if (!mounted) return;
    setState(() {
      _runningInstance = null;
      // Only deselect the trip we actually ended — ending a ghost run for a
      // previously-completed trip must not tear down the operator's current
      // selection (TripController matches the same rule in endTrip).
      if (_activeTrip?.id == running.tripId) _activeTrip = null;
    });
    _showToast('Trip ended. Schedule released.');
  }

  Widget _shiftBar() {
    final s = _activeShift;
    if (s == null) {
      return EmeraldGlassButton(
        onPressed: _openStartShift,
        icon: Icons.play_arrow,
        label: 'Start shift (driver + vehicle)',
      );
    }
    return EmeraldBanner(
      leading: Icons.radio_button_checked,
      onTap: _openStartShift,
      trailing: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.22),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: Colors.white.withValues(alpha: 0.6)),
        ),
        child: const Text(
          'END / VIEW',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w800,
            color: Colors.white,
          ),
        ),
      ),
      child: Text(
        'SHIFT: ${s.driverName.isNotEmpty ? s.driverName : 'Open'}'
        '${s.vehicleReg.isNotEmpty ? ' · ${s.vehicleReg}' : ''}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w800,
          color: Colors.white,
        ),
      ),
    );
  }

  Future<void> _openStartShift() async {
    await Navigator.of(context).push<bool>(
      emeraldPageRoute<bool>(const StartShiftScreen()),
    );
    if (!mounted) return;
    _activeShift = await AppDb.getActiveShift();
    setState(() {});
  }

  Widget _driverDropdown() {
    if (_drivers.isEmpty) {
      return TextField(
        controller: _driverCtrl,
        textCapitalization: TextCapitalization.characters,
        onChanged: (v) => setState(() => _driver = up(v)),
        decoration: const InputDecoration(
          labelText: 'Driver',
          isDense: true,
          border: OutlineInputBorder(),
        ),
      );
    }
    return DropdownButtonFormField<String>(
      initialValue: _driver,
      isExpanded: true,
      decoration: const InputDecoration(
        labelText: 'Driver',
        isDense: true,
        border: OutlineInputBorder(),
      ),
      items: _drivers
          .map((d) => DropdownMenuItem(
              value: d.name,
              child: Text(d.name, overflow: TextOverflow.ellipsis)))
          .toList(),
      onChanged: (v) {
        final d = _drivers.firstWhere((x) => x.name == v,
            orElse: () => Driver(name: v ?? ''));
        setState(() {
          _driver = up(v ?? '');
          _driverPhone = d.phone;
        });
      },
    );
  }

  /// Read-only, white-scaled chip for the frozen conductor (the logged-in
  /// operator). There is deliberately no dropdown here: the conductor profile
  /// is locked after login / shift start and can never be switched per ticket.
  Widget _conductorLockCard() {
    final name = _effectiveConductor1;
    final phone = _effectiveConductorPhone;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFFFDFDFB),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.lock_outline, size: 14, color: Color(0xFF94A3B8)),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                  'CONDUCTOR (locked)',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.5,
                    color: Color(0xFF64748B),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            name.isEmpty ? '—' : name,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w800,
              color: Color(0xFF14253A),
            ),
          ),
          if (phone.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              phone,
              style: const TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                color: Color(0xFF475569),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _itemsSection() {
    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: _type == TicketType.busFare ? _fareList() : _luggageInput(),
      ),
    );
  }

  Widget _fareList() {
    if (_fares.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            const Center(
              child: Text(
                'No fares configured on this device. '
                'Ask an admin to set them up, or send a request below.',
                textAlign: TextAlign.center,
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _requestFare,
              icon: const Icon(Icons.help_outline, size: 18),
              label: const Text('Request a fare'),
            ),
          ],
        ),
      );
    }
    return Column(
      children: [
        for (final f in _fares)
          ListTile(
            dense: true,
            leading: const Icon(Icons.confirmation_number_outlined),
            title: Text(f.name),
            subtitle: TextButton(
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 24),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                alignment: Alignment.centerLeft,
              ),
              onPressed: () => _editFarePrice(f),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    fmtMoney(_priceOverrides[f.id] ?? f.price, _currency),
                    style: TextStyle(
                      color: _priceOverrides[f.id] != null
                          ? Theme.of(context).colorScheme.primary
                          : Colors.grey.shade800,
                      fontWeight: _priceOverrides[f.id] != null
                          ? FontWeight.w700
                          : FontWeight.w600,
                    ),
                  ),
                  if (_fareEditable)
                    Padding(
                      padding: const EdgeInsets.only(left: 4),
                      child: Icon(
                        Icons.edit_outlined,
                        size: 13,
                        color: _priceOverrides[f.id] != null
                            ? Theme.of(context).colorScheme.primary
                            : Colors.blueGrey.shade400,
                      ),
                    ),
                ],
              ),
            ),
            trailing: SizedBox(
              width: 104,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.remove_circle_outline),
                    onPressed: (_cart[f.id] ?? 0) == 0
                        ? null
                        : () => _setQty(f.id!, (_cart[f.id]!) - 1),
                  ),
                  Text('${_cart[f.id] ?? 0}',
                      style: const TextStyle(fontWeight: FontWeight.bold)),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.add_circle_outline),
                    onPressed: () => _setQty(f.id!, (_cart[f.id] ?? 0) + 1),
                  ),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 4),
          child: TextButton.icon(
            onPressed: _requestFare,
            icon: const Icon(Icons.help_outline, size: 16),
            label: const Text('Need another fare? Request it'),
          ),
        ),
      ],
    );
  }

  /// Lets field staff log a fare the device does not carry. The fare catalogue
  /// is an admin revenue control, so this records a request rather than
  /// creating one - an admin approves it from Settings > Fare requests.
  Future<void> _requestFare() async {
    final nameCtrl = TextEditingController();
    final priceCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Request a fare'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Fares are set by your admin. Send the details and they will add '
              'it to the app.',
              style: Theme.of(ctx).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: nameCtrl,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Fare name'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: priceCtrl,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(
                labelText: 'Expected price',
                prefixText: _currency == 'USD' ? r'$' : _currency,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: noteCtrl,
              decoration: const InputDecoration(labelText: 'Note (optional)'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Send request'),
          ),
        ],
      ),
    );
    if (saved != true) return;
    final name = nameCtrl.text.trim();
    final cents = parseMoneyToCents(priceCtrl.text);
    if (name.isEmpty || cents == null) {
      _showToast('Enter a fare name and a valid price.');
      return;
    }
    final added = await AppDb.addFareRequest(
      name: name,
      price: cents,
      note: noteCtrl.text,
      by: _conductor1,
    );
    if (!mounted) return;
    _showToast(added
        ? 'Request sent. An admin will add "$name".'
        : '"$name" is already pending approval.');
  }

  Widget _luggageInput() {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _lugDescCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Description',
                    hintText: 'e.g. 90 trees seedlings',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                width: 110,
                child: TextField(
                  controller: _lugPriceCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: 'Price',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              FilledButton.tonalIcon(
                onPressed: _addLuggage,
                icon: const Icon(Icons.add),
                label: const Text('Add item'),
              ),
              const SizedBox(width: 12),
              if (_luggage.isNotEmpty)
                Expanded(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () => setState(() => _luggage.clear()),
                      child: const Text('Clear all'),
                    ),
                  ),
                ),
            ],
          ),
          for (final i in _luggage)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(i.name),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(fmtMoney(i.price, _currency)),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => setState(() => _luggage.remove(i)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _cartBar() {
    return Material(
      elevation: 8,
      color: Colors.white,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('TOTAL',
                        style: Theme.of(context).textTheme.labelSmall),
                    Text(
                      fmtMoney(_totalCents, _currency),
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                  ],
                ),
              ),
              EmeraldButton(
                expand: true,
                height: 48,
                onPressed: _totalCents == 0 ? null : _startSale,
                icon: Icons.print,
                label: _type == TicketType.luggage
                    ? 'Sell Luggage'
                    : 'Sell & Print',
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _startSale() async {
    _cashCtrl.clear();
    final items = _currentItems();
    final total = _totalCents;

    if (_type == TicketType.busFare &&
        (_activeTrip == null || _activeTrip!.id.isEmpty) &&
        !_hasManualRoute) {
      _showToast(
          'Select a scheduled trip or enter a manual route before selling bus fares.');
      return;
    }

    if (_type == TicketType.busFare && _activeShift == null) {
      await Navigator.of(context)
          .push(emeraldPageRoute<bool>(const StartShiftScreen()));
      if (!mounted) return;
      _activeShift = await AppDb.getActiveShift();
      if (_activeShift == null) {
        _showToast('Start a driver shift before selling bus fares.');
        return;
      }
      setState(() {});
    }

    final promoCtrl = TextEditingController();

    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        // promo/payment state persists inside the sheet's own StatefulBuilder.
        String sheetPayment = 'cash';
        String? promoError;
        String appliedCode = '';
        int discount = 0;
        // Names are required for bus-fare tickets unless the conductor ticks
        // "No name" (rare: a true walk-in with nothing to record). Luggage
        // tickets never require one.
        final isBusFare = _type == TicketType.busFare;
        var noName = false;

        return StatefulBuilder(
          builder: (ctx, setSheet) {
            Future<void> applyPromo() async {
              final code = promoCtrl.text.trim().toUpperCase();
              if (code.isEmpty) return;
              final promo = await AppDb.findPromo(code);
              if (promo == null || !promo.active) {
                setSheet(() {
                  promoError = 'Invalid or inactive promo code.';
                  appliedCode = '';
                  discount = 0;
                });
                return;
              }
              if (promo.minimumCents > total) {
                setSheet(() {
                  promoError =
                      'Minimum spend ${fmtMoney(promo.minimumCents, _currency)} required.';
                  appliedCode = '';
                  discount = 0;
                });
                return;
              }
              setSheet(() {
                promoError = null;
                appliedCode = promo.code;
                discount = promo.discountFor(total);
              });
            }

            final cash = parseMoneyToCents(_cashCtrl.text) ?? 0;
            final due = total - discount < 0 ? 0 : total - discount;
            final cashMethod = sheetPayment == 'cash';
            // A bus-fare ticket needs a passenger name unless "No name" is
            // deliberately ticked — cash handed must also clear the total.
            final nameGiven = _customerNameController.text.trim().isNotEmpty;
            final valid = cashMethod
                ? cash >= due && (nameGiven || isBusFare == false || noName)
                : (nameGiven || isBusFare == false || noName);
            final change = cashMethod ? cash - due : 0;
            return Padding(
              padding:
                  EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
              child: SafeArea(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Passenger details',
                          style: Theme.of(ctx).textTheme.titleMedium),
                      const SizedBox(height: 10),
                      TextField(
                        controller: _customerNameController,
                        textCapitalization: TextCapitalization.characters,
                        decoration: InputDecoration(
                          labelText: 'Customer name & surname',
                          hintText: 'Walk-in passenger',
                          isDense: true,
                          border: const OutlineInputBorder(),
                          errorText: isBusFare && !noName && !nameGiven
                              ? 'Passenger name required'
                              : null,
                        ),
                        onChanged: (_) => setSheet(() {}),
                      ),
                      const SizedBox(height: 4),
                      if (isBusFare)
                        Row(
                          children: [
                            Checkbox(
                              value: noName,
                              onChanged: (v) =>
                                  setSheet(() => noName = v ?? false),
                            ),
                            const Expanded(
                              child: Text('No name available (walk-in)',
                                  style: TextStyle(fontSize: 13)),
                            ),
                          ],
                        ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _customerPhoneController,
                        keyboardType: TextInputType.phone,
                        decoration: const InputDecoration(
                          labelText: 'Phone number',
                          isDense: true,
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const Divider(height: 20),
                      Text('Payment method',
                          style: Theme.of(ctx).textTheme.titleSmall),
                      const SizedBox(height: 8),
                      SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(
                              value: 'cash',
                              label: Text('Cash'),
                              icon: Icon(Icons.payments)),
                          ButtonSegment(
                              value: 'ecocash',
                              label: Text('EcoCash'),
                              icon: Icon(Icons.smartphone)),
                        ],
                        showSelectedIcon: false,
                        selected: {sheetPayment},
                        onSelectionChanged: (s) => setSheet(() {
                          sheetPayment = s.first;
                          _cashCtrl.text = '';
                        }),
                        style: const ButtonStyle(
                            visualDensity: VisualDensity.compact),
                      ),
                      const SizedBox(height: 14),
                      Text('Promo code',
                          style: Theme.of(ctx).textTheme.titleSmall),
                      const SizedBox(height: 8),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: TextField(
                              controller: promoCtrl,
                              textCapitalization: TextCapitalization.characters,
                              decoration: InputDecoration(
                                labelText: 'Code e.g. SAVE10',
                                isDense: true,
                                border: const OutlineInputBorder(),
                                errorText: promoError,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          SizedBox(
                            height: 48,
                            child: FilledButton.tonal(
                              onPressed: applyPromo,
                              child: const Text('Apply'),
                            ),
                          ),
                        ],
                      ),
                      if (appliedCode.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 6),
                          decoration: BoxDecoration(
                            color: const Color(0xFFE8F5E9),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(Icons.local_offer,
                                  size: 14, color: Color(0xFF1B5E20)),
                              const SizedBox(width: 6),
                              Text('$appliedCode applied',
                                  style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: Color(0xFF1B5E20))),
                              const SizedBox(width: 6),
                              Text('−${fmtMoney(discount, _currency)}',
                                  style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w700,
                                      color: Color(0xFF1B5E20))),
                            ],
                          ),
                        ),
                      ],
                      const Divider(height: 20),
                      Text('Confirm sale',
                          style: Theme.of(ctx).textTheme.titleLarge),
                      const SizedBox(height: 10),
                      for (final i in items)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(i.qty > 1
                                    ? '${i.name} (x${i.qty})'
                                    : i.name),
                              ),
                              Text(fmtMoney(i.total, _currency)),
                            ],
                          ),
                        ),
                      if (discount > 0) ...[
                        const Divider(),
                        Row(
                          children: [
                            const Expanded(
                                child: Text('DISCOUNT',
                                    style: TextStyle(
                                        fontWeight: FontWeight.w600))),
                            Text('−${fmtMoney(discount, _currency)}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ],
                      const Divider(),
                      Row(
                        children: [
                          const Expanded(
                              child: Text('TOTAL',
                                  style:
                                      TextStyle(fontWeight: FontWeight.bold))),
                          Text(fmtMoney(due, _currency),
                              style:
                                  const TextStyle(fontWeight: FontWeight.bold)),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (cashMethod) ...[
                        TextField(
                          controller: _cashCtrl,
                          keyboardType: const TextInputType.numberWithOptions(
                              decimal: true),
                          decoration: const InputDecoration(
                            labelText: 'Cash tendered',
                            isDense: true,
                            border: OutlineInputBorder(),
                          ),
                          onChanged: (_) => setSheet(() {}),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            const Expanded(child: Text('Cash tendered')),
                            Text(
                              fmtMoney(cash, _currency),
                              style:
                                  const TextStyle(fontWeight: FontWeight.bold),
                            ),
                          ],
                        ),
                        Row(
                          children: [
                            const Expanded(child: Text('Change')),
                            Text(
                              fmtMoney(change, _currency),
                              style: TextStyle(
                                fontWeight: FontWeight.bold,
                                color: valid
                                    ? Theme.of(ctx).colorScheme.primary
                                    : Theme.of(ctx).colorScheme.error,
                              ),
                            ),
                          ],
                        ),
                      ] else
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Text(
                            'Collect $due via ${paymentMethodLabel(sheetPayment)} and confirm.',
                            style: const TextStyle(
                                fontSize: 13, color: Color(0xFF64748B)),
                          ),
                        ),
                      const SizedBox(height: 14),
                      if (cashMethod) ...[
                        Text('Live preview',
                            style: Theme.of(ctx).textTheme.titleSmall),
                        const SizedBox(height: 8),
                        TicketPreviewCard(
                            data: _ticketData(
                          tendered: cash,
                          paymentMethod: sheetPayment,
                          total: due,
                          customerName: _customerNameController.text.trim(),
                          customerMobile: _customerPhoneController.text.trim(),
                        )),
                        const SizedBox(height: 14),
                      ],
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () => Navigator.of(ctx).pop(),
                            child: const Text('Cancel'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: valid
                                ? () => _confirmSale(cashMethod ? cash : due,
                                    paymentMethod: sheetPayment,
                                    promoCode: appliedCode,
                                    discount: discount,
                                    noName: noName)
                                : null,
                            child: const Text('Confirm & Print'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Future<void> _confirmSale(
    int cash, {
    String paymentMethod = 'cash',
    String promoCode = '',
    int discount = 0,
    bool noName = false,
  }) async {
    // Customer details are bound to the sale + printed ticket via the State-held
    // controllers. A bus-fare ticket records the passenger name verbatim; only
    // an explicit "No name" walk-in stores an empty name (never a fabricated
    // placeholder) so manifests keep clean, real data.
    final name = _customerNameController.text.trim();
    final phone = _customerPhoneController.text.trim();
    debugPrint('Confirming sale for '
        '${name.isEmpty ? 'NO NAME' : name} on shift '
        '${_activeShift?.id ?? '—'}');
    final custName = (name.isEmpty || noName) ? '' : name.toUpperCase();
    final custMobile = zimPhoneOrEmpty(phone);
    final allowed = await SecureKeystore.instance.canSellOffline();
    if (!allowed) {
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
              'Selling is paused: this device has no valid offline authorization. '
              'Connect to the server and sync to continue.'),
        ),
      );
      return;
    }
    final items = _currentItems();
    final total = _totalCents - discount < 0 ? 0 : _totalCents - discount;
    final sale = Sale(
      receiptNo: await AppDb.nextReceiptNo(),
      ticketType: _type.name,
      items: items,
      total: total,
      cash: cash,
      change: paymentMethod == 'cash' ? cash - total : 0,
      routeCode: _routeCode,
      routeName: _routeName,
      busReg: _effectiveBusReg,
      driver: _effectiveDriver,
      driverPhone: _effectiveDriverPhone,
      conductor1: _effectiveConductor1,
      conductor2: _conductor2,
      conductorPhone: _effectiveConductorPhone,
      seatNumber: _seat,
      tripNo: _activeTrip?.tripNo.isNotEmpty == true
          ? _activeTrip!.tripNo
          : (_hasManualRoute ? _manualTripNo : _tripNo),
      tripId: _activeTrip?.id ?? '',
      tripInstanceId: _runningInstance?.id ?? '',
      shiftId: _activeShift?.id ?? '',
      driverId: _activeTrip?.driverId ?? _activeShift?.driverId ?? '',
      conductorId: _activeTrip?.conductorId ?? '',
      paymentMethod: paymentMethod,
      customerName: custName,
      customerMobile: custMobile,
      customFare: _customFareTotal,
      departureTime: _departureTime,
      createdAt: DateTime.now(),
    );

    if (promoCode.isNotEmpty) {
      await AppDb.bumpPromoUsage(promoCode);
    }

    // Persist the sale BEFORE printing. Printing must never block the sale
    // from being recorded — and must never cause it to be inserted twice.
    final int saleId;
    try {
      saleId = await AppDb.insertSale(sale);
      // Keep the local occupancy count fresh so reports reflect it instantly.
      // Best-effort: a bump failure must never roll back an already-saved sale.
      final t = _activeTrip;
      if (t != null && t.id.isNotEmpty && _type == TicketType.busFare) {
        try {
          final bumped = Trip(
            id: t.id,
            tripNo: t.tripNo,
            routeCode: t.routeCode,
            routeFrom: t.routeFrom,
            routeTo: t.routeTo,
            routeName: t.routeName,
            busReg: t.busReg,
            driver: t.driver,
            driverPhone: t.driverPhone,
            driverId: t.driverId,
            conductor: t.conductor,
            conductorPhone: t.conductorPhone,
            conductorId: t.conductorId,
            departureTime: t.departureTime,
            status: t.status,
            totalSeats: t.totalSeats,
            seatsSold: t.seatsSold + 1,
          );
          await AppDb.upsertTrip(bumped);
          await AppDb.setActiveTrip(bumped);
          _activeTrip = bumped;
        } catch (_) {}
      }
    } catch (e) {
      if (!mounted) return;
      Navigator.of(context).pop();
      _showToast('Could not save the ticket: $e');
      return;
    }

    String printMsg;
    try {
      printMsg = await _printReceipt(sale);
      if (printMsg == 'Printed successfully') {
        await AppDb.setPrinted(saleId);
      }
    } catch (e) {
      // Thermal printer lost power / went out of range. The ticket is already
      // in offline history — DO NOT re-insert the sale.
      printMsg = 'Print error: $e. Ticket saved in offline history.';
    } finally {
      // Always close the confirm modal and reset the cart, even on a printer
      // exception — never leave the UI frozen mid-sale.
      if (mounted) {
        Navigator.of(context).pop();
        setState(() {
          _cart.clear();
          _luggage.clear();
        });
      }
    }

    if (!mounted) return;
    if (printMsg.startsWith('Print error')) {
      _showToast(printMsg);
      return;
    }
    await _showResultDialog(sale, printMsg);

    if (!mounted) return;

    // Luggage upsell: bus-fare tickets get a "does this passenger have
    // luggage?" prompt so a linked luggage ticket can be issued right away
    // with the passenger and trip details carried over.
    if (_type == TicketType.busFare && sale.ticketType == 'busFare') {
      final wantsLuggage = await _offerLuggageUpsell();
      if (wantsLuggage == true) {
        final saved = await AppDb.getSaleById(saleId);
        if (saved != null && mounted) {
          await Navigator.of(context).push(
              emeraldPageRoute<void>(LuggageTicketScreen(sourceSale: saved)));
        }
      }
    }
  }

  Future<bool?> _offerLuggageUpsell() {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Luggage?'),
        content: const Text('Does this passenger have luggage to check in?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('No'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Yes'),
          ),
        ],
      ),
    );
  }

  void _showToast(String message) {
    if (!mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<String> _printReceipt(Sale sale) async {
    final address = await AppDb.getSetting('printer_address', null);
    if (address == null || address.isEmpty) {
      return 'No printer configured';
    }
    final ok = await PrinterService.instance.printTicket(
        address: address, data: _saleToTicketData(sale), fromSale: sale);
    return ok ? 'Printed successfully' : 'Print failed';
  }

  TicketData _saleToTicketData(Sale sale) {
    final isLuggage = sale.ticketType == 'luggage';
    return TicketData(
      companyName: _companyName,
      slogan: _slogan,
      ticketType: isLuggage ? 'LUGGAGE TICKET' : 'BUS TICKET',
      receiptNo: sale.receiptNo,
      time: sale.createdAt ?? DateTime.now(),
      busReg: sale.busReg.isNotEmpty ? sale.busReg : _effectiveBusReg,
      tripNo: sale.tripNo.isNotEmpty ? sale.tripNo : _tripNo,
      website: _website,
      customerCare: _customerCare,
      companyAddress: _companyAddress,
      companyEmail: _companyEmail,
      receiptHeader: _receiptHeader,
      receiptFooter: _receiptFooter,
      routeCode: sale.routeCode.isNotEmpty ? sale.routeCode : _routeCode,
      routeName: sale.routeName.isNotEmpty ? sale.routeName : _routeName,
      items: sale.items,
      total: sale.total,
      currency: _currency,
      driver: sale.driver.isNotEmpty ? sale.driver : _effectiveDriver,
      driverPhone: sale.driverPhone.isNotEmpty
          ? sale.driverPhone
          : _effectiveDriverPhone,
      conductor1:
          sale.conductor1.isNotEmpty ? sale.conductor1 : _effectiveConductor1,
      conductor2: sale.conductor2.isNotEmpty ? sale.conductor2 : _conductor2,
      conductorPhone: sale.conductorPhone.isNotEmpty
          ? sale.conductorPhone
          : _effectiveConductorPhone,
      seatNumber: sale.seatNumber.isNotEmpty ? sale.seatNumber : _seat,
      departureTime:
          sale.departureTime.isNotEmpty ? sale.departureTime : _departureTime,
      customFare: sale.customFare,
      customerName: sale.customerName,
      customerMobile: sale.customerMobile,
      paymentMethod: sale.paymentMethod,
      tendered: sale.cash,
      note: isLuggage ? kLuggageNote : kTicketValidityNote,
    );
  }

  Future<void> _showResultDialog(Sale sale, String printMsg) {
    return showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Sale ${sale.receiptNo}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Total   ${fmtMoney(sale.total, _currency)}'),
            Text('Change  ${fmtMoney(sale.change, _currency)}'),
            const SizedBox(height: 10),
            Text(
              printMsg,
              style: TextStyle(
                color: printMsg == 'Printed successfully'
                    ? Theme.of(ctx).colorScheme.primary
                    : Colors.orange.shade800,
              ),
            ),
          ],
        ),
        actions: [
          if (printMsg != 'Printed successfully')
            TextButton(
              onPressed: () {
                Navigator.of(ctx).pop();
                _reprint(sale);
              },
              child: const Text('Reprint'),
            ),
          FilledButton.tonal(
            onPressed: () {
              Navigator.of(ctx).pop();
              _sharePdf(sale);
            },
            child: const Text('Send PDF'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  Future<void> _reprint(Sale sale) async {
    final msg = await _printReceipt(sale);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _sharePdf(Sale sale) async {
    final data = _saleToTicketData(sale);
    await PdfService.instance.shareTicket(data);
  }
}

/// Bottom-sheet broker between the app and the active-trip registry.
class _TripPickerSheet extends StatefulWidget {
  @override
  State<_TripPickerSheet> createState() => _TripPickerSheetState();
}

class _TripPickerSheetState extends State<_TripPickerSheet> {
  List<Trip> _trips = [];
  bool _loading = true;
  bool _refreshing = false;
  bool _isAdmin = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final role = await SecureKeystore.instance.readRole();
    _isAdmin = Roles.isAdmin(role ?? '');
    await _loadLocal();
    _refreshFromServer();
  }

  Future<void> _loadLocal() async {
    final trips =
        await AppDb.getTrips(statuses: const ['SCHEDULED', 'ACTIVE', 'OPEN']);
    if (!mounted) return;
    setState(() {
      _trips = trips;
      _loading = false;
    });
  }

  Future<void> _refreshFromServer() async {
    if (_refreshing) return;
    setState(() => _refreshing = true);
    try {
      await SyncService.instance.refreshCatalog();
      await _loadLocal();
    } catch (_) {}
    if (mounted) setState(() => _refreshing = false);
  }

  Future<void> _createTrip() async {
    final noCtrl = TextEditingController();
    final fromCtrl = TextEditingController();
    final toCtrl = TextEditingController();
    final codeCtrl = TextEditingController();
    final busCtrl = TextEditingController();
    final seatsCtrl = TextEditingController();

    // Auto-fill the route code from From/To unless the operator already
    // typed a custom one ("Harare"/"Bulawayo" -> "HRE-BYO").
    void autofillCode(TextEditingController f, TextEditingController t,
        TextEditingController c) {
      if (c.text.trim().isNotEmpty) return;
      final auto = autoRouteCode(f.text.trim(), t.text.trim());
      if (auto.isNotEmpty) c.text = auto;
    }

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Create trip'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                  controller: noCtrl,
                  decoration: const InputDecoration(
                      labelText: 'Trip no.', isDense: true)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                      child: TextField(
                          controller: fromCtrl,
                          onChanged: (_) =>
                              autofillCode(fromCtrl, toCtrl, codeCtrl),
                          decoration: const InputDecoration(
                              labelText: 'From', isDense: true))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: TextField(
                          controller: toCtrl,
                          onChanged: (_) =>
                              autofillCode(fromCtrl, toCtrl, codeCtrl),
                          decoration: const InputDecoration(
                              labelText: 'To', isDense: true))),
                ],
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                      child: TextField(
                          controller: codeCtrl,
                          decoration: const InputDecoration(
                              labelText: 'Route code', isDense: true))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: TextField(
                          controller: busCtrl,
                          decoration: const InputDecoration(
                              labelText: 'Bus reg', isDense: true))),
                ],
              ),
              const SizedBox(height: 8),
              TextField(
                controller: seatsCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                    labelText: 'Seat capacity', isDense: true),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Create')),
        ],
      ),
    );
    if (ok != true) return;
    final tripNo = noCtrl.text.trim();
    final routeFrom = fromCtrl.text.trim();
    final routeTo = toCtrl.text.trim();
    if (tripNo.isEmpty || routeFrom.isEmpty || routeTo.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('Trip no., From and To are required')));
      }
      return;
    }
    try {
      final trip = await TransitApi.createTrip({
        'tripNo': tripNo,
        'routeCode': codeCtrl.text.trim(),
        'routeFrom': routeFrom,
        'routeTo': routeTo,
        'busReg': busCtrl.text.trim(),
        'totalSeats': int.tryParse(seatsCtrl.text.trim()) ?? 0,
      });
      await AppDb.upsertTrip(trip);
      if (mounted) {
        Navigator.of(context).pop<Trip>(trip);
      }
    } on TransitApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(e.code == 'FORBIDDEN'
              ? 'Admin access required to create trips.'
              : e.message)));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Could not create trip. Check your connection.')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.6,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Text('Select an active trip',
                style: Theme.of(context).textTheme.titleMedium),
          ),
          const SizedBox(height: 4),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 20),
            child: Text(
              'Every ticket sold attaches to this trip.',
              style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              TextButton.icon(
                onPressed: _refreshing ? null : _refreshFromServer,
                icon: _refreshing
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.refresh, size: 18),
                label: Text(_refreshing ? 'Refreshing…' : 'Refresh'),
              ),
              if (_isAdmin)
                TextButton.icon(
                  onPressed: _createTrip,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Create trip'),
                ),
            ],
          ),
          const Divider(height: 1),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _trips.isEmpty
                    ? Center(
                        child: Text(
                          _refreshing
                              ? 'Loading trips…'
                              : 'No scheduled trips yet.\nStart a shift and sell on a manual route, or tap Refresh.',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Color(0xFF64748B)),
                        ),
                      )
                    : ListView.separated(
                        itemCount: _trips.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (ctx, i) {
                          final t = _trips[i];
                          final active =
                              t.status == 'ACTIVE' || t.status == 'OPEN';
                          return ListTile(
                            leading: Icon(
                              active ? Icons.play_circle_fill : Icons.schedule,
                              color: active
                                  ? const Color(0xFF1B5E20)
                                  : const Color(0xFFCA9A2D),
                            ),
                            title: Text(t.displayName,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600)),
                            subtitle: Text(
                                '${t.totalSeats} seats · ${t.seatsSold} sold'),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.of(ctx).pop<Trip>(t),
                          );
                        },
                      ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}
