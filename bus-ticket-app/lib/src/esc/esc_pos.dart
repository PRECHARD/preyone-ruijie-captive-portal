import 'dart:convert';
import 'dart:typed_data';

class EscPos {
  EscPos._();

  static const int paperCols = 32;

  static Uint8List init() => Uint8List.fromList(const [0x1B, 0x40]);

  static Uint8List bold(bool on) =>
      Uint8List.fromList([0x1B, 0x45, on ? 0x01 : 0x00]);

  static Uint8List alignLeft() => Uint8List.fromList(const [0x1B, 0x61, 0x00]);

  static Uint8List alignCenter() =>
      Uint8List.fromList(const [0x1B, 0x61, 0x01]);

  static Uint8List alignRight() => Uint8List.fromList(const [0x1B, 0x61, 0x02]);

  static Uint8List doubleSize(bool width, bool height) => Uint8List.fromList(
      [0x1D, 0x21, (width ? 0x10 : 0x00) | (height ? 0x01 : 0x00)]);

  static Uint8List fontB(bool on) =>
      Uint8List.fromList([0x1B, 0x4D, on ? 0x01 : 0x00]);

  static Uint8List feed(int lines) =>
      Uint8List.fromList([0x1B, 0x64, lines & 0xFF]);

  static Uint8List cut() => Uint8List.fromList(const [0x1D, 0x56, 0x00]);

  /// Prints a CODE128 barcode centered on the current alignment (`ESC a`).
  /// EPSON `GS k` m=73 — ASCII payload terminated by NUL, CODE128 auto subset.
  /// [heightDots] is the barcode height in dots (89 ≈ 1 cm at 203 DPI; compact
  /// tickets pass ≤ 28 so the bars stay well under the 1 cm spec). [moduleWidth]
  /// is the narrow-module width in dots (2 = fine, standard 58mm density).
  static Uint8List barcode(String data,
      {int heightDots = 28, int moduleWidth = 2}) {
    final buf = BytesBuilder();
    // GS h n — set barcode height.
    buf.add(const [0x1D, 0x68]);
    buf.addByte(heightDots & 0xFF);
    // GS w n — set horizontal (narrow module) width.
    buf.add(const [0x1D, 0x77]);
    buf.addByte(moduleWidth & 0xFF);
    // GS k m <data> NUL — m=73 prints CODE128.
    buf.add(const [0x1D, 0x6B, 0x49]);
    for (final code in data.codeUnits) {
      buf.addByte(code >= 32 && code <= 126 ? code : 0x3F);
    }
    buf.addByte(0x00);
    return buf.toBytes();
  }

  /// EPSON `GS ( k` QR-Code printing (model 2, module size 6, EC level L).
  /// Encodes UTF-8 payload — most ESC/POS printers churn the raw bytes.
  static Uint8List qr(String data) {
    final bytes = utf8.encode(data);
    if (bytes.isEmpty) return Uint8List.fromList(const [0x1B, 0x40]);
    final buf = BytesBuilder();
    // Select print model 2 → GS ( k 04 00 31 41 '2'(0x32)
    buf.add(const [0x1B, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32]);
    // Module size 6 → GS ( k 03 00 31 43 06
    buf.add(const [0x1B, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06]);
    // Error correction level L → GS ( k 03 00 31 45 '0'(0x30)
    buf.add(const [0x1B, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30]);
    // Store data → GS ( k pL pH 31 'P'(0x50) <data> 00
    final storeLen = bytes.length + 3;
    buf.add(const [0x1B, 0x28, 0x6B]);
    buf.addByte(storeLen & 0xFF);
    buf.addByte((storeLen >> 8) & 0xFF);
    buf.add(const [0x31, 0x50]);
    buf.add(bytes);
    buf.addByte(0x00);
    // Print stored data → GS ( k 03 00 31 'Q'(0x51) '0'(0x30)
    buf.add(const [0x1B, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return buf.toBytes();
  }

  static String center(String s, {int width = paperCols}) {
    final t = clip(s, width);
    final pad = width - t.length;
    final left = pad ~/ 2;
    final right = pad - left;
    return '${' ' * left}$t${' ' * right}';
  }

  static String left(String s, {int width = paperCols}) {
    final t = clip(s, width);
    return '$t${' ' * (width - t.length)}';
  }

  static String right(String s, {int width = paperCols}) {
    final t = clip(s, width);
    return '${' ' * (width - t.length)}$t';
  }

  static String divider([String ch = '-']) => ch * paperCols;

  static String clip(String s, int width) =>
      s.length <= width ? s : s.substring(0, width);

  static Uint8List text(String s) {
    final buf = BytesBuilder();
    for (final code in s.codeUnits) {
      buf.addByte(code < 256 ? code : 0x3F);
    }
    return buf.toBytes();
  }
}
