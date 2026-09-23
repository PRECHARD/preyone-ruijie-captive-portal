import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../models.dart';
import '../receipt.dart';

class PdfService {
  PdfService._();
  static final PdfService instance = PdfService._();

  static pw.Font _normal() => pw.Font.helvetica();
  static pw.Font _bold() => pw.Font.helveticaBold();

  Future<void> shareTicket(TicketData d) async {
    final lines = buildTicketLines(d);
    final doc = pw.Document();
    final hMm = (lines.length * 5.5 + 10).clamp(50, 800).toDouble();
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat(80 * PdfPageFormat.mm, hMm * PdfPageFormat.mm),
      margin: const pw.EdgeInsets.symmetric(horizontal: 2, vertical: 4),
      build: (ctx) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.center,
        mainAxisSize: pw.MainAxisSize.min,
        children: [
          for (final l in lines)
            pw.Text(
              l.text,
              style: pw.TextStyle(
                font: l.bold ? _bold() : _normal(),
                fontSize: l.big ? 14 : (l.small ? 8 : 10),
              ),
              textAlign: pw.TextAlign.center,
            ),
        ],
      ),
    ));
    await Printing.sharePdf(
        bytes: await doc.save(), filename: 'ticket-${d.receiptNo}');
  }

  Future<void> shareReport({
    required String companyName,
    required String currency,
    required DateTime from,
    required DateTime to,
    required List<Sale> sales,
    String tagline = '',
    String companyAddress = '',
    String customerCare = '',
    DriverShift? shift,
  }) async {
    final lines = buildReportLines(
      companyName: companyName,
      currency: currency,
      from: from,
      to: to,
      sales: sales.cast(),
      tagline: tagline,
      companyAddress: companyAddress,
      customerCare: customerCare,
      shift: shift,
    );
    final doc = pw.Document();
    final hMm = (lines.length * 5.5 + 10).clamp(50, 1200).toDouble();
    doc.addPage(pw.Page(
      pageFormat: PdfPageFormat(80 * PdfPageFormat.mm, hMm * PdfPageFormat.mm),
      margin: const pw.EdgeInsets.symmetric(horizontal: 2, vertical: 4),
      build: (ctx) => pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.center,
        mainAxisSize: pw.MainAxisSize.min,
        children: [
          for (final l in lines)
            pw.Text(
              l.text,
              style: pw.TextStyle(
                font: l.bold ? _bold() : _normal(),
                fontSize: l.big ? 14 : (l.small ? 8 : 10),
              ),
              textAlign: pw.TextAlign.center,
            ),
        ],
      ),
    ));
    await Printing.sharePdf(
        bytes: await doc.save(), filename: 'report-${_dateTag(from)}');
  }

  String _dateTag(DateTime d) =>
      '${d.year}${d.month.toString().padLeft(2, '0')}${d.day.toString().padLeft(2, '0')}';
}