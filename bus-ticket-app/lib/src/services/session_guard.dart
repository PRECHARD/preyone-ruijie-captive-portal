import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../screens/login_screen.dart';
import '../security/secure_keystore.dart';
import 'transit_api.dart';

/// Central sign-out interceptor for server-side auth rejections. When the
/// operator revokes/disabled a staff account or device (HTTP 401/403, or an
/// explicit STAFF_DEACTIVATED / ACCOUNT_DISABLED / DEVICE_BLOCKED code) the
/// terminal must drop its local session and return to the login screen.
class SessionGuard {
  SessionGuard._();

  /// Codes meaning the operator revoked this account/device permanently.
  static const _revokedCodes = {
    'STAFF_DEACTIVATED',
    'ACCOUNT_DISABLED',
    'DEVICE_BLOCKED',
    'HARDWARE_BLOCKED',
    'DEVICE_DISABLED',
    'USER_DISABLED',
    'COMPANY_DISABLED',
  };

  /// True when `code` signals a revoked/disabled account or device.
  static bool isRevoked(String? code) =>
      _revokedCodes.contains((code ?? '').trim().toUpperCase());

  /// True when an HTTP 401/403 (or a revoke/block code from any endpoint)
  /// should force the terminal back to the login screen.
  static bool shouldIntercept(TransitApiException e) {
    final code = (e.code ?? '').trim().toUpperCase();
    return e.statusCode == 401 ||
        e.statusCode == 403 ||
        isRevoked(code) ||
        code == 'SESSION_EXPIRED' ||
        code == 'DEVICE_NOT_FOUND';
  }

  static bool _busy = false;

  /// Clears the local session and routes to [LoginScreen]. When `deactivated`
  /// is true (account/device revoked) an explanatory modal is shown first so
  /// field staff understand why they were signed out.
  static Future<void> forceLogout(
    BuildContext context, {
    String title = 'Account Deactivated',
    String message = 'Your operator account has been deactivated. '
        'Please contact administration.',
    bool deactivated = true,
  }) async {
    if (_busy) return;
    _busy = true;
    try {
      await SecureKeystore.instance.clearTokens();
      await AppDb.setSetting('logged_in', '0');
      await AppDb.setSetting('logged_username', '');
      if (!context.mounted) return;
      if (deactivated) {
        await showDialog<void>(
          context: context,
          barrierDismissible: false,
          builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.block, color: Color(0xFFB45309)),
            title: Text(title),
            content: Text(
              message,
              style: const TextStyle(fontSize: 14, height: 1.4),
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
        );
        if (!context.mounted) return;
      }
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const LoginScreen()),
        (route) => false,
      );
    } finally {
      _busy = false;
    }
  }
}