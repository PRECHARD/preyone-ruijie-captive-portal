import 'package:bluetooth_print_plus/bluetooth_print_plus.dart';
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../db/app_db.dart';
import '../esc/esc_pos.dart';
import '../format.dart';
import '../roles.dart';
import '../security/secure_keystore.dart';
import '../services/printer_service.dart';
import '../services/session_guard.dart';
import '../services/sync_service.dart';
import '../services/transit_api.dart';
import '../widgets/emerald_ui.dart';
import '../controllers/trip_controller.dart';
import 'promotions_screen.dart';
import 'route_templates_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  static const _currencies = [
    'USD',
    'ZWL',
    'ZAR',
    'GBP',
    'EUR',
    'NGN',
    'KES',
    'UGX',
    'TZS',
    'ETB',
    'GHS',
    'BWP',
    'MZN',
    'MWK',
  ];

  final _companyCtrl = TextEditingController();
  final _sloganCtrl = TextEditingController();
  final _prefixCtrl = TextEditingController();
  final _websiteCtrl = TextEditingController();
  final _careCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();

  String _username = '';
  String _fullName = '';
  String _role = '';
  String _currency = 'USD';
  String _printerAddress = '';
  String _printerName = '';
  bool _scanning = false;
  List<BluetoothDevice> _devices = [];
  List<BluetoothDevice> _pairedDevices = [];
  bool _connecting = false;
  bool _syncing = false;
  bool _forcingEnd = false;
  String _syncStatus = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _companyCtrl.dispose();
    _sloganCtrl.dispose();
    _prefixCtrl.dispose();
    _websiteCtrl.dispose();
    _careCtrl.dispose();
    _addressCtrl.dispose();
    _emailCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final company = await AppDb.getSetting('company_name', '') ?? '';
    final slogan = await AppDb.getSetting('company_slogan', '') ?? '';
    final prefix = await AppDb.getSetting('receipt_prefix', 'AGJ') ?? 'AGJ';
    final currency = await AppDb.getSetting('currency', 'USD') ?? 'USD';
    final website = await AppDb.getSetting('website', '') ?? '';
    final care = await AppDb.getSetting('customer_care', '') ?? '';
    final address = await AppDb.getSetting('company_address', '') ?? '';
    final email = await AppDb.getSetting('company_email', '') ?? '';
    final username = await SecureKeystore.instance.readUsername() ?? '';
    final fullName = await SecureKeystore.instance.readFullName() ?? '';
    final role = await SecureKeystore.instance.readRole() ?? '';
    final addr = await AppDb.getSetting('printer_address', null);
    final name = await AppDb.getSetting('printer_name', null);
    // Mirror the sell screen: prefer the cached server company profile (kept
    // fresh by every refreshCatalog) over local settings so the Settings form
    // shows the same live branding the ticketing screen prints.
    final profile = await AppDb.getCompanyProfile();
    if (!mounted) return;
    setState(() {
      _companyCtrl.text =
          profile?.name.isNotEmpty == true ? profile!.name : company;
      _sloganCtrl.text =
          profile?.slogan.isNotEmpty == true ? profile!.slogan : slogan;
      _prefixCtrl.text = prefix;
      _websiteCtrl.text =
          profile?.website.isNotEmpty == true ? profile!.website : website;
      _careCtrl.text = zimPhoneOrEmpty(profile?.customerCare.isNotEmpty == true
          ? profile!.customerCare
          : care);
      _addressCtrl.text = profile?.companyAddress.isNotEmpty == true
          ? profile!.companyAddress
          : address;
      _emailCtrl.text = profile?.companyEmail.isNotEmpty == true
          ? profile!.companyEmail
          : email;
      _currency =
          profile?.currency.isNotEmpty == true ? profile!.currency : currency;
      _username = username;
      _fullName = fullName;
      _role = role;
      _printerAddress = addr ?? '';
      _printerName = name ?? '';
    });
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  @override
  Widget build(BuildContext context) {
    // Field staff (CONDUCTOR/DRIVER/TICKET_SELLER) see admin configuration
    // greyed out; tapping it explains the restriction instead of hiding it.
    final isAdmin = Roles.isAdmin(_role);
    return Scaffold(
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _adminLocked(_companyCard()),
          const SizedBox(height: 12),
          _adminLocked(_routeTemplatesCard()),
          const SizedBox(height: 12),
          _securityCard(),
          const SizedBox(height: 12),
          _printerCard(),
          if (isAdmin) ...[
            const SizedBox(height: 12),
            _promotionsCard(),
          ] else
            _promosLockedTile(),
          const SizedBox(height: 12),
          _syncCard(),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  /// Renders a card in grayscale for non-admins and shows an "Admin Access
  /// Required" toast on tap. Admins get the fully interactive card.
  Widget _adminLocked(Widget child) {
    if (Roles.isAdmin(_role)) return child;
    return Stack(
      children: [
        Opacity(
          opacity: 0.5,
          child: ColorFiltered(
            colorFilter: const ColorFilter.matrix(<double>[
              0.2126,
              0.7152,
              0.0722,
              0,
              0,
              0.2126,
              0.7152,
              0.0722,
              0,
              0,
              0.2126,
              0.7152,
              0.0722,
              0,
              0,
              0,
              0,
              0,
              1,
              0,
            ]),
            child: AbsorbPointer(child: child),
          ),
        ),
        Positioned.fill(
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: () => _snack('Admin Access Required'),
              splashColor: Colors.transparent,
              highlightColor: Colors.transparent,
            ),
          ),
        ),
      ],
    );
  }

  Widget _promosLockedTile() {
    return Card(
      child: ListTile(
        enabled: false,
        leading: const Icon(Icons.local_offer_outlined),
        title: const Text('Promotions',
            style: TextStyle(color: Color(0xFF94A3B8))),
        onTap: () => _snack('Admin Access Required'),
      ),
    );
  }

  Widget _promotionsCard() {
    return Card(
      child: ListTile(
        leading:
            const Icon(Icons.local_offer_outlined, color: Color(0xFFB45309)),
        title: const Text('Promotions',
            style: TextStyle(fontWeight: FontWeight.w600)),
        subtitle: const Text('Manage voucher promo codes and discounts',
            style: TextStyle(fontSize: 12, color: Color(0xFF64748B))),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context)
            .push(emeraldPageRoute<void>(const PromotionsScreen())),
      ),
    );
  }

  Widget _securityCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Account', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            const Text(
              'Signed in to the Preyone Transit server. Your role and access rights are managed by your administrator.',
              style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 12),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const CircleAvatar(
                backgroundColor: Color(0xFFE8F5E9),
                child: Icon(Icons.person_outline, color: Color(0xFF1B5E20)),
              ),
              title: Text(_fullName.isNotEmpty ? _fullName : _username,
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(
                  '${_username.isNotEmpty ? '@$_username' : 'Not signed in'}'
                  '${_role.isNotEmpty ? '  ·  $_role' : ''}'),
            ),
            const SizedBox(height: 10),
            Text(
              'Preyone Transit  ·  v${kAppVersion.split('+').first}',
              style: const TextStyle(fontSize: 12, color: Color(0xFF94A3B8)),
            ),
          ],
        ),
      ),
    );
  }

  Widget _companyCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Company', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            TextField(
              controller: _companyCtrl,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(
                labelText: 'Company name',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _sloganCtrl,
              decoration: const InputDecoration(
                labelText: 'Slogan (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _prefixCtrl,
                    textCapitalization: TextCapitalization.characters,
                    decoration: const InputDecoration(
                      labelText: 'Ticket prefix',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _currency,
                    decoration: const InputDecoration(
                      labelText: 'Currency',
                      border: OutlineInputBorder(),
                    ),
                    items: _currencies
                        .map((c) => DropdownMenuItem(value: c, child: Text(c)))
                        .toList(),
                    onChanged: (v) => setState(() => _currency = v ?? 'USD'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _websiteCtrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'Website (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _careCtrl,
              decoration: const InputDecoration(
                labelText: 'Customer care (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _addressCtrl,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Company address',
                hintText: '123 Robert Mugabe Road, Harare, Zimbabwe',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _emailCtrl,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Company email (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              onPressed: _saveCompany,
              icon: const Icon(Icons.save_outlined),
              label: const Text('Save company'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _saveCompany() async {
    await AppDb.setSetting('company_name', up(_companyCtrl.text));
    await AppDb.setSetting('company_slogan', _sloganCtrl.text.trim());
    await AppDb.setSetting('receipt_prefix', up(_prefixCtrl.text));
    await AppDb.setSetting('currency', _currency);
    await AppDb.setSetting('website', _websiteCtrl.text.trim());
    await AppDb.setSetting('customer_care', zimPhoneOrEmpty(_careCtrl.text));
    await AppDb.setSetting('company_address', _addressCtrl.text.trim());
    await AppDb.setSetting('company_email', _emailCtrl.text.trim());
    AppState.instance.refresh();
    _snack('Saved');
  }

  Widget _printerCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Bluetooth Printer',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(
                    _printerName.isEmpty
                        ? (_printerAddress.isEmpty
                            ? 'Not configured'
                            : _printerAddress)
                        : '$_printerName\n$_printerAddress',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                FilledButton.tonal(
                  onPressed: (_scanning || _connecting) ? null : _scan,
                  child: const Text('Scan'),
                ),
              ],
            ),
            if (_scanning || _connecting)
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: LinearProgressIndicator(),
              ),
            if (_pairedDevices.isNotEmpty) ...[
              const Padding(
                padding: EdgeInsets.only(top: 12, bottom: 4),
                child: Text('PAIRED PRINTERS',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF64748B))),
              ),
              for (final d in _pairedDevices)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.link),
                  title: Text(d.name.isEmpty ? '(unnamed)' : d.name),
                  subtitle: Text(d.address),
                  trailing: TextButton(
                    onPressed: () => _selectDevice(d),
                    child: const Text('Connect'),
                  ),
                ),
            ],
            if (_devices.isNotEmpty) ...[
              const Padding(
                padding: EdgeInsets.only(top: 12, bottom: 4),
                child: Text('NEARBY PRINTERS',
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: Color(0xFF64748B))),
              ),
              for (final d in _devices)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.print_outlined),
                  title: Text(d.name.isEmpty ? '(unnamed)' : d.name),
                  subtitle: Text(d.address),
                  trailing: TextButton(
                    onPressed: () => _selectDevice(d),
                    child: const Text('Connect'),
                  ),
                ),
            ],
            if (_printerAddress.isNotEmpty)
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _reconnectPrinter,
                    child: const Text('Reconnect'),
                  ),
                  TextButton(
                    onPressed: _testPrint,
                    child: const Text('Test print'),
                  ),
                  TextButton(
                    onPressed: _disconnect,
                    child: const Text('Disconnect'),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _devices = [];
      _pairedDevices = [];
    });
    try {
      // Classic discovery + the phone's paired (bonded) set, since Android
      // hides paired printers from a fresh scan.
      final results = await Future.wait([
        PrinterService.instance.scan(),
        PrinterService.instance.bondedDevices(),
      ]);
      final devices = results[0];
      final paired = results[1];
      if (!mounted) return;
      setState(() {
        // Show a paired printer only once — drop it from the nearby results.
        final pairedAddrs = paired.map((p) => p.address).toSet();
        _devices =
            devices.where((d) => !pairedAddrs.contains(d.address)).toList();
        _pairedDevices = paired;
      });
      if (devices.isEmpty && paired.isEmpty) {
        _snack('No printers found. Turn on Bluetooth & Location Services, '
            'make sure the printer is on and close to the phone, then '
            'rescan. If it still fails, pair it in your phone Settings '
            'and it will appear under "Paired printers".');
      }
    } on Object catch (e) {
      // Any error (Exception, TypeError, StateError…) must never lock the UI
      // on the scanner. Report the failure and let the user retry.
      debugPrint('Printer scan failed: $e');
      if (mounted) {
        _snack('Bluetooth scan failed. Enable Bluetooth and try again.');
      }
    } finally {
      if (mounted) {
        setState(() => _scanning = false);
      }
    }
  }

  Future<void> _selectDevice(BluetoothDevice device) async {
    if (!mounted) return;
    setState(() => _connecting = true);
    bool ok = false;
    try {
      ok = await PrinterService.instance.connect(device);
    } on Object catch (e) {
      debugPrint('Printer connect failed: $e');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
    if (!mounted) return;
    if (!ok) {
      _snack(
          'Could not connect to ${device.name.isEmpty ? device.address : device.name}. '
          'Make sure it is switched on, not connected to another phone/PC, '
          'accept the pairing prompt on this phone if shown, then retry. '
          'If it keeps failing, unpair and re-pair it in phone Settings.');
      return;
    }
    await AppDb.setSetting('printer_address', device.address);
    await AppDb.setSetting('printer_name', device.name);
    setState(() {
      _printerAddress = device.address;
      _printerName = device.name;
    });
    _snack('Connected to ${device.name}');
  }

  Future<void> _reconnectPrinter() async {
    if (_printerAddress.isEmpty) {
      _snack('No printer to reconnect');
      return;
    }
    setState(() => _connecting = true);
    try {
      final ok =
          await PrinterService.instance.connectByAddress(_printerAddress);
      if (!mounted) return;
      _snack(ok
          ? 'Reconnected to ${_printerName.isEmpty ? _printerAddress : _printerName}'
          : 'Could not reconnect: make sure the printer is on and nearby.');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _disconnect() async {
    await PrinterService.instance.disconnect();
    if (!mounted) return;
    setState(() {
      _printerAddress = '';
      _printerName = '';
      _devices = [];
      _pairedDevices = [];
    });
    await AppDb.setSetting('printer_address', '');
    await AppDb.setSetting('printer_name', '');
    _snack('Disconnected');
  }

  Future<void> _testPrint() async {
    final connected =
        await PrinterService.instance.connectByAddress(_printerAddress);
    if (!connected) {
      _snack('Printer not connected');
      return;
    }
    final b = <int>[];
    b.addAll(EscPos.init());
    b.addAll(EscPos.alignCenter());
    b.addAll(EscPos.bold(true));
    b.addAll(EscPos.text('${EscPos.center(_companyCtrl.text)}\n'));
    b.addAll(EscPos.bold(false));
    b.addAll(EscPos.text('${EscPos.center('PRINTER TEST OK')}\n'));
    b.addAll(EscPos.feed(3));
    b.addAll(EscPos.cut());
    final ok = await PrinterService.instance.write(b);
    _snack(ok ? 'Printed test page' : 'Print failed');
  }

  Widget _routeTemplatesCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Route templates',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            const Text(
              'Master routes a conductor uses to open an unscheduled run: list '
              'the stages in travel order and price each leg. Templates stay on '
              'this device and never join the server schedule board.',
              style: TextStyle(fontSize: 12.5),
            ),
            const SizedBox(height: 10),
            EmeraldGlassButton(
              icon: Icons.route_outlined,
              label: 'Manage route templates',
              onPressed: () => Navigator.of(context).push<bool>(
                emeraldPageRoute<bool>(const RouteTemplatesScreen()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _syncCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Offline sync',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            const Text(
              'Sell tickets offline and sync automatically to the '
              'production server when tapped. The server endpoint is built in '
              '— no configuration needed.',
              style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: _syncing ? null : _syncNow,
                icon: _syncing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.sync),
                label: Text(_syncing ? 'Syncing…' : 'Sync Now'),
              ),
            ),
            if (_syncStatus.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_syncStatus,
                    style: Theme.of(context).textTheme.bodySmall),
              ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _syncing || _forcingEnd ? null : _forceEndStuckRun,
              icon: _forcingEnd
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.report_gmailerrorred, size: 18),
              label: Text(_forcingEnd ? 'Ending…' : 'Force End Stuck Run'),
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFFB45309),
                side: const BorderSide(color: Color(0xFFB45309)),
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'If a trip still shows as running after being ended, tap here to '
              'release it. All tickets stay saved and sync normally.',
              style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _forceEndStuckRun() async {
    final running = await AppDb.getRunningTripInstances();
    if (_forcingEnd) return;
    if (running.isEmpty) {
      _snack('No stuck run to release.');
      return;
    }
    final labels = running.map((i) => i.tripNo).toSet().join(', ');
    final unsynced = await AppDb.getUnsyncedSales();
    final pending = unsynced.isEmpty
        ? 'All tickets on this device are synced.'
        : 'Warning: ${unsynced.length} ticket(s) are still unsynced. They are '
            'safe and stay queued — press "Sync Now" afterwards to upload them.';
    if (!mounted) return;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Force end stuck run?'),
        content: Text('Release running trip: $labels.\n\n$pending\n\n'
            'This only clears the local run state — no tickets are deleted.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFFB45309),
            ),
            child: const Text('Force end'),
          ),
        ],
      ),
    );
    if (confirm != true || !mounted) return;
    setState(() => _forcingEnd = true);
    String message;
    try {
      message = await TripController.instance.forceEndStuckRun();
    } finally {
      if (mounted && _forcingEnd) setState(() => _forcingEnd = false);
    }
    if (!mounted) return;
    _snack(message);
    AppState.instance.refresh();
    if (message.startsWith('Ended')) {
      // Queue pending sales are untouched; prompt a sync so nothing lingers.
      await _syncNow();
    }
  }

  Future<void> _syncNow() async {
    setState(() {
      _syncing = true;
      _syncStatus = '';
    });
    // Push pending sales/shifts, then pull the freshest catalog (trips,
    // promotions, company profile, staff roster) so offline selling is current.
    final result = await SyncService.instance.syncNow();
    if (result.ok) {
      await SyncService.instance.refreshCatalog();
    }
    if (!mounted) return;
    setState(() {
      _syncing = false;
      _syncStatus = result.message;
    });
    _snack(result.message);
    AppState.instance.refresh();
    if (result.critical) {
      if (!mounted) return;
      // Force sign out: server revoked/disabled this device/account.
      await SessionGuard.forceLogout(
        context,
        deactivated: result.deviceDisabled,
      );
    }
  }
}
