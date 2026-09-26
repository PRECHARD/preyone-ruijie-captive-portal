import 'package:barcode_widget/barcode_widget.dart';
import 'package:flutter/material.dart';
import '../format.dart';
import '../receipt.dart';

/// Live 1:1 mirror of the 58mm thermal ticket. Every row mirrors the exact
/// print layout produced by `buildTicketLines` — full-width centered company
/// name, the company address + customer-care number directly beneath it, bold
/// tagline, the BUS: / TKT: metadata row with equal bold typography, crew +
/// passenger rows, the payment breakdown (Payment Method / Cash Tendered /
/// Change) computed from `tendered` directly under the total, the per-type
/// ticket statement, an underline + space before a footer carrying ONLY the
/// disclaimer + website, and a QR code + full-width CODE128 barcode below it.
/// Nothing is shown here that does not print.
class TicketPreviewCard extends StatelessWidget {
  const TicketPreviewCard({super.key, required this.data});
  final TicketData data;

  static const _navy = Color(0xFF14253A);
  static const _ink = Color(0xFF26323F);
  static const _muted = Color(0xFF6E7B8A);
  static const _amber = Color(0xFFCA9A2D);
  static const _dividerColor = Color(0xFFECE7DE);
  static const _amberg = Color(0xFFFBF5E6);

  String get _website {
    final w = data.website.trim();
    return w.isEmpty ? kPlatformUrl : w;
  }

  @override
  Widget build(BuildContext context) {
    final company = up(data.companyName);
    final hasRoute = data.routeCode.isNotEmpty || data.routeName.isNotEmpty;
    final hasSeat = data.seatNumber.trim().isNotEmpty;
    final hasStaff = data.driver.isNotEmpty ||
        data.conductor1.isNotEmpty ||
        data.conductor2.isNotEmpty;
    final hasItems = data.items.isNotEmpty;

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _dividerColor, width: 1.2),
        boxShadow: const [
          BoxShadow(
            color: Color(0x18000000),
            blurRadius: 20,
            offset: Offset(0, 8),
          ),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(height: 5, color: _amber),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _header(company),
                const SizedBox(height: 16),
                _identityRow(),
                const SizedBox(height: 14),
                if (hasRoute) ...[
                  _journeySection(),
                  const SizedBox(height: 14),
                ],
                if (hasSeat) ...[
                  _seatLine(),
                  const SizedBox(height: 16),
                ],
                _divider(),
                const SizedBox(height: 14),
                if (hasStaff) ...[
                  _staffSection(),
                  const SizedBox(height: 14),
                ],
                _customerSection(),
                const SizedBox(height: 14),
                _divider(),
                const SizedBox(height: 14),
                if (hasItems) ...[
                  _fareSection(),
                  const SizedBox(height: 10),
                ],
                _totalRow(),
                const SizedBox(height: 8),
                _paymentBreakdown(),
                const SizedBox(height: 12),
                _validityNote(),
                const SizedBox(height: 12),
                _divider(),
                const SizedBox(height: 16),
                _footer(),
                const SizedBox(height: 14),
                _qrCode(),
                const SizedBox(height: 14),
                _barcode(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _header(String company) {
    return Column(
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(
            company,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 21,
              fontWeight: FontWeight.w800,
              color: _navy,
              letterSpacing: 0.5,
              height: 1.2,
            ),
          ),
        ),
        _contactStrip(),
        if (data.slogan.trim().isNotEmpty) ...[
          const SizedBox(height: 3),
          Text(
            up(data.slogan),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: _amber,
              letterSpacing: 0.6,
            ),
          ),
        ],
        const SizedBox(height: 10),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
          decoration: BoxDecoration(
            color: _navy,
            borderRadius: BorderRadius.circular(99),
          ),
          child: Text(
            up(data.ticketType),
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: Colors.white,
              letterSpacing: 2,
            ),
          ),
        ),
      ],
    );
  }

  /// Company address, then the customer-care number — directly beneath the
  /// company name exactly as the printed header block lays them out.
  Widget _contactStrip() {
    final address = up(data.companyAddress).trim();
    final care = formatZimPhone(data.customerCare);
    if (address.isEmpty && care == 'N/A') return const SizedBox.shrink();
    return Column(
      children: [
        if (address.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text(
            address,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w500,
              color: _muted,
              height: 1.35,
            ),
          ),
        ],
        if (care != 'N/A') ...[
          const SizedBox(height: 2),
          Text(
            'CUSTOMER CARE  $care',
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              color: _muted,
              height: 1.3,
            ),
          ),
        ],
      ],
    );
  }

  /// Bus registration and ticket number — equal bold typography, exactly as
  /// the printed `BUS: …` / `TKT: #…` metadata row. Date + time and the
  /// conditional seat line sit directly beneath it.
  Widget _identityRow() {
    return Column(
      children: [
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _identityTile('BUS', up(data.busReg))),
              const SizedBox(width: 12),
              Expanded(
                child: _identityTile('TKT', '#${up(data.receiptNo)}'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              fmtDate(data.time),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: _muted,
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 10),
              child: Icon(Icons.circle, size: 4, color: _dividerColor),
            ),
            Text(
              fmtTime(data.time),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: _ink,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _identityTile(String label, String value) {
    final showValue = value.isNotEmpty && up(value) != '#';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFF6F4F0),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        children: [
          Text(
            label,
            style: const TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w600,
              color: _muted,
              letterSpacing: 2,
            ),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              showValue ? value : '—',
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w800,
                color: _navy,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _seatLine() {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: _amberg,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: _amber.withValues(alpha: 0.3)),
        ),
        child: Text(
          'SEAT ${up(data.seatNumber)}',
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w800,
            color: _navy,
          ),
        ),
      ),
    );
  }

  Widget _journeySection() {
    final parts = routeParts(up(data.routeName));
    final hasFromTo = parts.length >= 2;
    return Column(
      children: [
        if (hasFromTo)
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _journeyLabel('FROM', parts[0])),
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 8),
                child: Padding(
                  padding: EdgeInsets.only(top: 22),
                  child: Icon(Icons.arrow_forward, size: 16, color: _amber),
                ),
              ),
              Expanded(child: _journeyLabel('TO', parts[1])),
            ],
          )
        else
          Center(
            child: Text(
              up(data.routeName),
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: _ink,
                height: 1.35,
              ),
            ),
          ),
        if (data.routeCode.isNotEmpty) ...[
          const SizedBox(height: 2),
          Text(
            up(data.routeCode),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: _amber,
              letterSpacing: 1.5,
            ),
          ),
        ],
      ],
    );
  }

  Widget _journeyLabel(String label, String value) {
    return Column(
      children: [
        Text(
          label,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w600,
            color: _muted,
            letterSpacing: 2,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w800,
            color: _navy,
            height: 1.25,
          ),
        ),
      ],
    );
  }

  Widget _staffSection() {
    return Column(
      children: [
        if (data.driver.isNotEmpty)
          _staffRow('DRIVER', up(data.driver), data.driverPhone),
        if (data.conductor1.isNotEmpty)
          _staffRow('CONDUCTOR', up(data.conductor1), data.conductorPhone),
        if (data.conductor2.isNotEmpty)
          _staffRow('CONDUCTOR', up(data.conductor2), ''),
      ],
    );
  }

  Widget _staffRow(String label, String value, String phone) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SizedBox(
                width: 96,
                child: Text(
                  label,
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                    color: _muted,
                    letterSpacing: 1.5,
                  ),
                ),
              ),
              Expanded(
                child: Text(
                  value,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: _ink,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          if (phone.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 96),
              child: Text(
                formatZimPhone(phone),
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: _muted,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _customerSection() {
    final name =
        data.customerName.trim().isEmpty ? '-' : up(data.customerName.trim());
    return Column(
      children: [
        _staffRow('PASSENGER', name, ''),
        if (data.customerMobile.isNotEmpty)
          _staffRow('MOBILE', formatZimPhone(data.customerMobile), ''),
      ],
    );
  }

  Widget _fareSection() {
    return Column(
      children: [
        for (final i in data.items)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    i.qty > 1 ? '${i.name}  ×${i.qty}' : i.name,
                    style: const TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w500,
                      color: _ink,
                    ),
                  ),
                ),
                Text(
                  i.qty > 1
                      ? '${i.qty} pcs   ${fmtMoney(i.total, data.currency)}'
                      : fmtMoney(i.total, data.currency),
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: _ink,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _totalRow() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFFF0EDE8),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        children: [
          const Text(
            'TOTAL FARE',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w800,
              color: _navy,
              letterSpacing: 0.3,
            ),
          ),
          const Spacer(),
          Text(
            (data.total / 100).toStringAsFixed(2),
            style: const TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w800,
              color: _navy,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 2),
          Text(
            up(data.currency.trim().isEmpty ? 'USD' : data.currency),
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w800,
              color: _muted,
            ),
          ),
        ],
      ),
    );
  }

  Widget _paymentBreakdown() {
    return Column(
      children: [
        _breakdownRow(
          'PAYMENT METHOD',
          paymentMethodLabel(data.paymentMethod),
        ),
        _breakdownRow(
          'CASH TENDERED',
          (data.tenderedCents / 100).toStringAsFixed(2),
        ),
        _breakdownRow('CHANGE', (data.changeCents / 100).toStringAsFixed(2)),
      ],
    );
  }

  Widget _breakdownRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: _muted,
              letterSpacing: 0.4,
            ),
          ),
          const Spacer(),
          Text(
            value,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w800,
              color: _ink,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ),
    );
  }

  Widget _validityNote() {
    return Text(
      data.note,
      textAlign: TextAlign.center,
      style: const TextStyle(
        fontSize: 10.5,
        fontWeight: FontWeight.w400,
        color: _muted,
        height: 1.45,
      ),
    );
  }

  Widget _footer() {
    return Column(
      children: [
        const Text(
          'Powered by',
          style: TextStyle(
            fontSize: 10.5,
            fontWeight: FontWeight.w400,
            color: _muted,
            letterSpacing: 0.4,
          ),
        ),
        const SizedBox(height: 2),
        const Text(
          'PREYONE TECHNOLOGIES',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w800,
            color: _navy,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          _website,
          style: const TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w500,
            color: _muted,
          ),
        ),
      ],
    );
  }

  Widget _qrCode() {
    return Center(
      child: BarcodeWidget(
        barcode: Barcode.qrCode(),
        data: barcodeDataFor(data),
        height: 150,
        width: 150,
        drawText: false,
        color: _navy,
        backgroundColor: Colors.white,
      ),
    );
  }

  Widget _barcode() {
    return BarcodeWidget(
      barcode: Barcode.code128(),
      data: barcodeDataFor(data),
      height: 30,
      width: double.infinity,
      drawText: false,
      color: _navy,
      backgroundColor: Colors.white,
    );
  }

  Widget _divider() => Container(
        height: 1,
        color: _dividerColor,
      );
}
