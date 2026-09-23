import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'secure_keystore.dart';

/// Raised whenever the field-encryption key is missing or unusable, so data at
/// rest is never silently written or read in plaintext.
class SecurityException implements Exception {
  const SecurityException(this.message);
  final String message;

  @override
  String toString() => 'SecurityException: $message';
}

class FieldCrypto {
  FieldCrypto._();
  static final FieldCrypto instance = FieldCrypto._();

  static const _version = 'v1';
  static const _prefix = 'enc1:$_version:';

  static const _missingKeyError =
      SecurityException('FieldCrypto: AES key is missing. Refusing to use plaintext.');

  AesGcm? _aes;
  SecretKey? _key;

  /// Call once after SecureKeystore.init() at app startup.
  Future<void> init() async {
    try {
      final keyBytes = SecureKeystore.instance.aesKeyBytes;
      if (keyBytes.length != 32) throw _missingKeyError;
      _aes = AesGcm.with256bits(nonceLength: 12);
      _key = SecretKey(keyBytes);
    } on SecurityException {
      rethrow;
    } catch (_) {
      // aesKeyBytes force-unwraps; convert a missing/unreadable keystore key
      // into an explicit SecurityException instead of a bare null-check crash.
      throw _missingKeyError;
    }
  }

  void _ensureKey() {
    if (_aes == null || _key == null) throw _missingKeyError;
  }

  Future<String?> encrypt(String? plaintext) async {
    if (plaintext == null || plaintext.isEmpty) return plaintext;
    // Security hardening: never silently write plaintext when the key is
    // missing. Fail loudly so at-rest encryption cannot be bypassed.
    _ensureKey();
    final box = await _aes!.encrypt(
      Uint8List.fromList(utf8.encode(plaintext)),
      secretKey: _key!,
    );
    // Format: enc1:v1:<nonce_b64url><ct_b64url><tag_b64url>
    return '$_prefix${base64UrlEncode(box.nonce)}${base64UrlEncode(box.cipherText)}${base64UrlEncode(box.mac.bytes)}';
  }

  Future<String?> decrypt(String? ciphertext) async {
    if (ciphertext == null || ciphertext.isEmpty) return ciphertext;
    if (!ciphertext.startsWith(_prefix)) return ciphertext; // legacy plaintext passthrough
    // Encrypted data present but the key is missing: surface a hard error
    // rather than silently returning empty fields.
    _ensureKey();
    try {
      final raw = ciphertext.substring(_prefix.length);
      // Nonce=12 bytes → 16 chars base64url; mac=16 bytes → ~22 chars base64url;
      // split by reading fixed sizes.
      final nonce = base64Url.decode(base64Url.normalize(raw.substring(0, 16)));
      final tagStr = raw.substring(raw.length - 22);
      final ctStr = raw.substring(16, raw.length - 22);
      final ct = base64Url.decode(base64Url.normalize(ctStr));
      final tag = base64Url.decode(base64Url.normalize(tagStr));
      final secretBox = SecretBox(ct, nonce: nonce, mac: Mac(tag));
      final result = await _aes!.decrypt(secretBox, secretKey: _key!);
      return utf8.decode(result);
    } catch (e) {
      return ''; // decryption failure
    }
  }
}