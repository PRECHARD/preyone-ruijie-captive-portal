package com.preyone.pos.hardware.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.compose.foundation.Button
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.preyone.pos.hardware.printer.EscPosPrinter
import com.preyone.pos.hardware.printer.EscPosPrinter.ConnectionMode
import com.preyone.pos.hardware.printer.EscPosPrinter.PrinterConnection
import com.preyone.pos.hardware.printer.EscPosPrinter.BluetoothPrinter
import com.preyone.pos.hardware.printer.EscPosPrinter.BlePrinter
import com.preyone.pos.hardware.printer.EscPosPrinter.UsbPrinter
import com.preyone.pos.hardware.printer.EscPosPrinter.NetworkPrinter
import com.preyone.pos.hardware.scanner.BarcodeScannerManager
import com.preyone.pos.hardware.scanner.BarcodeScannerManager.ScannerConfig
import com.preyone.pos.hardware.scanner.BarcodeScannerManager.ScannerType
import com.preyone.pos.ui.theme.PreyoneTheme

@Composable
fun PrinterSettingsScreen(
    context: Context,
    onPrinterSelected: (PrinterConnection) -> Unit,
    onScannerSelected: (ScannerConfig) -> Unit
) {
    val (mode, setMode) = remember { mutableStateOf<ConnectionMode>(ConnectionMode.BLUETOOTH) }
    val (deviceName, setDeviceName) = remember { mutableStateOf<String>("") }
    val (deviceAddress, setDeviceAddress) = remember { mutableStateOf<String>("") }

    Column(
        modifier = Modifier
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = "Thermal Printer Settings",
            style = ThemeMaterial3.typography.h3,
            modifier = Modifier.padding(bottom = 12.dp)
        )

        // Connection Mode Selector
        OutlinedTextField(
            value = deviceName,
            onValueChange = setDeviceName,
            label = { Text("Printer Name") },
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = deviceAddress,
            onValueChange = setDeviceAddress,
            label = { Text("MAC Address / Device ID") },
            modifier = Modifier.fillMaxWidth()
        )

        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)
        ) {
            val modeButtons = listOf(
                Pair(ConnectionMode.BLUETOOTH, "Bluetooth"),
                Pair(ConnectionMode.USB_HOST, "USB (OTG)"),
                Pair(ConnectionMode.NETWORK, "Network/LAN")
            )

            modeButtons.forEach { (m, label) ->
                Button(
                    selected = mode == m,
                    onClick = { setMode(m) },
                    modifier = Modifier.width(1f / 3f).padding(2.dp)
                ) {
                    Text(label)
                }
            }
        }

        // Connect Button
        Button(
            onClick = {
                val connection: PrinterConnection = when (mode) {
                    ConnectionMode.BLUETOOTH -> {
                        EscPosPrinter.BluetoothPrinter(deviceAddress)
                    }
                    ConnectionMode.USB_HOST -> {
                        EscPosPrinter.UsbPrinter(deviceAddress)
                    }
                    ConnectionMode.NETWORK -> {
                        EscPosPrinter.NetworkPrinter("192.168.1.100") // placeholder IP
                    }
                }
                if (connection.connect()) {
                    onPrinterSelected(connection)
                    Toast(context, "Printer connected: ${mode}", Toast.LENGTH_SHORT).show()
                } else {
                    Toast(context, "Failed to connect printer", Toast.LENGTH_SHORT).show()
                }
            }
        ) {
            Text("Connect Printer")
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Scanner Settings Section
        Text(
            text = "Barcode Scanner Settings",
            style = ThemeMaterial3.typography.h4,
            modifier = Modifier.padding(bottom = 4.dp)
        )

        OutlinedTextField(
            value = deviceName,
            onValueChange = setDeviceName,
            label = { Text("Scanner Name") },
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = deviceAddress,
            onValueChange = setDeviceAddress,
            label = { Text("Scanner Type (VID:PID or BT Address)") },
            modifier = Modifier.fillMaxWidth()
        )

        ScannerType.values().forEach { scannerType ->
            Button(
                onClick = {
                    val config = ScannerConfig(
                        type = scannerType,
                        name = scannerType.toString(),
                        isEnabled = true,
                        prefix = "",
                        suffix = ""
                    )
                    onScannerSelected(config)
                }
            ) {
                Text(scannerType.toString())
            }
        }
    }
}

@Composable
fun PrintActionButtons(
    onPrintReceipt: () -> Unit,
    onPrintDuplicate: () -> Unit,
    onReprintQuote: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.InsideHorizontally
        ) {
            Button(
                onClick = onPrintReceipt,
                modifier = Modifier.weight(1f)
            ) {
                Text("Print Receipt")
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.InsideHorizontally
        ) {
            Button(
                onClick = onPrintDuplicate,
                modifier = Modifier.weight(1f)
            ) {
                Text("Print Duplicate")
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.InsideHorizontally
        ) {
            Button(
                onClick = onReprintQuote,
                modifier = Modifier.weight(1f)
            ) {
                Text("Reprint Quote")
            }
        }
    }
}

@Composable
fun PrintReceiptButton(onPrint: () -> Unit) {
    Button(
        onClick = onPrint,
        modifier = Modifier.fillMaxWidth(),
        colors = ButtonDefaults.fillColors(
            containerColor = PreyoneTheme.colors.primary,
            contentColor = androidx.compose.ui.graphics.Color.White
        )
    ) {
        Text(
            text = "Print Receipt",
            style = MaterialTheme.typography.button
        )
    }
}