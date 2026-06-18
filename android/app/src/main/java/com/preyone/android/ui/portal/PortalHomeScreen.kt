package com.preyone.android.ui.portal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.preyone.android.data.api.Package
import com.preyone.android.data.api.PayNowRequest
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PortalHomeScreen(
    packages: List<Package>,
    onSignup: (name: String, phone: String, code: String) -> Unit,
    onBuyPackage: (pkg: Package, phone: String, name: String) -> Unit,
    onSwitchToAdmin: () -> Unit,
    isLoading: Boolean,
    error: String?
) {
    var fullName by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var voucherCode by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DarkBg)
            .verticalScroll(rememberScrollState())
    ) {
        // Header
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(Surface2)
                .padding(24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Default.Wifi, contentDescription = null, tint = Cyan, modifier = Modifier.size(48.dp))
                Spacer(Modifier.height(8.dp))
                Text("Preyone UltraNet", style = MaterialTheme.typography.headlineMedium, color = Cyan, fontWeight = FontWeight.Bold)
                Text("Stay Connected. Stay Ahead.", style = MaterialTheme.typography.bodyMedium, color = TextMuted)
            }
        }

        // Voucher activation form
        Surface(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            shape = RoundedCornerShape(16.dp),
            color = Surface2
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Activate WiFi Access", style = MaterialTheme.typography.titleMedium, color = TextPrimary)
                Spacer(Modifier.height(12.dp))
                PreyoneTextField(value = fullName, onValueChange = { fullName = it }, label = "Full Name")
                Spacer(Modifier.height(8.dp))
                PreyoneTextField(value = phone, onValueChange = { phone = it }, label = "Phone Number")
                Spacer(Modifier.height(8.dp))
                PreyoneTextField(value = voucherCode, onValueChange = { voucherCode = it }, label = "Voucher Code")
                Spacer(Modifier.height(12.dp))
                if (error != null) {
                    Text(error, color = Pink, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
                PreyoneButton(text = "Connect", onClick = { onSignup(fullName, phone, voucherCode) }, loading = isLoading)
            }
        }

        // Packages
        Text("Packages", style = MaterialTheme.typography.titleMedium, color = TextPrimary, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))

        packages.forEach { pkg ->
            var buyPhone by remember { mutableStateOf("") }
            PackageCard(
                pkg = pkg,
                onBuy = { onBuyPackage(pkg, buyPhone, fullName) },
                phoneValue = buyPhone,
                onPhoneChange = { buyPhone = it }
            )
        }

        Spacer(Modifier.height(24.dp))

        TextButton(
            onClick = onSwitchToAdmin,
            modifier = Modifier.align(Alignment.CenterHorizontally)
        ) {
            Text("Admin Login", color = TextMuted)
        }

        Spacer(Modifier.height(32.dp))
    }
}

@Composable
private fun PackageCard(
    pkg: Package,
    onBuy: () -> Unit,
    phoneValue: String,
    onPhoneChange: (String) -> Unit
) {
    val accent = when {
        pkg.isUncapped -> Purple
        pkg.billingPeriod == "monthly" -> Cyan
        else -> Pink
    }

    Surface(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        shape = RoundedCornerShape(12.dp),
        color = Surface2,
        tonalElevation = 2.dp
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(pkg.displayName, style = MaterialTheme.typography.titleMedium, color = TextPrimary)
                Text("$${pkg.priceAmount}/${pkg.billingPeriod}", style = MaterialTheme.typography.titleSmall, color = accent, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(4.dp))
            Text(
                if (pkg.isUncapped) "Uncapped" else "${pkg.dataLimitGb}GB",
                style = MaterialTheme.typography.bodySmall,
                color = TextMuted
            )
            Text("${pkg.bandwidthDown} Mbps", style = MaterialTheme.typography.bodySmall, color = TextDim)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = phoneValue,
                    onValueChange = onPhoneChange,
                    label = { Text("Phone for EcoCash") },
                    singleLine = true,
                    shape = RoundedCornerShape(8.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = accent,
                        unfocusedBorderColor = Border,
                        cursorColor = accent,
                        focusedTextColor = TextPrimary,
                        unfocusedTextColor = TextPrimary,
                        focusedContainerColor = Surface,
                        unfocusedContainerColor = Surface
                    ),
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(8.dp))
                Button(
                    onClick = onBuy,
                    shape = RoundedCornerShape(8.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = DarkBg)
                ) {
                    Text("Buy")
                }
            }
        }
    }
}
