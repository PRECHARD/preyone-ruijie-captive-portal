const kPlatformName = 'Preyone Transit';
const kPlatformDesc = 'Transport Management & Ticketing Platform';
const kPlatformProvider = 'Preyone Technologies';
const kPlatformUrl = 'www.preyone.com';

const _months = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

String two(int n) => n.toString().padLeft(2, '0');

/// Uppercases a value for storage / printing (names, route codes, bus
/// registrations, vehicle details). Empty and null-safe.
String up(String? value) => value == null ? '' : value.trim().toUpperCase();

/// Printable label for a payment method. Only 'cash' and 'ecocash' are
/// offered by the app; anything stored historically ('one_money', 'mobile',
/// …) still renders legibly so old receipts keep meaning.
String paymentMethodLabel(String method) {
  switch (method.trim().toLowerCase()) {
    case 'cash':
      return 'CASH';
    case 'ecocash':
      return 'ECOCASH';
    default:
      final v = method.trim().toUpperCase().replaceAll('_', ' ');
      return v.isEmpty ? 'CASH' : v;
  }
}

String fmtDateTime(DateTime d) =>
    '${d.year}-${two(d.month)}-${two(d.day)} ${two(d.hour)}:${two(d.minute)}:${two(d.second)}';

String fmtDate(DateTime d) => '${two(d.day)} ${_months[d.month - 1]} ${d.year}';

String fmtTime(DateTime d) =>
    '${two(d.hour)}:${two(d.minute)}:${two(d.second)}';

String fmtMoney(int cents, String code) {
  final sign = cents < 0 ? '-' : '';
  final v = cents.abs();
  final dollars = v ~/ 100;
  final c = (v % 100).toString().padLeft(2, '0');
  final grouped = dollars
      .toString()
      .replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  final base = '$sign$grouped.$c';
  final cc = code.trim().toUpperCase();
  return cc.isEmpty ? base : '$cc $base';
}

/// Normalizes a scheduled departure value for display. Server times arrive as
/// ISO-8601 (e.g. "2026-09-18T13:00:00.000Z") while app-created times are
/// already "HH:mm" — collapses both to a short "HH:mm" label for tickets.
String formatDepartureTime(String v) {
  final trimmed = v.trim();
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})')
      .firstMatch(trimmed);
  if (m != null) return '${m.group(4)}:${m.group(5)}';
  return trimmed;
}

int? parseMoneyToCents(String input) {
  final cleaned = input.trim().replaceAll(',', '.');
  final parts = cleaned.split('.');
  final wholeDigits = parts[0].replaceAll(RegExp(r'[^0-9]'), '');
  final whole = int.tryParse(wholeDigits.isEmpty ? '0' : wholeDigits);
  if (whole == null) return null;
  var cents = whole * 100;
  if (parts.length > 1) {
    var frac = parts[1].replaceAll(RegExp(r'[^0-9]'), '');
    if (frac.isEmpty) return cents;
    if (frac.length > 2) frac = frac.substring(0, 2);
    frac = frac.padRight(2, '0');
    cents += int.parse(frac);
  }
  return cents;
}

/// Spreads [left] and [right] across exactly [totalWidth] columns for 58mm
/// printers. Guarantees at least one space between the pair so the right-hand
/// value never collides with the label.
String formatRow(String left, String right, {int totalWidth = 32}) {
  var spaces = totalWidth - (left.length + right.length);
  if (spaces < 1) spaces = 1;
  return left + (' ' * spaces) + right;
}

/// Truncates [s] to at most [max] characters so a label row never wraps on a
/// 32-column ticket.
String clipText(String s, int max) => s.length <= max ? s : s.substring(0, max);

/// Normalizes a Zimbabwe mobile number for print output. Maps every form of
/// the inner-network prefix back to the real country code "+263" — "+363",
/// bare "363" and trunk-prefixed "0363" — expands local "07x" and "08x"
/// numbers to full "+2637x" / "+2638x" form (also accepting bare "7x"/"8x"),
/// and reports absent numbers as "N/A".
String formatZimPhone(String raw) {
  var v = raw.trim();
  if (v.isEmpty) return 'N/A';
  v = v.replaceAll(RegExp(r'[^0-9+]'), '');
  if (v.startsWith('+363')) {
    v = '+263${v.substring(4)}';
  } else if (v.startsWith('0363')) {
    v = '+263${v.substring(4)}';
  } else if (v.startsWith('363')) {
    v = '+263${v.substring(3)}';
  }
  if (v.startsWith('07') || v.startsWith('08')) {
    v = '+263${v.substring(1)}';
  } else if (v.startsWith('7') || v.startsWith('8')) {
    v = '+263$v';
  }
  return v;
}

/// Same normalization as [formatZimPhone] but returns '' for blank input, so
/// the result can be stored straight into the database. Every phone taken
/// from a user input column stores the Zim Short Code (+263...) form.
String zimPhoneOrEmpty(String raw) {
  final n = formatZimPhone(raw);
  return n == 'N/A' ? '' : n;
}
