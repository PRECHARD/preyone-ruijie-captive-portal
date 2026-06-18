package com.preyone.android.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Cyan = Color(0xFF00E5FF)
val Pink = Color(0xFFFF007F)
val Purple = Color(0xFF6A0DAD)
val DarkBg = Color(0xFF050505)
val Surface = Color(0xFF0A0A0A)
val Surface2 = Color(0xFF111111)
val Surface3 = Color(0xFF1A1A1A)
val Border = Color(0xFF3A3A5E)
val TextPrimary = Color(0xFFE2E8F0)
val TextMuted = Color(0xFF94A3B8)
val TextDim = Color(0xFF64748B)
val White = Color.White

private val DarkColorScheme = darkColorScheme(
    primary = Cyan,
    secondary = Pink,
    tertiary = Purple,
    background = DarkBg,
    surface = Surface,
    surfaceVariant = Surface2,
    onPrimary = DarkBg,
    onSecondary = DarkBg,
    onTertiary = White,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    onSurfaceVariant = TextMuted,
    outline = Border,
    outlineVariant = Color(0xFF2A2A3E),
)

@Composable
fun PreyoneTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = Typography(),
        content = content
    )
}
