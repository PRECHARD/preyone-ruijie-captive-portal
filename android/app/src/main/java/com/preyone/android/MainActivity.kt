package com.preyone.android

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import com.preyone.android.auth.TokenStore
import com.preyone.android.data.api.*
import com.preyone.android.data.repository.AdminRepository
import com.preyone.android.navigation.AppNavigation
import com.preyone.android.navigation.NavEvent
import com.preyone.android.navigation.NavState
import com.preyone.android.ui.theme.PreyoneTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val repository = AdminRepository()
    private lateinit var tokenStore: TokenStore
    private var state by mutableStateOf(NavState())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tokenStore = TokenStore(applicationContext)

        setContent {
            PreyoneTheme {
                val scope = rememberCoroutineScope()

                LaunchedEffect(Unit) {
                    val token = tokenStore.getToken()
                    if (token != null) {
                        ApiClient.setToken(token)
                        val role = tokenStore.getRole()
                        state = state.copy(isLoggedIn = true, userRole = role)
                        loadDashboard()
                    }
                    loadPackages()
                }

                fun handleEvent(event: NavEvent) {
                    when (event) {
                        is NavEvent.Login -> scope.launch {
                            state = state.copy(isLoading = true, error = null)
                            repository.login(event.email, event.password)
                                .onSuccess { response ->
                                    if (response.success && response.token != null) {
                                        ApiClient.setToken(response.token)
                                        tokenStore.saveLogin(
                                            response.token,
                                            response.role ?: "Staff",
                                            response.fullName ?: ""
                                        )
                                        state = state.copy(
                                            isLoggedIn = true,
                                            isLoading = false,
                                            userName = response.fullName,
                                            userRole = response.role,
                                            error = null
                                        )
                                        loadDashboard()
                                    } else {
                                        state = state.copy(
                                            isLoading = false,
                                            error = response.error ?: "Login failed"
                                        )
                                    }
                                }
                                .onFailure { e ->
                                    state = state.copy(
                                        isLoading = false,
                                        error = e.message ?: "Network error"
                                    )
                                }
                        }

                        is NavEvent.Logout -> scope.launch {
                            ApiClient.setToken(null)
                            tokenStore.clear()
                            state = NavState(packages = state.packages)
                        }

                        is NavEvent.RefreshDashboard -> scope.launch {
                            loadDashboard()
                        }

                        is NavEvent.RefreshSales -> scope.launch {
                            state = state.copy(isLoading = true)
                            repository.getMySales()
                                .onSuccess { response ->
                                    state = state.copy(
                                        sales = response.sales ?: emptyList(),
                                        salesTotal = response.total ?: 0.0,
                                        isLoading = false
                                    )
                                }
                                .onFailure { e ->
                                    state = state.copy(isLoading = false, error = e.message)
                                }
                        }

                        is NavEvent.RefreshStaff -> scope.launch {
                            state = state.copy(isLoading = true)
                            repository.getStaff()
                                .onSuccess { response ->
                                    state = state.copy(
                                        staff = response.staff ?: emptyList(),
                                        isLoading = false
                                    )
                                }
                                .onFailure { e ->
                                    state = state.copy(isLoading = false, error = e.message)
                                }
                        }

                        is NavEvent.CreateVoucher -> scope.launch {
                            state = state.copy(isLoading = true)
                            repository.createVouchers(event.tier, event.count)
                                .onSuccess {
                                    state = state.copy(isLoading = false)
                                    loadVouchers()
                                    Toast.makeText(this@MainActivity, "Vouchers created", Toast.LENGTH_SHORT).show()
                                }
                                .onFailure { e ->
                                    state = state.copy(isLoading = false, error = e.message)
                                }
                        }

                        is NavEvent.ApproveStaff -> scope.launch {
                            repository.approveStaff(event.id)
                                .onSuccess { loadStaff() }
                                .onFailure { e -> state = state.copy(error = e.message) }
                        }

                        is NavEvent.RemoveStaff -> scope.launch {
                            repository.removeStaff(event.id)
                                .onSuccess { loadStaff() }
                                .onFailure { e -> state = state.copy(error = e.message) }
                        }

                        is NavEvent.PortalSignup -> scope.launch {
                            state = state.copy(isLoading = true, error = null)
                            repository.portalSignup(event.name, event.phone, event.code)
                                .onSuccess { response ->
                                    state = state.copy(isLoading = false)
                                    Toast.makeText(this@MainActivity, response.message ?: "Connected!", Toast.LENGTH_SHORT).show()
                                }
                                .onFailure { e ->
                                    state = state.copy(isLoading = false, error = e.message)
                                }
                        }

                        is NavEvent.BuyPackage -> scope.launch {
                            state = state.copy(isLoading = true, error = null)
                            val pkg = event.pkg
                            repository.initiatePayment(
                                PayNowRequest(
                                    tier = pkg.tierName,
                                    displayName = pkg.displayName,
                                    amount = pkg.priceAmount,
                                    currency = pkg.priceCurrency,
                                    billingPeriod = pkg.billingPeriod,
                                    dataLimitGb = pkg.dataLimitGb,
                                    isUncapped = pkg.isUncapped,
                                    bandwidthUp = pkg.bandwidthUp,
                                    bandwidthDown = pkg.bandwidthDown,
                                    phone = event.phone,
                                    fullName = event.name
                                )
                            ).onSuccess { response ->
                                state = state.copy(isLoading = false)
                                if (response.pollUrl != null) {
                                    Toast.makeText(this@MainActivity, "Open browser to complete payment", Toast.LENGTH_LONG).show()
                                }
                            }.onFailure { e ->
                                state = state.copy(isLoading = false, error = e.message)
                            }
                        }
                    }
                }

                AppNavigation(
                    state = state,
                    onEvent = { handleEvent(it) }
                )
            }
        }
    }

    private suspend fun loadDashboard() {
        state = state.copy(isLoading = true)
        repository.getDashboard()
            .onSuccess { response ->
                state = state.copy(dashboard = response, isLoading = false)
            }
            .onFailure { e ->
                state = state.copy(isLoading = false, error = e.message)
            }
    }

    private suspend fun loadVouchers() {
        repository.getVouchers()
            .onSuccess { response ->
                state = state.copy(vouchers = response.vouchers, voucherTotal = response.total)
            }
    }

    private suspend fun loadStaff() {
        repository.getStaff()
            .onSuccess { response ->
                state = state.copy(staff = response.staff ?: emptyList())
            }
    }

    private suspend fun loadPackages() {
        repository.getPackages()
            .onSuccess { response ->
                state = state.copy(packages = response.packages)
            }
    }
}
