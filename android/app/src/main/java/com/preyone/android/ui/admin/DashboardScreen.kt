package com.preyone.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.preyone.android.data.api.DashboardResponse
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@Composable
fun DashboardScreen(
    dashboard: DashboardResponse?,
    isLoading: Boolean,
    error: String?,
    onRefresh: () -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { PageHeader("Dashboard") }

        if (isLoading && dashboard == null) {
            item {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Cyan)
                }
            }
        }

        if (error != null) {
            item {
                Text(error, color = Pink, style = MaterialTheme.typography.bodySmall)
            }
        }

        if (dashboard != null) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    StatCard(
                        title = "Active Vouchers",
                        value = dashboard.activeVouchers.toString(),
                        accentColor = Cyan,
                        modifier = Modifier.weight(1f)
                    )
                    StatCard(
                        title = "APs Online",
                        value = "${dashboard.apOnline ?: "?"}/${dashboard.apTotal ?: "?"}",
                        accentColor = if ((dashboard.apOnline ?: 0) < (dashboard.apTotal ?: 1)) Pink else Cyan,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    StatCard(
                        title = "Data Today",
                        value = formatBytes(dashboard.dataConsumedToday),
                        accentColor = Purple,
                        modifier = Modifier.weight(1f)
                    )
                    StatCard(
                        title = "FUP Triggered",
                        value = dashboard.fupTriggered.toString(),
                        accentColor = Pink,
                        modifier = Modifier.weight(1f)
                    )
                }
            }

            if (!dashboard.sales24h.isNullOrEmpty()) {
                item {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = Surface2,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text("Sales (24h)", style = MaterialTheme.typography.titleSmall, color = TextMuted)
                            Spacer(Modifier.height(8.dp))
                            dashboard.sales24h.take(12).forEach { sale ->
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween
                                ) {
                                    Text(sale.hour, style = MaterialTheme.typography.bodySmall, color = TextDim)
                                    Text("$${String.format("%.2f", sale.total)}", style = MaterialTheme.typography.bodySmall, color = TextPrimary)
                                }
                            }
                        }
                    }
                }
            }
        }

        item {
            Spacer(Modifier.height(16.dp))
            PreyoneButton(text = "Refresh", onClick = onRefresh, loading = isLoading)
        }
    }
}

private fun formatBytes(bytes: Long): String {
    return when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${bytes / 1024} KB"
        bytes < 1024 * 1024 * 1024 -> "${"%.1f".format(bytes.toDouble() / (1024 * 1024))} MB"
        else -> "${"%.2f".format(bytes.toDouble() / (1024 * 1024 * 1024))} GB"
    }
}
