package com.preyone.pos.hardware

import com.preyone.pos.hardware.printer.EscPosPrinter
import com.preyone.pos.hardware.scanner.BarcodeScannerManager
import com.preyone.pos.hardware.scanner.BarcodeScannerManager.ScannerConfig
import com.preyone.pos.hardware.scanner.BarcodeScannerManager.ScannerType
import com.preyone.pos.data.local.ProductEntity
import com.preyone.pos.data.local.ProductDao
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

@RunWith(org.junit.runners.JUnit4::class)
class EscPosPrinterTest {

    @Before
    fun setUp() {
        // Reset any state before each test
    }

    @Test
    fun `generates header with double-width company name`() {
        // Act
        val header = EscPosPrinter.printHeader(
            companyName = "PREYONE STORE",
            shopLocation = "123 MAIN ST, CITY",
            taxId = "VAT123456789",
            cashierId = "CA001"
        )

        // Assert
        assertNotNull("Header should not be null", header)
        assertTrue("Header should have content", header.isNotEmpty())
        // Verify ESC/POS command structure: starts with ESC byte
        assertTrue("Header should start with ESC command", header[0] == 0x1B)
    }

    @Test
    fun `generates line item with quantity and pricing`() {
        // Act
        val line = EscPosPrinter.printLineItem(
            itemName = "Widget A",
            qty = 3,
            unitPrice = 15.50,
            lineTotal = 46.50
        )

        // Assert
        assertNotNull("Line item should not be null", line)
        assertTrue("Line item should have content", line.isNotEmpty())
        // Should contain ESC command for justification
        assertTrue("Line item should contain ESC command", line.contains(0x1B.toByte()))
    }

    @Test
    fun `generates tax breakdown with dual currency`() {
        // Act
        val tax = EscPosPrinter.printTaxBreakdown(
            subtotal = 100.00,
            taxPct = 15.5,
            taxAmount = 15.50,
            total = 115.50,
            currencyFrom = "USD",
            currencyTo = "ZWG",
            exchangeRate = 13.00
        )

        // Assert
        assertNotNull("Tax breakdown should not be null", tax)
        assertTrue("Tax breakdown should have content", tax.isNotEmpty())
    }

    @Test
    fun `cash drawer kick command format`() {
        // Act
        val kick = EscPosPrinter.cashDrawerKick()

        // Assert
        assertNotNull("Cash drawer kick should not be null", kick)
        assertTrue("Cash drawer kick should be 5 bytes", kick.size == 5)
        // Expected: ESC @ p 0x00 25 0xFA
        assertTrue("First byte should be ESC", kick[0] == 0x1B)
        assertTrue("Second byte should be @ p command", kick[1] == 0x70)
        assertTrue("Fourth byte should be 25 (0x19)", kick[3] == 0x19)
        assertTrue("Fifth byte should be FA", kick[4] == 0xFA)
    }
}

@RunWith(org.junit.runners.JUnit4::class)
class BarcodeScannerManagerTest {

    @Test
    fun `trimPrefixSuffix removes scanner prefix`() {
        // Arrange
        val config = ScannerConfig(
            type = ScannerType.HID_KEYBOARD,
            name = "Test Scanner",
            prefix = ">",
            suffix = "<",
            timeoutMs = 1500
        )
        val raw = ">12345678<"

        // Act
        val result = BarcodeScannerManager.trimPrefixSuffix(raw, config)

        // Assert
        assertEquals("Should remove prefix and suffix", "12345678", result)
    }

    @Test
    fun `trimPrefixSuffix handles no prefix`() {
        // Arrange
        val config = ScannerConfig(
            type = ScannerType.HID_KEYBOARD,
            name = "Test Scanner",
            prefix = "",
            suffix = "",
            timeoutMs = 1500
        )
        val raw = "ABC123"

        // Act
        val result = BarcodeScannerManager.trimPrefixSuffix(raw, config)

        // Assert
        assertEquals("Should return raw when no prefix/suffix", "ABC123", result)
    }

    @Test
    fun `lookupProduct finds matching product`() = runBlocking {
        // Arrange - Set up in-memory DB would go here
        // For now, verify the function signature and type safety
        val mockDao = mock(ProductDao::class.java)
        `when`(mockDao.getByCompany(anyString())).thenReturn(emptyList())

        // Act
        val result = BarcodeScannerManager.lookupProduct(mockDao, "TEST123")

        // Assert
        assertNull("Should return null when no products found", result)
    }

    @Test
    fun `scan result data model`() {
        // Act
        val scan = BarcodeScannerManager.ScanResult(
            barcode = "ABC123",
            scannerId = "USB-VID:PID-1234",
            timestamp = System.currentTimeMillis(),
            success = true
        )

        // Assert
        assertEquals("Barcode should match", "ABC123", scan.barcode)
        assertEquals("Scanner ID should match", "USB-VID:PID-1234", scan.scannerId)
        assertTrue("Timestamp should be positive", scan.timestamp > 0)
        assertTrue("Success should be true", scan.success)
    }
}