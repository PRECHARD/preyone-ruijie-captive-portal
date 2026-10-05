import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, this.onNavigate});

  final void Function(int index)? onNavigate;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<Sale> _today = [];
  List<Sale> _recent = [];
  String _company = '';
  String _slogan = '';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day);
    final end = DateTime(now.year, now.month, now.day, 23, 59, 59);
    final today = await AppDb.getSalesBetween(start, end);
    final recent = await AppDb.getSales();
    final company = await AppDb.getSetting('company_name', '') ?? '';
    final slogan = await AppDb.getSetting('company_slogan', '') ?? '';
    final currency = await AppDb.getSetting('currency', 'USD') ?? 'USD';
    if (!mounted) return;
    setState(() {
      _today = today;
      _recent = recent.take(6).toList();
      _company = company;
      _slogan = slogan;
      _currency = currency;
      _loading = false;
    });
  }

  String _currency = 'USD';

  int get _todayRevenue => _today.fold(0, (s, x) => s + x.total);
  int get _todayPassengers =>
      _today.fold(0, (s, x) => s + x.items.fold(0, (a, i) => a + i.qty));

  @override
  Widget build(BuildContext context) {
    final header = _company;
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Dashboard',
                          style: Theme.of(context)
                              .textTheme
                              .headlineSmall
                              ?.copyWith(fontWeight: FontWeight.w800),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          header,
                          style: const TextStyle(
                            fontSize: 13,
                            color: Color(0xFF64748B),
                          ),
                        ),
                        if (_slogan.isNotEmpty)
                          Text(
                            _slogan,
                            style: const TextStyle(
                              fontSize: 12,
                              fontStyle: FontStyle.italic,
                              color: Color(0xFF1B5E20),
                            ),
                          ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Refresh',
                    onPressed: _load,
                    icon: const Icon(Icons.refresh),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _metricCard(
                      icon: Icons.confirmation_number_outlined,
                      iconColor: const Color(0xFF1B5E20),
                      label: 'Tickets Sold',
                      value: '${_today.length}',
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _metricCard(
                      icon: Icons.payments_outlined,
                      iconColor: const Color(0xFFB45309),
                      label: "Today's Revenue",
                      value: fmtMoney(_todayRevenue, _currency),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: _metricCard(
                      icon: Icons.people_outline,
                      iconColor: const Color(0xFF7C3AED),
                      label: 'Passengers',
                      value: '$_todayPassengers',
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _metricCard(
                      icon: Icons.percent,
                      iconColor: const Color(0xFF0369A1),
                      label: 'Avg Fare',
                      value: _today.isEmpty
                          ? fmtMoney(0, _currency)
                          : fmtMoney((_todayRevenue / _today.length).round(),
                              _currency),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: () => widget.onNavigate?.call(1),
                      icon: const Icon(Icons.add_shopping_cart),
                      label: const Text('Sell Ticket'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: FilledButton.tonalIcon(
                      onPressed: () => widget.onNavigate?.call(5),
                      icon: const Icon(Icons.receipt_long_outlined),
                      label: const Text('Reports'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              Text(
                'Recent Tickets',
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_recent.isEmpty)
                const Card(
                  child: Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: Text('No tickets sold yet')),
                  ),
                )
              else
                for (final s in _recent) _recentTile(s),
            ],
          ),
        ),
      ),
    );
  }

  Widget _metricCard({
    required IconData icon,
    required Color iconColor,
    required String label,
    required String value,
  }) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFE2E8F0)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 26, color: iconColor),
          const SizedBox(height: 10),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              value,
              style: const TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w800,
                color: Color(0xFF0F1E33),
              ),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: Color(0xFF64748B),
            ),
          ),
        ],
      ),
    );
  }

  Widget _recentTile(Sale s) {
    final items = s.items
        .map((i) => i.qty > 1 ? '${i.name}  ×${i.qty}' : i.name)
        .join(', ');
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE2E8F0)),
      ),
      child: ListTile(
        dense: true,
        leading: const CircleAvatar(
          radius: 18,
          backgroundColor: Color(0xFFE8F5E9),
          child: Icon(Icons.confirmation_number,
              size: 18, color: Color(0xFF1B5E20)),
        ),
        title: Text(
          s.receiptNo,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
        subtitle: Text(
          '$items  ·  ${fmtDateTime(s.createdAt!)}',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12),
        ),
        trailing: Text(
          fmtMoney(s.total, _currency),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
