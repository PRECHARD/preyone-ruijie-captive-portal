package com.preyone.android.data.repository

import com.preyone.android.data.api.*

class AdminRepository {

    private val api get() = ApiClient.api

    // ── Auth ──
    suspend fun login(email: String, password: String): Result<LoginResponse> = apiCall {
        api.adminLogin(LoginRequest(email, password))
    }

    // ── Dashboard ──
    suspend fun getDashboard(): Result<DashboardResponse> = apiCall {
        api.getDashboard()
    }

    suspend fun getActiveSessions(): Result<ActiveSessionsResponse> = apiCall {
        api.getActiveSessions()
    }

    // ── Vouchers ──
    suspend fun getVouchers(page: Int = 1): Result<VouchersResponse> = apiCall {
        api.getVouchers(page)
    }

    suspend fun createVouchers(tier: String, count: Int = 1): Result<CreateVoucherResponse> = apiCall {
        api.createVouchers(CreateVoucherRequest(tier, count))
    }

    // ── Sales ──
    suspend fun getMySales(start: String? = null, end: String? = null): Result<SalesResponse> = apiCall {
        api.getMySales(start, end)
    }

    // ── Staff ──
    suspend fun getStaff(): Result<StaffResponse> = apiCall {
        api.getStaff()
    }

    suspend fun approveStaff(id: String): Result<StaffResponse> = apiCall {
        api.approveStaff(id)
    }

    suspend fun removeStaff(id: String): Result<StaffResponse> = apiCall {
        api.removeStaff(id)
    }

    // ── Packages ──
    suspend fun getPackages(): Result<PackagesResponse> = apiCall {
        api.getPackages()
    }

    // ── Portal ──
    suspend fun portalSignup(fullName: String, phone: String, voucherCode: String): Result<PortalSignupResponse> = apiCall {
        api.portalSignup(PortalSignupRequest(fullName, phone, voucherCode, true))
    }

    // ── Payments ──
    suspend fun initiatePayment(request: PayNowRequest): Result<PayNowResponse> = apiCall {
        api.initiatePayment(request)
    }
}

private suspend fun <T> apiCall(call: suspend () -> retrofit2.Response<T>): Result<T> {
    return try {
        val response = call()
        if (response.isSuccessful) {
            response.body()?.let { Result.success(it) }
                ?: Result.failure(Exception("Empty response body"))
        } else {
            val errorBody = response.errorBody()?.string() ?: response.message()
            Result.failure(Exception(errorBody))
        }
    } catch (e: Exception) {
        Result.failure(e)
    }
}
