package com.preyone.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.preyone.android.data.api.CreateVoucherRequest
import com.preyone.android.data.api.Voucher
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VouchersScreen(
    vouchers: List<Voucher>,
    total: Int,
    isLoading: Boolean,
    onCreateVoucher: (tier: String, count: Int) -> Unit,
    onLoadMore: () -> Unit
) {
    var showCreateDialog by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                PageHeader("Vouchers ($total)")
                IconButton(onClick = { showCreateDialog = true }) {
                    Icon(Icons.Default.Add, contentDescription = "Create", tint = Cyan)
                }
            }
        }

        if (isLoading && vouchers.isEmpty()) {
            item {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Cyan)
                }
            }
        }

        items(vouchers) { voucher ->
            VoucherCard(voucher)
        }
    }

    if (showCreateDialog) {
        CreateVoucherDialog(
            onDismiss = { showCreateDialog = false },
            onCreate = { tier, count ->
                onCreateVoucher(tier, count)
                showCreateDialog = false
            }
        )
    }
}

@Composable
private fun VoucherCard(voucher: Voucher) {
    val statusColor = when {
        voucher.active == true -> Cyan
        (voucher.usedCount ?: 0) >= (voucher.maxUses ?: 1) -> Pink
        else -> TextDim
    }

    Surface(
        shape = RoundedCornerShape(10.dp),
        color = Surface2,
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(voucher.code, style = MaterialTheme.typography.titleSmall, color = TextPrimary, fontWeight = FontWeight.Bold)
                voucher.packageTier?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TextMuted) }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "${voucher.usedCount ?: 0}/${voucher.maxUses ?: 1}",
                    style = MaterialTheme.typography.bodySmall,
                    color = statusColor
                )
                Text(
                    if (voucher.active == true) "Active" else "Used",
                    style = MaterialTheme.typography.labelSmall,
                    color = statusColor
                )
            }
        }
    }
}

@Composable
private fun CreateVoucherDialog(
    onDismiss: () -> Unit,
    onCreate: (tier: String, count: Int) -> Unit
) {
    var tier by remember { mutableStateOf("PreLINK") }
    var count by remember { mutableStateOf("1") }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Surface2,
        title = { Text("Create Vouchers", color = TextPrimary) },
        text = {
            Column {
                PreyoneTextField(value = tier, onValueChange = { tier = it }, label = "Package Tier")
                Spacer(Modifier.height(8.dp))
                PreyoneTextField(value = count, onValueChange = { count = it }, label = "Count")
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(tier, count.toIntOrNull() ?: 1) }) {
                Text("Create", color = Cyan)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = TextMuted)
            }
        }
    )
}
