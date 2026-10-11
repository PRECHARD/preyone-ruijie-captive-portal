/// App identity constants, dependency-free so any layer (API client, previews,
/// settings) can reference the exact build without an import cycle.
///
/// Bumped together with [pubspec.yaml] on every app release. The version is
/// surfaced ONLY in the Flutter UI (login screen, settings/about, drawer) —
/// physical thermal receipts must never print build/version strings.
const kAppVersion = '1.0.0+26';
const kAppVersionShort = '1.0.0';
