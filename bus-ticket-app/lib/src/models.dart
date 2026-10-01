class Fare {
  Fare({
    this.id,
    required this.name,
    required this.price,
    this.enabled = true,
  });

  final int? id;
  final String name;
  final int price;
  final bool enabled;

  Map<String, Object?> toMap() => {
        'id': id,
        'name': name,
        'price': price,
        'enabled': enabled ? 1 : 0,
      };

  factory Fare.fromMap(Map<String, Object?> map) => Fare(
        id: map['id'] as int?,
        name: map['name'] as String,
        price: map['price'] as int,
        enabled: (map['enabled'] as int) == 1,
      );
}

class SaleItem {
  SaleItem({
    required this.name,
    required this.price,
    required this.qty,
    required this.total,
  });

  final String name;
  final int price;
  final int qty;
  final int total;

  Map<String, Object?> toJson() =>
      {'name': name, 'price': price, 'qty': qty, 'total': total};

  factory SaleItem.fromJson(Map<String, dynamic> map) => SaleItem(
        name: map['name'] as String,
        price: map['price'] as int,
        qty: map['qty'] as int,
        total: map['total'] as int,
      );
}

class Sale {
  Sale({
    this.id,
    required this.receiptNo,
    required this.items,
    required this.total,
    required this.cash,
    required this.change,
    this.ticketType = 'busFare',
    this.companyId = '',
    this.routeCode = '',
    this.routeName = '',
    this.busReg = '',
    this.driver = '',
    this.driverPhone = '',
    this.conductor1 = '',
    this.conductor2 = '',
    this.conductorPhone = '',
    this.seatNumber = '',
    this.tripNo = '',
    this.tripId = '',
    this.tripInstanceId = '',
    this.shiftId = '',
    this.driverId = '',
    this.conductorId = '',
    this.paymentMethod = 'cash',
    this.customerName = '',
    this.customerMobile = '',
    this.customFare = 0,
    this.departureTime = '',
    this.luggageLinkedTicketId = '',
    this.createdAt,
    this.synced = 0,
    this.printed = 0,
    this.txId = '',
    this.signature = '',
  });

  final int? id;
  final String receiptNo;
  final List<SaleItem> items;
  final int total;
  final int cash;
  final int change;
  final String ticketType;
  final String companyId;
  final String routeCode;
  final String routeName;
  final String busReg;
  final String driver;
  final String driverPhone;
  final String conductor1;
  final String conductor2;
  final String conductorPhone;
  final String seatNumber;
  final String tripNo;
  final String tripId;
  final String tripInstanceId;
  final String shiftId;
  final String driverId;
  final String conductorId;
  final String paymentMethod;
  final String customerName;
  final String customerMobile;

  /// Total cents charged on manually-overridden fare lines (0 = no override).
  final int customFare;

  /// Scheduled departure time shown on the ticket (e.g. "06:30").
  final String departureTime;

  /// For luggage upsell tickets: the bus-fare ticket_id (tx_id) they link to.
  final String luggageLinkedTicketId;

  final DateTime? createdAt;
  final int synced;
  final int printed;
  final String txId;
  final String signature;

  Map<String, Object?> toJson() => {
        'receipt_no': receiptNo,
        'ticket_type': ticketType,
        'company_id': companyId,
        'route_code': routeCode,
        'route_name': routeName,
        'bus_reg': busReg,
        'driver': driver,
        'driver_phone': driverPhone,
        'conductor1': conductor1,
        'conductor2': conductor2,
        'conductor_phone': conductorPhone,
        'seat_number': seatNumber,
        'trip_no': tripNo,
        'trip_id': tripId,
        'trip_instance_id': tripInstanceId,
        'shift_id': shiftId,
        'driver_id': driverId,
        'conductor_id': conductorId,
        'payment_method': paymentMethod,
        'customer_name': customerName,
        'customer_mobile': customerMobile,
        'custom_fare': customFare,
        'departure_time': departureTime,
        'luggage_linked_ticket_id': luggageLinkedTicketId,
        'items': items.map((i) => i.toJson()).toList(),
        'total': total,
        'cash': cash,
        'change': change,
        'created_at': createdAt?.toIso8601String(),
        'printed': printed,
        'synced': synced,
        'tx_id': txId,
        'signature': signature,
      };

  /// Returns the first non-empty string present under any of [keys].
  /// Null, missing and blank values are skipped, so wire formats that spread
  /// the same field across snake_case + camelCase (or rename it) still resolve.
  static String _firstOf(Map<String, dynamic> m, List<String> keys) {
    for (final k in keys) {
      final v = m[k];
      if (v == null) continue;
      final t = v.toString().trim();
      if (t.isNotEmpty) return t;
    }
    return '';
  }

  static int _intOf(Map<String, dynamic> m, List<String> keys, [int dflt = 0]) {
    for (final k in keys) {
      final v = m[k];
      if (v is int) return v;
      if (v is num) return v.toInt();
      if (v is String && v.trim().isNotEmpty) {
        final parsed = int.tryParse(v.trim());
        if (parsed != null) return parsed;
      }
    }
    return dflt;
  }

  /// Defensive wire-to-model mapping. Accepts both snake_case (DB / server)
  /// and camelCase (API JSON) keys with alias fallbacks, so a hydration or
  /// import path can never silently lose customer / crew / vehicle detail.
  factory Sale.fromJson(Map<String, dynamic> j) {
    final items = <SaleItem>[];
    final rawItems = j['items'];
    if (rawItems is List) {
      for (final it in rawItems) {
        if (it is Map) {
          try {
            items.add(SaleItem.fromJson(it.cast<String, dynamic>()));
          } on Object {
            // A malformed item must not abort the whole sale import.
          }
        }
      }
    }
    final rawCustomer =
        _firstOf(j, ['customer_name', 'customerName', 'customer_phone_name']);
    final customerName = rawCustomer.isEmpty ? '' : rawCustomer;
    return Sale(
      id: j['id'] is int ? j['id'] as int : null,
      receiptNo: _firstOf(j, ['receipt_no', 'receiptNo']),
      items: items,
      total: _intOf(j, ['total']),
      cash: _intOf(j, ['cash']),
      change: _intOf(j, ['change']),
      ticketType: _firstOf(j, ['ticket_type', 'ticketType']),
      companyId: _firstOf(j, ['company_id', 'companyId']),
      routeCode: _firstOf(j, ['route_code', 'routeCode']),
      routeName: _firstOf(j, ['route_name', 'routeName']),
      busReg: _firstOf(j, ['bus_reg', 'busReg', 'bus_registration']),
      driver: _firstOf(j, ['driver_name', 'driverName', 'driver']),
      driverPhone: _firstOf(j, ['driver_phone', 'driverPhone']),
      conductor1: _firstOf(
          j, ['conductor_name', 'conductorName', 'conductor1', 'conductor']),
      conductor2: _firstOf(j, ['conductor2', 'conductor2_name']),
      conductorPhone: _firstOf(j, ['conductor_phone', 'conductorPhone']),
      seatNumber: _firstOf(j, ['seat_number', 'seatNumber']),
      tripNo: _firstOf(j, ['trip_no', 'tripNo']),
      tripId: _firstOf(j, ['trip_id', 'tripId']),
      tripInstanceId: _firstOf(j, ['trip_instance_id', 'tripInstanceId']),
      shiftId: _firstOf(j, ['shift_id', 'shiftId']),
      driverId: _firstOf(j, ['driver_id', 'driverId']),
      conductorId: _firstOf(j, ['conductor_id', 'conductorId']),
      paymentMethod: _firstOf(j, ['payment_method', 'paymentMethod']),
      customerName: customerName,
      customerMobile: _firstOf(j, [
        'customer_phone',
        'customerPhone',
        'customer_mobile',
        'customerMobile'
      ]),
      customFare: _intOf(j, ['custom_fare', 'customFare']),
      departureTime: _firstOf(j, ['departure_time', 'departureTime']),
      luggageLinkedTicketId:
          _firstOf(j, ['luggage_linked_ticket_id', 'luggageLinkedTicketId']),
      createdAt: DateTime.tryParse(_firstOf(j, ['created_at', 'createdAt'])),
      synced: _intOf(j, ['synced']),
      printed: _intOf(j, ['printed']),
      txId: _firstOf(j, ['tx_id', 'txId']),
      signature: _firstOf(j, ['signature']),
    );
  }

  factory Sale.fromMap(Map<String, Object?> map) =>
      Sale.fromJson(map.cast<String, dynamic>());

  /// Model-to-wire (DB row shape, default snake_case) mapping. Complements
  /// [toJson] which returns the API JSON shape.
  Map<String, Object?> toMap() => {
        'id': id,
        'receipt_no': receiptNo,
        'ticket_type': ticketType,
        'items': items.map((i) => i.toJson()).toList(),
        'total': total,
        'cash': cash,
        'change': change,
        'route_code': routeCode,
        'route_name': routeName,
        'bus_reg': busReg,
        'driver': driver,
        'driver_phone': driverPhone,
        'conductor1': conductor1,
        'conductor2': conductor2,
        'conductor_phone': conductorPhone,
        'seat_number': seatNumber,
        'trip_no': tripNo,
        'trip_id': tripId,
        'trip_instance_id': tripInstanceId,
        'shift_id': shiftId,
        'driver_id': driverId,
        'conductor_id': conductorId,
        'payment_method': paymentMethod,
        'customer_name': customerName,
        'customer_mobile': customerMobile,
        'custom_fare': customFare,
        'departure_time': departureTime,
        'luggage_linked_ticket_id': luggageLinkedTicketId,
        'created_at': createdAt?.toIso8601String(),
        'synced': synced,
        'printed': printed,
        'tx_id': txId,
        'signature': signature,
      };
}

class Trip {
  Trip({
    this.id = '',
    required this.tripNo,
    this.routeCode = '',
    this.routeFrom = '',
    this.routeTo = '',
    this.routeName = '',
    this.busReg = '',
    this.driver = '',
    this.driverPhone = '',
    this.driverId = '',
    this.conductor = '',
    this.conductorPhone = '',
    this.conductorId = '',
    this.departureTime = '',
    this.status = 'SCHEDULED',
    this.baseFareCents = 0,
    this.totalSeats = 0,
    this.seatsSold = 0,
  });

  final String id;
  final String tripNo;
  final String routeCode;
  final String routeFrom;
  final String routeTo;
  final String routeName;
  final String busReg;
  final String driver;
  final String driverPhone;
  final String driverId;
  final String conductor;
  final String conductorPhone;
  final String conductorId;
  final String departureTime;
  final String status;
  final int baseFareCents;
  final int totalSeats;
  final int seatsSold;

  /// Prefix that marks a device-local on-the-go trip. These never exist on the
  /// server schedule board, so the trip lifecycle must stay off the replay queue
  /// (see TripController) — the local `trip_instances` row is the only record.
  static const localTripPrefix = 'TRIP-';

  /// True for a trip this device created on the fly (an on-the-go run) rather
  /// than one mirrored from the server schedule.
  bool get isLocal => id.startsWith(localTripPrefix);

  String get displayName {
    final route = routeName.isNotEmpty
        ? routeName
        : [routeFrom, routeTo].where((s) => s.isNotEmpty).join(' - ');
    final base = '$tripNo  $route'.trim();
    return busReg.isEmpty ? base : '$base  $busReg';
  }

  Map<String, Object?> toMap() => {
        'id': id,
        'trip_no': tripNo,
        'route_code': routeCode,
        'route_from': routeFrom,
        'route_to': routeTo,
        'route_name': routeName,
        'bus_reg': busReg,
        'driver': driver,
        'driver_phone': driverPhone,
        'driver_id': driverId,
        'conductor': conductor,
        'conductor_phone': conductorPhone,
        'conductor_id': conductorId,
        'departure_time': departureTime,
        'status': status,
        'base_fare_cents': baseFareCents,
        'total_seats': totalSeats,
        'seats_sold': seatsSold,
      };

  factory Trip.fromMap(Map<String, Object?> map) => Trip(
        id: (map['id'] as String?) ?? '',
        tripNo: (map['trip_no'] as String?) ?? '',
        routeCode: (map['route_code'] as String?) ?? '',
        routeFrom: (map['route_from'] as String?) ?? '',
        routeTo: (map['route_to'] as String?) ?? '',
        routeName: (map['route_name'] as String?) ?? '',
        busReg: (map['bus_reg'] as String?) ?? '',
        driver: (map['driver'] as String?) ?? '',
        driverPhone: (map['driver_phone'] as String?) ?? '',
        driverId: (map['driver_id'] as String?) ?? '',
        conductor: (map['conductor'] as String?) ?? '',
        conductorPhone: (map['conductor_phone'] as String?) ?? '',
        conductorId: (map['conductor_id'] as String?) ?? '',
        departureTime: (map['departure_time'] as String?) ?? '',
        status: (map['status'] as String?) ?? 'SCHEDULED',
        baseFareCents: (map['base_fare_cents'] as int?) ?? 0,
        totalSeats: (map['total_seats'] as int?) ?? 0,
        seatsSold: (map['seats_sold'] as int?) ?? 0,
      );

  factory Trip.fromJson(Map<String, dynamic> json) => Trip(
        id: (json['id'] as String?) ?? '',
        tripNo: (json['tripNo'] as String?) ?? '',
        routeCode: (json['routeCode'] as String?) ?? '',
        routeFrom: (json['routeFrom'] as String?) ?? '',
        routeTo: (json['routeTo'] as String?) ?? '',
        routeName: (json['routeName'] as String?) ?? '',
        busReg: (json['busReg'] as String?) ?? '',
        driver: (json['driver'] as String?) ?? '',
        driverPhone: (json['driverPhone'] as String?) ?? '',
        driverId: (json['driverId'] as String?) ?? '',
        conductor: (json['conductor'] as String?) ?? '',
        conductorPhone: (json['conductorPhone'] as String?) ?? '',
        conductorId: (json['conductorId'] as String?) ?? '',
        departureTime: (json['departureTime'] as String?) ?? '',
        status: (json['status'] as String?) ?? 'SCHEDULED',
        baseFareCents: (json['baseFareCents'] as int?) ?? 0,
        totalSeats: (json['totalSeats'] as int?) ?? 0,
        seatsSold: (json['seatsSold'] as int?) ?? 0,
      );

  static List<Trip> listFromJson(dynamic data) {
    final list = data as List? ?? [];
    return list
        .whereType<Map>()
        .map((e) => Trip.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }
}

class Promo {
  Promo({
    this.id = '',
    required this.code,
    this.description = '',
    this.type = 'PERCENT',
    this.value = 0,
    this.minimumCents = 0,
    this.maxValueCents = 0,
    this.active = true,
    this.usageCount = 0,
  });

  final String id;
  final String code;
  final String description;
  final String type;
  final int value;
  final int minimumCents;
  final int maxValueCents;
  final bool active;
  final int usageCount;

  /// Discount in cents applied to a subtotal (satisfies minimums/caps).
  int discountFor(int subtotalCents) {
    if (!active || subtotalCents < minimumCents) return 0;
    final raw = type == 'FLAT' ? value : (subtotalCents * value / 100).round();
    final capped =
        maxValueCents > 0 ? (raw > maxValueCents ? maxValueCents : raw) : raw;
    if (raw <= 0) return 0;
    return capped > subtotalCents ? subtotalCents : capped;
  }

  Map<String, Object?> toMap() => {
        'id': id,
        'code': code,
        'description': description,
        'type': type,
        'value': value,
        'minimum_cents': minimumCents,
        'max_value_cents': maxValueCents,
        'active': active ? 1 : 0,
        'usage_count': usageCount,
      };

  factory Promo.fromMap(Map<String, Object?> map) => Promo(
        id: (map['id'] as String?) ?? '',
        code: (map['code'] as String?) ?? '',
        description: (map['description'] as String?) ?? '',
        type: (map['type'] as String?) ?? 'PERCENT',
        value: (map['value'] as int?) ?? 0,
        minimumCents: (map['minimum_cents'] as int?) ?? 0,
        maxValueCents: (map['max_value_cents'] as int?) ?? 0,
        active: (map['active'] as int? ?? 1) == 1,
        usageCount: (map['usage_count'] as int?) ?? 0,
      );

  factory Promo.fromJson(Map<String, dynamic> json) => Promo(
        id: (json['id'] as String?) ?? '',
        code: (json['code'] as String?) ?? '',
        description: (json['description'] as String?) ?? '',
        type: (json['type'] as String?) ?? 'PERCENT',
        value: (json['value'] as int?) ?? 0,
        minimumCents: (json['minimumCents'] as int?) ?? 0,
        maxValueCents: (json['maxValueCents'] as int?) ?? 0,
        active: (json['active'] as bool?) ?? true,
        usageCount: (json['usageCount'] as int?) ?? 0,
      );

  static List<Promo> listFromJson(dynamic data) {
    final list = data as List? ?? [];
    return list
        .whereType<Map>()
        .map((e) => Promo.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }
}

class Driver {
  Driver({this.id, required this.name, this.phone = '', this.active = true});

  final int? id;
  final String name;
  final String phone;
  final bool active;

  Map<String, Object?> toMap() => {
        'id': id,
        'name': name,
        'phone': phone,
        'active': active ? 1 : 0,
      };

  factory Driver.fromMap(Map<String, Object?> map) => Driver(
        id: map['id'] as int?,
        name: map['name'] as String,
        phone: map['phone'] as String? ?? '',
        active: (map['active'] as int? ?? 1) == 1,
      );
}

class Conductor {
  Conductor({
    this.id,
    required this.name,
    this.phone = '',
    this.active = true,
  });

  final int? id;
  final String name;
  final String phone;
  final bool active;

  Map<String, Object?> toMap() => {
        'id': id,
        'name': name,
        'phone': phone,
        'active': active ? 1 : 0,
      };

  factory Conductor.fromMap(Map<String, Object?> map) => Conductor(
        id: map['id'] as int?,
        name: map['name'] as String,
        phone: map['phone'] as String? ?? '',
        active: (map['active'] as int? ?? 1) == 1,
      );
}

class CompanyProfile {
  CompanyProfile({
    this.id = '',
    this.name = '',
    this.slogan = '',
    this.website = '',
    this.customerCare = '',
    this.companyAddress = '',
    this.companyEmail = '',
    this.logoUrl = '',
    this.receiptHeader = '',
    this.receiptFooter = '',
    this.currency = 'USD',
  });

  final String id;
  final String name;
  final String slogan;
  final String website;
  final String customerCare;
  final String companyAddress;
  final String companyEmail;
  final String logoUrl;
  final String receiptHeader;
  final String receiptFooter;
  final String currency;

  Map<String, Object?> toMap() => {
        'id': id,
        'name': name,
        'slogan': slogan,
        'website': website,
        'customer_care': customerCare,
        'company_address': companyAddress,
        'company_email': companyEmail,
        'logo_url': logoUrl,
        'receipt_header': receiptHeader,
        'receipt_footer': receiptFooter,
        'currency': currency,
        'updated_at': DateTime.now().toIso8601String(),
      };

  factory CompanyProfile.fromMap(Map<String, Object?> map) => CompanyProfile(
        id: (map['id'] as String?) ?? '',
        name: (map['name'] as String?) ?? '',
        slogan: (map['slogan'] as String?) ?? '',
        website: (map['website'] as String?) ?? '',
        customerCare: (map['customer_care'] as String?) ?? '',
        companyAddress: (map['company_address'] as String?) ?? '',
        companyEmail: (map['company_email'] as String?) ?? '',
        logoUrl: (map['logo_url'] as String?) ?? '',
        receiptHeader: (map['receipt_header'] as String?) ?? '',
        receiptFooter: (map['receipt_footer'] as String?) ?? '',
        currency: (map['currency'] as String?) ?? 'USD',
      );

  factory CompanyProfile.fromJson(Map<String, dynamic> json) => CompanyProfile(
        id: (json['id'] as String?) ?? '',
        name: (json['name'] as String?) ?? '',
        slogan: (json['slogan'] as String?) ?? '',
        website: (json['website'] as String?) ?? '',
        customerCare: (json['customerCare'] as String?) ?? '',
        companyAddress: (json['companyAddress'] as String?) ?? '',
        companyEmail: (json['companyEmail'] as String?) ?? '',
        logoUrl: (json['logoUrl'] as String?) ?? '',
        receiptHeader: (json['receiptHeader'] as String?) ?? '',
        receiptFooter: (json['receiptFooter'] as String?) ?? '',
        currency: (json['currency'] as String?) ?? 'USD',
      );
}

class StaffProfile {
  StaffProfile({
    this.id = '',
    this.role = 'DRIVER',
    this.fullName = '',
    this.phone = '',
    this.licenseNo = '',
    this.status = 'ACTIVE',
  });

  final String id;
  final String role;
  final String fullName;
  final String phone;
  final String licenseNo;
  final String status;

  String get displayName {
    final base = fullName.trim();
    return phone.isEmpty ? base : '$base  · $phone';
  }

  bool get active => status != 'INACTIVE';

  factory StaffProfile.fromJson(Map<String, dynamic> json) => StaffProfile(
        id: (json['id'] as String?) ?? '',
        role: (json['role'] as String?) ?? 'DRIVER',
        fullName: (json['fullName'] as String?) ?? '',
        phone: (json['phone'] as String?) ??
            (json['phone_number'] as String?) ??
            '',
        licenseNo: (json['licenseNo'] as String?) ?? '',
        status: (json['status'] as String?) ?? 'ACTIVE',
      );

  static List<StaffProfile> listFromJson(dynamic data) {
    final list = data as List? ?? [];
    return list
        .whereType<Map>()
        .map((e) => StaffProfile.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }
}

class DriverShift {
  DriverShift({
    required this.id,
    this.driverId = '',
    this.driverName = '',
    this.driverPhone = '',
    this.conductorName = '',
    this.conductorPhone = '',
    this.vehicleReg = '',
    this.status = 'OPEN',
    this.startedAt,
    this.closedAt,
    this.synced = 0,
  });

  final String id;
  final String driverId;
  final String driverName;
  final String driverPhone;
  final String conductorName;
  final String conductorPhone;
  final String vehicleReg;
  final String status;
  final DateTime? startedAt;
  final DateTime? closedAt;
  final int synced;

  Map<String, Object?> toMap() => {
        'id': id,
        'driver_id': driverId,
        'driver_name': driverName,
        'driver_phone': driverPhone,
        'conductor_name': conductorName,
        'conductor_phone': conductorPhone,
        'vehicle_reg': vehicleReg,
        'status': status,
        'started_at': startedAt?.toIso8601String() ?? '',
        'closed_at': closedAt?.toIso8601String() ?? '',
        'synced': synced,
      };

  factory DriverShift.fromMap(Map<String, Object?> map) => DriverShift(
        id: (map['id'] as String?) ?? '',
        driverId: (map['driver_id'] as String?) ?? '',
        driverName: (map['driver_name'] as String?) ?? '',
        driverPhone: (map['driver_phone'] as String?) ?? '',
        conductorName: (map['conductor_name'] as String?) ?? '',
        conductorPhone: (map['conductor_phone'] as String?) ?? '',
        vehicleReg: (map['vehicle_reg'] as String?) ?? '',
        status: (map['status'] as String?) ?? 'OPEN',
        startedAt: DateTime.tryParse((map['started_at'] as String?) ?? ''),
        closedAt: DateTime.tryParse((map['closed_at'] as String?) ?? ''),
        synced: (map['synced'] as int?) ?? 0,
      );

  factory DriverShift.fromJson(Map<String, dynamic> json) => DriverShift(
        id: (json['id'] as String?) ?? '',
        driverId: (json['driverId'] as String?) ?? '',
        driverName: (json['driverName'] as String?) ?? '',
        driverPhone: (json['driverPhone'] as String?) ?? '',
        conductorName: (json['conductorName'] as String?) ?? '',
        conductorPhone: (json['conductorPhone'] as String?) ?? '',
        vehicleReg: (json['vehicleReg'] as String?) ?? '',
        status: (json['status'] as String?) ?? 'OPEN',
        startedAt: DateTime.tryParse((json['startedAt'] as String?) ?? ''),
        closedAt: DateTime.tryParse((json['closedAt'] as String?) ?? ''),
      );
}

class Vehicle {
  Vehicle({this.id, required this.registration, this.active = true});

  final int? id;
  final String registration;
  final bool active;

  // Value equality keeps DropdownButtonFormField<Vehicle> stable across a
  // roster refresh: the dropdown asserts that exactly one item equals the
  // current value, and the refresh hands us new Vehicle instances each time.
  // A vehicle is identified by its registration, which is unique per company.
  @override
  bool operator ==(Object other) =>
      other is Vehicle && other.registration == registration;

  @override
  int get hashCode => registration.hashCode;

  @override
  String toString() => 'Vehicle($registration)';

  Map<String, Object?> toMap() => {
        'id': id,
        'registration': registration,
        'active': active ? 1 : 0,
      };

  factory Vehicle.fromMap(Map<String, Object?> map) => Vehicle(
        id: map['id'] as int?,
        registration: (map['registration'] as String?) ?? '',
        active: (map['active'] as int? ?? 1) == 1,
      );
}
