package com.preyone.android.data.api

import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    // ── Admin Auth ──
    @POST("api/admin/auth/login")
    suspend fun adminLogin(@Body request: LoginRequest): Response<LoginResponse>

    // ── Dashboard ──
    @GET("api/admin/dashboard")
    suspend fun getDashboard(): Response<DashboardResponse>

    @GET("api/admin/active-sessions")
    suspend fun getActiveSessions(): Response<ActiveSessionsResponse>

    // ── Vouchers ──
    @GET("api/admin/vouchers")
    suspend fun getVouchers(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50
    ): Response<VouchersResponse>

    @POST("api/admin/vouchers")
    suspend fun createVouchers(@Body request: CreateVoucherRequest): Response<CreateVoucherResponse>

    // ── Sales ──
    @GET("api/admin/my-sales")
    suspend fun getMySales(
        @Query("startDate") startDate: String? = null,
        @Query("endDate") endDate: String? = null
    ): Response<SalesResponse>

    // ── Staff ──
    @GET("api/admin/staff")
    suspend fun getStaff(): Response<StaffResponse>

    @POST("api/admin/staff/approve/{id}")
    suspend fun approveStaff(@Path("id") id: String): Response<StaffResponse>

    @DELETE("api/admin/staff/{id}")
    suspend fun removeStaff(@Path("id") id: String): Response<StaffResponse>

    // ── Packages ──
    @GET("api/packages")
    suspend fun getPackages(): Response<PackagesResponse>

    // ── Portal ──
    @POST("api/auth/signup")
    suspend fun portalSignup(@Body request: PortalSignupRequest): Response<PortalSignupResponse>

    // ── Payments ──
    @POST("api/payments/initiate")
    suspend fun initiatePayment(@Body request: PayNowRequest): Response<PayNowResponse>
}
