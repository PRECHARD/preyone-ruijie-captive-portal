import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../src/db/app_db.dart';

/// Runs in a separate isolate for background/terminated-state FCM deliveries.
/// Keep it dependency-light — nothing beyond Firebase messaging is safe here.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  debugPrint('Preyone FCM background: ${message.messageId ?? 'no-id'} '
      '${message.notification?.title ?? ''}');
}

/// Lightweight Firebase Cloud Messaging wrapper for the POS terminal.
///
/// Best-effort: every failure is swallowed so the offline ticketing flow is
/// never blocked by a missing network or missing Firebase configuration.
class FcmService {
  FcmService._();

  static final FcmService instance = FcmService._();

  String _token = '';
  bool _initialized = false;

  /// The FCM registration token for this conductor/terminal, used to dispatch
  /// targeted messages from the server (e.g. offline-shift alerts, seat
  /// conflicts, roll calls). Empty until [init] runs successfully.
  String get token => _token;

  Future<void> init() async {
    if (_initialized) return;
    _initialized = true;

    final messaging = FirebaseMessaging.instance;

    // The Dart-side handler runs in its own isolate and covers background +
    // terminated states. Foreground handling is wired below.
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    final settings = await messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    debugPrint('FCM auth status: ${settings.authorizationStatus}');

    // Registration token for targeted server→terminal push messages.
    final token = await messaging.getToken();
    if (token != null && token.isNotEmpty) {
      _token = token;
      debugPrint('FCM token: $token');
      await AppDb.setSetting('fcm_token', token);
    }

    messaging.onTokenRefresh.listen((refreshed) {
      _token = refreshed;
      debugPrint('FCM token refreshed: $refreshed');
      AppDb.setSetting('fcm_token', refreshed);
    });

    // Foreground messages (app open and in focus).
    FirebaseMessaging.onMessage.listen((message) {
      final title = message.notification?.title ?? 'Preyone Transit';
      final body = message.notification?.body ?? '';
      debugPrint('FCM in-app message [$title] $body');
    });
  }
}
