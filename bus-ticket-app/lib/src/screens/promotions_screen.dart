import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../services/transit_api.dart';

/// Admin-only promotions editor. Local-first: every change is saved to the
/// offline store immediately, then pushed to the server best-effort.
class PromotionsScreen extends StatefulWidget {
  const PromotionsScreen({super.key});

  @override
  State<PromotionsScreen> createState() => _PromotionsScreenState();
}

class _PromotionsScreenState extends State<PromotionsScreen> {
  List<Promo> _promos = [];
  String _currency = 'USD';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final currency = await AppDb.getSetting('currency', 'USD') ?? 'USD';
    final promos = await AppDb.getPromotions(onlyActive: false);
    if (!mounted) return;
    setState(() {
      _promos = promos;
      _currency = currency;
      _loading = false;
    });
  }

  Map<String, dynamic> _payload(Promo p) => {
        'code': p.code,
        'description': p.description,
        'type': p.type,
        'value': p.value,
        'minimumCents': p.minimumCents,
        'maxValueCents': p.maxValueCents,
        'active': p.active,
      };

  String _summary(Promo p) {
    final discount = p.type == 'FLAT'
        ? '${fmtMoney(p.value, _currency)} off'
        : '${p.value}% off';
    final minPart = p.minimumCents > 0
        ? ' · min ${fmtMoney(p.minimumCents, _currency)}'
        : '';
    final capPart = p.maxValueCents > 0
        ? ' · cap ${fmtMoney(p.maxValueCents, _currency)}'
        : '';
    final usedPart = ' · used ${p.usageCount}';
    return p.description.isEmpty
        ? '$discount$minPart$capPart$usedPart'
        : '${p.description} · $discount$minPart$capPart$usedPart';
  }

  Future<void> _createPromo() async {
    final saved = await _promoDialog(null);
    if (saved == null) return;
    await AppDb.upsertPromo(saved);
    await _tryPush(() => TransitApi.createPromotion(_payload(saved)));
    await _load();
  }

  Future<void> _editPromo(Promo promo) async {
    final saved = await _promoDialog(promo);
    if (saved == null) return;
    await AppDb.upsertPromo(saved);
    if (saved.id.isNotEmpty) {
      await _tryPush(
          () => TransitApi.updatePromotion(saved.id, _payload(saved)));
    }
    await _load();
  }

  Future<void> _toggleActive(Promo promo, bool active) async {
    final updated = Promo(
      id: promo.id,
      code: promo.code,
      description: promo.description,
      type: promo.type,
      value: promo.value,
      minimumCents: promo.minimumCents,
      maxValueCents: promo.maxValueCents,
      active: active,
      usageCount: promo.usageCount,
    );
    await AppDb.upsertPromo(updated);
    if (promo.id.isNotEmpty) {
      await _tryPush(
          () => TransitApi.updatePromotion(promo.id, _payload(updated)));
    }
    await _load();
  }

  Future<void> _deletePromo(Promo promo) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete promotion?'),
        content: Text('Remove "${promo.code}"? Existing discounts already '
            'booked are kept on their tickets.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await AppDb.deletePromo(promo.id);
    if (promo.id.isNotEmpty) {
      // No server DELETE endpoint: deactivate it instead so it does not
      // reappear in the shared company catalog on the next refresh.
      final deactivated = Promo(
        id: promo.id,
        code: promo.code,
        description: promo.description,
        type: promo.type,
        value: promo.value,
        minimumCents: promo.minimumCents,
        maxValueCents: promo.maxValueCents,
        active: false,
        usageCount: promo.usageCount,
      );
      await _tryPush(
          () => TransitApi.updatePromotion(promo.id, _payload(deactivated)));
    }
    await _load();
  }

  /// Attempts a server call; silently swallows offline/forbidden failures so
  /// the local (authoritative-for-the-device) change still stands.
  Future<void> _tryPush(Future<Map<String, dynamic>> Function() call) async {
    try {
      await call();
    } catch (e) {
      // Offline or server-side rejection — the promo still works locally.
    }
  }

  Future<Promo?> _promoDialog(Promo? existing) async {
    final codeCtrl = TextEditingController(text: existing?.code ?? '');
    final descCtrl = TextEditingController(text: existing?.description ?? '');
    String type = existing?.type ?? 'PERCENT';
    final valueCtrl = TextEditingController(
      text: existing == null
          ? ''
          : existing.type == 'FLAT'
              ? (existing.value / 100).toStringAsFixed(2)
              : '${existing.value}',
    );
    final minCtrl = TextEditingController(
      text: existing == null || existing.minimumCents == 0
          ? ''
          : (existing.minimumCents / 100).toStringAsFixed(2),
    );
    final capCtrl = TextEditingController(
      text: existing == null || existing.maxValueCents == 0
          ? ''
          : (existing.maxValueCents / 100).toStringAsFixed(2),
    );

    final saved = await showDialog<Promo>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: Text(existing == null ? 'New promotion' : 'Edit promotion'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: codeCtrl,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    labelText: 'Code',
                    hintText: 'XMAS10',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: descCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Description (optional)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'PERCENT', label: Text('Percent')),
                    ButtonSegment(value: 'FLAT', label: Text('Fixed')),
                  ],
                  selected: {type},
                  onSelectionChanged: (s) => setDialog(() => type = s.first),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: valueCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: InputDecoration(
                    labelText: type == 'FLAT'
                        ? 'Discount amount'
                        : 'Discount percent (max 100)',
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: minCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: 'Minimum spend (optional)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: capCtrl,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                    labelText: 'Maximum discount (optional)',
                    border: OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                final code = codeCtrl.text.trim().toUpperCase();
                if (code.isEmpty) return;
                final value = type == 'FLAT'
                    ? (parseMoneyToCents(valueCtrl.text) ?? 0)
                    : (int.tryParse(valueCtrl.text.trim()) ?? 0);
                if (value <= 0) return;
                final min = parseMoneyToCents(minCtrl.text) ?? 0;
                final cap = parseMoneyToCents(capCtrl.text) ?? 0;
                Navigator.of(ctx).pop(Promo(
                  id: existing?.id ?? '',
                  code: code,
                  description: descCtrl.text.trim(),
                  type: type,
                  value: value,
                  minimumCents: min,
                  maxValueCents: cap,
                  active: existing?.active ?? true,
                  usageCount: existing?.usageCount ?? 0,
                ));
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    return saved;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Promotions'),
        actions: [
          IconButton(
            tooltip: 'Refresh from server',
            onPressed: _load,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            elevation: 0,
            color: Colors.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
              side: const BorderSide(color: Color(0xFFE2E8F0)),
            ),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Promo codes',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Give passengers a discount at checkout. Codes are '
                    'verified on-device even while offline.',
                    style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
                  ),
                  const SizedBox(height: 12),
                  FilledButton.tonalIcon(
                    onPressed: _createPromo,
                    icon: const Icon(Icons.add),
                    label: const Text('New promotion'),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_promos.isEmpty)
            const Card(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Center(child: Text('No promotions yet')),
              ),
            )
          else
            for (final p in _promos) _promoCard(p),
        ],
      ),
    );
  }

  Widget _promoCard(Promo p) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xFFE2E8F0)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(
          children: [
            const Icon(Icons.local_offer_outlined,
                color: Color(0xFFB45309), size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    p.code,
                    style: const TextStyle(
                        fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _summary(p),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11.5, color: Color(0xFF64748B)),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 4),
            Switch(
              value: p.active,
              onChanged: (v) => _toggleActive(p, v),
            ),
            IconButton(
              icon: const Icon(Icons.edit_outlined, size: 20),
              tooltip: 'Edit',
              visualDensity: VisualDensity.compact,
              onPressed: () => _editPromo(p),
            ),
            IconButton(
              icon: const Icon(Icons.delete_outline, size: 20),
              tooltip: 'Delete',
              visualDensity: VisualDensity.compact,
              onPressed: () => _deletePromo(p),
            ),
          ],
        ),
      ),
    );
  }
}
