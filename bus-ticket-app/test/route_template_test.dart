import 'package:bus_ticket_app/src/models.dart';
import 'package:bus_ticket_app/src/models/route_template.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  RouteTemplate template() => const RouteTemplate(
        id: 'tpl-1',
        name: 'Harare - Chitungwiza',
        code: 'HRE-CHI',
        stages: [
          RouteStage(id: 's1', templateId: 'tpl-1', seq: 1, name: 'Harare'),
          RouteStage(id: 's2', templateId: 'tpl-1', seq: 2, name: 'Ruwa'),
          RouteStage(
              id: 's3', templateId: 'tpl-1', seq: 3, name: 'Chitungwiza'),
        ],
        fares: [
          RouteStageFare(
              id: 'f1',
              templateId: 'tpl-1',
              fromSeq: 1,
              toSeq: 2,
              priceCents: 500),
          RouteStageFare(
              id: 'f2',
              templateId: 'tpl-1',
              fromSeq: 2,
              toSeq: 3,
              priceCents: 700),
          RouteStageFare(
              id: 'f3',
              templateId: 'tpl-1',
              fromSeq: 1,
              toSeq: 3,
              priceCents: 1200),
        ],
      );

  group('route template fare matrix', () {
    test('forward legs read the stored price', () {
      final t = template();
      expect(t.fareCentsBetween(1, 2), 500);
      expect(t.fareCentsBetween(2, 3), 700);
      expect(t.fareCentsBetween(1, 3), 1200);
    });

    test('return legs reuse the forward price', () {
      final t = template();
      // The matrix is stored forward-only; a return leg must not price at 0.
      expect(t.fareCentsBetween(2, 1), 500);
      expect(t.fareCentsBetween(3, 1), 1200);
      expect(t.fareCentsBetween(3, 2), 700);
    });

    test('an unpriced leg falls back to the standard tariff (0)', () {
      final t = template();
      final sparse = RouteTemplate(
        id: 'tpl-2',
        name: 'Sparse',
        stages: t.stages,
        fares: const [
          RouteStageFare(
              id: 'g1',
              templateId: 'tpl-2',
              fromSeq: 1,
              toSeq: 3,
              priceCents: 900),
        ],
      );
      expect(sparse.fareCentsBetween(1, 3), 900);
      expect(sparse.fareCentsBetween(1, 2), 0);
      expect(sparse.fareCentsBetween(2, 1), 0);
    });

    test('same stage is never priced', () {
      expect(template().fareCentsBetween(2, 2), 0);
    });

    test('route label is the board → alight pair', () {
      final t = template();
      expect(t.routeLabel(1, 3), 'Harare - Chitungwiza');
      expect(t.routeLabel(3, 1), 'Chitungwiza - Harare');
      expect(t.routeLabel(1, 99), '');
    });

    test('a template needs two stages to be usable', () {
      expect(template().isUsable, isTrue);
      expect(
        const RouteTemplate(
                id: 'x',
                name: 'One stop',
                stages: [RouteStage(templateId: 'x', seq: 1, name: 'Only')])
            .isUsable,
        isFalse,
      );
    });
  });

  group('route template json round-trip', () {
    test('stages and fares survive an encode/decode cycle', () {
      final t = template();
      final back = RouteTemplate.fromJson(t.toJson());
      expect(back.id, t.id);
      expect(back.name, t.name);
      expect(back.code, t.code);
      expect(back.active, isTrue);
      expect(back.stages.map((s) => s.name).toList(),
          ['Harare', 'Ruwa', 'Chitungwiza']);
      expect(back.fareCentsBetween(2, 3), 700);
      expect(back.fareCentsBetween(3, 2), 700);
    });
  });

  group('device-local trip identity', () {
    test('an on-the-go trip id is flagged local and never a server uuid', () {
      const id = 'TRIP-A1B2C3-1789012345678';
      final trip = Trip(id: id, tripNo: 'OTG-0730-12');
      expect(trip.isLocal, isTrue);
      expect(id.startsWith(Trip.localTripPrefix), isTrue);
    });

    test('a server schedule id is not flagged local', () {
      final trip =
          Trip(id: '7c1f0b2e-0f4a-4f0a-9c2e-1a2b3c4d5e6f', tripNo: 'T-1');
      expect(trip.isLocal, isFalse);
    });
  });
}
