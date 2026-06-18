package com.preyone.android.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.preyone.android.ui.LoginScreen
import com.preyone.android.ui.admin.*
import com.preyone.android.ui.components.*
import com.preyone.android.ui.portal.PortalHomeScreen
import com.preyone.android.ui.theme.*

sealed class Screen(val route: String, val title: String, val icon: ImageVector?) {
    object Portal : Screen("portal", "WiFi Portal", null)
    object Login : Screen("login", "Login", null)
    object Dashboard : Screen("dashboard", "Dashboard", Icons.Default.Dashboard)
    object Vouchers : Screen("vouchers", "Vouchers", Icons.Default.CardGiftcard)
    object Sales : Screen("sales", "Sales", Icons.Default.TrendingUp)
    object Staff : Screen("staff", "Staff", Icons.Default.People)
}

data class NavState(
    val isLoggedIn: Boolean = false,
    val userRole: String? = null,
    val userName: String? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
    val dashboard: com.preyone.android.data.api.DashboardResponse? = null,
    val vouchers: List<com.preyone.android.data.api.Voucher> = emptyList(),
    val voucherTotal: Int = 0,
    val sales: List<com.preyone.android.data.api.Sale> = emptyList(),
    val salesTotal: Double = 0.0,
    val staff: List<com.preyone.android.data.api.StaffMember> = emptyList(),
    val packages: List<com.preyone.android.data.api.Package> = emptyList()
)

private val adminScreens = listOf(
    Screen.Dashboard,
    Screen.Vouchers,
    Screen.Sales,
    Screen.Staff
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppNavigation(
    state: NavState,
    onEvent: (NavEvent) -> Unit
) {
    val navController = rememberNavController()
    val navBackStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = navBackStackEntry?.destination?.route
    val isAdminScreen = adminScreens.any { it.route == currentRoute }

    Scaffold(
        containerColor = DarkBg,
        topBar = {
            if (isAdminScreen && state.isLoggedIn) {
                TopAppBar(
                    title = { Text("Preyone", color = Cyan) },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Surface2
                    ),
                    actions = {
                        state.userName?.let {
                            Text(it, color = TextMuted, style = MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = { onEvent(NavEvent.Logout) }) {
                            Text("Logout", color = Pink)
                        }
                    }
                )
            } else if (currentRoute == Screen.Portal.route) {
                TopAppBar(
                    title = { Text("Preyone WiFi", color = Cyan) },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Surface2)
                )
            }
        },
        bottomBar = {
            if (isAdminScreen && state.isLoggedIn) {
                NavigationBar(
                    containerColor = Surface2
                ) {
                    adminScreens.forEach { screen ->
                        NavigationBarItem(
                            icon = { screen.icon?.let { Icon(it, contentDescription = screen.title) } },
                            label = { Text(screen.title) },
                            selected = currentRoute == screen.route,
                            onClick = {
                                navController.navigate(screen.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = Cyan,
                                selectedTextColor = Cyan,
                                unselectedIconColor = TextMuted,
                                unselectedTextColor = TextMuted,
                                indicatorColor = Surface3
                            )
                        )
                    }
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = if (state.isLoggedIn) Screen.Dashboard.route else Screen.Portal.route,
            modifier = Modifier.padding(padding)
        ) {
            composable(Screen.Portal.route) {
                PortalScreen(
                    state = state,
                    onEvent = onEvent,
                    onNavigateToAdmin = {
                        navController.navigate(Screen.Login.route)
                    }
                )
            }
            composable(Screen.Login.route) {
                LoginScreen(
                    onLogin = { email, password -> onEvent(NavEvent.Login(email, password)) },
                    onSwitchToPortal = { navController.popBackStack() },
                    isLoading = state.isLoading,
                    error = state.error
                )
            }
            composable(Screen.Dashboard.route) {
                DashboardScreen(
                    dashboard = state.dashboard,
                    isLoading = state.isLoading,
                    error = state.error,
                    onRefresh = { onEvent(NavEvent.RefreshDashboard) }
                )
            }
            composable(Screen.Vouchers.route) {
                VouchersScreen(
                    vouchers = state.vouchers,
                    total = state.voucherTotal,
                    isLoading = state.isLoading,
                    onCreateVoucher = { tier, count ->
                        onEvent(NavEvent.CreateVoucher(tier, count))
                    },
                    onLoadMore = {}
                )
            }
            composable(Screen.Sales.route) {
                SalesScreen(
                    sales = state.sales,
                    total = state.salesTotal,
                    isLoading = state.isLoading,
                    onRefresh = { onEvent(NavEvent.RefreshSales) }
                )
            }
            composable(Screen.Staff.route) {
                StaffScreen(
                    staff = state.staff,
                    isLoading = state.isLoading,
                    onApprove = { id -> onEvent(NavEvent.ApproveStaff(id)) },
                    onRemove = { id -> onEvent(NavEvent.RemoveStaff(id)) },
                    onRefresh = { onEvent(NavEvent.RefreshStaff) },
                    userRole = state.userRole
                )
            }
        }
    }
}

@Composable
private fun PortalScreen(
    state: NavState,
    onEvent: (NavEvent) -> Unit,
    onNavigateToAdmin: () -> Unit
) {
    com.preyone.android.ui.portal.PortalHomeScreen(
        packages = state.packages,
        onSignup = { name, phone, code -> onEvent(NavEvent.PortalSignup(name, phone, code)) },
        onBuyPackage = { pkg, phone, name ->
            if (phone.isNotBlank() && name.isNotBlank()) {
                onEvent(NavEvent.BuyPackage(pkg, phone, name))
            }
        },
        onSwitchToAdmin = onNavigateToAdmin,
        isLoading = state.isLoading,
        error = state.error
    )
}

sealed class NavEvent {
    data class Login(val email: String, val password: String) : NavEvent()
    object Logout : NavEvent()
    object RefreshDashboard : NavEvent()
    object RefreshSales : NavEvent()
    object RefreshStaff : NavEvent()
    data class CreateVoucher(val tier: String, val count: Int) : NavEvent()
    data class ApproveStaff(val id: String) : NavEvent()
    data class RemoveStaff(val id: String) : NavEvent()
    data class PortalSignup(val name: String, val phone: String, val code: String) : NavEvent()
    data class BuyPackage(val pkg: com.preyone.android.data.api.Package, val phone: String, val name: String) : NavEvent()
}
