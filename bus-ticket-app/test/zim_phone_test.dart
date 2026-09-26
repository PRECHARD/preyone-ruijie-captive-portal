import 'package:flutter_test/flutter_test.dart';

import 'package:bus_ticket_app/src/format.dart';

void main() {
  group('zimPhoneOrEmpty', () {
    test('expands local 07x and 08x numbers to +263', () {
      expect(zimPhoneOrEmpty('0772111111'), '+263772111111');
      expect(zimPhoneOrEmpty('0812345678'), '+263812345678');
    });

    test('expands bare 7x and 8x numbers', () {
      expect(zimPhoneOrEmpty('712345678'), '+263712345678');
      expect(zimPhoneOrEmpty('812345678'), '+263812345678');
    });

    test('fixes the inner-network +363 prefix back to +263', () {
      expect(zimPhoneOrEmpty('+363771234567'), '+263771234567');
    });

    test('fixes "+363" with spaces mid-number (legacy raw storage)', () {
      expect(zimPhoneOrEmpty('+363 773717003'), '+263773717003');
      expect(formatZimPhone('+363 773717003'), '+263773717003');
    });

    test('keeps an existing +263 number untouched', () {
      expect(zimPhoneOrEmpty('+263712345678'), '+263712345678');
    });

    test('returns empty for blank input so it can be stored', () {
      expect(zimPhoneOrEmpty(''), '');
      expect(zimPhoneOrEmpty('   '), '');
    });

    test('strips non-digit noise outside the number', () {
      expect(zimPhoneOrEmpty('call 0772 111 111 now'), '+263772111111');
    });

    test('formatZimPhone still reports N/A for display paths', () {
      expect(formatZimPhone(''), 'N/A');
    });
  });
}
