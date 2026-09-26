import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../security/secure_keystore.dart';
import '../services/transit_api.dart';
import '../widgets/emerald_ui.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _usernameCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _obscure = true;
  bool _loading = false;
  String? _error;
  bool _offlineAvailable = false;

  @override
  void initState() {
    super.initState();
    _checkOffline();
  }

  Future<void> _checkOffline() async {
    final user = await SecureKeystore.instance.readUsername();
    final ok = await SecureKeystore.instance.isOfflineAuthorized();
    if (!mounted) return;
    setState(() {
      _offlineAvailable = user != null && user.isNotEmpty && ok;
    });
  }

  @override
  void dispose() {
    _usernameCtrl.dispose();
    _passwordCtrl.dispose();
    super.dispose();
  }

  Future<void> _completeOnlineLogin(TransitAccount account) async {
    await SecureKeystore.instance.saveSessionToken(account.sessionToken);
    await SecureKeystore.instance.saveDeviceToken(account.deviceToken);
    await SecureKeystore.instance.saveAuthSession(
      userId: account.userId,
      username: account.username,
      fullName: account.fullName,
      role: account.role,
      companyId: account.companyId,
      companySlug: account.companySlug,
      offlineLease: account.offlineLease,
    );
    await AppDb.setSetting('logged_in', '1');
    await AppDb.setSetting('logged_username', account.username);
    if (!mounted) return;
    Navigator.of(context).pushReplacementNamed('/main');
  }

  Future<void> _showDeviceDialog(String title, String message) async {
    if (!mounted) return;
    setState(() => _loading = false);
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.warning_amber_rounded, color: Color(0xFFB45309)),
        title: Text(title),
        content:
            Text(message, style: const TextStyle(fontSize: 14, height: 1.4)),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  Future<void> _login() async {
    final user = _usernameCtrl.text.trim();
    final pass = _passwordCtrl.text;
    if (user.isEmpty || pass.isEmpty) {
      setState(() => _error = 'Enter your username and password');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final account = await TransitApi.login(user, pass);
      // The screen can be popped while the request is in flight; every dialog
      // below touches this context, so bail out if we are gone.
      if (!mounted) return;

      if (account.deviceDisabled) {
        setState(() {
          _loading = false;
          _error =
              'This device has been disabled. Please contact your administrator.';
        });
        return;
      }
      if (account.deviceMismatch) {
        await _showDeviceDialog(
          'Device linked to another account',
          'This terminal is linked to another staff account. Please request an '
              'admin to unbind the device in the portal.',
        );
        return;
      }
      if (account.needsDeviceRegistration) {
        // First-time device binding.
        final register = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Register this device'),
            content: const Text(
                'Your account will be securely linked to this device.\n\n'
                'This device will be authorized to sell tickets offline and will '
                'remain linked until an administrator resets the binding.'),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('Register device'),
              ),
            ],
          ),
        );
        if (!mounted) return;
        if (register != true) {
          setState(() => _loading = false);
          return;
        }
        final bound = await TransitApi.registerDevice(account);
        if (!mounted) return;
        await _completeOnlineLogin(bound);
        return;
      }

      if (account.deviceToken.isEmpty) {
        setState(() {
          _loading = false;
          _error =
              'This account is not registered on this device. Please contact your administrator.';
        });
        return;
      }
      await _completeOnlineLogin(account);
    } on TransitApiException catch (e) {
      if (!mounted) return;
      final code = e.code?.toUpperCase() ?? '';
      if (code == 'DEVICE_BLOCKED' || code == 'HARDWARE_BLOCKED') {
        await _showDeviceDialog(
          'Terminal blocked',
          'This terminal has been blocked by your operator. Please contact administration.',
        );
        return;
      }
      if (code == 'DEVICE_BOUND_OTHER') {
        await _showDeviceDialog(
          'Device linked to another account',
          'This terminal is linked to another staff account. Please request an '
              'admin to unbind the device in the portal.',
        );
        return;
      }
      setState(() {
        _loading = false;
        _error = e.message;
      });
    } catch (e) {
      // Network unreachable or timeout: fall back to offline authorization.
      final cachedUser = await SecureKeystore.instance.readUsername();
      final offlineOk = await SecureKeystore.instance.isOfflineAuthorized();
      if (cachedUser != null &&
          cachedUser.isNotEmpty &&
          offlineOk &&
          cachedUser.toLowerCase() == user.toLowerCase()) {
        await AppDb.setSetting('logged_in', '1');
        await AppDb.setSetting('logged_username', user);
        if (!mounted) return;
        Navigator.of(context).pushReplacementNamed('/main');
        return;
      }
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error =
            'Cannot reach the server and no offline authorization is available on this device.';
      });
    }
  }

  /// "Forgot Password / PIN?" flow. Fleet staff without a registered portal
  /// email are told to have their operator reset the PIN from the Fleet
  /// dashboard; portal account holders can enter their email (or phone) and
  /// get a preyone.com reset link emailed to them.
  Future<void> _forgotPassword() async {
    final ctrl = TextEditingController();
    final identifier = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Forgot Password / PIN?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'If your staff account was created by your operator, they must '
              'reset your PIN from the Fleet dashboard.',
              style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Registered email on preyone.com',
                hintText: 'you@example.com',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (v) => Navigator.of(ctx).pop(v.trim()),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: const Text('Email reset link'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    ctrl.dispose();
    if (identifier == null || identifier.isEmpty) return;

    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await TransitApi.requestPasswordReset(email: identifier);
      if (!mounted) return;
      setState(() => _loading = false);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
              'If that account is registered, a reset link has been sent.'),
        ),
      );
    } on TransitApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Reset request failed: ${e.message}';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error =
            'Cannot reach the server. If you have a preyone.com account, try again when online.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      body: EmeraldAurora(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Logo
                  Center(
                    child: Container(
                      width: 96,
                      height: 96,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                        border: Border.all(
                            color: const Color(0xFFE2E8F0), width: 1),
                        boxShadow: const [
                          BoxShadow(
                            color: Color(0x14000000),
                            blurRadius: 14,
                            offset: Offset(0, 6),
                          ),
                        ],
                      ),
                      child: ClipOval(
                        child: Image.asset(
                          'assets/logo.png',
                          fit: BoxFit.cover,
                          width: 96,
                          height: 96,
                          errorBuilder: (_, __, ___) => const Icon(
                            Icons.directions_bus_filled,
                            size: 52,
                            color: Color(0xFF1B5E20),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    kPlatformName,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 30,
                      fontWeight: FontWeight.w800,
                      color: Color(0xFF0F1E33),
                      letterSpacing: 0.5,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    kPlatformDesc,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: Color(0xFF64748B),
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 36),
                  Card(
                    elevation: 0,
                    color: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                      side: const BorderSide(color: Color(0xFFE2E8F0)),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.all(22),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          TextField(
                            controller: _usernameCtrl,
                            textCapitalization: TextCapitalization.none,
                            decoration: const InputDecoration(
                              labelText: 'Username',
                              prefixIcon: Icon(Icons.person_outline),
                              border: OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 14),
                          TextField(
                            controller: _passwordCtrl,
                            obscureText: _obscure,
                            onSubmitted: (_) => _login(),
                            decoration: InputDecoration(
                              labelText: 'Password',
                              prefixIcon: const Icon(Icons.lock_outline),
                              border: const OutlineInputBorder(),
                              suffixIcon: IconButton(
                                icon: Icon(_obscure
                                    ? Icons.visibility_off_outlined
                                    : Icons.visibility_outlined),
                                onPressed: () =>
                                    setState(() => _obscure = !_obscure),
                              ),
                            ),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 10),
                            Text(
                              _error!,
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: Colors.red.shade700,
                                fontSize: 13,
                              ),
                            ),
                          ],
                          if (_offlineAvailable) ...[
                            const SizedBox(height: 10),
                            const Text(
                              'Offline sign-in available for this device',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: Color(0xFF1B5E20),
                                fontSize: 12.5,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                          const SizedBox(height: 20),
                          EmeraldButton(
                            expand: true,
                            height: 48,
                            onPressed: _loading ? null : _login,
                            icon: _loading ? null : Icons.login,
                            label: _loading ? 'Signing in...' : 'Login',
                          ),
                          const SizedBox(height: 10),
                          TextButton(
                            onPressed: _loading ? null : _forgotPassword,
                            child: const Text('Forgot Password / PIN?'),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 32),
                  const Text(
                    'Powered by $kPlatformProvider',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12,
                      color: Color(0xFF94A3B8),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    kPlatformUrl,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12, color: Color(0xFF94A3B8)),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'v${kAppVersion.split('+').first}',
                    textAlign: TextAlign.center,
                    style:
                        const TextStyle(fontSize: 12, color: Color(0xFF94A3B8)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
