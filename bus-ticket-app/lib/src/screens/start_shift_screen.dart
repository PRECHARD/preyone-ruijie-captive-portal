import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../security/secure_keystore.dart';
import '../services/sync_service.dart';
import '../services/transit_api.dart';
import '../uuid.dart';

/// A selectable staff member for the "Assigned Driver" dropdown. Populated
/// from the live admin-managed roster (`/staff?role=DRIVER`) or, when offline,
/// from the cached local drivers table.
///
/// Value equality is essential here, not cosmetic. The dropdown compares
/// `initialValue` against `items` and asserts that EXACTLY ONE item matches;
/// without `==` it compares by identity, and this screen builds its option list
/// twice (once in initState, again after the roster sync) producing fresh
/// objects each time. The field would then hold a first-load object that no
/// longer exists in `items`, the assert fires during build, and Flutter paints
/// the whole screen with the red ErrorWidget. Matching on id+name means a
/// refreshed roster is correctly treated as the same selection.
@immutable
class _DriverOption {
  const _DriverOption({required this.id, required this.name, this.phone = ''});

  final String id;
  final String name;
  final String phone;

  @override
  bool operator ==(Object other) =>
      other is _DriverOption && other.id == id && other.name == name;

  @override
  int get hashCode => Object.hash(id, name);

  @override
  String toString() => '_DriverOption($id, $name)';
}

/// Starts (or closes) a driver shift locally: the logged-in operator is
/// locked in as the conductor (name + phone auto-filled from the staff
/// roster), the assigned driver and vehicle are chosen here, and the shift
/// is pushed to the server during the next sync (best-effort).
class StartShiftScreen extends StatefulWidget {
  const StartShiftScreen({super.key});

  @override
  State<StartShiftScreen> createState() => _StartShiftScreenState();
}

class _StartShiftScreenState extends State<StartShiftScreen> {
  List<_DriverOption> _driverOptions = [];
  List<Vehicle> _vehicles = [];
  DriverShift? _activeShift;
  int _ticketCount = 0;
  int _totalCents = 0;
  String _currency = 'USD';
  bool _loading = true;
  bool _busy = false;

  _DriverOption? _selectedDriver;
  Vehicle? _selectedVehicle;
  String _conductorName = '';
  String _conductorPhone = '';
  String _tripReg = '';
  final _vehicleRegCtrl = TextEditingController();
  final _driverNameCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
    // Freshen the admin-managed roster in the background so conductor phones
    // and the driver list are current before a shift starts. Best-effort.
    _primeRoster();
  }

  /// Refreshes the admin-managed roster, then re-reads the local conductor
  /// profile so a phone/name change made in the admin console appears on this
  /// screen immediately (no manual pull-to-refresh needed).
  Future<void> _primeRoster() async {
    await SyncService.instance.syncStaffRoster();
    if (!mounted) return;
    await _load();
  }

  Future<void> _refresh() async {
    await SyncService.instance.syncStaffRoster();
    await _load();
  }

  @override
  void dispose() {
    _vehicleRegCtrl.dispose();
    _driverNameCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final vehicles = await AppDb.getVehicles();
    final shift = await AppDb.getActiveShift();
    var count = 0;
    var total = 0;
    if (shift != null) {
      count = await AppDb.shiftTicketCount(shift.id);
      total = await AppDb.shiftTotalCents(shift.id);
    }
    final currency = await AppDb.getSetting('currency', 'USD') ?? 'USD';

    // The signed-in operator is the conductor on this shift. Their phone is
    // resolved from the admin-managed roster (matched by full name) so it is
    // never typed by hand.
    final operator = (await SecureKeystore.instance.readFullName()) ?? '';
    final rosterConductor = await AppDb.findConductorByFullName(operator);
    final conductorName = (rosterConductor?.name ?? operator).trim();
    final conductorPhone = (rosterConductor?.phone ?? '').trim();

    // Assigned driver: live roster first, cached drivers table as fallback.
    final driverOptions = await _resolveDriverOptions();
    // Schedule inheritance: when the conductor picked an active trip/schedule,
    // the admin pre-assigned driver and vehicle ride along — even offline or
    // when the standalone `/staff?role=DRIVER` roster query is empty/blocked.
    final activeTrip = await AppDb.getActiveTrip();

    if (!mounted) return;
    setState(() {
      _vehicles = vehicles;
      _driverOptions = driverOptions;
      _activeShift = shift;
      _ticketCount = count;
      _totalCents = total;
      _currency = currency;
      _loading = false;
      _conductorName = conductorName;
      _conductorPhone = conductorPhone;
      final trip = activeTrip;
      if (trip != null &&
          (trip.driverId.isNotEmpty || trip.driver.trim().isNotEmpty)) {
        final scheduled = _DriverOption(
          id: trip.driverId,
          name: trip.driver.trim().isEmpty
              ? 'Scheduled driver'
              : trip.driver.trim(),
          phone: trip.driverPhone.trim(),
        );
        _driverOptions = [
          scheduled,
          ..._driverOptions.where((o) => o.id != scheduled.id),
        ];
        _selectedDriver = scheduled;
      }
      _tripReg = up(trip?.busReg.trim() ?? '');
      if (_tripReg.isNotEmpty) {
        _vehicleRegCtrl.text = _tripReg;
        Vehicle? match;
        for (final v in _vehicles) {
          if (up(v.registration) == _tripReg) {
            match = v;
            break;
          }
        }
        _selectedVehicle = match;
      }
      _selectedDriver ??= _defaultDriver(operator, _driverOptions);
      if (_selectedVehicle == null &&
          _vehicles.isNotEmpty &&
          _tripReg.isEmpty) {
        _selectedVehicle = _vehicles.first;
      }
    });
  }

  /// Mirrors the admin-managed DRIVER profiles into the local drivers table,
  /// then returns the live roster (only when one is available). Offline, the
  /// cached drivers table is used so shift setup never blocks.
  Future<List<_DriverOption>> _resolveDriverOptions() async {
    try {
      final staff = await TransitApi.fetchStaff(role: 'DRIVER');
      await AppDb.upsertStaffRoster(staff);
      final active =
          staff.where((s) => s.active && s.fullName.trim().isNotEmpty).toList();
      if (active.isNotEmpty) {
        return [
          for (final s in active)
            _DriverOption(
              id: s.id,
              name: s.fullName.trim(),
              phone: s.phone.trim(),
            ),
        ];
      }
    } catch (_) {
      // Offline — fall through to the cached roster.
    }
    final local = await AppDb.getDrivers();
    return [
      for (final d in local)
        _DriverOption(
          id: d.id?.toString() ?? '',
          name: d.name,
          phone: d.phone,
        ),
    ];
  }

  /// Pre-selects the operator themselves when they hold the DRIVER role.
  ///
  /// Deliberately does NOT fall back to `options.first`. Silently pre-selecting
  /// an arbitrary roster driver is dangerous on a conductor terminal: the driver
  /// printed on the ticket and the one legally on the bus can differ, and nobody
  /// notices until an accident is traced to the wrong name. When the operator is
  /// not themselves a driver we leave the field empty so the assignment is a
  /// deliberate act. `_startShift` already refuses to proceed without one.
  _DriverOption? _defaultDriver(String operator, List<_DriverOption> options) {
    if (options.isEmpty) return null;
    final op = operator.trim().toLowerCase();
    if (op.isEmpty) return null;
    for (final o in options) {
      if (o.name.trim().toLowerCase() == op) return o;
    }
    return null;
  }

  Future<void> _startShift() async {
    if (_conductorPhone.trim().isEmpty) {
      _toast('Your staff profile is missing a phone number. Ask your operator '
          'to complete your staff record before starting a shift.');
      return;
    }
    final driver = _selectedDriver ??
        (_driverNameCtrl.text.trim().isNotEmpty
            ? _DriverOption(id: '', name: _driverNameCtrl.text.trim())
            : null);
    if (driver == null) {
      _toast('Select or type the driver before starting the shift.');
      return;
    }
    final vehicleReg =
        up(_selectedVehicle?.registration ?? _vehicleRegCtrl.text);
    if (vehicleReg.isEmpty) {
      _toast('Select or add a vehicle before starting the shift.');
      return;
    }
    setState(() => _busy = true);
    await AppDb.startShift(
      id: uuidV4(),
      driverId: driver.id,
      driverName: up(driver.name),
      driverPhone: zimPhoneOrEmpty(driver.phone),
      conductorName: up(_conductorName),
      conductorPhone: zimPhoneOrEmpty(_conductorPhone),
      vehicleReg: vehicleReg,
    );
    if (!mounted) return;
    Navigator.of(context).pop(true);
  }

  Future<void> _endShift() async {
    final shift = _activeShift;
    if (shift == null) return;
    setState(() => _busy = true);
    await AppDb.closeActiveShift();
    try {
      await TransitApi.closeShift(shift.id);
    } catch (_) {
      // Offline — the local shift is closed; the server reconciles later.
    }
    if (!mounted) return;
    Navigator.of(context).pop(true);
  }

  Future<void> _addVehicle() async {
    final controller = TextEditingController();
    final reg = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add vehicle'),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(
            labelText: 'Registration',
            hintText: 'e.g. ZAE 1234 or BUS-77',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (reg == null || reg.isEmpty) return;
    final normalized = up(reg);
    await AppDb.addVehicle(normalized);
    final vehicles = await AppDb.getVehicles();
    if (!mounted) return;
    setState(() {
      _vehicles = vehicles;
      if (vehicles.isNotEmpty) {
        _selectedVehicle = vehicles.firstWhere(
            (v) => v.registration == normalized,
            orElse: () => vehicles.first);
      }
    });
  }

  void _toast(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bus shift'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: [
                  _activeShift != null ? _activeShiftCard() : _startShiftCard(),
                ],
              ),
            ),
    );
  }

  Widget _activeShiftCard() {
    final shift = _activeShift!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Card(
          elevation: 2,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _statusPill(),
                const SizedBox(height: 12),
                if (shift.driverName.isNotEmpty) ...[
                  _row(Icons.person, 'Driver', shift.driverName),
                  const SizedBox(height: 8),
                ],
                if (shift.conductorName.isNotEmpty) ...[
                  _row(Icons.badge, 'Conductor', shift.conductorName),
                  const SizedBox(height: 8),
                ],
                if (shift.vehicleReg.isNotEmpty) ...[
                  _row(Icons.directions_bus, 'Vehicle', shift.vehicleReg),
                  const SizedBox(height: 8),
                ],
                if (shift.startedAt != null)
                  _row(Icons.schedule, 'Started',
                      fmtDateTime(shift.startedAt!.toLocal())),
                const Divider(height: 24),
                _row(Icons.confirmation_number, 'Tickets', '$_ticketCount'),
                const SizedBox(height: 8),
                _row(Icons.payments, 'Gross', fmtMoney(_totalCents, _currency)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _busy ? null : _endShift,
          icon: const Icon(Icons.stop_circle_outlined),
          label: const Text('End shift'),
        ),
      ],
    );
  }

  Widget _statusPill() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFE8F5E9),
        borderRadius: BorderRadius.circular(999),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.radio_button_checked, size: 16, color: Color(0xFF1B5E20)),
          SizedBox(width: 6),
          Text(
            'SHIFT OPEN',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w800,
              color: Color(0xFF1B5E20),
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(IconData icon, String label, String value) {
    return Row(
      children: [
        Icon(icon, size: 18, color: const Color(0xFF64748B)),
        const SizedBox(width: 8),
        Text('$label  ',
            style: const TextStyle(fontSize: 13, color: Color(0xFF64748B))),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
        ),
      ],
    );
  }

  Widget _startShiftCard() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Card(
          elevation: 2,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Who is running this shift?',
                    style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 12),
                // Locked-in conductor (the signed-in operator).
                const Row(
                  children: [
                    Icon(Icons.lock_outline,
                        size: 14, color: Color(0xFF94A3B8)),
                    SizedBox(width: 6),
                    Text(
                      'Conductor (you) — locked from your staff profile',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF64748B),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                // Locked-in conductor rendered as a read-only white card.
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFDFDFB),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFE2E8F0)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.person_pin,
                          size: 18, color: Color(0xFF94A3B8)),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _conductorName.isEmpty ? '—' : _conductorName,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w800,
                                color: Color(0xFF14253A),
                              ),
                            ),
                            if (_conductorPhone.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                _conductorPhone,
                                style: const TextStyle(
                                  fontSize: 12.5,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFF475569),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                      const Icon(Icons.lock_outline,
                          size: 14, color: Color(0xFF94A3B8)),
                    ],
                  ),
                ),
                if (_conductorPhone.isEmpty) ...[
                  const SizedBox(height: 6),
                  const Text(
                    'No phone on file — ask your operator to update your '
                    'staff profile so it prints on every ticket.',
                    style: TextStyle(fontSize: 12, color: Color(0xFFB45309)),
                  ),
                ],
                const SizedBox(height: 18),
                const Divider(height: 1),
                const SizedBox(height: 16),
                if (_driverOptions.isEmpty)
                  TextField(
                    controller: _driverNameCtrl,
                    textCapitalization: TextCapitalization.words,
                    decoration: const InputDecoration(
                      labelText: 'Driver name',
                      hintText: 'No drivers on the roster — type the name',
                      isDense: true,
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.person,
                          size: 18, color: Color(0xFF94A3B8)),
                    ),
                  )
                else
                  DropdownButtonFormField<_DriverOption>(
                    initialValue: _selectedDriver,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Assigned Driver',
                      isDense: true,
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.person,
                          size: 18, color: Color(0xFF94A3B8)),
                    ),
                    items: [
                      for (final o in _driverOptions)
                        DropdownMenuItem(
                          value: o,
                          child: Text(o.name, overflow: TextOverflow.ellipsis),
                        ),
                    ],
                    onChanged: (d) => setState(() => _selectedDriver = d),
                  ),
                if (_selectedDriver != null &&
                    _selectedDriver!.phone.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    '${_selectedDriver!.name}  ·  ${_selectedDriver!.phone}',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Color(0xFF64748B),
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                if (_vehicles.isEmpty ||
                    (_tripReg.isNotEmpty && _selectedVehicle == null))
                  TextField(
                    controller: _vehicleRegCtrl,
                    textCapitalization: TextCapitalization.characters,
                    decoration: const InputDecoration(
                      labelText: 'Vehicle registration',
                      hintText: 'e.g. ZAE 1234',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                  )
                else
                  DropdownButtonFormField<Vehicle>(
                    // Key on the registration rather than the instance: the
                    // roster refresh swaps in new Vehicle objects, and the
                    // dropdown assert requires value equality to hold.
                    key: ValueKey<String>(_selectedVehicle?.registration ?? ''),
                    initialValue: _selectedVehicle,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'Vehicle',
                      isDense: true,
                      border: OutlineInputBorder(),
                    ),
                    items: [
                      for (final v in _vehicles)
                        DropdownMenuItem(
                          value: v,
                          child: Text(v.registration,
                              overflow: TextOverflow.ellipsis),
                        ),
                    ],
                    onChanged: (v) => setState(() => _selectedVehicle = v),
                  ),
                const SizedBox(height: 8),
                TextButton.icon(
                  onPressed: _addVehicle,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Add vehicle'),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _busy ? null : _startShift,
          icon: const Icon(Icons.play_arrow),
          label: const Text('Start shift'),
        ),
      ],
    );
  }
}
