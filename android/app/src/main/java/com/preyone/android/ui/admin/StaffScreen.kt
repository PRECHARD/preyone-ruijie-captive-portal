package com.preyone.android.ui.admin

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.preyone.android.data.api.StaffMember
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@Composable
fun StaffScreen(
    staff: List<StaffMember>,
    isLoading: Boolean,
    onApprove: (id: String) -> Unit,
    onRemove: (id: String) -> Unit,
    onRefresh: () -> Unit,
    userRole: String?
) {
    val isCEO = userRole == "CEO"

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        item { PageHeader("Staff Management") }

        if (isLoading && staff.isEmpty()) {
            item {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Cyan)
                }
            }
        }

        items(staff) { member ->
            StaffCard(
                member = member,
                isCEO = isCEO,
                onApprove = { onApprove(member.id) },
                onRemove = { onRemove(member.id) }
            )
        }
    }
}

@Composable
private fun StaffCard(
    member: StaffMember,
    isCEO: Boolean,
    onApprove: () -> Unit,
    onRemove: () -> Unit
) {
    val roleColor = when (member.role) {
        "CEO" -> Pink
        "Manager" -> Cyan
        else -> Purple
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
                Text(member.fullName, style = MaterialTheme.typography.titleSmall, color = TextPrimary)
                member.email?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TextMuted) }
                Text(member.role, style = MaterialTheme.typography.labelSmall, color = roleColor)
            }
            Row {
                if (isCEO && member.role != "CEO" && member.approved == false) {
                    IconButton(onClick = onApprove) {
                        Icon(Icons.Default.Check, contentDescription = "Approve", tint = Cyan)
                    }
                }
                if (isCEO && member.role != "CEO") {
                    IconButton(onClick = onRemove) {
                        Icon(Icons.Default.Delete, contentDescription = "Remove", tint = Pink)
                    }
                }
            }
        }
    }
}
