import 'dart:convert';
import 'dart:math';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../models.dart';
import '../models/route_template.dart';
import '../models/trip_model.dart' show SyncQueueEvent, TripInstance;
import '../security/field_crypto.dart';
import '../security/secure_keystore.dart';
import '../uuid.dart';

class AppDb {
  AppDb._();

  static Database? _db;

  static Future<Database> get db async {
    _db ??= await _open();
    return _db!;
  }

  static Future<void> init() async {
    await db;
  }

  static Future<Database> _open() async {
    final dir = await getDatabasesPath();
    final path = p.join(dir, 'bus_ticket.db');
    final database = await openDatabase(
      path,
      version: 16,
      onCreate: (d, v) async {
        await d.execute('''
          CREATE TABLE fares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1
          )
        ''');
        await d.execute('''
          CREATE TABLE sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_no TEXT NOT NULL,
            ticket_type TEXT NOT NULL DEFAULT 'busFare',
            company_id TEXT NOT NULL DEFAULT '',
            route_code TEXT NOT NULL DEFAULT '',
            route_name TEXT NOT NULL DEFAULT '',
            bus_reg TEXT NOT NULL DEFAULT '',
            driver TEXT NOT NULL DEFAULT '',
            driver_phone TEXT NOT NULL DEFAULT '',
            conductor1 TEXT NOT NULL DEFAULT '',
            conductor2 TEXT NOT NULL DEFAULT '',
            conductor_phone TEXT NOT NULL DEFAULT '',
            seat_number TEXT NOT NULL DEFAULT '',
            trip_no TEXT NOT NULL DEFAULT '',
            trip_id TEXT NOT NULL DEFAULT '',
            trip_instance_id TEXT NOT NULL DEFAULT '',
            shift_id TEXT NOT NULL DEFAULT '',
            driver_id TEXT NOT NULL DEFAULT '',
            conductor_id TEXT NOT NULL DEFAULT '',
            payment_method TEXT NOT NULL DEFAULT 'cash',
            customer_name TEXT NOT NULL DEFAULT '',
            customer_mobile TEXT NOT NULL DEFAULT '',
            custom_fare INTEGER NOT NULL DEFAULT 0,
            departure_time TEXT NOT NULL DEFAULT '',
            luggage_linked_ticket_id TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL,
            total INTEGER NOT NULL,
            cash INTEGER NOT NULL,
            change INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0,
            printed INTEGER NOT NULL DEFAULT 0,
            tx_id TEXT NOT NULL DEFAULT '',
            signature TEXT NOT NULL DEFAULT ''
          )
        ''');
        await d.execute('''
          CREATE TABLE drivers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1
          )
        ''');
        await d.execute('''
          CREATE TABLE conductors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1
          )
        ''');
        await d.execute('''
          CREATE TABLE trips (
            id TEXT PRIMARY KEY,
            trip_no TEXT NOT NULL,
            route_code TEXT NOT NULL DEFAULT '',
            route_from TEXT NOT NULL DEFAULT '',
            route_to TEXT NOT NULL DEFAULT '',
            route_name TEXT NOT NULL DEFAULT '',
            bus_reg TEXT NOT NULL DEFAULT '',
            driver TEXT NOT NULL DEFAULT '',
            driver_phone TEXT NOT NULL DEFAULT '',
            driver_id TEXT NOT NULL DEFAULT '',
            conductor TEXT NOT NULL DEFAULT '',
            conductor_phone TEXT NOT NULL DEFAULT '',
            conductor_id TEXT NOT NULL DEFAULT '',
            departure_time TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'SCHEDULED',
            base_fare_cents INTEGER NOT NULL DEFAULT 0,
            total_seats INTEGER NOT NULL DEFAULT 0,
            seats_sold INTEGER NOT NULL DEFAULT 0
          )
        ''');
        await d.execute('''
          CREATE TABLE promotions (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'PERCENT',
            value INTEGER NOT NULL DEFAULT 0,
            minimum_cents INTEGER NOT NULL DEFAULT 0,
            max_value_cents INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            usage_count INTEGER NOT NULL DEFAULT 0
          )
        ''');
        await d.execute('''
          CREATE TABLE company_profile (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            slogan TEXT NOT NULL DEFAULT '',
            website TEXT NOT NULL DEFAULT '',
            customer_care TEXT NOT NULL DEFAULT '',
            company_address TEXT NOT NULL DEFAULT '',
            company_email TEXT NOT NULL DEFAULT '',
            logo_url TEXT NOT NULL DEFAULT '',
            receipt_header TEXT NOT NULL DEFAULT '',
            receipt_footer TEXT NOT NULL DEFAULT '',
            currency TEXT NOT NULL DEFAULT 'USD',
            updated_at TEXT NOT NULL DEFAULT ''
          )
        ''');
        await d.execute('''
          CREATE TABLE driver_shifts (
            id TEXT PRIMARY KEY,
            driver_id TEXT NOT NULL DEFAULT '',
            driver_name TEXT NOT NULL DEFAULT '',
            driver_phone TEXT NOT NULL DEFAULT '',
            conductor_name TEXT NOT NULL DEFAULT '',
            conductor_phone TEXT NOT NULL DEFAULT '',
            vehicle_reg TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'OPEN',
            started_at TEXT NOT NULL DEFAULT '',
            closed_at TEXT NOT NULL DEFAULT '',
            synced INTEGER NOT NULL DEFAULT 0
          )
        ''');
        await d.execute('''
          CREATE TABLE vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            registration TEXT NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1
          )
        ''');
        await d.execute(
            'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        await _createSyncSchema(d);
        await _createRouteTemplateSchema(d);
      },
      onUpgrade: (d, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN ticket_type TEXT NOT NULL DEFAULT 'busFare'");
        }
        if (oldVersion < 3) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN route_code TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN route_name TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN driver TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN conductor1 TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN conductor2 TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 4) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN customer_mobile TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 5) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN driver_phone TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN conductor_phone TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN seat_number TEXT NOT NULL DEFAULT ''");
          await d.execute('''
            CREATE TABLE drivers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              phone TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1
            )
          ''');
          await d.execute('''
            CREATE TABLE conductors (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL DEFAULT '',
              phone TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1
            )
          ''');
        }
        if (oldVersion < 6) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN tx_id TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN signature TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 7) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN trip_no TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 8) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN trip_id TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
          await d.execute('''
            CREATE TABLE trips (
              id TEXT PRIMARY KEY,
              trip_no TEXT NOT NULL,
              route_code TEXT NOT NULL DEFAULT '',
              route_from TEXT NOT NULL DEFAULT '',
              route_to TEXT NOT NULL DEFAULT '',
              route_name TEXT NOT NULL DEFAULT '',
              bus_reg TEXT NOT NULL DEFAULT '',
              driver TEXT NOT NULL DEFAULT '',
              driver_phone TEXT NOT NULL DEFAULT '',
              driver_id TEXT NOT NULL DEFAULT '',
              conductor TEXT NOT NULL DEFAULT '',
              conductor_phone TEXT NOT NULL DEFAULT '',
              conductor_id TEXT NOT NULL DEFAULT '',
              departure_time TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'SCHEDULED',
              total_seats INTEGER NOT NULL DEFAULT 0,
              seats_sold INTEGER NOT NULL DEFAULT 0
            )
          ''');
          await d.execute('''
            CREATE TABLE promotions (
              id TEXT PRIMARY KEY,
              code TEXT NOT NULL UNIQUE,
              description TEXT NOT NULL DEFAULT '',
              type TEXT NOT NULL DEFAULT 'PERCENT',
              value INTEGER NOT NULL DEFAULT 0,
              minimum_cents INTEGER NOT NULL DEFAULT 0,
              max_value_cents INTEGER NOT NULL DEFAULT 0,
              active INTEGER NOT NULL DEFAULT 1,
              usage_count INTEGER NOT NULL DEFAULT 0
            )
          ''');
        }
        if (oldVersion < 9) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN shift_id TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN driver_id TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN conductor_id TEXT NOT NULL DEFAULT ''");
          await d.execute('''
            CREATE TABLE company_profile (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL DEFAULT '',
              slogan TEXT NOT NULL DEFAULT '',
              website TEXT NOT NULL DEFAULT '',
              customer_care TEXT NOT NULL DEFAULT '',
              company_address TEXT NOT NULL DEFAULT '',
              company_email TEXT NOT NULL DEFAULT '',
              logo_url TEXT NOT NULL DEFAULT '',
              receipt_header TEXT NOT NULL DEFAULT '',
              receipt_footer TEXT NOT NULL DEFAULT '',
              currency TEXT NOT NULL DEFAULT 'USD',
              updated_at TEXT NOT NULL DEFAULT ''
            )
          ''');
          await d.execute('''
            CREATE TABLE driver_shifts (
              id TEXT PRIMARY KEY,
              driver_id TEXT NOT NULL DEFAULT '',
              driver_name TEXT NOT NULL DEFAULT '',
              vehicle_reg TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'OPEN',
              started_at TEXT NOT NULL DEFAULT '',
              closed_at TEXT NOT NULL DEFAULT '',
              synced INTEGER NOT NULL DEFAULT 0
            )
          ''');
          await d.execute('''
            CREATE TABLE vehicles (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              registration TEXT NOT NULL UNIQUE,
              active INTEGER NOT NULL DEFAULT 1
            )
          ''');
        }
        if (oldVersion < 10) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN custom_fare INTEGER NOT NULL DEFAULT 0");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN departure_time TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE sales ADD COLUMN luggage_linked_ticket_id TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 11) {
          await d.execute(
              "ALTER TABLE driver_shifts ADD COLUMN driver_phone TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE driver_shifts ADD COLUMN conductor_name TEXT NOT NULL DEFAULT ''");
          await d.execute(
              "ALTER TABLE driver_shifts ADD COLUMN conductor_phone TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 12) {
          await d.execute(
              "ALTER TABLE trips ADD COLUMN base_fare_cents INTEGER NOT NULL DEFAULT 0");
        }
        if (oldVersion < 13) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN bus_reg TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 14) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN trip_instance_id TEXT NOT NULL DEFAULT ''");
          await _createSyncSchema(d);
        }
        if (oldVersion < 15) {
          await d.execute(
              "ALTER TABLE sales ADD COLUMN company_id TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 16) {
          await _createRouteTemplateSchema(d);
        }
      },
    );
    await _seedFares(database);
    return database;
  }

  static Future<void> _seedFares(Database d) async {
    final count = Sqflite.firstIntValue(
            await d.rawQuery('SELECT COUNT(*) AS c FROM fares')) ??
        0;
    if (count == 0) {
      final batch = d.batch();
      batch.insert('fares', {'name': 'Adult', 'price': 200, 'enabled': 1});
      batch.insert('fares', {'name': 'Child', 'price': 100, 'enabled': 1});
      batch.insert('fares', {'name': 'Senior', 'price': 150, 'enabled': 1});
      batch.insert('fares', {'name': 'Luggage', 'price': 100, 'enabled': 1});
      await batch.commit(noResult: true);
    }
  }

  /// Shared between a fresh install (v15 onCreate) and upgrades (v15 onUpgrade):
  /// the offline trip-lifecycle replay queue and the running-trip instance store.
  static Future<void> _createSyncSchema(Database d) async {
    await d.execute('''
      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_uuid TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trip_id TEXT NOT NULL DEFAULT '',
        trip_no TEXT NOT NULL DEFAULT '',
        shift_id TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        synced INTEGER NOT NULL DEFAULT 0
      )
    ''');
    await d.execute('''
      CREATE TABLE IF NOT EXISTS trip_instances (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL DEFAULT '',
        trip_no TEXT NOT NULL DEFAULT '',
        shift_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'RUNNING',
        actual_departure TEXT NOT NULL DEFAULT '',
        actual_arrival TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        ended_at TEXT NOT NULL DEFAULT ''
      )
    ''');
  }

  /// Shared between a fresh install (v16 onCreate) and upgrades (v16 onUpgrade):
  /// the "master route templates" a conductor uses to open an unscheduled
  /// on-the-go run — stage list plus the stage-to-stage fare matrix.
  static Future<void> _createRouteTemplateSchema(Database d) async {
    await d.execute('''
      CREATE TABLE IF NOT EXISTS route_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT ''
      )
    ''');
    await d.execute('''
      CREATE TABLE IF NOT EXISTS route_template_stages (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL
      )
    ''');
    await d.execute(
        'CREATE INDEX IF NOT EXISTS idx_rts_template ON route_template_stages(template_id, seq)');
    await d.execute('''
      CREATE TABLE IF NOT EXISTS route_template_fares (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        price_cents INTEGER NOT NULL DEFAULT 0
      )
    ''');
    await d.execute(
        'CREATE INDEX IF NOT EXISTS idx_rtf_template ON route_template_fares(template_id)');
  }

  /// All templates with their stages and fare matrix hydrated, in creation
  /// order. Stages come back sorted by seq so callers can index by position.
  static Future<List<RouteTemplate>> getRouteTemplates() async {
    final d = await db;
    final rows =
        await d.query('route_templates', orderBy: 'created_at ASC, name ASC');
    if (rows.isEmpty) return const [];
    final ids = rows.map((r) => (r['id'] as String?) ?? '').toList();
    final marks = List.filled(ids.length, '?').join(',');
    final stageRows = await d.query(
      'route_template_stages',
      where: 'template_id IN ($marks)',
      whereArgs: ids,
      orderBy: 'template_id ASC, seq ASC',
    );
    final fareRows = await d.query(
      'route_template_fares',
      where: 'template_id IN ($marks)',
      whereArgs: ids,
      orderBy: 'template_id ASC, from_seq ASC, to_seq ASC',
    );
    final stagesBy = <String, List<RouteStage>>{};
    for (final r in stageRows) {
      final s = RouteStage.fromRow(r);
      stagesBy.putIfAbsent(s.templateId, () => []).add(s);
    }
    final faresBy = <String, List<RouteStageFare>>{};
    for (final r in fareRows) {
      final f = RouteStageFare.fromRow(r);
      faresBy.putIfAbsent(f.templateId, () => []).add(f);
    }
    return rows
        .map((r) => RouteTemplate.fromRow(
              r,
              stages: stagesBy[(r['id'] as String?) ?? ''] ?? const [],
              fares: faresBy[(r['id'] as String?) ?? ''] ?? const [],
            ))
        .toList();
  }

  static Future<RouteTemplate?> getRouteTemplate(String id) async {
    final all = await getRouteTemplates();
    for (final t in all) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// Inserts or updates [template] together with its full stage list and fare
  /// matrix. Children are replaced wholesale in one transaction — the matrix is
  /// small (stage count squared at worst) and a partial diff would risk orphan
  /// rows when a stage is renamed or removed.
  static Future<void> saveRouteTemplate(RouteTemplate template) async {
    final d = await db;
    await d.transaction((txn) async {
      final id = template.id.isEmpty ? uuidV4() : template.id;
      final row = template.toRow()..['id'] = id;
      // Upsert: an UPDATE that matches nothing must not silently drop the
      // template on the floor (a caller passing an id we no longer hold would
      // otherwise see the save "succeed" with nothing written).
      final changed = template.id.isEmpty
          ? 0
          : await txn
              .update('route_templates', row, where: 'id = ?', whereArgs: [id]);
      if (changed == 0) {
        await txn.insert('route_templates', row);
      }
      await txn.delete('route_template_stages',
          where: 'template_id = ?', whereArgs: [id]);
      await txn.delete('route_template_fares',
          where: 'template_id = ?', whereArgs: [id]);
      var seq = 0;
      for (final s in template.stages) {
        seq++;
        if (s.name.trim().isEmpty) continue;
        await txn.insert('route_template_stages', {
          'id': s.id.isEmpty ? uuidV4() : s.id,
          'template_id': id,
          'seq': s.seq > 0 ? s.seq : seq,
          'name': s.name.trim(),
        });
      }
      for (final f in template.fares) {
        if (f.fromSeq == f.toSeq) continue;
        await txn.insert('route_template_fares', {
          'id': f.id.isEmpty ? uuidV4() : f.id,
          'template_id': id,
          'from_seq': f.fromSeq,
          'to_seq': f.toSeq,
          'price_cents': f.priceCents,
        });
      }
    });
  }

  /// Deletes a template and its stages/matrix. Existing sales are untouched —
  /// they only reference the trip, never the template.
  static Future<void> deleteRouteTemplate(String id) async {
    final d = await db;
    await d.transaction((txn) async {
      await txn.delete('route_template_fares',
          where: 'template_id = ?', whereArgs: [id]);
      await txn.delete('route_template_stages',
          where: 'template_id = ?', whereArgs: [id]);
      await txn.delete('route_templates', where: 'id = ?', whereArgs: [id]);
    });
  }

  /// Active templates only (conductor-facing pickers).
  static Future<List<RouteTemplate>> getActiveRouteTemplates() async {
    final all = await getRouteTemplates();
    return all.where((t) => t.active && t.isUsable).toList();
  }

  static Future<List<Fare>> getFares({bool onlyEnabled = true}) async {
    final d = await db;
    final rows = await d.query('fares',
        where: onlyEnabled ? 'enabled = 1' : null, orderBy: 'id ASC');
    return rows.map(Fare.fromMap).toList();
  }

  static Future<int> addFare(String name, int price) async {
    final d = await db;
    return d.insert('fares', {'name': name, 'price': price, 'enabled': 1});
  }

  static Future<void> updateFare(Fare fare) async {
    final d = await db;
    await d.update(
        'fares',
        {
          'name': fare.name,
          'price': fare.price,
          'enabled': fare.enabled ? 1 : 0,
        },
        where: 'id = ?',
        whereArgs: [fare.id]);
  }

  static Future<void> deleteFare(int id) async {
    final d = await db;
    await d.delete('fares', where: 'id = ?', whereArgs: [id]);
  }

  // ── Fare requests ─────────────────────────────────────────────────────────
  // Field staff cannot edit the fare catalogue (that is a revenue control), but
  // they often meet a tariff the device has never heard of. Rather than let
  // them invent a fare or hit a dead end, they log a request here and an admin
  // approves it into the real catalogue. Stored as a JSON array under the
  // `settings` table so no schema migration is needed.

  static const _fareRequestKey = 'fare_requests';

  /// Pending fare requests, oldest first. Unparseable or foreign-shaped data is
  /// treated as empty rather than throwing, so a bad write can never brick the
  /// sell screen.
  static Future<List<Map<String, Object?>>> getFareRequests() async {
    final raw = await getSetting(_fareRequestKey, '[]');
    if (raw == null || raw.trim().isEmpty) return [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [];
      return decoded
          .whereType<Map<String, Object?>>()
          .where((m) => m['name'] is String && (m['name'] as String).isNotEmpty)
          .toList();
    } on FormatException {
      return [];
    }
  }

  /// Records a conductor's request for a fare. Returns false when one with the
  /// same name is already pending, so repeated taps cannot pile up duplicates.
  static Future<bool> addFareRequest({
    required String name,
    required int price,
    String? note,
    String? by,
  }) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return false;
    final pending = await getFareRequests();
    final exists = pending.any(
        (m) => (m['name'] as String).toLowerCase() == trimmed.toLowerCase());
    if (exists) return false;
    pending.add(<String, Object?>{
      'name': trimmed,
      'price': price,
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
      if (by != null && by.trim().isNotEmpty) 'by': by.trim(),
      'at': DateTime.now().toIso8601String(),
    });
    await setSetting(_fareRequestKey, jsonEncode(pending));
    return true;
  }

  static Future<void> clearFareRequests() async {
    await setSetting(_fareRequestKey, '[]');
  }

  // ── Helper: build canonical payload string (must match server exactly) ──

  static const _unitSep = '\x1f';

  static String buildCanonicalTicketPayload({
    required String txId,
    required String clientReceiptNo,
    required String tripNo,
    required String routeCode,
    required String routeName,
    required String driver,
    required String driverPhone,
    required String conductor1,
    required String conductor2,
    required String conductorPhone,
    required String seatNumber,
    required String customerName,
    required String customerMobile,
    required String itemsJson,
    required int totalCents,
    required int cashCents,
    required int changeCents,
    required String saleTime,
  }) {
    return [
      txId,
      clientReceiptNo,
      tripNo,
      routeCode,
      routeName,
      driver,
      driverPhone,
      conductor1,
      conductor2,
      conductorPhone,
      seatNumber,
      customerName,
      customerMobile,
      itemsJson,
      totalCents.toString(),
      cashCents.toString(),
      changeCents.toString(),
      saleTime,
    ].join(_unitSep);
  }

  // ── Field encryption helpers ──

  static Future<String> _enc(String? v) async =>
      (await FieldCrypto.instance.encrypt(v ?? '')) ?? '';
  static Future<String> _dec(String? v) async =>
      (await FieldCrypto.instance.decrypt(v ?? '')) ?? '';

  static Future<int> insertSale(Sale sale) async {
    final d = await db;
    final deviceId = await SecureKeystore.instance.readDeviceUuid();
    final rng = Random.secure();
    final txId =
        '$deviceId-${DateTime.now().millisecondsSinceEpoch}-${rng.nextInt(0x10000).toRadixString(16)}';

    final detailsJson = jsonEncode(sale.items.map((i) => i.toJson()).toList());
    final saleTime = sale.createdAt!.toIso8601String();
    final totalCents = sale.total;
    final cashCents = sale.cash;
    final changeCents = sale.change;

    final payloadStr = buildCanonicalTicketPayload(
      txId: txId,
      clientReceiptNo: sale.receiptNo,
      tripNo: sale.tripNo,
      routeCode: sale.routeCode,
      routeName: sale.routeName,
      driver: sale.driver,
      driverPhone: sale.driverPhone,
      conductor1: sale.conductor1,
      conductor2: sale.conductor2,
      conductorPhone: sale.conductorPhone,
      seatNumber: sale.seatNumber,
      customerName: sale.customerName,
      customerMobile: sale.customerMobile,
      itemsJson: detailsJson,
      totalCents: totalCents,
      cashCents: cashCents,
      changeCents: changeCents,
      saleTime: saleTime,
    );

    final sigBytes =
        await SecureKeystore.instance.sign(utf8.encode(payloadStr));
    final sigB64 = base64UrlEncode(sigBytes).replaceAll('=', '');

    final encBusReg = await _enc(sale.busReg);
    final encDriver = await _enc(sale.driver);
    final encDriverPhone = await _enc(sale.driverPhone);
    final encConductor1 = await _enc(sale.conductor1);
    final encConductor2 = await _enc(sale.conductor2);
    final encConductorPhone = await _enc(sale.conductorPhone);
    final encSeatNumber = await _enc(sale.seatNumber);
    final encCustomerName = await _enc(sale.customerName);
    final encCustomerMobile = await _enc(sale.customerMobile);

    return d.insert('sales', {
      'receipt_no': sale.receiptNo,
      'ticket_type': sale.ticketType,
      'company_id':
          (await SecureKeystore.instance.readCompanyId()) ?? sale.companyId,
      'route_code': sale.routeCode,
      'route_name': sale.routeName,
      'bus_reg': encBusReg,
      'driver': encDriver,
      'driver_phone': encDriverPhone,
      'conductor1': encConductor1,
      'conductor2': encConductor2,
      'conductor_phone': encConductorPhone,
      'seat_number': encSeatNumber,
      'trip_no': sale.tripNo,
      'trip_id': sale.tripId,
      'trip_instance_id': sale.tripInstanceId,
      'shift_id': sale.shiftId,
      'driver_id': sale.driverId,
      'conductor_id': sale.conductorId,
      'payment_method': sale.paymentMethod,
      'customer_name': encCustomerName,
      'customer_mobile': encCustomerMobile,
      'custom_fare': sale.customFare,
      'departure_time': sale.departureTime,
      'luggage_linked_ticket_id': sale.luggageLinkedTicketId,
      'details': detailsJson,
      'total': totalCents,
      'cash': cashCents,
      'change': changeCents,
      'created_at': saleTime,
      'synced': 0,
      'printed': 0,
      'tx_id': txId,
      'signature': sigB64,
    });
  }

  /// Sales newest-first. [offset]/[limit] page the result so the history list
  /// never loads the whole table at once (large offline queues stay usable).
  /// A null [limit] returns everything for the tiny call sites that need it.
  static Future<List<Sale>> getSales({int? limit, int offset = 0}) async {
    final d = await db;
    final rows = await d.query('sales',
        orderBy: 'id DESC',
        limit: limit ?? 200,
        offset: offset < 0 ? 0 : offset);
    return [for (final row in rows) await _saleFromRow(row)];
  }

  /// Total sales rows (for paging "load more" in history).
  static Future<int> getSalesCount() async {
    final d = await db;
    final result = Sqflite.firstIntValue(
        await d.rawQuery('SELECT COUNT(*) AS c FROM sales'));
    return result ?? 0;
  }

  /// A single sale by rowid — used after insert to read back the generated tx_id.
  static Future<Sale?> getSaleById(int? id) async {
    if (id == null) return null;
    final d = await db;
    final rows =
        await d.query('sales', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return _saleFromRow(rows.first);
  }

  /// The latest sale created under a given tx_id (e.g. the bus-fare ticket a
  /// luggage ticket links back to via `luggage_linked_ticket_id`). Used so a
  /// reprinted luggage ticket inherits the linked bus-fare vehicle/crew.
  static Future<Sale?> getSaleByTxId(String txId) async {
    if (txId.isEmpty) return null;
    final d = await db;
    final rows =
        await d.query('sales', where: 'tx_id = ?', whereArgs: [txId], limit: 1);
    if (rows.isEmpty) return null;
    return _saleFromRow(rows.first);
  }

  static Future<List<Sale>> getSalesBetween(
      DateTime start, DateTime end) async {
    final d = await db;
    final rows = await d.query('sales',
        where: 'created_at >= ? AND created_at <= ?',
        whereArgs: [start.toIso8601String(), end.toIso8601String()],
        orderBy: 'id ASC');
    return [for (final row in rows) await _saleFromRow(row)];
  }

  static Future<List<Sale>> getUnsyncedSales() async {
    final d = await db;
    final rows = await d.query('sales', where: 'synced = 0', orderBy: 'id ASC');
    return [for (final row in rows) await _saleFromRow(row)];
  }

  /// All sales (any date) attached to a specific trip, e.g. for manifests.
  static Future<List<Sale>> getSalesByTrip(String tripId) async {
    if (tripId.isEmpty) return [];
    final d = await db;
    final rows = await d.query('sales',
        where: 'trip_id = ?', whereArgs: [tripId], orderBy: 'id ASC');
    return [for (final row in rows) await _saleFromRow(row)];
  }

  /// All sales for a shift (any trip, any sync state) — used for shift
  /// manifests so a run printed mid-shift still captures unsynced tickets.
  static Future<List<Sale>> getSalesByShift(String shiftId) async {
    if (shiftId.isEmpty) return [];
    final d = await db;
    final rows = await d.query('sales',
        where: 'shift_id = ?', whereArgs: [shiftId], orderBy: 'id ASC');
    return [for (final row in rows) await _saleFromRow(row)];
  }

  static Future<void> markSalesSynced(List<int> ids) async {
    if (ids.isEmpty) return;
    final d = await db;
    final placeholders = List.filled(ids.length, '?').join(',');
    await d.rawUpdate(
        'UPDATE sales SET synced = 1 WHERE id IN ($placeholders)', ids);
  }

  static Future<void> setPrinted(int id) async {
    final d = await db;
    await d.update('sales', {'printed': 1}, where: 'id = ?', whereArgs: [id]);
  }

  /// Records the same passenger name/phone on an existing sale (used when a
  /// luggage ticket confirms the passenger's details and the linked bus-fare
  /// ticket must carry them too). PII stays encrypted like insertSale. If the
  /// sale has not synced yet it is re-marked unsynced so the fresher payload
  /// reaches the server once; an already-synced row is left synced so it never
  /// loops as a duplicate.
  static Future<void> updateSaleCustomer(
    int? id, {
    required String customerName,
    required String customerMobile,
  }) async {
    if (id == null) return;
    final d = await db;
    final rows = await d.query('sales',
        columns: ['synced'], where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return;
    final alreadySynced = (rows.first['synced'] as int?) == 1;
    final patch = <String, Object?>{
      'customer_name': await _enc(customerName.trim()),
      'customer_mobile': await _enc(customerMobile.trim()),
    };
    if (!alreadySynced) patch['synced'] = 0;
    await d.update('sales', patch, where: 'id = ?', whereArgs: [id]);
  }

  /// Backfills missing fields on an existing sale after a successful server
  /// fetch (ticket detail). Only non-empty values are written so a bad or
  /// partial server row can never wipe locally-collected data. PII columns
  /// are encrypted exactly like insertSale does.
  static Future<void> hydrateSale(
    int? id, {
    String? customerName,
    String? customerMobile,
    String? busReg,
    String? driver,
    String? driverPhone,
    String? conductor1,
    String? conductor2,
    String? conductorPhone,
    String? departureTime,
    String? paymentMethod,
  }) async {
    if (id == null) return;
    final d = await db;
    final patch = <String, Object?>{};
    if (customerName != null && customerName.trim().isNotEmpty) {
      patch['customer_name'] = await _enc(customerName.trim());
    }
    if (customerMobile != null && customerMobile.trim().isNotEmpty) {
      patch['customer_mobile'] = await _enc(customerMobile.trim());
    }
    if (busReg != null && busReg.trim().isNotEmpty) {
      patch['bus_reg'] = await _enc(busReg.trim());
    }
    if (driver != null && driver.trim().isNotEmpty) {
      patch['driver'] = await _enc(driver.trim());
    }
    if (driverPhone != null && driverPhone.trim().isNotEmpty) {
      patch['driver_phone'] = await _enc(driverPhone.trim());
    }
    if (conductor1 != null && conductor1.trim().isNotEmpty) {
      patch['conductor1'] = await _enc(conductor1.trim());
    }
    if (conductor2 != null && conductor2.trim().isNotEmpty) {
      patch['conductor2'] = await _enc(conductor2.trim());
    }
    if (conductorPhone != null && conductorPhone.trim().isNotEmpty) {
      patch['conductor_phone'] = await _enc(conductorPhone.trim());
    }
    if (departureTime != null && departureTime.trim().isNotEmpty) {
      patch['departure_time'] = departureTime.trim();
    }
    if (paymentMethod != null && paymentMethod.trim().isNotEmpty) {
      patch['payment_method'] = paymentMethod.trim();
    }
    if (patch.isEmpty) return;
    await d.update('sales', patch, where: 'id = ?', whereArgs: [id]);
  }

  static Future<Sale> _saleFromRow(Map<String, Object?> row) async => Sale(
        id: row['id'] as int,
        receiptNo: row['receipt_no'] as String,
        ticketType: row['ticket_type'] as String? ?? 'busFare',
        companyId: row['company_id'] as String? ?? '',
        routeCode: row['route_code'] as String? ?? '',
        routeName: row['route_name'] as String? ?? '',
        busReg: await _dec(row['bus_reg'] as String?),
        driver: await _dec(row['driver'] as String?),
        driverPhone: await _dec(row['driver_phone'] as String?),
        conductor1: await _dec(row['conductor1'] as String?),
        conductor2: await _dec(row['conductor2'] as String?),
        conductorPhone: await _dec(row['conductor_phone'] as String?),
        seatNumber: await _dec(row['seat_number'] as String?),
        tripNo: row['trip_no'] as String? ?? '',
        tripId: row['trip_id'] as String? ?? '',
        tripInstanceId: row['trip_instance_id'] as String? ?? '',
        shiftId: row['shift_id'] as String? ?? '',
        driverId: row['driver_id'] as String? ?? '',
        conductorId: row['conductor_id'] as String? ?? '',
        paymentMethod: row['payment_method'] as String? ?? 'cash',
        customerName: await _dec(row['customer_name'] as String?),
        customerMobile: await _dec(row['customer_mobile'] as String?),
        customFare: (row['custom_fare'] as num?)?.toInt() ?? 0,
        departureTime: row['departure_time'] as String? ?? '',
        luggageLinkedTicketId: row['luggage_linked_ticket_id'] as String? ?? '',
        items: (jsonDecode(row['details'] as String) as List)
            .map((e) => SaleItem.fromJson((e as Map).cast<String, dynamic>()))
            .toList(),
        total: row['total'] as int,
        cash: row['cash'] as int,
        change: row['change'] as int,
        createdAt: DateTime.parse(row['created_at'] as String),
        synced: row['synced'] as int,
        printed: row['printed'] as int,
        txId: row['tx_id'] as String? ?? '',
        signature: row['signature'] as String? ?? '',
      );

  static Future<String?> getSetting(String key, [String? fallback]) async {
    final d = await db;
    final rows = await d.query('settings',
        columns: ['value'], where: 'key = ?', whereArgs: [key], limit: 1);
    if (rows.isEmpty) return fallback;
    return rows.first['value'] as String?;
  }

  /// One round-trip fetch of many settings, keyed by name. Missing keys are
  /// simply absent from the map — callers apply their own defaults. Replaces
  /// the N-way `Future.wait` of individual [getSetting] calls on heavy screens.
  static Future<Map<String, String>> getSettings(List<String> keys) async {
    if (keys.isEmpty) return const {};
    final d = await db;
    final placeholders = List.filled(keys.length, '?').join(', ');
    final rows = await d.rawQuery(
        'SELECT key, value FROM settings WHERE key IN ($placeholders)', keys);
    return {
      for (final r in rows)
        if (r['key'] != null)
          (r['key'] as String): (r['value'] as String?) ?? '',
    };
  }

  static Future<void> setSetting(String key, String value) async {
    final d = await db;
    await d.insert('settings', {'key': key, 'value': value},
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  static Future<String> nextReceiptNo() async {
    final prefix = (await getSetting('receipt_prefix', 'AGJ'))?.trim();
    final count =
        int.tryParse(await getSetting('receipt_counter', '0') ?? '0') ?? 0;
    final next = count + 1;
    await setSetting('receipt_counter', '$next');
    if (prefix == null || prefix.isEmpty) return '$next';
    return '$prefix${next.toString().padLeft(4, '0')}';
  }

  static Future<String> deviceId() async =>
      SecureKeystore.instance.readDeviceUuid();

  // ---- Drivers ----

  static Future<List<Driver>> getDrivers({bool onlyActive = true}) async {
    final d = await db;
    final rows = await d.query('drivers',
        where: onlyActive ? 'active = 1' : null, orderBy: 'name ASC');
    return rows.map(Driver.fromMap).toList();
  }

  static Future<int> addDriver(String name, String phone) async {
    final d = await db;
    return d.insert('drivers', {'name': name, 'phone': phone, 'active': 1});
  }

  static Future<void> updateDriver(Driver driver) async {
    final d = await db;
    await d.update(
        'drivers',
        {
          'name': driver.name,
          'phone': driver.phone,
          'active': driver.active ? 1 : 0,
        },
        where: 'id = ?',
        whereArgs: [driver.id]);
  }

  static Future<void> deleteDriver(int id) async {
    final d = await db;
    await d.delete('drivers', where: 'id = ?', whereArgs: [id]);
  }

  // ---- Conductors ----

  static Future<List<Conductor>> getConductors({bool onlyActive = true}) async {
    final d = await db;
    final rows = await d.query('conductors',
        where: onlyActive ? 'active = 1' : null, orderBy: 'name ASC');
    return rows.map(Conductor.fromMap).toList();
  }

  static Future<int> addConductor(String name, String phone) async {
    final d = await db;
    return d.insert('conductors', {'name': name, 'phone': phone, 'active': 1});
  }

  static Future<void> updateConductor(Conductor conductor) async {
    final d = await db;
    await d.update(
        'conductors',
        {
          'name': conductor.name,
          'phone': conductor.phone,
          'active': conductor.active ? 1 : 0,
        },
        where: 'id = ?',
        whereArgs: [conductor.id]);
  }

  static Future<void> deleteConductor(int id) async {
    final d = await db;
    await d.delete('conductors', where: 'id = ?', whereArgs: [id]);
  }

  // ---- Staff roster (admin-managed profiles) ----

  /// Merges web-admin-created DRIVER / CONDUCTOR profiles into the local
  /// picker tables. Matches by full name (case-insensitive) so a phone change
  /// made in the admin console updates the existing row instead of duplicating
  /// it; nothing is ever deleted locally. {@code status} drives the active flag.
  static Future<void> upsertStaffRoster(List<StaffProfile> staff) async {
    final d = await db;
    final batch = d.batch();
    for (final s in staff) {
      final table = s.role == 'CONDUCTOR' ? 'conductors' : 'drivers';
      final existing = await d.query(table,
          where: 'name = ? COLLATE NOCASE', whereArgs: [s.fullName], limit: 1);
      if (existing.isNotEmpty) {
        batch.update(table, {'phone': s.phone, 'active': s.active ? 1 : 0},
            where: 'id = ?', whereArgs: [existing.first['id']]);
      } else {
        batch.insert(table, {
          'name': s.fullName,
          'phone': s.phone,
          'active': s.active ? 1 : 0,
        });
      }
    }
    await batch.commit(noResult: true);
  }

  // ---- Trips ----

  static Future<List<Trip>> getTrips({List<String>? statuses}) async {
    final d = await db;
    final rows = await d.query(
      'trips',
      where: statuses == null || statuses.isEmpty
          ? null
          : 'status IN (${List.filled(statuses.length, '?').join(',')})',
      whereArgs: statuses,
      orderBy: 'departure_time ASC, id ASC',
    );
    return rows.map(Trip.fromMap).toList();
  }

  static Future<Trip?> getTrip(String id) async {
    if (id.isEmpty) return null;
    final d = await db;
    final rows =
        await d.query('trips', where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return Trip.fromMap(rows.first);
  }

  /// Local upsert mirroring the server trip (server row wins when status/others conflict).
  static Future<void> upsertTrip(Trip trip) async {
    final d = await db;
    await d.insert('trips', trip.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  static Future<void> upsertTrips(List<Trip> trips) async {
    if (trips.isEmpty) return;
    final d = await db;
    final batch = d.batch();
    for (final t in trips) {
      batch.insert('trips', t.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  static Future<void> deleteTrip(String id) async {
    final d = await db;
    await d.delete('trips', where: 'id = ?', whereArgs: [id]);
  }

  static Future<void> clearTrips() async {
    final d = await db;
    await d.delete('trips');
  }

  /// The currently selected trip for sales on this device.
  static Future<Trip?> getActiveTrip() async {
    final raw = await getSetting('active_trip', '');
    if (raw == null || raw.isEmpty) return null;
    try {
      final map = jsonDecode(raw) as Map<String, dynamic>;
      return Trip.fromJson(map);
    } catch (_) {
      return null;
    }
  }

  static Future<void> setActiveTrip(Trip? trip) async {
    if (trip == null) {
      await setSetting('active_trip', '');
      return;
    }
    await setSetting(
        'active_trip',
        jsonEncode({
          'id': trip.id,
          'tripNo': trip.tripNo,
          'routeCode': trip.routeCode,
          'routeFrom': trip.routeFrom,
          'routeTo': trip.routeTo,
          'routeName': trip.routeName,
          'busReg': trip.busReg,
          'driver': trip.driver,
          'driverPhone': trip.driverPhone,
          'driverId': trip.driverId,
          'conductor': trip.conductor,
          'conductorPhone': trip.conductorPhone,
          'conductorId': trip.conductorId,
          'departureTime': trip.departureTime,
          'status': trip.status,
          'totalSeats': trip.totalSeats,
          'seatsSold': trip.seatsSold,
        }));
  }

  // ---- Promotions ----

  static Future<List<Promo>> getPromotions({bool onlyActive = true}) async {
    final d = await db;
    final rows = await d.query('promotions',
        where: onlyActive ? 'active = 1' : null,
        orderBy: 'active DESC, code ASC');
    return rows.map(Promo.fromMap).toList();
  }

  static Future<Promo?> findPromo(String code) async {
    if (code.trim().isEmpty) return null;
    final d = await db;
    final rows = await d.query('promotions',
        where: 'code = ? COLLATE NOCASE', whereArgs: [code.trim()], limit: 1);
    if (rows.isEmpty) return null;
    return Promo.fromMap(rows.first);
  }

  static Future<void> upsertPromo(Promo promo) async {
    final d = await db;
    await d.insert('promotions', promo.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  static Future<void> upsertPromos(List<Promo> promos) async {
    if (promos.isEmpty) return;
    final d = await db;
    final batch = d.batch();
    for (final p in promos) {
      batch.insert('promotions', p.toMap(),
          conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await batch.commit(noResult: true);
  }

  static Future<void> deletePromo(String id) async {
    if (id.isEmpty) return;
    final d = await db;
    await d.delete('promotions', where: 'id = ?', whereArgs: [id]);
  }

  static Future<void> setPromoActive(String id, bool active) async {
    if (id.isEmpty) return;
    final d = await db;
    await d.update('promotions', {'active': active ? 1 : 0},
        where: 'id = ?', whereArgs: [id]);
  }

  static Future<void> bumpPromoUsage(String code) async {
    final d = await db;
    await d.rawUpdate(
        'UPDATE promotions SET usage_count = usage_count + 1 WHERE code = ? COLLATE NOCASE',
        [code.trim()]);
  }

  // ---- Company profile (receipt branding) ----

  static Future<void> upsertCompanyProfile(CompanyProfile profile) async {
    final d = await db;
    await d.insert('company_profile', profile.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  static Future<CompanyProfile?> getCompanyProfile() async {
    final d = await db;
    final rows = await d.query('company_profile', limit: 1);
    if (rows.isEmpty) return null;
    return CompanyProfile.fromMap(rows.first);
  }

  static Future<void> clearCompanyProfile() async {
    final d = await db;
    await d.delete('company_profile');
  }

  // ---- Driver shifts ----

  /// Opens a shift locally, closing any shift already open on this device.
  /// Offline-first — the shift is pushed to the server during the next sync.
  static Future<void> startShift({
    required String id,
    String driverId = '',
    String driverName = '',
    String driverPhone = '',
    String conductorName = '',
    String conductorPhone = '',
    String vehicleReg = '',
  }) async {
    final d = await db;
    final now = DateTime.now().toIso8601String();
    await d.transaction((txn) async {
      await txn.update('driver_shifts', {'status': 'CLOSED', 'closed_at': now},
          where: "status = 'OPEN'");
      await txn.insert('driver_shifts', {
        'id': id,
        'driver_id': driverId,
        'driver_name': driverName,
        'driver_phone': driverPhone,
        'conductor_name': conductorName,
        'conductor_phone': conductorPhone,
        'vehicle_reg': vehicleReg,
        'status': 'OPEN',
        'started_at': now,
        'closed_at': '',
        'synced': 0,
      });
    });
  }

  static Future<DriverShift?> getActiveShift() async {
    final d = await db;
    final rows = await d.query('driver_shifts',
        where: "status = 'OPEN'", orderBy: 'started_at DESC', limit: 1);
    if (rows.isEmpty) return null;
    return DriverShift.fromMap(rows.first);
  }

  /// The driver shift that covered [day] — the one opened that calendar day
  /// (latest first), used to stamp the end-of-day report with its crew.
  static Future<DriverShift?> getShiftForDay(DateTime day) async {
    final start = DateTime(day.year, day.month, day.day);
    final end = start.add(const Duration(days: 1));
    final d = await db;
    final rows = await d.query('driver_shifts',
        where: 'started_at >= ? AND started_at < ?',
        whereArgs: [start.toIso8601String(), end.toIso8601String()],
        orderBy: 'started_at DESC',
        limit: 1);
    if (rows.isEmpty) return null;
    return DriverShift.fromMap(rows.first);
  }

  /// Resolves a roster phone for the conductor whose profile is matched by
  /// full name (case-insensitive). Used to auto-fill the ticket's crew block
  /// from the signed-in operator rather than trusting typed input.
  static Future<Conductor?> findConductorByFullName(String name) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return null;
    final d = await db;
    final rows = await d.query('conductors',
        where: 'name = ? COLLATE NOCASE', whereArgs: [trimmed], limit: 1);
    if (rows.isEmpty) return null;
    return Conductor.fromMap(rows.first);
  }

  static Future<DriverShift?> getShift(String id) async {
    if (id.isEmpty) return null;
    final d = await db;
    final rows = await d.query('driver_shifts',
        where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return DriverShift.fromMap(rows.first);
  }

  static Future<void> closeActiveShift() async {
    final d = await db;
    await d.update(
        'driver_shifts',
        {
          'status': 'CLOSED',
          'closed_at': DateTime.now().toIso8601String(),
        },
        where: "status = 'OPEN'");
  }

  static Future<void> markShiftSynced(String id) async {
    if (id.isEmpty) return;
    final d = await db;
    await d.update('driver_shifts', {'synced': 1},
        where: 'id = ?', whereArgs: [id]);
  }

  // ---- Offline trip-lifecycle replay queue ----

  /// Records a lifecycle action that happened offline so it can be replayed to
  /// the server during the next sync. [eventUuid] is the idempotency key —
  /// callers generate one transaction UUID per action.
  static Future<void> queueEvent({
    required String eventType,
    required String eventUuid,
    String tripId = '',
    String tripNo = '',
    String shiftId = '',
    String payload = '',
  }) async {
    final d = await db;
    await d.insert('sync_queue', {
      'event_uuid': eventUuid,
      'event_type': eventType,
      'trip_id': tripId,
      'trip_no': tripNo,
      'shift_id': shiftId,
      'payload': payload,
      'created_at': DateTime.now().toUtc().toIso8601String(),
      'synced': 0,
    });
  }

  static Future<List<SyncQueueEvent>> getUnsyncedEvents() async {
    final d = await db;
    final rows =
        await d.query('sync_queue', where: 'synced = 0', orderBy: 'id ASC');
    return rows.map(SyncQueueEvent.fromMap).toList();
  }

  static Future<void> markEventSynced(int id) async {
    final d = await db;
    await d.update('sync_queue', {'synced': 1},
        where: 'id = ?', whereArgs: [id]);
  }

  static Future<void> markEventsSynced(List<int> ids) async {
    if (ids.isEmpty) return;
    final d = await db;
    final placeholders = List.filled(ids.length, '?').join(',');
    await d.rawUpdate(
        'UPDATE sync_queue SET synced = 1 WHERE id IN ($placeholders)', ids);
  }

  // ---- Running trip instance store ----

  static Future<void> insertTripInstance(TripInstance instance) async {
    final d = await db;
    await d.insert('trip_instances', instance.toMap(),
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  static Future<TripInstance?> getRunningTripInstance() async {
    final d = await db;
    final rows = await d.query('trip_instances',
        where: "status = 'RUNNING'", orderBy: 'started_at DESC', limit: 1);
    if (rows.isEmpty) return null;
    return TripInstance.fromMap(rows.first);
  }

  /// Every RUNNING instance on this device, newest first. Used by the duplicate-
  /// start guard and the stuck-run reconcile so ghost rows can be found and
  /// cleared even when more than one exists for the same (or different) trip.
  static Future<List<TripInstance>> getRunningTripInstances() async {
    final d = await db;
    final rows = await d.query('trip_instances',
        where: "status = 'RUNNING'", orderBy: 'started_at DESC');
    return rows.map(TripInstance.fromMap).toList();
  }

  /// A RUNNING instance for one specific trip (newest first), or null.
  static Future<TripInstance?> getRunningTripInstanceForTrip(
      String tripId) async {
    if (tripId.isEmpty) return null;
    final d = await db;
    final rows = await d.query('trip_instances',
        where: "status = 'RUNNING' AND trip_id = ?",
        whereArgs: [tripId],
        orderBy: 'started_at DESC',
        limit: 1);
    if (rows.isEmpty) return null;
    return TripInstance.fromMap(rows.first);
  }

  /// Ends every RUNNING instance for a trip with the same arrival stamp — a
  /// duplicate-start race can leave several RUNNING rows for one trip, so ending
  /// must clear all of them, never just one.
  static Future<void> endRunningInstancesForTrip(String tripId,
      {DateTime? arrivedAt}) async {
    if (tripId.isEmpty) return;
    final d = await db;
    final arrived = arrivedAt ?? DateTime.now();
    await d.update(
        'trip_instances',
        {
          'status': 'ENDED',
          'actual_arrival': arrived.toUtc().toIso8601String(),
          'ended_at': arrived.toUtc().toIso8601String(),
        },
        where: "status = 'RUNNING' AND trip_id = ?",
        whereArgs: [tripId]);
  }

  /// Ends every RUNNING instance on the device (settings "Force End" valve).
  /// Sales rows are never touched — they keep their trip reference and remain
  /// queued for sync, so no offline revenue is dropped.
  static Future<void> endAllRunningInstances({DateTime? arrivedAt}) async {
    final d = await db;
    final arrived = arrivedAt ?? DateTime.now();
    await d.update(
        'trip_instances',
        {
          'status': 'ENDED',
          'actual_arrival': arrived.toUtc().toIso8601String(),
          'ended_at': arrived.toUtc().toIso8601String(),
        },
        where: "status = 'RUNNING'");
  }

  static Future<TripInstance?> getTripInstance(String id) async {
    if (id.isEmpty) return null;
    final d = await db;
    final rows = await d.query('trip_instances',
        where: 'id = ?', whereArgs: [id], limit: 1);
    if (rows.isEmpty) return null;
    return TripInstance.fromMap(rows.first);
  }

  /// Ends the running instance: stamps the actual arrival and flips it to ENDED.
  static Future<void> endTripInstance(String id, {DateTime? arrivedAt}) async {
    if (id.isEmpty) return;
    final d = await db;
    final arrived = arrivedAt ?? DateTime.now();
    await d.update(
        'trip_instances',
        {
          'status': 'ENDED',
          'actual_arrival': arrived.toUtc().toIso8601String(),
          'ended_at': arrived.toUtc().toIso8601String(),
        },
        where: 'id = ?',
        whereArgs: [id]);
  }

  /// Live ticket count for a shift (computed from sales — always accurate).
  static Future<int> shiftTicketCount(String shiftId) async {
    if (shiftId.isEmpty) return 0;
    final d = await db;
    final rows = await d.rawQuery(
        'SELECT COUNT(*) AS c FROM sales WHERE shift_id = ?', [shiftId]);
    if (rows.isEmpty) return 0;
    return (rows.first['c'] as int?) ?? 0;
  }

  /// Live gross (cents) for a shift, computed from sales.
  static Future<int> shiftTotalCents(String shiftId) async {
    if (shiftId.isEmpty) return 0;
    final d = await db;
    final rows = await d.rawQuery(
        'SELECT COALESCE(SUM(total), 0) AS t FROM sales WHERE shift_id = ?',
        [shiftId]);
    if (rows.isEmpty) return 0;
    return (rows.first['t'] as int?) ?? 0;
  }

  // ---- Vehicles (cached local registrations) ----

  static Future<List<Vehicle>> getVehicles({bool onlyActive = true}) async {
    final d = await db;
    final rows = await d.query('vehicles',
        where: onlyActive ? 'active = 1' : null, orderBy: 'registration ASC');
    return rows.map(Vehicle.fromMap).toList();
  }

  static Future<void> addVehicle(String registration) async {
    final reg = registration.trim();
    if (reg.isEmpty) return;
    final d = await db;
    await d.insert('vehicles', {'registration': reg, 'active': 1},
        conflictAlgorithm: ConflictAlgorithm.ignore);
  }
}
