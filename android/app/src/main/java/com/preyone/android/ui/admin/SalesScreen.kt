package com.preyone.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.preyone.android.data.api.Sale
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@Composable
fun SalesScreen(
    sales: List<Sale>,
    total: Double,
    isLoading: Boolean,
    onRefresh: () -> Unit
) {
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
                PageHeader("My Sales")
                Text(
                    "Total: $$total",
                    style = MaterialTheme.typography.titleMedium,
                    color = Cyan,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        if (isLoading && sales.isEmpty()) {
            item {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Cyan)
                }
            }
        }

        items(sales) { sale ->
            SaleCard(sale)
        }
    }
}

@Composable
private fun SaleCard(sale: Sale) {
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
                sale.packageTier?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = TextPrimary) }
                sale.voucherCode?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TextMuted) }
                sale.paymentMethod?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = TextDim) }
            }
            Column(horizontalAlignment = Alignment.End) {
                sale.amount?.let {
                    Text(
                        "$${String.format("%.2f", it)}",
                        style = MaterialTheme.typography.titleSmall,
                        color = Cyan,
                        fontWeight = FontWeight.Bold
                    )
                }
                sale.createdAt?.let {
                    Text(it.take(10), style = MaterialTheme.typography.labelSmall, color = TextDim)
                }
            }
        }
    }
}
