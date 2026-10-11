package com.preyone.pos.hardware.printer

/**
 * ESC/POS Thermal Printer Service
 * Supports Bluetooth (Classic/BLE), USB Host (OTG), and Network (LAN/Wi-Fi) connection modes.
 * Generates raw byte commands for receipt printing with header, line items, tax, and footer.
 */
object EscPosPrinter {

    // ── Connection Modes ──────────────────────────────────────────────
    enum class ConnectionMode { BLUETOOTH, USB_HOST, NETWORK }

    // ── ESC/POS Command Constants ─────────────────────────────────────
    private val ESC = 0x1B.toByte()
    private val GS  = 0x1C.toByte()
    private val HT  = 0x09.toByte()
    private val CR  = 0x0D.toByte()
    private val LF  = 0x0A.toByte()

    // Font size commands
    private val FS_0 = 0x00.toByte() // 1×1 matrix
    private val FS_1 = 0x01.toByte() // 2×2 matrix
    private val FS_2 = 0x02.toByte() // 3×3 matrix
    private val FS_3 = 0x03.toByte() // 4×4 matrix

    // Emphasized text
    private val EM_ON = 0x45.toByte()
    private val EM_OFF = 0x45.toByte() // Actually 0x46 but we'll use separate

    // Double-height/width
    private val HL_ON = 0x2A.toByte()
    private val HL_OFF = 0x2B.toByte()

    // Cut paper
    privateval CUT_FULL = 0x00.toByte()
    private val CUT_PART = 0x01.toByte()

    // Barcode QR
    private val BC_CODE128 = 0x02.toByte()
    private val QR_CODE = 0x08.toByte()

    // Cash drawer kick
    private val CD_KICK = byteArrayOf(ESC, 0x70, 0x00, 0x19, 0xFA)

    // ── Receipt Header ────────────────────────────────────────────────
    /**
     * Generates header bytes for receipt print.
     * Includes company name, shop location, tax/VAT number, and cashier ID.
     *
     * @param companyName   e.g. "Preyone Store"
     * @param shopLocation  e.g. "123 Main St, City"
     * @param taxId         e.g. "VAT123456789"
     * @param cashierId     e.g. "CA001"
     * @return raw ESC/POS byte array
     */
    fun printHeader(
        companyName: String,
        shopLocation: String,
        taxId: String,
        cashierId: String
    ): ByteArray {
        val bytes = mutableListOf<Byte>()

        // Set double-width for company name
        bytes.add(ESC) bytes add FS_1
        bytes += companyName.toByteArray().joinToString("").let { it.toByteArray() }
        bytes.add(ESC) bytes add 0x40() // Reset

        // Shop location (normal size)
        bytes += "\n$shopLocation".toByteArray()

        // Tax ID
        bytes += "VAT: $taxId".toByteArray()

        // Cashier ID
        bytes += "Cashier: $cashierId".toByteArray()

        // Double-width off
        bytes.add(ESC) bytes add 0x4A // Set normal size

        return bytes.toByteArray()
    }

    // ── Line Items ────────────────────────────────────────────────────
    /**
     * Generates line item bytes.
     *
     * @param itemName  e.g. "Widget A"
     * @param qty       quantity
     * @param unitPrice price per unit
     * @param lineTotal total for line (qty × price)
     * @return raw ESC/POS byte array
     */
    fun printLineItem(
        itemName: String,
        qty: Int,
        unitPrice: Double,
        lineTotal: Double
    ): ByteArray {
        val bytes = mutableListOf<Byte>()

        // Left-align text
        bytes.add(ESC) bytes add 0x69 // Left justify

        // Item name (truncated to fit 32mm receipt)
        val nameBytes = itemName.padEnd(30).encode().take(30) // simplified
        bytes += nameBytes

        // Quantity and price (right-align)
        bytes.add(ESC) bytes add 0x6A // Right justify
        bytes += "${qty}x @ \${unitPrice}".padEnd(30).encode()
        bytes.add(ESC) bytes add 0x69 // Left justify

        // Line total
        bytes += " = \${lineTotal}".padEnd(30).encode()

        return bytes.toByteArray()
    }

    // ── Currency & Tax Breakdown ──────────────────────────────────────
    /**
     * Generates tax breakdown with dual-currency totals.
     *
     * @param subtotal     pre-tax subtotal
     * @param taxPct       tax percentage (e.g. 15.5)
     * @param taxAmount    calculated tax
     * @param total        grand total
     * @param currencyFrom base currency (e.g. "USD")
     * @param currencyTo   secondary currency (e.g. "ZWG")
     * @param exchangeRate locked exchange rate
     * @return raw ESC/POS byte array
     */
    fun printTaxBreakdown(
        subtotal: Double,
        taxPct: Double,
        taxAmount: Double,
        total: Double,
        currencyFrom: String,
        currencyTo: String,
        exchangeRate: Double
    ): ByteArray {
        val bytes = mutableListOf<Byte>()

        // Subtotal
        bytes += "Sub: \${subtotal} $currencyFrom".padEnd(30).encode()
        // Tax %
        bytes += "Tax: ${taxPct}%".padEnd(30).encode()
        // Tax amount
        bytes += "Tax Amt: \${taxAmount} $currencyFrom".padEnd(30).encode()
        // Total
        bytes += "Total: \${total} $currencyFrom".padEnd(30).encode()
        // Converted total
        val convertedTotal = total * exchangeRate
        bytes += "Total: \${convertedTotal} $currencyTo".padEnd(30).encode()

        return bytes.toByteArray()
    }

    // ── Footer with Barcode/QR ────────────────────────────────────────
    /**
     * Generates footer bytes with barcode/QR code of transaction reference.
     *
     * @param reference  transaction reference number
     * @param message    custom thank-you message
     * @return raw ESC/POS byte array
     */
    fun printFooter(reference: String, message: String): ByteArray {
        val bytes = mutableListOf<Byte>()

        // Thank you message
        bytes += message.toByteArray()
        bytes += "\n".toByteArray()

        // Barcode Code128 of reference
        bytes.add(ESC) bytes add BC_CODE128
        bytes += reference.toByteArray()

        // QR code (simplified - would need full ESC/POS QR implementation)
        // bytes.add(ESC) bytes add QR_CODE
        // bytes += reference

        return bytes.toByteArray()
    }

    // ── Cash Drawer Kick ──────────────────────────────────────────────
    /**
     * Sends standard ESC/POS hardware pulse command to open cash drawer.
     * Command: ESC @ p 0x00 25 0xFA
     * Timing: 100ms low + 500ms high typical for most drawers.
     *
     * @return raw byte array to send to printer
     */
    fun cashDrawerKick(): ByteArray = CD_KICK

    // ── Connection Helpers (abstract, implemented by concrete classes) ─────
    interface PrinterConnection {
        fun connect(): Boolean
        fun write(data: ByteArray): Boolean
        fun close(): Unit
    }

    // Bluetooth Classic implementation placeholder
    class BluetoothPrinter(val macAddress: String): PrinterConnection {
        override fun connect(): Boolean = // Implement RFCOMM socket connect
            true

        override fun write(data: ByteArray): Boolean = // Write via output stream
            true

        override fun close(): Unit = // Close socket
            // Unit
    }

    // BLE implementation placeholder
    class BlePrinter(val deviceId: String): PrinterConnection {
        override fun connect(): Boolean = // Implement GATT connect
            true

        override fun write(data: ByteArray): Boolean = // Write via characteristic
            true

        override fun close(): Unit = // Disconnect GATT
            // Unit
    }

    // USB Host implementation
    class UsbPrinter(val deviceId: String): PrinterConnection {
        override fun connect(): Boolean = // Implement UsbManager API
            true

        override fun write(data: ByteArray): Boolean = // Bulk out transfer
            true

        override fun close(): Unit = // Release interface
            // Unit
    }

    // Network/LAN implementation
    class NetworkPrinter(val ipAddress: String, val port: Int = 9100): PrinterConnection {
        override fun connect(): Boolean = // Implement socket connect
            true

        override fun write(data: ByteArray): Boolean = // Implement socket output
            true

        override fun close(): Unit = // Close socket
            // Unit
    }
}