import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../db/app_db.dart';

class SecureKeystore {
  SecureKeystore._();
  static final SecureKeystore instance = SecureKeystore._();

  static const _kDeviceUuid = 'preyone_device_uuid';
  static const _kEd25519Seed = 'preyone_ed25519_seed';
  static const _kAesKey = 'preyone_aes_key';
  static const _kSessionToken = 'preyone_session_token';
  static const _kDeviceToken = 'preyone_device_token';
  static const _kUserId = 'preyone_user_id';
  static const _kUsername = 'preyone_username';
  static const _kFullName = 'preyone_full_name';
  static const _kRole = 'preyone_role';
  static const _kCompanyId = 'preyone_company_id';
  static const _kOfflineLease = 'preyone_offline_lease';
  static const _kServerUrl = 'preyone_server_url';
  static const _kCompanySlug = 'preyone_company_slug';

  final _storage = const FlutterSecureStorage();

  Ed25519? _algo;
  SimpleKeyPair? _keyPair;
  List<int>? _aesKeyBytes;

  String _b64(List<int> bytes) => base64UrlEncode(bytes).replaceAll('=', '');
  List<int> _unb64(String s) {
    var t = s.replaceAll('-', '+').replaceAll('_', '/');
    while (t.length % 4 != 0) {
      t += '=';
    }
    return base64.decode(t);
  }

  /// Persistent hardware identity. Android's ANDROID_ID (Settings.Secure) is
  /// stable across app updates, cache clears, data wipes and re-installs when
  /// the APK is signed with the same key — exactly what terminal registration
  /// needs. Read through a native channel because device_info_plus no longer
  /// exposes it. Fallbacks cover devices/runtimes where it is unavailable.
  static const _identityChannel = MethodChannel('preyone.device/identity');

  static Future<String> _hardwareDeviceId() async {
    try {
      final id = await _identityChannel.invokeMethod<String>('androidId');
      if (id != null && id.isNotEmpty) return id;
    } catch (_) {
      // Unsupported platform or platform channel failure — fall through.
    }
    return '';
  }

  Future<void> init() async {
    _algo = Ed25519();

    // Device UUID — canonical value is the persistent hardware ANDROID_ID.
    // The stored/migrated value is kept for continuity with older installs,
    // but the hardware ID wins so re-installs keep the same terminal identity.
    var uuid = await _hardwareDeviceId();
    if (uuid.isEmpty) {
      final stored = await _storage.read(key: _kDeviceUuid);
      if (stored != null && stored.isNotEmpty) {
        uuid = stored;
      } else {
        final existing = await AppDb.getSetting('device_id', null);
        if (existing != null && existing.isNotEmpty) {
          uuid = existing;
        }
      }
    }
    if (uuid.isEmpty) {
      final rng = Random.secure();
      uuid = List.generate(32, (_) => rng.nextInt(16).toRadixString(16)).join();
    }
    await _storage.write(key: _kDeviceUuid, value: uuid);
    // Mirror for compat with sync: keep setting in sync.
    await AppDb.setSetting('device_id', uuid);

    // Ed25519 keypair (seeds are stored, keypair is recreated on demand).
    final seedStr = await _storage.read(key: _kEd25519Seed);
    if (seedStr != null && seedStr.length >= 40) {
      _keyPair = await _algo!.newKeyPairFromSeed(_unb64(seedStr));
    } else {
      final kp = await _algo!.newKeyPair();
      final extracted = await kp.extract();
      final seedBytes = extracted.bytes;
      await _storage.write(key: _kEd25519Seed, value: _b64(seedBytes));
      _keyPair = kp;
    }

    // AES key for field encryption at rest.
    final aesStr = await _storage.read(key: _kAesKey);
    if (aesStr != null && aesStr.isNotEmpty) {
      _aesKeyBytes = _unb64(aesStr);
    } else {
      final rng = Random.secure();
      _aesKeyBytes = List.generate(32, (_) => rng.nextInt(256));
      await _storage.write(key: _kAesKey, value: _b64(_aesKeyBytes!));
    }
  }

  Future<String> readDeviceUuid() async {
    final v = await _storage.read(key: _kDeviceUuid);
    if (v != null && v.isNotEmpty) return v;
    // Fallback if init wasn't awaited yet (shouldn't happen).
    final fallback = await AppDb.getSetting('device_id', null);
    return fallback ?? '';
  }

  Future<String> publicKeyB64u() async {
    final pub = await _keyPair!.extractPublicKey();
    final bytes = pub.bytes;
    return _b64(bytes);
  }

  Future<List<int>> sign(List<int> message) async {
    final sig = await _algo!.sign(message, keyPair: _keyPair!);
    return sig.bytes;
  }

  List<int> get aesKeyBytes => _aesKeyBytes!;
  String get aesKeyB64u => _b64(_aesKeyBytes!);

  // ── Token + auth session persistence ──────────────────────────────────

  Future<void> saveSessionToken(String token) => _storage.write(key: _kSessionToken, value: token);
  Future<String?> readSessionToken() => _storage.read(key: _kSessionToken);
  Future<void> saveDeviceToken(String token) => _storage.write(key: _kDeviceToken, value: token);
  Future<String?> readDeviceToken() => _storage.read(key: _kDeviceToken);
  Future<void> clearTokens() async {
    await _storage.delete(key: _kSessionToken);
    await _storage.delete(key: _kDeviceToken);
    await _storage.delete(key: _kUserId);
    await _storage.delete(key: _kUsername);
    await _storage.delete(key: _kFullName);
    await _storage.delete(key: _kRole);
    await _storage.delete(key: _kCompanyId);
    await _storage.delete(key: _kOfflineLease);
    await _storage.delete(key: _kCompanySlug);
  }

  Future<void> saveAuthSession({
    required String userId,
    required String username,
    required String fullName,
    required String role,
    required String companyId,
    required String companySlug,
    String? offlineLease,
  }) async {
    await _storage.write(key: _kUserId, value: userId);
    await _storage.write(key: _kUsername, value: username);
    await _storage.write(key: _kFullName, value: fullName);
    await _storage.write(key: _kRole, value: role);
    await _storage.write(key: _kCompanyId, value: companyId);
    await _storage.write(key: _kCompanySlug, value: companySlug);
    if (offlineLease != null) {
      await _storage.write(key: _kOfflineLease, value: offlineLease);
    }
  }

  Future<String?> readUserId() => _storage.read(key: _kUserId);
  Future<String?> readUsername() => _storage.read(key: _kUsername);
  Future<String?> readFullName() => _storage.read(key: _kFullName);
  Future<String?> readRole() => _storage.read(key: _kRole);
  Future<String?> readCompanyId() => _storage.read(key: _kCompanyId);
  Future<String?> readCompanySlug() => _storage.read(key: _kCompanySlug);
  Future<String?> readOfflineLease() => _storage.read(key: _kOfflineLease);

  Future<void> saveOfflineLease(String expiry) => _storage.write(key: _kOfflineLease, value: expiry);
  Future<void> saveServerUrl(String url) => _storage.write(key: _kServerUrl, value: url);
  Future<String?> readServerUrl() async {
    final v = await _storage.read(key: _kServerUrl);
    if (v != null && v.isNotEmpty) return v;
    // Fallback to the legacy settings if present (migration path).
    return await AppDb.getSetting('server_url', null);
  }

  /// Returns true if offline access is still authorized (lease not expired).
  Future<bool> isOfflineAuthorized() async {
    final lease = await readOfflineLease();
    if (lease == null || lease.isEmpty) return false;
    try {
      final expiry = DateTime.parse(lease).toUtc();
      return DateTime.now().toUtc().isBefore(expiry);
    } catch (_) {
      return false;
    }
  }

  /// Gate used before selling/printing tickets.
  ///
  /// Fail-open while no server is configured (legacy standalone mode). Once a
  /// server URL is configured, selling requires a bound device whose offline
  /// authorization lease has not expired.
  Future<bool> canSellOffline() async {
    final url = await readServerUrl();
    if (url == null || url.isEmpty) return true;
    final token = await readDeviceToken();
    if (token == null || token.isEmpty) return false;
    return isOfflineAuthorized();
  }
}