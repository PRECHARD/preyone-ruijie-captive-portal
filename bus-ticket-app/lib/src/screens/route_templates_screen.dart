import 'package:flutter/material.dart';

import '../db/app_db.dart';
import '../format.dart';
import '../models/route_template.dart';
import '../services/sync_service.dart';
import '../services/transit_api.dart';
import '../widgets/emerald_ui.dart';

/// Admin editor for the "master route templates": the stage list plus the
/// stage-to-stage fare matrix the conductor screen reads when opening an
/// on-the-go run. Purely local configuration — templates never reach the server
/// and never appear in the trip picker.
class RouteTemplatesScreen extends StatefulWidget {
  const RouteTemplatesScreen({super.key});

  @override
  State<RouteTemplatesScreen> createState() => _RouteTemplatesScreenState();
}

class _RouteTemplatesScreenState extends State<RouteTemplatesScreen> {
  List<RouteTemplate> _templates = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final all = await AppDb.getRouteTemplates();
    if (!mounted) return;
    setState(() {
      _templates = all;
      _loading = false;
    });
  }

  void _snack(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  Future<void> _openEditor(RouteTemplate? template) async {
    final saved = await Navigator.of(context).push<bool>(
      emeraldPageRoute<bool>(
        _RouteTemplateEditor(template: template),
      ),
    );
    if (saved == true) await _load();
  }

  Future<void> _delete(RouteTemplate t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Delete ${t.name}?'),
        content: const Text(
            'The template, its stages and its fare matrix are removed from this '
            'device. Tickets already sold are unaffected.'),
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
    // Delete centrally first, then locally: a local delete the server rejected
    // would silently return on the next pull with no explanation. Offline, fall
    // back to the local delete so the operator's intent is still honoured.
    try {
      await SyncService.instance.deleteRouteTemplateFromServer(t.id);
    } on TransitApiException catch (e) {
      await AppDb.deleteRouteTemplate(t.id);
      _snack('Deleted on this device only — ${e.message}');
      await _load();
      return;
    } catch (_) {
      await AppDb.deleteRouteTemplate(t.id);
    }
    await _load();
    _snack('Template deleted.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Route templates'),
        leading: const BackButton(),
        actions: [
          IconButton(
            tooltip: 'New template',
            icon: const Icon(Icons.add),
            onPressed: () => _openEditor(null),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _templates.isEmpty
              ? _empty()
              : ListView.separated(
                  padding: const EdgeInsets.all(12),
                  itemCount: _templates.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (context, i) {
                    final t = _templates[i];
                    return Card(
                      elevation: 1,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: ListTile(
                        title: Text(t.name,
                            style:
                                const TextStyle(fontWeight: FontWeight.w800)),
                        subtitle: Text(
                          '${t.stages.length} stages'
                          '${t.code.isEmpty ? '' : ' · ${up(t.code)}'}'
                          '${t.active ? '' : ' · inactive'}',
                          style: const TextStyle(fontSize: 12.5),
                        ),
                        isThreeLine: t.description.isNotEmpty,
                        onTap: () => _openEditor(t),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              tooltip: 'Delete',
                              icon: const Icon(Icons.delete_outline),
                              onPressed: () => _delete(t),
                            ),
                            const Icon(Icons.chevron_right),
                          ],
                        ),
                      ),
                    );
                  },
                ),
      floatingActionButton: _templates.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: () => _openEditor(null),
              backgroundColor: kEmeraldDeep,
              foregroundColor: Colors.white,
              icon: const Icon(Icons.add),
              label: const Text('New template'),
            ),
    );
  }

  Widget _empty() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.route_outlined,
                size: 48, color: Color(0xFF94A3B8)),
            const SizedBox(height: 14),
            const Text(
              'No route templates yet',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            const Text(
              'Add a master route: list its stages in travel order, then price '
              'the legs. Conductors use it to open unscheduled runs.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: Color(0xFF64748B)),
            ),
            const SizedBox(height: 18),
            EmeraldButton(
              icon: Icons.add,
              label: 'Add first template',
              onPressed: () => _openEditor(null),
            ),
          ],
        ),
      ),
    );
  }
}

/// Single-template editor. Stage rows keep the order they were added in — that
/// order is the seq, which is what the fare matrix and the conductor's
/// board/alight pickers key on.
class _RouteTemplateEditor extends StatefulWidget {
  const _RouteTemplateEditor({this.template});

  final RouteTemplate? template;

  @override
  State<_RouteTemplateEditor> createState() => _RouteTemplateEditorState();
}

class _RouteTemplateEditorState extends State<_RouteTemplateEditor> {
  late final _nameCtrl =
      TextEditingController(text: widget.template?.name ?? '');
  late final _codeCtrl =
      TextEditingController(text: widget.template?.code ?? '');
  late final _descCtrl =
      TextEditingController(text: widget.template?.description ?? '');
  late bool _active = widget.template?.active ?? true;
  late List<RouteStage> _stages = [...?widget.template?.stages]
    ..sort((a, b) => a.seq.compareTo(b.seq));
  late Map<String, int> _fares = {
    for (final f in widget.template?.fares ?? const <RouteStageFare>[])
      _legKey(f.fromSeq, f.toSeq): f.priceCents,
  };
  bool _saving = false;

  static String _legKey(int from, int to) => '$from-$to';

  @override
  void dispose() {
    _nameCtrl.dispose();
    _codeCtrl.dispose();
    _descCtrl.dispose();
    super.dispose();
  }

  int _priceFor(int from, int to) => _fares[_legKey(from, to)] ?? 0;

  Future<void> _addStage() async {
    // No TextEditingController here on purpose: showDialog resolves while the
    // dialog is still animating out, and disposing a controller the outgoing
    // TextField still holds throws "used after being disposed" mid-animation.
    // Capturing the text via onChanged has no such lifetime to get wrong.
    var typed = '';
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Stage ${_stages.length + 1}'),
        content: TextField(
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          onChanged: (v) => typed = v,
          decoration: const InputDecoration(
            labelText: 'Stage name',
            hintText: 'e.g. RUWANKA',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx)
                .pop(typed.trim().isEmpty ? null : typed.trim()),
            child: const Text('Add'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty || !mounted) return;
    setState(() {
      _stages = [
        ..._stages,
        RouteStage(
            templateId: widget.template?.id ?? '',
            seq: _stages.length + 1,
            name: name),
      ];
    });
  }

  void _move(int index, int delta) {
    final target = index + delta;
    if (target < 0 || target >= _stages.length) return;
    setState(() {
      final list = [..._stages];
      final moved = list.removeAt(index);
      list.insert(target, moved);
      // Seq is positional, so the matrix has to follow the stages: map every
      // old seq to its new position before re-keying the prices.
      final newSeqOfOld = <int, int>{};
      final renumbered = <RouteStage>[];
      for (var i = 0; i < list.length; i++) {
        newSeqOfOld[list[i].seq] = i + 1;
        renumbered.add(RouteStage(
          id: list[i].id,
          templateId: list[i].templateId,
          seq: i + 1,
          name: list[i].name,
        ));
      }
      final rebuilt = <String, int>{};
      _fares.forEach((key, cents) {
        final parts = key.split('-').map(int.parse).toList();
        final from = newSeqOfOld[parts[0]];
        final to = newSeqOfOld[parts[1]];
        if (from == null || to == null || from == to) return;
        final lo = from < to ? from : to;
        final hi = from < to ? to : from;
        rebuilt[_legKey(lo, hi)] = cents;
      });
      _stages = renumbered;
      _fares = rebuilt;
    });
  }

  void _removeStage(int index) {
    setState(() {
      final removedSeq = _stages[index].seq;
      final kept = <RouteStage>[];
      for (var i = 0; i < _stages.length; i++) {
        if (i == index) continue;
        kept.add(RouteStage(
          id: _stages[i].id,
          templateId: _stages[i].templateId,
          seq: i + 1,
          name: _stages[i].name,
        ));
      }
      final rebuilt = <String, int>{};
      _fares.forEach((key, cents) {
        final parts = key.split('-').map(int.parse).toList();
        if (parts.contains(removedSeq)) return;
        int remap(int seq) => seq > removedSeq ? seq - 1 : seq;
        final from = remap(parts[0]);
        final to = remap(parts[1]);
        if (from == to || from < 1 || to < 1) return;
        rebuilt[_legKey(from, to)] = cents;
      });
      _stages = kept;
      _fares = rebuilt;
    });
  }

  Future<void> _save() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Name the template.')));
      return;
    }
    if (_stages.length < 2) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Add at least two stages so a leg can be priced.')));
      return;
    }
    setState(() => _saving = true);
    final existing = widget.template;
    final fares = <RouteStageFare>[];
    for (var i = 0; i < _stages.length; i++) {
      for (var j = i + 1; j < _stages.length; j++) {
        fares.add(RouteStageFare(
          templateId: existing?.id ?? '',
          fromSeq: _stages[i].seq,
          toSeq: _stages[j].seq,
          priceCents: _priceFor(_stages[i].seq, _stages[j].seq),
        ));
      }
    }
    final draft = RouteTemplate(
      id: existing?.id ?? '',
      name: name,
      code: _codeCtrl.text.trim(),
      description: _descCtrl.text.trim(),
      active: _active,
      createdAt: existing?.createdAt,
      stages: _stages,
      fares: fares,
    );

    // The company owns the master set, so a successful save goes to the server
    // and the device mirrors whatever the server returns (authoritative id and
    // timestamps). Falling back to a local-only save keeps this usable when the
    // terminal is offline; the next catalog sync will reconcile it.
    try {
      await SyncService.instance.saveRouteTemplateToServer(draft);
    } on TransitApiException catch (e) {
      await AppDb.saveRouteTemplate(draft);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
          'Saved on this device only — could not reach the company (${e.message}). '
          'It will sync when you are back online.',
        ),
      ));
    } catch (_) {
      await AppDb.saveRouteTemplate(draft);
    }
    if (!mounted) return;
    Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final legs = <Widget>[];
    for (var i = 0; i < _stages.length; i++) {
      for (var j = i + 1; j < _stages.length; j++) {
        final from = _stages[i];
        final to = _stages[j];
        final key = _legKey(from.seq, to.seq);
        final cents = _fares[key] ?? 0;
        legs.add(
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${up(from.name)} → ${up(to.name)}',
                    style: const TextStyle(
                        fontSize: 13, fontWeight: FontWeight.w600),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: 10),
                SizedBox(
                  width: 130,
                  child: TextFormField(
                    initialValue:
                        cents == 0 ? '' : (cents / 100).toStringAsFixed(2),
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    onChanged: (raw) {
                      final parsed = parseMoneyToCents(raw);
                      setState(() {
                        if (parsed == null) {
                          _fares.remove(key);
                        } else {
                          _fares[key] = parsed;
                        }
                      });
                    },
                    decoration: const InputDecoration(
                      isDense: true,
                      prefixText: '  ',
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.template == null ? 'New template' : 'Edit template'),
        leading: const BackButton(),
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: const Text('SAVE'),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _nameCtrl,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(
              labelText: 'Route name',
              hintText: 'e.g. Harare - Chitungwiza',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _codeCtrl,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(
              labelText: 'Route code (optional)',
              hintText: 'HRE-CHI',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _descCtrl,
            maxLines: 2,
            decoration: const InputDecoration(
              labelText: 'Notes (optional)',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Active for conductors',
                style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            subtitle: const Text(
              'Inactive templates stay saved but are hidden from the '
              'on-the-go trip picker.',
              style: TextStyle(fontSize: 12),
            ),
            value: _active,
            onChanged: (v) => setState(() => _active = v),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Expanded(
                child: Text('Stages',
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
              ),
              TextButton.icon(
                onPressed: _addStage,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add stage'),
              ),
            ],
          ),
          if (_stages.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'No stages yet. Add the origin first, then each stop in travel '
                'order — the fare matrix below follows this order.',
                style: TextStyle(fontSize: 12.5, color: Color(0xFF64748B)),
              ),
            ),
          for (var i = 0; i < _stages.length; i++)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: CircleAvatar(
                radius: 14,
                backgroundColor: const Color(0xFFE8F5E9),
                child: Text('${_stages[i].seq}',
                    style: const TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w800)),
              ),
              title: Text(up(_stages[i].name),
                  style: const TextStyle(fontWeight: FontWeight.w600)),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: 'Move up',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.arrow_upward, size: 18),
                    onPressed: i == 0 ? null : () => _move(i, -1),
                  ),
                  IconButton(
                    tooltip: 'Move down',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.arrow_downward, size: 18),
                    onPressed:
                        i == _stages.length - 1 ? null : () => _move(i, 1),
                  ),
                  IconButton(
                    tooltip: 'Remove',
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () => _removeStage(i),
                  ),
                ],
              ),
            ),
          const Divider(height: 24),
          const Text('Fare matrix',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12)),
          const SizedBox(height: 4),
          const Text(
            'Price every forward leg. The conductor screen reuses the same price '
            'for the return direction. Leave a leg empty to fall back to the '
            'standard tariff.',
            style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
          ),
          const SizedBox(height: 6),
          if (legs.isEmpty)
            const Text(
              'Add two or more stages to price the legs.',
              style: TextStyle(fontSize: 12.5, color: Color(0xFF94A3B8)),
            ),
          ...legs,
          const SizedBox(height: 24),
          EmeraldButton(
            expand: true,
            height: 48,
            icon: Icons.save_outlined,
            label: _saving ? 'Saving…' : 'Save template',
            onPressed: _saving ? null : _save,
          ),
        ],
      ),
    );
  }
}
