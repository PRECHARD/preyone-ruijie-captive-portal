import 'package:flutter/material.dart';

import '../app_state.dart';
import '../db/app_db.dart';
import '../format.dart';
import '../models.dart';
import '../roles.dart';
import '../security/secure_keystore.dart';

class DriversScreen extends StatefulWidget {
  const DriversScreen({super.key});

  @override
  State<DriversScreen> createState() => _DriversScreenState();
}

class _DriversScreenState extends State<DriversScreen> {
  List<Driver> _drivers = [];
  bool _loading = true;

  /// Only ADMIN/SUPER_ADMIN may add, edit or delete drivers.
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
    final drivers = await AppDb.getDrivers(onlyActive: false);
    final role = await SecureKeystore.instance.readRole() ?? '';
    if (!mounted) return;
    setState(() {
      _drivers = drivers;
      _canManage = Roles.canManageStaff(role);
      _loading = false;
    });
  }

  Future<void> _add() => _dialog(null);

  Future<void> _edit(Driver d) => _dialog(d);

  Future<void> _dialog(Driver? existing) async {
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final phoneCtrl = TextEditingController(text: existing?.phone ?? '');
    var active = existing?.active ?? true;
    final saved = await showDialog<_DriverResult>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: Text(existing == null ? 'New Driver' : 'Edit Driver'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: nameCtrl,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  labelText: 'Driver name',
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
                Navigator.of(ctx)
                    .pop(_DriverResult(name, zimPhoneOrEmpty(phoneCtrl.text), active));
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    if (saved == null) return;
    if (existing == null) {
      await AppDb.addDriver(saved.name, saved.phone);
    } else {
      await AppDb.updateDriver(Driver(
        id: existing.id,
        name: saved.name,
        phone: saved.phone,
        active: saved.active,
      ));
    }
    AppState.instance.refresh();
    await _load();
  }

  Future<void> _toggleActive(Driver d) async {
    await AppDb.updateDriver(Driver(
      id: d.id,
      name: d.name,
      phone: d.phone,
      active: !d.active,
    ));
    AppState.instance.refresh();
    await _load();
  }

  Future<void> _delete(Driver d) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete driver?'),
        content: Text('Remove "${d.name}" from drivers?'),
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
    await AppDb.deleteDriver(d.id!);
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
                      'Drivers',
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
                      label: const Text('Add driver'),
                    ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Manage the drivers assigned to your buses. Driver details appear on tickets.',
                style: TextStyle(color: Color(0xFF64748B), fontSize: 12.5),
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _drivers.isEmpty
                      ? const Center(child: Text('No drivers yet. Add your first driver.'))
                      : ListView.separated(
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          itemCount: _drivers.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 8),
                          itemBuilder: (ctx, i) {
                            final d = _drivers[i];
                            return Card(
                              elevation: 0,
                              color: Colors.white,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(12),
                                side: BorderSide(
                                  color: d.active
                                      ? const Color(0xFFE2E8F0)
                                      : const Color(0xFFE2E8F0),
                                ),
                              ),
                              child: ListTile(
                                leading: CircleAvatar(
                                  radius: 20,
                                  backgroundColor: const Color(0xFFE8F5E9),
                                  child: const Icon(Icons.person,
                                      color: Color(0xFF1B5E20)),
                                ),
                                title: Text(
                                  d.name,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w700),
                                ),
                                subtitle: d.phone.isEmpty
                                    ? null
                                    : Text(
                                        d.phone,
                                        style: const TextStyle(fontSize: 12.5),
                                      ),
                                isThreeLine: false,
                                trailing: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (_canManage) ...[
                                      IconButton(
                                        tooltip: d.active
                                            ? 'Deactivate'
                                            : 'Activate',
                                        icon: Icon(
                                          d.active
                                              ? Icons.check_circle
                                              : Icons.cancel,
                                          color: d.active
                                              ? Colors.green
                                              : Colors.grey.shade400,
                                        ),
                                        onPressed: () => _toggleActive(d),
                                      ),
                                      IconButton(
                                        tooltip: 'Edit',
                                        icon: const Icon(Icons.edit_outlined),
                                        onPressed: () => _edit(d),
                                      ),
                                      IconButton(
                                        tooltip: 'Delete',
                                        icon: const Icon(Icons.delete_outline),
                                        onPressed: () => _delete(d),
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

class _DriverResult {
  const _DriverResult(this.name, this.phone, this.active);
  final String name;
  final String phone;
  final bool active;
}