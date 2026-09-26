// Test-only helper: gives every test FILE its own database directory.
//
// AppDb hardcodes both the file name (bus_ticket.db) and the lookup of its
// directory (getDatabasesPath()), and `flutter test` runs test files
// concurrently. Without this, two files race on one SQLite file and you get
// "file is being used by another process" or, worse, silent cross-talk between
// fixtures. Swapping the ffi handler's path is the only seam that works
// without touching production code.
import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
// ignore: implementation_imports
import 'package:sqflite_common_ffi/src/sqflite_ffi_impl.dart'
    show SqfliteFfiHandler, sqfliteFfiHandler;
// ignore: depend_on_referenced_packages
import 'package:sqlite3/common.dart' show CommonDatabase;

/// Prepares ffi for host-side tests. Returns the database directory to use.
/// [name] must be unique per test file.
///
/// noIsolate is required, not a preference: the isolate-based factory shares a
/// long-lived sqflite isolate per process, and that isolate holds its OWN copy
/// of [sqfliteFfiHandler]. A path override applied in the test isolate is
/// therefore invisible to it, and two files silently end up on one file again.
Future<String> useTestDatabaseDir(String name) async {
  sqfliteFfiInit();
  final dir = Directory(p.join('.dart_tool', 'test_dbs', name)).absolute;
  if (!dir.existsSync()) dir.createSync(recursive: true);
  sqfliteFfiHandler = _RedirectedHandler(sqfliteFfiHandler, dir.path);
  databaseFactory = createDatabaseFactoryFfi(noIsolate: true);
  return dir.path;
}

class _RedirectedHandler implements SqfliteFfiHandler {
  _RedirectedHandler(this._inner, this._dir);

  final SqfliteFfiHandler _inner;
  final String _dir;

  @override
  String getDatabasesPathPlatform() => _dir;

  @override
  Future<CommonDatabase> openPlatform(Map argumentsMap) =>
      _inner.openPlatform(argumentsMap);

  @override
  Future<void> deleteDatabasePlatform(String path) =>
      _inner.deleteDatabasePlatform(path);

  @override
  Future<void> writeDatabaseBytesPlatform(String path, Uint8List bytes) =>
      _inner.writeDatabaseBytesPlatform(path, bytes);

  @override
  Future<Uint8List> readDatabaseBytesPlatform(String path) =>
      _inner.readDatabaseBytesPlatform(path);

  @override
  Future<bool> handleDatabaseExistsPlatform(String path) =>
      _inner.handleDatabaseExistsPlatform(path);

  @override
  Future<void> handleOptionsPlatform(Map argumentMap) =>
      _inner.handleOptionsPlatform(argumentMap);
}
