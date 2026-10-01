// Regression tests for the red-screen crash on the Start Shift screen.
//
// The bug: _DriverOption had no value equality, so the driver dropdown compared
// its initialValue against items by identity. The screen builds its option list
// twice (initState, then again after the roster sync), creating fresh objects
// each time, so the field held a first-load instance that no longer existed in
// items. DropdownButtonFormField asserts exactly one matching item and throws
// DURING BUILD, which Flutter renders as a full-screen red ErrorWidget. The
// conductor saw a red screen instead of "start a shift first".
//
// These tests pin the value semantics that make the dropdown safe, so a future
// refactor cannot silently reintroduce identity comparison.
import 'package:bus_ticket_app/src/db/app_db.dart';
import 'package:bus_ticket_app/src/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Vehicle value equality', () {
    test('two vehicles with the same registration are equal', () {
      final a = Vehicle(id: 1, registration: 'AGJ 1234');
      final b = Vehicle(id: 2, registration: 'AGJ 1234');
      expect(a, equals(b));
      expect(a.hashCode, b.hashCode);
    });

    test('different registrations are not equal', () {
      final a = Vehicle(id: 1, registration: 'AGJ 1234');
      final b = Vehicle(id: 1, registration: 'AGJ 9999');
      expect(a, isNot(equals(b)));
    });

    test('a refreshed roster object still matches the held selection', () {
      // Simulates the exact failure: field holds selection from load #1, items
      // are built from load #2. A dropdown requires exactly one match here.
      final held = Vehicle(id: 7, registration: 'ABC 111');
      final items = <Vehicle>[
        Vehicle(id: 7, registration: 'ABC 111'),
        Vehicle(id: 8, registration: 'ABC 222'),
      ];
      expect(items.where((v) => v == held).length, 1);
    });
  });

  group('ABS plate letters extraction', () {
    test('leading letters are taken from a normal registration', () {
      expect(AppDb.absLetters('AGJ 1234'), 'AGJ');
      expect(AppDb.absLetters('agj-1234'), 'AGJ');
      expect(AppDb.absLetters('AGJ1234'), 'AGJ');
    });

    test('letters are found when they trail the digits', () {
      expect(AppDb.absLetters('1234 ABC'), 'ABC');
    });

    test('a purely numeric plate yields no letters', () {
      expect(AppDb.absLetters('1234567'), isNull);
    });

    test('empty or punctuation-only input yields no letters', () {
      expect(AppDb.absLetters(''), isNull);
      expect(AppDb.absLetters('   '), isNull);
      expect(AppDb.absLetters('---'), isNull);
    });
  });
}
