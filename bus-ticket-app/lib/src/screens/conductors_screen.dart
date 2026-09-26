import 'package:flutter/material.dart';

import '../app_state.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../roles.dart';
import '../security/secure_keystore.dart';

class ConductorsScreen extends StatefulWidget {
  const ConductorsScreen({super.key});

  @override
  State<ConductorsScreen> createState() => _ConductorsScreenState();
}

class _ConductorsScreenState extends State<ConductorsScreen> {
  List<Conductor> _conductors = [];
  bool _loading = true;

  /// Only ADMIN/SUPER_ADMIN may add, edit or delete conductors.
  bool _canManage = true;

  @override
  void initState() {
    super.initState();
    _load();
    AppState.instance.addListener(_load);
  }

  @override
  void dispose() {
    AppState.instance.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final conductors = await AppDb.getConductors(onlyActive: false);
    final role = await SecureKeystore.instance.readRole() ?? '';
    if (!mounted) return;
    setState(() {
      _conductors = conductors;
      _canManage = Roles.canManageStaff(role);
      _loading = false;
    });
  }

  Future<void> _add() => _dialog(null);

  Future<void> _edit(Conductor c) => _dialog(c);

  Future<void> _dialog(Conductor? existing) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final phoneCtrl = TextEditingController(text: existing?.phone ?? '');
    var active = existing?.active ?? true;
    final saved = await showDialog<_ConductorResult>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: Text(existing == null ? 'New Conductor' : 'Edit Conductor'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'Conductor name',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: phoneCtrl,
                keyboardType: TextInputType.phone,
                decoration: const InputDecoration(
                  labelText: 'Phone number',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 10),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Active'),
                value: active,
                onChanged: (v) => setDialog(() => active = v ?? true),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                final name = nameCtrl.text.trim();
                if (name.isEmpty) return;
                Navigator.of(ctx).pop(_ConductorResult(
                    name, zimPhoneOrEmpty(phoneCtrl.text), active));
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    if (saved == null) return;
    if (existing == null) {
      await AppDb.addConductor(saved.name, saved.phone);
    } else {
      await AppDb.updateConductor(Conductor(
        id: existing.id,
        name: saved.name,
        phone: saved.phone,
        active: saved.active,
      ));
    }
    AppState.instance.refresh();
    await _load();
  }

  Future<void> _toggleActive(Conductor c) async {
    await AppDb.updateConductor(Conductor(
      id: c.id,
      name: c.name,
      phone: c.phone,
      active: !c.active,
    ));
    AppState.instance.refresh();
    await _load();
  }

  Future<void> _delete(Conductor c) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete conductor?'),
        content: Text('Remove "${c.name}" from conductors?'),
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
    await AppDb.deleteConductor(c.id!);
    AppState.instance.refresh();
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Conductors',
                      style: Theme.of(context)
                          .textTheme
                          .headlineSmall
                          ?.copyWith(fontWeight: FontWeight.w800),
                    ),
                  ),
                  if (_canManage)
                    FilledButton.icon(
                      onPressed: _add,
                      icon: const Icon(Icons.add),
                      label: const Text('Add conductor'),
                    ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Manage the conductors assigned to your buses. Conductor details appear on tickets.',
                style: TextStyle(color: Color(0xFF64748B), fontSize: 12.5),
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _conductors.isEmpty
                      ? const Center(
                          child: Text(
                              'No conductors yet. Add your first conductor.'))
                      : ListView.separated(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 16, vertical: 8),
                          itemCount: _conductors.length,
                          separatorBuilder: (_, __) =>
                              const SizedBox(height: 8),
                          itemBuilder: (ctx, i) {
                            final c = _conductors[i];
                            return Card(
                              elevation: 0,
                              color: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                                side:
                                    const BorderSide(color: Color(0xFFE2E8F0)),
                              ),
                              child: ListTile(
                                leading: const CircleAvatar(
                                  radius: 20,
                                  backgroundColor: Color(0xFFEDE9FE),
                                  child: Icon(Icons.person,
                                      color: Color(0xFF7C3AED)),
                                ),
                                title: Text(
                                  c.name,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700),
                                ),
                                subtitle: c.phone.isEmpty
                                    ? null
                                    : Text(
                                        c.phone,
                                        style: const TextStyle(fontSize: 12.5),
                                      ),
                                trailing: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (_canManage) ...[
                                      IconButton(
                                        tooltip: c.active
                                            ? 'Deactivate'
                                            : 'Activate',
                                        icon: Icon(
                                          c.active
                                              ? Icons.check_circle
                                              : Icons.cancel,
                                          color: c.active
                                              ? Colors.green
                                              : Colors.grey.shade400,
                                        ),
                                        onPressed: () => _toggleActive(c),
                                      ),
                                      IconButton(
                                        tooltip: 'Edit',
                                        icon: const Icon(Icons.edit_outlined),
                                        onPressed: () => _edit(c),
                                      ),
                                      IconButton(
                                        tooltip: 'Delete',
                                        icon: const Icon(Icons.delete_outline),
                                        onPressed: () => _delete(c),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ConductorResult {
  const _ConductorResult(this.name, this.phone, this.active);
  final String name;
  final String phone;
  final bool active;
}
