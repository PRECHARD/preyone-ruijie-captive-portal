// Auto route-code generation for trips and tickets.
//
// Uses IATA-style city codes ("HARARE" -> "HRE") so a bus route from Harare
// to Bulawayo becomes "HRE-BYO". Unmapped towns fall back to the first three
// uppercase letters (e.g. "Bethel" -> "BET") so any route still gets a
// stable, human-readable code.

const Map<String, String> kRouteCityCodes = {
  'BEITBRIDGE': 'BBE',
  'BINDURA': 'BIN',
  'BULAWAYO': 'BYO',
  'CHINHOYI': 'CHI',
  'CHIREDZI': 'CZD',
  'CHITUNGWIZA': 'CHT',
  'GROOMBRIDGE': 'GRB',
  'GWERU': 'GWE',
  'HARARE': 'HRE',
  'HWANGE': 'HWA',
  'KADOMA': 'KAD',
  'KARIBA': 'KRB',
  'KWEKWE': 'KWE',
  'MARONDERA': 'MAR',
  'MASVINGO': 'MAS',
  'MUTARE': 'MUT',
  'PLUMTREE': 'PLU',
  'RUSAPE': 'RUS',
  'SHAMVA': 'SHV',
  'VICTORIA_FALLS': 'VFA',
  'ZVISHAVANE': 'ZVI',
};

/// 3-letter code for one place name (manual map, else first 3 uppercase letters).
String routeCodeForPlace(String place) {
  final name = place.toUpperCase().replaceAll(RegExp(r'[^A-Z]'), '');
  if (name.isEmpty) return '';
  final mapped = kRouteCityCodes[name];
  if (mapped != null) return mapped;
  if (name.length >= 3) return name.substring(0, 3);
  return name.padRight(3, 'X');
}

/// Route code from an origin/destination pair ("Harare" / "Bulawayo" -> "HRE-BYO").
String autoRouteCode(String from, String to) {
  final f = routeCodeForPlace(from);
  final t = routeCodeForPlace(to);
  if (f.isEmpty || t.isEmpty) return '';
  return '$f-$t';
}
