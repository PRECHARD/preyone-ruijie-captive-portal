package com.preyone.android.data.api

import com.google.gson.annotations.SerializedName

// ── Auth ──
data class LoginRequest(val email: String, val password: String)

data class LoginResponse(
    val success: Boolean,
    val token: String?,
    val role: String?,
    val fullName: String?,
    val error: String?
)

data class PortalSignupRequest(
    @SerializedName("fullName") val fullName: String,
    val phone: String,
    @SerializedName("voucherCode") val voucherCode: String,
    @SerializedName("acceptedTos") val acceptedTos: Boolean
)

data class PortalSignupResponse(
    val success: Boolean?,
    val message: String?,
    val error: String?
)

// ── Dashboard ──
data class DashboardResponse(
    @SerializedName("activeVouchers") val activeVouchers: Int,
    @SerializedName("dataConsumedToday") val dataConsumedToday: Long,
    @SerializedName("fupTriggered") val fupTriggered: Int,
    @SerializedName("apOnline") val apOnline: Int?,
    @SerializedName("apTotal") val apTotal: Int?,
    @SerializedName("sales24h") val sales24h: List<HourlySales>?
)

data class HourlySales(
    val hour: String,
    val total: Double
)

data class LiveSession(
    val id: String,
    @SerializedName("full_name") val fullName: String,
    val phone: String,
    @SerializedName("voucher_code") val voucherCode: String,
    @SerializedName("session_expires_at") val sessionExpiresAt: String?,
    @SerializedName("data_used_bytes") val dataUsedBytes: Long?,
    @SerializedName("data_quota_bytes") val dataQuotaBytes: Long?,
    @SerializedName("bandwidth_mbps_down") val bandwidthDown: Int?,
    @SerializedName("mac_address") val macAddress: String?
)

data class ActiveSessionsResponse(
    @SerializedName("activeUsers") val activeUsers: List<LiveSession>,
    @SerializedName("totalActive") val totalActive: Int
)

// ── Vouchers ──
data class Voucher(
    val id: String,
    val code: String,
    @SerializedName("package_tier") val packageTier: String?,
    @SerializedName("duration_min") val durationMin: Int?,
    @SerializedName("used_count") val usedCount: Int?,
    @SerializedName("max_uses") val maxUses: Int?,
    @SerializedName("created_at") val createdAt: String?,
    val active: Boolean?
)

data class VouchersResponse(
    val vouchers: List<Voucher>,
    val total: Int
)

data class CreateVoucherRequest(
    @SerializedName("packageTier") val packageTier: String,
    val count: Int = 1
)

data class CreateVoucherResponse(
    val success: Boolean,
    val vouchers: List<Voucher>?,
    val error: String?
)

// ── Sales ──
data class Sale(
    val id: String,
    @SerializedName("voucher_code") val voucherCode: String?,
    @SerializedName("package_tier") val packageTier: String?,
    val amount: Double?,
    val currency: String?,
    @SerializedName("payment_method") val paymentMethod: String?,
    @SerializedName("sold_by_name") val soldByName: String?,
    @SerializedName("created_at") val createdAt: String?
)

data class SalesResponse(
    val sales: List<Sale>?,
    val total: Double?
)

// ── Staff ──
data class StaffMember(
    val id: String,
    @SerializedName("full_name") val fullName: String,
    val email: String?,
    val role: String,
    val approved: Boolean?,
    @SerializedName("created_at") val createdAt: String?
)

data class StaffResponse(
    val staff: List<StaffMember>?,
    val message: String?
)

// ── Packages ──
data class Package(
    @SerializedName("tier_name") val tierName: String,
    @SerializedName("display_name") val displayName: String,
    @SerializedName("price_amount") val priceAmount: Double,
    @SerializedName("price_currency") val priceCurrency: String,
    @SerializedName("billing_period") val billingPeriod: String,
    @SerializedName("duration_min") val durationMin: Int?,
    @SerializedName("data_limit_gb") val dataLimitGb: Int?,
    @SerializedName("is_uncapped") val isUncapped: Boolean,
    @SerializedName("bandwidth_mbps_up") val bandwidthUp: Int,
    @SerializedName("bandwidth_mbps_down") val bandwidthDown: Int
)

data class PackagesResponse(val packages: List<Package>)

// ── Pay Now initiation ──
data class PayNowRequest(
    val tier: String,
    @SerializedName("displayName") val displayName: String,
    val amount: Double,
    val currency: String,
    @SerializedName("billingPeriod") val billingPeriod: String,
    @SerializedName("dataLimitGb") val dataLimitGb: Int?,
    @SerializedName("isUncapped") val isUncapped: Boolean,
    @SerializedName("bandwidthUp") val bandwidthUp: Int,
    @SerializedName("bandwidthDown") val bandwidthDown: Int,
    val phone: String,
    @SerializedName("fullName") val fullName: String
)

data class PayNowResponse(
    val success: Boolean?,
    @SerializedName("paymentId") val paymentId: String?,
    @SerializedName("pesepayPollUrl") val pollUrl: String?,
    val error: String?
)

data class ErrorResponse(val error: String)
