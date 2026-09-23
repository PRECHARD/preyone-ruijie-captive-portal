import 'package:flutter/foundation.dart';

class AppState extends ChangeNotifier {
  AppState._();
  static final AppState instance = AppState._();

  void refresh() => notifyListeners();
}