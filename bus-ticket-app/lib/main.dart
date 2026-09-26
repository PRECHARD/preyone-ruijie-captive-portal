import 'dart:async';
import 'dart:ui' show PlatformDispatcher;

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'src/app_state.dart';
import 'src/db/app_db.dart';
import 'src/format.dart';
import 'src/models.dart';
import 'src/roles.dart';
import 'src/screens/conductors_screen.dart';
import 'src/screens/dashboard_screen.dart';
import 'src/screens/drivers_screen.dart';
import 'src/screens/history_screen.dart';
import 'src/screens/home_screen.dart';
import 'src/screens/login_screen.dart';
import 'src/screens/reports_screen.dart';
import 'src/screens/settings_screen.dart';
import 'src/security/field_crypto.dart';
import 'src/security/secure_keystore.dart';
import 'src/services/session_guard.dart';
import 'src/services/printer_service.dart';
import 'src/services/sync_service.dart';
import 'src/services/transit_api.dart';
import 'src/widgets/emerald_ui.dart';
import 'services/fcm_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Edge-to-edge: the app draws its own light surface behind the status and
  // navigation bars. Every screen in this app keeps a light background, so the
  // bar icons stay dark (readable in sun) and the bars themselves stay
  // transparent. Set once here; individual screens only need to change the
  // brightness when they render a dark accent under the bar.
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    systemNavigationBarColor: Colors.transparent,
    statusBarIconBrightness: Brightness.dark,
    statusBarBrightness: Brightness.light,
    systemNavigationBarIconBrightness: Brightness.dark,
    systemNavigationBarContrastEnforced: false,
  ));

  // Firebase bootstrap is best-effort and never fatal: an offline terminal or
  // a missing/expired google-services config must not block the local SQLite
  // POS flow from starting. On success, Crashlytics + FCM are wired up.
  try {
    await Firebase.initializeApp();
    FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterFatalError;
    PlatformDispatcher.instance.onError = (error, stack) {
      FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
      return true;
    };
    await FcmService.instance.init();
  } catch (e) {
    debugPrint('Firebase init skipped: $e');
  }

  await AppDb.init();
  await SecureKeystore.instance.init();
  await FieldCrypto.instance.init();
  runApp(const PreyoneTransitApp());
}

class PreyoneTransitApp extends StatelessWidget {
  const PreyoneTransitApp({super.key});

  /// Emerald-flavoured Material 3 theme. The seed stays close to the brand
  /// green so every generated surface/ripple stays in the emerald family,
  /// while the explicit component themes below carry the higher-contrast
  /// surfaces the field terminals need in direct sun.
  static ThemeData _theme() {
    final scheme =
        ColorScheme.fromSeed(seedColor: const Color(0xFF1B5E20)).copyWith(
      primary: kEmeraldDeep,
      onPrimary: Colors.white,
      secondary: kEmeraldJade,
      onSecondary: kEmeraldInk,
      surface: const Color(0xFFF5F7FA),
    );
    return ThemeData(
      colorScheme: scheme,
      useMaterial3: true,
      appBarTheme: const AppBarTheme(
        backgroundColor: Color(0xFFF5F7FA),
        elevation: 0,
        scrolledUnderElevation: 0,
        systemOverlayStyle: SystemUiOverlayStyle.dark,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: kPlatformName,
      debugShowCheckedModeBanner: false,
      theme: _theme(),
      onGenerateRoute: (settings) {
        if (settings.name == '/main') {
          return emeraldPageRoute<void>(const MainShell());
        }
        return null;
      },
      home: const Gate(),
    );
  }
}

class Gate extends StatefulWidget {
  const Gate({super.key});

  @override
  State<Gate> createState() => _GateState();
}

class _GateState extends State<Gate> {
  bool _checking = true;
  bool _loggedIn = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final logged = await AppDb.getSetting('logged_in', '0') ?? '0';
    if (!mounted) return;
    setState(() {
      _loggedIn = logged == '1';
      _checking = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_checking) {
      return const Scaffold(
        backgroundColor: Color(0xFFF5F7FA),
        body: Center(child: CircularProgressIndicator()),
      );
    }
    return _loggedIn ? const MainShell() : const LoginScreen();
  }
}

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

enum _NavItem {
  dashboard('Dashboard', Icons.space_dashboard_outlined, Icons.space_dashboard),
  ticketing('Ticketing', Icons.confirmation_number_outlined,
      Icons.confirmation_number),
  tickets('Tickets', Icons.receipt_long_outlined, Icons.receipt_long),
  drivers(
      'Drivers', Icons.directions_bus_outlined, Icons.directions_bus_filled),
  conductors('Conductors', Icons.supervisor_account_outlined,
      Icons.supervisor_account),
  reports('Reports', Icons.insert_chart_outlined, Icons.insert_chart),
  settings('Settings', Icons.settings_outlined, Icons.settings);

  const _NavItem(this.label, this.icon, this.selectedIcon);
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

class _MainShellState extends State<MainShell> with WidgetsBindingObserver {
  _NavItem _current = _NavItem.dashboard;
  String _role = '';

  final Connectivity _connectivity = Connectivity();
  StreamSubscription<List<ConnectivityResult>>? _connSub;
  bool _wasOnline = false;

  // Near-real-time company/orders sync: while the shell is mounted online, a
  // lightweight catalog pull runs every few minutes (and on app resume) so a
  // company profile edit on the web admin propagates to ticketing, tickets,
  // reports and every receipt without the cashier doing anything. Self-throttled.
  Timer? _catalogTimer;
  bool _catalogSyncing = false;

  static const _titles = {
    _NavItem.dashboard: 'Dashboard',
    _NavItem.ticketing: 'Sell Tickets',
    _NavItem.tickets: 'Tickets',
    _NavItem.drivers: 'Drivers',
    _NavItem.conductors: 'Conductors',
    _NavItem.reports: 'Reports',
    _NavItem.settings: 'Settings',
  };

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    SecureKeystore.instance.readRole().then((role) {
      if (mounted) setState(() => _role = role ?? '');
    });
    _initConnectivityWatcher();
    // Silent periodic catalog sync keeps the server company profile (and open
    // trips) fresh on this terminal while it stays online — see _catalogSync.
    _catalogTimer = Timer.periodic(_catalogSyncInterval, (_) => _catalogSync());
    // Silent reconnect to the last used thermal printer (best-effort). Deferred
    // past the first frame: on this device family (Vivo/Android 14) a Bluetooth
    // channel/permission call racing the shell bootstrap kills the process.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PrinterService.instance.autoReconnect();
    });
  }

  static const _catalogSyncInterval = Duration(minutes: 3);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Backgrounded terminals also learn about a company-profile edit the moment
    // the cashier brings the app back to the foreground.
    if (state == AppLifecycleState.resumed) _catalogSync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _catalogTimer?.cancel();
    _connSub?.cancel();
    super.dispose();
  }

  /// Listens for the device regaining connectivity and pushes any queued
  /// offline sales (then refreshes the catalog) so a reconnect catches up
  /// without the cashier doing anything. A revoked/disabled account detected
  /// during that sync signs the terminal out via [SessionGuard].
  Future<void> _initConnectivityWatcher() async {
    try {
      final results = await _connectivity.checkConnectivity();
      _wasOnline = results.any((r) => r != ConnectivityResult.none);
      _connSub = _connectivity.onConnectivityChanged.listen(
        (results) => _onConnectivityChanged(results),
      );
      if (_wasOnline) _onReconnected();
    } catch (_) {
      // Plugin unavailable on this build — auto-sync silently disabled.
    }
  }

  void _onConnectivityChanged(List<ConnectivityResult> results) {
    final online = results.any((r) => r != ConnectivityResult.none);
    if (online && !_wasOnline) {
      _wasOnline = true;
      _onReconnected();
    } else if (!online) {
      _wasOnline = false;
    }
  }

  /// Lightweight background refresh so a company-profile edit (name, slogan,
  /// website, customer care, receipt header/footer, currency, logo…) made on
  /// the web admin reaches this terminal without the cashier doing anything.
  /// Pulls the catalog (company profile + open trips + promos + roster) into
  /// the local mirror, then nudges every screen that listens to [AppState] to
  /// re-read it. Best-effort and self-throttled: offline or mid-sync waits
  /// for the next tick, and a silent failure never disturbs selling.
  Future<void> _catalogSync() async {
    if (_catalogSyncing || !_wasOnline) return;
    _catalogSyncing = true;
    try {
      final before = await AppDb.getCompanyProfile();
      await SyncService.instance.refreshCatalog();
      // Only re-render everything when the brand actually changed, so a
      // routine 3-minute refresh never resets a cashier's in-progress form.
      final after = await AppDb.getCompanyProfile();
      if (!_sameBrand(before, after)) AppState.instance.refresh();
    } catch (_) {
      // Offline or the pull failed — keep the last local snapshot.
    } finally {
      _catalogSyncing = false;
    }
  }

  /// True when both snapshots expose identical brand fields — the fields every
  /// receipt/screen is rebuilt from. Null-safe: a missing profile != a present
  /// one, so a first-ever pull still triggers a redraw.
  static bool _sameBrand(CompanyProfile? a, CompanyProfile? b) {
    if (a == null || b == null) return a == b;
    return a.id == b.id &&
        a.name == b.name &&
        a.slogan == b.slogan &&
        a.website == b.website &&
        a.customerCare == b.customerCare &&
        a.companyAddress == b.companyAddress &&
        a.companyEmail == b.companyEmail &&
        a.logoUrl == b.logoUrl &&
        a.receiptHeader == b.receiptHeader &&
        a.receiptFooter == b.receiptFooter &&
        a.currency == b.currency;
  }

  Future<void> _onReconnected() async {
    final result = await SyncService.instance.syncNow();
    if (result.ok) {
      if (result.message.isNotEmpty && mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(result.message)));
      }
      await SyncService.instance.refreshCatalog();
      AppState.instance.refresh();
    } else if (result.critical) {
      if (!mounted) return;
      await SessionGuard.forceLogout(
        context,
        deactivated: result.deviceDisabled,
      );
    }
  }

  /// Nav items hidden for field staff: they cannot manage other staff.
  List<_NavItem> get _visibleItems {
    if (Roles.canManageStaff(_role)) return _NavItem.values;
    return _NavItem.values
        .where((i) => i != _NavItem.drivers && i != _NavItem.conductors)
        .toList();
  }

  /// Force ticketing away from a staff-restricted section.
  void _switchTo(_NavItem item) {
    if (!_visibleItems.contains(item)) {
      item = _NavItem.dashboard;
    }
    setState(() => _current = item);
    AppState.instance.refresh();
  }

  void _selectItem(_NavItem item) {
    _switchTo(item);
    Navigator.of(context).pop();
  }

  Widget _body() {
    switch (_current) {
      case _NavItem.dashboard:
        return DashboardScreen(
          onNavigate: (index) {
            // Quick actions jump straight to the target tab (1 = Sell Ticket,
            // 5 = Reports) without going through the drawer.
            final target = switch (index) {
              1 => _NavItem.ticketing,
              5 => _NavItem.reports,
              _ => _NavItem.dashboard,
            };
            _switchTo(target);
          },
        );
      case _NavItem.ticketing:
        return const HomeScreen();
      case _NavItem.tickets:
        return const HistoryScreen();
      case _NavItem.drivers:
        return const DriversScreen();
      case _NavItem.conductors:
        return const ConductorsScreen();
      case _NavItem.reports:
        return const ReportsScreen();
      case _NavItem.settings:
        return const SettingsScreen();
    }
  }

  void _logout() {
    SecureKeystore.instance.clearTokens();
    AppDb.setSetting('logged_in', '0');
    Navigator.of(context).pushReplacement(
      emeraldPageRoute<void>(const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      drawer: Drawer(
        child: SafeArea(
          child: Column(
            children: [
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: const Color(0xFFE8F5E9),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: Image.asset(
                          'assets/logo.png',
                          fit: BoxFit.cover,
                          errorBuilder: (_, __, ___) => const Icon(
                            Icons.directions_bus_filled,
                            color: Color(0xFF1B5E20),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    const Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            kPlatformName,
                            style: TextStyle(
                              fontSize: 17,
                              fontWeight: FontWeight.w800,
                              color: Color(0xFF0F1E33),
                            ),
                          ),
                          Text(
                            kPlatformDesc,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              color: Color(0xFF64748B),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              const Divider(height: 1),
              const SizedBox(height: 8),
              Expanded(
                child: ListView(
                  children: [
                    for (final item in _visibleItems)
                      ListTile(
                        leading: Icon(
                            _current == item ? item.selectedIcon : item.icon),
                        selected: _current == item,
                        selectedColor: const Color(0xFF1B5E20),
                        selectedTileColor: const Color(0xFFE8F5E9),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                        title: Text(item.label,
                            style:
                                const TextStyle(fontWeight: FontWeight.w600)),
                        onTap: () => _selectItem(item),
                      ),
                  ],
                ),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.logout),
                title: const Text('Logout',
                    style: TextStyle(fontWeight: FontWeight.w600)),
                onTap: _logout,
              ),
              const SizedBox(height: 6),
              const Text(
                'Powered by $kPlatformProvider',
                style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
              ),
              const Text(
                kPlatformUrl,
                style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  'v${kAppVersion.split('+').first}',
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
      appBar: AppBar(
        title: Text(_titles[_current]!),
        leading: Builder(
          builder: (ctx) => IconButton(
            icon: const Icon(Icons.menu),
            onPressed: () => Scaffold.of(ctx).openDrawer(),
          ),
        ),
        actions: [
          if (_current == _NavItem.ticketing)
            IconButton(
              tooltip: 'Scan QR code',
              icon: const Icon(Icons.qr_code_scanner),
              onPressed: () {},
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: EmeraldTabEntrance(
        tabKey: _current,
        child: _body(),
      ),
    );
  }
}
