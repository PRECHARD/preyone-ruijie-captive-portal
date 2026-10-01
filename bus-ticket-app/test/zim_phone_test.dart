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

  group('363 prefix is normalized regardless of length', () {
    // Regression: the 0363/363 branches used to require length >= 12 / >= 11, so
    // a short stored value such as "363" fell through every branch and was sent
    // to the printer verbatim — tickets came out reading "CUSTOMER CARE 363".
    // The printer was never at fault; it rendered the bad bytes faithfully.
    test('bare 363 no longer reaches the paper', () {
      expect(formatZimPhone('363'), '+263');
      expect(zimPhoneOrEmpty('363'), '+263');
    });

    test('short 363-prefixed values are rewritten, not passed through', () {
      expect(zimPhoneOrEmpty('363784111'), '+263784111');
      expect(zimPhoneOrEmpty('0363771'), '+263771');
    });

    test('full-length 363 forms still normalize identically', () {
      expect(zimPhoneOrEmpty('363772717003'), '+263772717003');
      expect(zimPhoneOrEmpty('0363772717003'), '+263772717003');
      expect(zimPhoneOrEmpty('+363772717003'), '+263772717003');
    });

    test('a 363-prefixed value with spaces is still cleaned up', () {
      expect(zimPhoneOrEmpty('363 772 717003'), '+263772717003');
    });

    test('genuine +263 numbers are untouched', () {
      expect(zimPhoneOrEmpty('+263772717003'), '+263772717003');
    });

    test('a number with no subscriber digits yields a bare country code', () {
      // Nothing can invent the missing subscriber digits: a stored value that
      // is only "363" normalizes to "+263" and no further. That is a data
      // problem to correct at source, not a formatting one.
      expect(formatZimPhone('+363'), '+263');
      expect(formatZimPhone('0363'), '+263');
    });
  });
}
