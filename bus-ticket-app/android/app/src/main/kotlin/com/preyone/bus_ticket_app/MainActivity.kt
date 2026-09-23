package com.preyone.bus_ticket_app

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "preyone.device/identity")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "androidId" -> {
                        val id = try {
                            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                        } catch (e: Exception) {
                            null
                        }
                        if (id.isNullOrEmpty()) result.error("UNAVAILABLE", "ANDROID_ID unavailable", null)
                        else result.success(id)
                    }
                    "bondedDevices" -> {
                        // Bluetooth classic discovery (startDiscovery) deliberately hides
                        // devices that are already paired/bonded with the phone, so a
                        // printer that was paired once in Settings never reappears in a
                        // fresh scan. Expose the bonded set so the app can list it too.
                        val devices = mutableListOf<Map<String, Any>>()
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                                ContextCompat.checkSelfPermission(
                                    applicationContext,
                                    Manifest.permission.BLUETOOTH_CONNECT
                                ) != PackageManager.PERMISSION_GRANTED
                            ) {
                                result.error("NO_BLUETOOTH_CONNECT", "BLUETOOTH_CONNECT permission not granted", null)
                                return@setMethodCallHandler
                            }
                            val adapter = BluetoothAdapter.getDefaultAdapter()
                            if (adapter != null) {
                                for (dev in adapter.bondedDevices) {
                                    // LE-only peripherals are not usable by the classic
                                    // RFCOMM printer path — skip them.
                                    if (dev.type == BluetoothDevice.DEVICE_TYPE_LE) continue
                                    devices.add(
                                        mapOf(
                                            "name" to (dev.name ?: ""),
                                            "address" to dev.address,
                                            "type" to dev.type
                                        )
                                    )
                                }
                            }
                            result.success(devices)
                        } catch (e: Exception) {
                            result.error("ERROR", e.message ?: "bondedDevices failed", null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    // Vivo / Android 14 devices can crash with a NullPointerException when the
    // permission delegate is torn down while a runtime-permission request is
    // still in flight (a known flutter engine race). Shield the super call so
    // a null delegate can never take the whole process down.
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        try {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        } catch (e: NullPointerException) {
            // Delegate was null / already detached — the request is a no-op.
        } catch (e: IllegalStateException) {
            // Plugin channel already detached — safe to ignore.
        }
    }
}