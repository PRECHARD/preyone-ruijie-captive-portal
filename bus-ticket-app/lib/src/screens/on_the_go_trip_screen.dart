import 'package:flutter/material.dart';

import '../controllers/trip_controller.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../models/route_template.dart';
import '../roles.dart';
import '../security/secure_keystore.dart';
import '../widgets/emerald_ui.dart';
import 'start_shift_screen.dart';

/// Leg direction along a template's stage list.
enum _Direction { forward, returnLeg }

extension on _Direction {
  String get label => this == _Direction.forward
      ? 'FORWARD (origin → terminus)'
      : 'RETURN (terminus → origin)';
}

/// "Conductor on-the-go trip": opens a run that no admin ever scheduled.
///
/// The conductor picks a master route template, the direction of travel and the
/// two stages the bus actually serves on this leg; the fare comes from the
/// template's stage-to-stage matrix (overridable in the same way as any other
/// fare). The resulting trip is device-local (`TRIP-<device>-<timestamp>`): it
/// prints, manifests, syncs its tickets and shows in reports, but it never enters
/// the server schedule board and never queues a trip lifecycle event.
class OnTheGoTripScreen extends StatefulWidget {
  const OnTheGoTripScreen({super.key});

  @override
  State<OnTheGoTripScreen> createState() => _OnTheGoTripScreenState();
}

class _OnTheGoTripScreenState extends State<OnTheGoTripScreen> {
  List<RouteTemplate> _templates = [];
  RouteTemplate? _template;
  _Direction _direction = _Direction.forward;
  int? _boardSeq;
  int? _dropSeq;
  final _fareCtrl = TextEditingController();
  bool _fareOverridden = false;
  bool _loading = true;
  bool _creating = false;
  DriverShift? _shift;
  bool _canOverride = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _fareCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final templates = await AppDb.getActiveRouteTemplates();
    final shift = await AppDb.getActiveShift();
    final role = (await SecureKeystore.instance.readRole()) ?? '';
    final allowOverride =
        (await AppDb.getSetting('allow_fare_override', '1')) == '1';
    final profile = await AppDb.getCompanyProfile();
    final settings = await AppDb.getSettings(const ['currency']);
    if (!mounted) return;
    setState(() {
      _templates = templates;
      _shift = shift;
      _canOverride = allowOverride && Roles.canEditFares(role);
      _currency = profile?.currency.isNotEmpty == true
          ? profile!.currency
          : settings['currency'] ?? 'USD';
      _loading = false;
      if (templates.isNotEmpty) _selectTemplate(templates.first);
    });
  }

  /// Stages in travel order for [template] given the chosen direction.
  List<RouteStage> _stagesFor(RouteTemplate template) {
    final list = [...template.stages]..sort((a, b) => a.seq.compareTo(b.seq));
    return _direction == _Direction.forward ? list : list.reversed.toList();
  }

  /// Stages in travel order for the chosen direction, tagged with their seq.
  List<RouteStage> get _orderedStages {
    final t = _template;
    return t == null ? const [] : _stagesFor(t);
  }

  void _selectTemplate(RouteTemplate t) {
    final ordered = _stagesFor(t);
    setState(() {
      _template = t;
      _boardSeq = ordered.isNotEmpty ? ordered.first.seq : null;
      _dropSeq = ordered.length > 1 ? ordered[1].seq : null;
      _fareOverridden = false;
      _syncFareToMatrix();
    });
  }

  void _flipDirection() {
    setState(() {
      _direction = _direction == _Direction.forward
          ? _Direction.returnLeg
          : _Direction.forward;
      final ordered = _orderedStages;
      _boardSeq = ordered.isNotEmpty ? ordered.first.seq : null;
      _dropSeq = ordered.length > 1 ? ordered[1].seq : null;
      _fareOverridden = false;
      _syncFareToMatrix();
    });
  }

  void _syncFareToMatrix() {
    final cents = _matrixFareCents;
    _fareCtrl.text = (cents / 100).toStringAsFixed(2);
  }

  int get _matrixFareCents {
    final t = _template;
    if (t == null || _boardSeq == null || _dropSeq == null) return 0;
    return t.fareCentsBetween(_boardSeq!, _dropSeq!);
  }

  /// Fare actually charged on the run: the matrix price, or the conductor's
  /// override when one is typed.
  int get _effectiveFareCents {
    if (_fareOverridden) {
      final parsed = parseMoneyToCents(_fareCtrl.text);
      if (parsed != null) return parsed;
    }
    return _matrixFareCents;
  }

  String _currency = 'USD';

  /// Crew line describing the shift the run will be bound to.
  String get _shiftSummary {
    final s = _shift;
    if (s == null) return 'no shift yet';
    final who = s.conductorName.isNotEmpty ? s.conductorName : s.driverName;
    return '${up(who)}${s.vehicleReg.isNotEmpty ? ' · ${up(s.vehicleReg)}' : ''}';
  }

  void _snack(String msg, {SnackBarAction? action}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), action: action, duration: const Duration(seconds: 6)),
    );
  }

  /// Opens a shift first when there is none — a run is always bound to a
  /// conductor and a bus, exactly like a scheduled departure.
  Future<DriverShift?> _ensureShift() async {
    var shift = _shift ?? await AppDb.getActiveShift();
    if (shift == null) {
      if (!mounted) return null;
      await Navigator.of(context).push<bool>(
        emeraldPageRoute<bool>(const StartShiftScreen()),
      );
      if (!mounted) return null;
      shift = await AppDb.getActiveShift();
      if (shift != null) setState(() => _shift = shift);
    }
    return shift;
  }

  /// Stable, collision-free id for a device-created run:
  /// `TRIP-<device>-<epochMillis>`. The server never sees it — the sales push
  /// keeps the id on the ticket for local traceability.
  Future<String> _localTripId() async {
    final uuid = await SecureKeystore.instance.readDeviceUuid();
    var device = up(uuid).replaceAll('-', '');
    if (device.length > 6) device = device.substring(device.length - 6);
    if (device.isEmpty) device = 'DEVICE';
    return 'TRIP-$device-${DateTime.now().millisecondsSinceEpoch}';
  }

  Future<void> _create() async {
    final t = _template;
    if (_creating) return;
    if (t == null) return;
    // One run at a time. This screen is reachable from the ticketing page, so
    // re-check the live instance here rather than trusting the caller's guard:
    // a trip may have been opened between the launcher tap and this submit.
    final running = await AppDb.getRunningTripInstance();
    if (running != null) {
      if (!mounted) return;
      _snack('Trip ${running.tripNo} is running. '
          'End it before opening another run.');
      return;
    }
    if (_boardSeq == null || _dropSeq == null) {
      _snack('Pick where the passenger boards and where they get off.');
      return;
    }
    if (_boardSeq == _dropSeq) {
      _snack('Boarding and destination stage must differ.');
      return;
    }
    final shift = await _ensureShift();
    if (shift == null || !mounted) {
      // The conductor dismissed the shift screen without starting a shift.
      // Explain the requirement and point them at the button that fixes it,
      // rather than leaving a bare failure.
      if (shift == null) {
        _snack(
          'No driver shift is open. Start a shift first, then open the run.',
          action: SnackBarAction(
            label: 'START SHIFT',
            onPressed: () => _ensureShift(),
          ),
        );
      }
      return;
    }

    setState(() => _creating = true);
    final boarding = t.stageAt(_boardSeq!);
    final destination = t.stageAt(_dropSeq!);
    final routeLabel = t.routeLabel(_boardSeq!, _dropSeq!);
    final now = DateTime.now();
    final fare = _effectiveFareCents;

    final trip = Trip(
      id: await _localTripId(),
      tripNo: 'OTG-${two(now.hour)}${two(now.minute)}-${_boardSeq!}'
          '${_dropSeq!}',
      routeCode: t.code.isEmpty ? '' : up(t.code),
      routeFrom: up(boarding?.name),
      routeTo: up(destination?.name),
      routeName: routeLabel,
      busReg: up(shift.vehicleReg),
      driver: up(shift.driverName),
      driverPhone: shift.driverPhone,
      driverId: shift.driverId,
      conductor: up(shift.conductorName),
      conductorPhone: shift.conductorPhone,
      status: 'SCHEDULED',
      baseFareCents: fare,
    );

    await AppDb.upsertTrip(trip);
    final instance =
        await TripController.instance.startTrip(trip, shiftId: shift.id);
    if (!mounted) return;
    setState(() => _creating = false);
    if (instance == null) {
      // Do not leave the run selected: TripController refuses a second RUNNING
      // row, and an active selection pointing at a trip that never opened is
      // what strands the operator on the ticketing page.
      _snack('Could not open the run. Another trip may still be running.');
      return;
    }
    // Only adopt the new run as the active selection once it actually started.
    await AppDb.setActiveTrip(trip);
    if (!mounted) return;
    Navigator.of(context).pop(trip);
  }

  @override
  Widget build(BuildContext context) {
    final stages = _orderedStages;
    return Scaffold(
      appBar: AppBar(
        title: const Text('On-the-go trip'),
        leading: const BackButton(),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _templates.isEmpty
              ? _emptyState()
              : _form(stages),
      bottomNavigationBar: _templates.isEmpty || _loading
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: EmeraldButton(
                  expand: true,
                  height: 50,
                  icon: Icons.play_arrow,
                  label:
                      _creating ? 'Opening run…' : 'Open run & start selling',
                  onPressed: _creating ? null : _create,
                ),
              ),
            ),
    );
  }

  Widget _emptyState() {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.route_outlined, size: 48, color: Color(0xFF94A3B8)),
            SizedBox(height: 14),
            Text(
              'No route templates yet',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
            ),
            SizedBox(height: 8),
            Text(
              'An admin adds a master route (stages + fares) in Settings, then '
              'you can open an unscheduled run from here.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _form(List<RouteStage> stages) {
    final t = _template!;
    final fare = _matrixFareCents;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Master route', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 8),
        DropdownButtonFormField<String>(
          initialValue: t.id,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Template',
            border: OutlineInputBorder(),
          ),
          items: [
            for (final item in _templates)
              DropdownMenuItem(
                value: item.id,
                child: Text(
                  item.name,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: (id) {
            if (id == null) return;
            final picked = _templates.firstWhere((e) => e.id == id);
            _selectTemplate(picked);
          },
        ),
        const SizedBox(height: 12),
        SegmentedButton<_Direction>(
          segments: [
            for (final d in _Direction.values)
              ButtonSegment(
                value: d,
                label: Text(d.label.split(' ').first),
                icon: Icon(d == _Direction.forward
                    ? Icons.arrow_downward
                    : Icons.arrow_upward),
              ),
          ],
          selected: {_direction},
          onSelectionChanged: (_) => _flipDirection(),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: _stagePicker(
                label: 'Board at',
                stages: stages,
                value: _boardSeq,
                onChanged: (seq) => setState(() {
                  _boardSeq = seq;
                  _fareOverridden = false;
                  _syncFareToMatrix();
                }),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _stagePicker(
                label: 'Get off at',
                stages: stages,
                value: _dropSeq,
                onChanged: (seq) => setState(() {
                  _dropSeq = seq;
                  _fareOverridden = false;
                  _syncFareToMatrix();
                }),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: const Color(0xFFE8F5E9),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFF1B5E20)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Route on this run',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: Colors.black.withValues(alpha: 0.6),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                t.routeLabel(_boardSeq ?? 0, _dropSeq ?? 0).isEmpty
                    ? 'Pick both stages'
                    : t.routeLabel(_boardSeq!, _dropSeq!),
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF0F1E33),
                ),
              ),
              const SizedBox(height: 8),
              Text(
                fare > 0
                    ? 'Matrix fare: ${fmtMoney(fare, _currency)}'
                    : 'No matrix fare for this leg — the standard tariff applies.',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF1B5E20),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        if (_canOverride)
          TextField(
            controller: _fareCtrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() => _fareOverridden = true),
            decoration: InputDecoration(
              labelText: 'Fare override (optional)',
              helperText: _canOverride
                  ? 'Leave as-is to charge the template fare (${fmtMoney(_matrixFareCents, _currency)})'
                  : '',
              prefixIcon: const Icon(Icons.payments_outlined),
              border: const OutlineInputBorder(),
            ),
          )
        else
          const Text(
            'Fare overrides are disabled for this account, so the template fare '
            'is charged as-is.',
            style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
          ),
        const SizedBox(height: 10),
        Text(
          'A run is bound to the open shift ($_shiftSummary). You will be asked '
          'to start a shift if none is open.',
          style: const TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
        ),
      ],
    );
  }

  Widget _stagePicker({
    required String label,
    required List<RouteStage> stages,
    required int? value,
    required ValueChanged<int?> onChanged,
  }) {
    return DropdownButtonFormField<int>(
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final s in stages)
          DropdownMenuItem(
            value: s.seq,
            child: Text(up(s.name), overflow: TextOverflow.ellipsis),
          ),
      ],
      onChanged: onChanged,
    );
  }
}
