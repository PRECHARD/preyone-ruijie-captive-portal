import 'dart:convert';

/// "Master route template" — a reusable stage list plus the fare matrix between
/// stages, owned by the company (device-local mirror) and edited in Settings.
///
/// A template is not a trip: it never appears in the trip picker and never
/// receives tickets on its own. It is the source the conductor uses to spin up
/// an on-the-go run ([RouteTemplate.toLocalTrip]), so an unscheduled bus still
/// prints consistent route names, stage-to-stage fares and vehicle/crew data
/// without an admin having scheduled anything on the server.
class RouteTemplate {
  const RouteTemplate({
    this.id = '',
    required this.name,
    this.code = '',
    this.description = '',
    this.active = true,
    this.createdAt,
    this.stages = const [],
    this.fares = const [],
  });

  final String id;
  final String name;
  final String code;
  final String description;
  final bool active;
  final DateTime? createdAt;
  final List<RouteStage> stages;
  final List<RouteStageFare> fares;

  bool get isUsable => stages.length >= 2;

  /// Stage at [seq] (1-based, as stored) or null.
  RouteStage? stageAt(int seq) {
    for (final s in stages) {
      if (s.seq == seq) return s;
    }
    return null;
  }

  /// Fare in cents for a passenger boarding at [fromSeq] and alighting at
  /// [toSeq], in either direction: the matrix is stored in forward order, so a
  /// return leg simply looks the pair up swapped. Returns 0 when the operator
  /// has not priced that leg yet (the sale then falls back to the standard
  /// tariff, and can be overridden per ticket as usual).
  int fareCentsBetween(int fromSeq, int toSeq) {
    final lo = fromSeq < toSeq ? fromSeq : toSeq;
    final hi = fromSeq < toSeq ? toSeq : fromSeq;
    for (final f in fares) {
      if (f.fromSeq == lo && f.toSeq == hi) return f.priceCents;
    }
    return 0;
  }

  /// Canonical 'FROM - TO' route label for a leg, e.g. `HARARE - CHITUNGWIZA`.
  String routeLabel(int fromSeq, int toSeq) {
    final from = stageAt(fromSeq)?.name ?? '';
    final to = stageAt(toSeq)?.name ?? '';
    if (from.isEmpty || to.isEmpty) return '';
    return '$from - $to';
  }

  Map<String, Object?> toRow() => {
        'id': id,
        'name': name,
        'code': code,
        'description': description,
        'active': active ? 1 : 0,
        'created_at': (createdAt ?? DateTime.now()).toUtc().toIso8601String(),
      };

  factory RouteTemplate.fromRow(
    Map<String, Object?> row, {
    List<RouteStage> stages = const [],
    List<RouteStageFare> fares = const [],
  }) =>
      RouteTemplate(
        id: (row['id'] as String?) ?? '',
        name: (row['name'] as String?) ?? '',
        code: (row['code'] as String?) ?? '',
        description: (row['description'] as String?) ?? '',
        active: ((row['active'] as int?) ?? 1) != 0,
        createdAt:
            DateTime.tryParse((row['created_at'] as String?) ?? '')?.toLocal(),
        stages: stages,
        fares: fares,
      );

  /// Full round-trip through JSON — used by the offline catalog mirror so a
  /// template survives a reinstall-free DB copy without a second query.
  ///
  /// [createdAt] is carried so a server→device mirror does not rewrite it on
  /// every sync (which would reshuffle the `created_at ASC` display order and
  /// lose the server's authoritative ordering).
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'code': code,
        'description': description,
        'active': active,
        'createdAt': (createdAt ?? DateTime.now()).toUtc().toIso8601String(),
        'stages': stages.map((s) => s.toJson()).toList(),
        'fares': fares.map((f) => f.toJson()).toList(),
      };

  String encode() => jsonEncode(toJson());

  factory RouteTemplate.fromJson(Map<String, dynamic> j) => RouteTemplate(
        id: str(j['id']),
        name: str(j['name']),
        code: str(j['code']),
        description: str(j['description']),
        active: j['active'] != false,
        createdAt: DateTime.tryParse(str(j['createdAt']))?.toLocal(),
        stages: (j['stages'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => RouteStage.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        fares: (j['fares'] as List? ?? const [])
            .whereType<Map>()
            .map((e) => RouteStageFare.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
      );

  static String str(Object? v) => v?.toString() ?? '';
}

/// One stop on a template, ordered from the origin (seq 1) to the terminus.
class RouteStage {
  const RouteStage({
    this.id = '',
    required this.templateId,
    required this.seq,
    required this.name,
  });

  final String id;
  final String templateId;
  final int seq;
  final String name;

  Map<String, Object?> toRow() => {
        'id': id,
        'template_id': templateId,
        'seq': seq,
        'name': name,
      };

  Map<String, dynamic> toJson() =>
      {'id': id, 'seq': seq, 'name': name, 'templateId': templateId};

  factory RouteStage.fromRow(Map<String, Object?> row) => RouteStage(
        id: (row['id'] as String?) ?? '',
        templateId: (row['template_id'] as String?) ?? '',
        seq: (row['seq'] as int?) ?? 0,
        name: (row['name'] as String?) ?? '',
      );

  factory RouteStage.fromJson(Map<String, dynamic> j) => RouteStage(
        id: RouteTemplate.str(j['id']),
        templateId: RouteTemplate.str(j['templateId']),
        seq: int.tryParse(RouteTemplate.str(j['seq'])) ?? 0,
        name: RouteTemplate.str(j['name']),
      );
}

/// Price for one leg of the matrix, stored in forward order (from < to).
class RouteStageFare {
  const RouteStageFare({
    this.id = '',
    required this.templateId,
    required this.fromSeq,
    required this.toSeq,
    required this.priceCents,
  });

  final String id;
  final String templateId;
  final int fromSeq;
  final int toSeq;
  final int priceCents;

  Map<String, Object?> toRow() => {
        'id': id,
        'template_id': templateId,
        'from_seq': fromSeq,
        'to_seq': toSeq,
        'price_cents': priceCents,
      };

  Map<String, dynamic> toJson() => {
        'id': id,
        'fromSeq': fromSeq,
        'toSeq': toSeq,
        'priceCents': priceCents,
        'templateId': templateId,
      };

  factory RouteStageFare.fromRow(Map<String, Object?> row) => RouteStageFare(
        id: (row['id'] as String?) ?? '',
        templateId: (row['template_id'] as String?) ?? '',
        fromSeq: (row['from_seq'] as int?) ?? 0,
        toSeq: (row['to_seq'] as int?) ?? 0,
        priceCents: (row['price_cents'] as int?) ?? 0,
      );

  factory RouteStageFare.fromJson(Map<String, dynamic> j) => RouteStageFare(
        id: RouteTemplate.str(j['id']),
        templateId: RouteTemplate.str(j['templateId']),
        fromSeq: int.tryParse(RouteTemplate.str(j['fromSeq'])) ?? 0,
        toSeq: int.tryParse(RouteTemplate.str(j['toSeq'])) ?? 0,
        priceCents: int.tryParse(RouteTemplate.str(j['priceCents'])) ?? 0,
      );
}
