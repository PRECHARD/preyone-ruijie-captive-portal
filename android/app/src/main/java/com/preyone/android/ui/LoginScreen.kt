package com.preyone.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.preyone.android.ui.components.*
import com.preyone.android.ui.theme.*

@Composable
fun LoginScreen(
    onLogin: (email: String, password: String) -> Unit,
    onSwitchToPortal: () -> Unit,
    isLoading: Boolean,
    error: String?
) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(DarkBg)
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 400.dp)
        ) {
            Text(
                text = "PREYONE",
                style = MaterialTheme.typography.headlineLarge,
                color = Cyan,
                fontWeight = FontWeight.Bold
            )
            Text(
                text = "Admin Console",
                style = MaterialTheme.typography.titleMedium,
                color = TextMuted
            )

            Spacer(Modifier.height(40.dp))

            PreyoneTextField(
                value = email,
                onValueChange = { email = it },
                label = "Email"
            )
            Spacer(Modifier.height(12.dp))

            PreyonePasswordField(
                value = password,
                onValueChange = { password = it },
                label = "Password"
            )
            Spacer(Modifier.height(8.dp))

            if (error != null) {
                Text(
                    text = error,
                    color = Pink,
                    style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
            }

            PreyoneButton(
                text = "Sign In",
                onClick = { onLogin(email, password) },
                loading = isLoading
            )

            Spacer(Modifier.height(24.dp))

            TextButton(onClick = onSwitchToPortal) {
                Text("Back to WiFi Portal", color = TextMuted)
            }
        }
    }
}
