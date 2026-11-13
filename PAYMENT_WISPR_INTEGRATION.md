# Preyone UltraNet Captive Portal: Complete Payment & WISPr Integration

## 📋 System Overview

This document describes the complete integration of dynamic pricing, Pesepay EcoCash payments, and WISPr protocol support for automatic bandwidth and data quota configuration on Ruijie Access Points.

---

## 🏗️ Architecture Components

### 1. **Database Schema** (`src/db/migrate.ts`)

#### New Tables:

**`packages`** - Preyone subscription tiers
- `tier_name`: PreLITE, PreLINK, PreMAX, PreULTRA, PreEXECUTIVE
- `price_amount`: USD pricing (0.99 - 59.99)
- `duration_min`: Session length (1440 min = 1 day, 10080 = 1 week, 43200 = 1 month)
- `data_limit_gb`: NULL for uncapped plans
- `is_uncapped`: BOOLEAN for unlimited data tiers
- `bandwidth_mbps_up/down`: Speed limits for WISPr configuration

**`payments`** - Payment transaction tracking
- Stores Pesepay reference IDs
- Tracks payment status (pending → completed)
- Links users to packages purchased
- Records EcoCash phone number for payment

**`wispr_profiles`** - Session bandwidth configuration
- Created after successful payment
- Stores device MAC address
- Bandwidth in Kbps (converted from Mbps)
- Data quota in bytes (converted from GB)
- Session expiry timestamp

**`users`** - Enhanced with `package_id` reference
**`access_log`** - Unchanged, tracks all authentication events

---

## 🎨 Frontend Flow

### HTML Updates (`public/index.html`)

Each package card button now includes semantic data attributes:

```html
<button type="button" class="pkg-action" 
  data-tier="PreMAX"
  data-display-name="Pro"
  data-amount="34.99"
  data-currency="USD"
  data-period="monthly"
  data-data-limit="100"
  data-bandwidth-up="10"
  data-bandwidth-down="10"
  data-is-uncapped="false">
  Buy now
</button>
```

**Attributes Used:**
- `data-tier`: Package tier identifier
- `data-display-name`: User-friendly name
- `data-amount`: Price in USD
- `data-period`: Billing cycle (daily/weekly/monthly)
- `data-data-limit`: GB limit (null for uncapped)
- `data-bandwidth-up/down`: Mbps speeds
- `data-is-uncapped`: Boolean for unlimited plans

### JavaScript Payment Flow (`public/js/portal.js`)

**Step 1: User clicks "Buy now"**
```javascript
packageButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const packageData = {
      tier: btn.dataset.tier,
      displayName: btn.dataset.displayName,
      amount: btn.dataset.amount,
      // ... other attributes
    };
    showPackagePaymentModal(packageData);
  });
});
```

**Step 2: Payment modal displays**
- Shows package details
- Requests EcoCash phone number
- Displays price and data limits

**Step 3: User confirms payment**
```javascript
async function initiatePackagePayment(packageData, phone) {
  const paymentData = {
    tier: packageData['data-tier'],
    amount: parseFloat(packageData['data-amount']),
    bandwidthUp: parseInt(packageData['data-bandwidth-up']),
    bandwidthDown: parseInt(packageData['data-bandwidth-down']),
    phone,
    fullName,
    macAddress, // From Ruijie query params
    ipAddress,
  };

  const response = await fetch('/api/payments/initiate', {
    method: 'POST',
    body: JSON.stringify(paymentData),
  });

  // Redirect to Pesepay poll URL
  window.location.href = result.pesepayPollUrl;
}
```

---

## 💳 Backend Payment Processing (`src/routes/payments.ts`)

### Payment Initiation Flow

**Endpoint:** `POST /api/payments/initiate`

```typescript
POST /api/payments/initiate
{
  "tier": "PreMAX",
  "displayName": "Pro",
  "amount": 34.99,
  "currency": "USD",
  "billingPeriod": "monthly",
  "dataLimitGb": 100,
  "isUncapped": false,
  "bandwidthUp": 10,
  "bandwidthDown": 10,
  "phone": "+263771327202",
  "fullName": "John Doe",
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "ipAddress": "192.168.1.100"
}
```

**Process:**
1. Validate required fields
2. Get or create user by phone number
3. Lookup package by tier name
4. Create payment record with status='pending'
5. Call Pesepay API with EcoCash targeting
6. Return poll URL for redirect

**Response:**
```json
{
  "success": true,
  "paymentId": "550e8400-e29b-41d4-a716-446655440000",
  "pesepayReference": "PY-550E8400-1716201234567",
  "pesepayPollUrl": "https://api.pesepay.com/poll?ref=PY-550E8400-...",
  "amount": 34.99,
  "phone": "+263771327202"
}
```

### Payment Callback (`GET /api/payments/callback?ref=...`)

**Process:**
1. Verify payment with Pesepay API
2. Update payment status to 'completed'
3. Create WISPr profile for device
4. Bind bandwidth/quota to MAC address

---

## 🌐 WISPr Parameter Transformation (`src/utils/wisprTransformer.ts`)

### What is WISPr?

WISPr (Wireless Internet Service Provider roaming) is the industry standard protocol for captive portal authentication and session management. Ruijie APs support WISPr extensions for bandwidth and data quota configuration.

### Transformation Pipeline

**Input:** Package data (human-readable)
```
PreMAX: 100GB, 10 Mbps down, 10 Mbps up
```

**Step 1: Convert Mbps → Kbps** (×1000)
```
10 Mbps = 10,000 Kbps
```

**Step 2: Convert GB → Bytes** (×1,073,741,824)
```
100 GB = 107,374,182,400 bytes
```

**Step 3: Create WISPr Profile**
```typescript
{
  macAddress: "AA:BB:CC:DD:EE:FF",
  bandwidthUpKbps: 10000,
  bandwidthDownKbps: 10000,
  dataQuotaBytes: 107374182400,
  isUncapped: false,
  durationSeconds: 2592000 // 30 days
}
```

### WISPr Parameters Format

The system generates RADIUS-compatible VSA (Vendor-Specific-Attribute) strings:

```
Ruijie-Upstream-Bandwidth=10000
Ruijie-Downstream-Bandwidth=10000
Ruijie-Data-Quota=107374182400
Ruijie-Session-Timeout=2592000
Ruijie-Session-Id=550e8400-e29b-41d4-a716-446655440000
```

### Ruijie Callback URL with WISPr Parameters

**Ruijie Challenge:** After authentication, the AP redirects the user to a success URL. We embed WISPr parameters in this URL for automatic configuration:

```
https://success.preyone.com/?
  token=550e8400-...
  WISPr-Bandwidth-Max-Up=10000
  WISPr-Bandwidth-Max-Down=10000
  WISPr-Data-Quota=107374182400
  WISPr-Session-Timeout=2592000
  Billing-Type=quota
  Device-MAC=AA:BB:CC:DD:EE:FF
  Uncapped=false
```

**How Ruijie Uses These Parameters:**
1. AP reads URL parameters after user authentication
2. Parses WISPr attributes
3. Creates traffic shaping rules for the device's MAC address
4. Enforces bandwidth limits via tc (traffic control)
5. Tracks data usage against quota
6. Auto-disconnects when quota exhausted or session expires

---

## 🔄 Complete User Journey

### Scenario: User purchases PreMAX package via EcoCash

```
1. USER NAVIGATES TO PORTAL
   ├─ Ruijie AP detects unauthenticated device
   ├─ Redirects to captive portal (index.html)
   └─ URL includes: ?mac=AA:BB:CC:DD:EE:FF&ip=192.168.1.100

2. USER SEES PACKAGE OPTIONS
   ├─ JavaScript captures Ruijie MAC/IP from URL params
   ├─ Displays 8 package cards with pricing
   └─ Each button has data attributes for package details

3. USER CLICKS "BUY NOW" (PreMAX)
   ├─ Payment modal opens
   ├─ Shows: "$34.99/month, 100GB DATA, 10 Mbps"
   ├─ Requests EcoCash phone number
   └─ User confirms payment

4. PAYMENT INITIATED
   ├─ POST /api/payments/initiate
   ├─ Backend creates user record (phone-based lookup)
   ├─ Creates payment record (status=pending)
   ├─ Calls Pesepay API with EcoCash targeting:
   │  └─ request.payment.method = "ecocash"
   │  └─ request.payment.phone = "263771327202"
   ├─ Receives Pesepay redirect URL
   └─ Sends back poll URL to frontend

5. PESEPAY CHECKOUT (EcoCash)
   ├─ Frontend redirects: window.location.href = pesepayPollUrl
   ├─ User sees EcoCash payment prompt
   ├─ User enters PIN to authorize
   └─ Pesepay confirms payment

6. PAYMENT CALLBACK
   ├─ Pesepay redirects to: /api/payments/callback?ref=PY-550E8400-...
   ├─ Backend verifies payment status
   ├─ Updates payment record: status=completed
   ├─ Creates WISPr profile:
   │  ├─ MAC: AA:BB:CC:DD:EE:FF
   │  ├─ Bandwidth: 10,000 Kbps (down/up)
   │  ├─ Data Quota: 107,374,182,400 bytes (100GB)
   │  └─ Expiry: NOW + 2,592,000 seconds (30 days)
   └─ Writes to wispr_profiles table

7. RUIJIE AUTHENTICATION RESPONSE
   ├─ Backend calls Ruijie auth API
   ├─ Includes WISPr parameters in response
   ├─ Ruijie AP receives: bandwidth limits + data quota
   ├─ AP applies traffic shaping for MAC
   └─ Device is now authenticated + bandwidth-limited

8. USER DEVICE CONNECTED
   ├─ Unauthenticated traffic redirected to Ruijie login endpoint
   ├─ User logs in with credentials
   ├─ AP references WISPr profile from session
   ├─ Traffic shaping enforced:
   │  ├─ Max 10 Mbps download
   │  ├─ Max 10 Mbps upload
   │  ├─ Max 100GB monthly data
   │  └─ Auto-disconnect on quota/expiry
   └─ User enjoys full connectivity within limits

9. SESSION MONITORING
   ├─ WISPr profile tracks data usage
   ├─ User receives notifications when quota approaches
   ├─ Session expires after 30 days
   ├─ Data access log records login event
   └─ Analytics updated
```

---

## 🔐 Environment Variables Required

Add to `.env`:

```bash
# Pesepay Configuration
PESEPAY_API_KEY=your_pesepay_api_key
PESEPAY_API_ID=your_pesepay_api_id
PESEPAY_BASE_URL=https://api.pesepay.com/api/postpay
PESEPAY_MERCHANT_ID=your_merchant_id

# Portal Configuration
BASE_URL=https://portal.preyone.com
RUIJIE_SUCCESS_URL=https://yourruijieap.local/success

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=captive_portal
DB_USER=postgres
DB_PASSWORD=your_secure_password

# Server
PORT=3000
NODE_ENV=production
```

---

## 📊 Key Data Conversions

### Bandwidth Conversion
| Input | Output | Calculation |
|-------|--------|-------------|
| 2 Mbps | 2,000 Kbps | × 1,000 |
| 10 Mbps | 10,000 Kbps | × 1,000 |
| 30 Mbps | 30,000 Kbps | × 1,000 |

### Data Quota Conversion
| Input | Output | Calculation |
|-------|--------|-------------|
| 2 GB | 2,147,483,648 bytes | × 1,073,741,824 |
| 100 GB | 107,374,182,400 bytes | × 1,073,741,824 |
| Uncapped | NULL | No limit |

### Session Duration Conversion
| Tier | Minutes | Seconds | Duration |
|------|---------|---------|----------|
| Daily | 1,440 | 86,400 | 1 day |
| Weekly | 10,080 | 604,800 | 7 days |
| Monthly | 43,200 | 2,592,000 | 30 days |

---

## 🧪 Testing the Integration

### 1. Test Payment Initiation
```bash
curl -X POST http://localhost:3000/api/payments/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "tier": "PreMAX",
    "displayName": "Pro",
    "amount": 34.99,
    "currency": "USD",
    "billingPeriod": "monthly",
    "dataLimitGb": 100,
    "isUncapped": false,
    "bandwidthUp": 10,
    "bandwidthDown": 10,
    "phone": "+263771327202",
    "fullName": "Test User",
    "macAddress": "AA:BB:CC:DD:EE:FF"
  }'
```

### 2. Check WISPr Profile
```bash
psql captive_portal -c \
  "SELECT * FROM wispr_profiles WHERE mac_address = 'AA:BB:CC:DD:EE:FF';"
```

### 3. Verify Payment Status
```bash
curl http://localhost:3000/api/payments/status/{paymentId}
```

---

## 📝 File Summary

| File | Purpose |
|------|---------|
| `src/db/migrate.ts` | Database schema with packages, payments, WISPr |
| `src/routes/payments.ts` | Payment initiation & callback handling |
| `src/services/pesepayService.ts` | Pesepay API integration (EcoCash targeting) |
| `src/utils/wisprTransformer.ts` | Bandwidth/quota parameter conversion |
| `src/routes/auth.ts` | Updated to include WISPr config |
| `src/index.ts` | Registered `/api/payments` router |
| `public/index.html` | Package cards with semantic data attributes |
| `public/js/portal.js` | Payment modal & purchase flow |
| `public/css/portal.css` | Modal styling (appended) |

---

## 🚀 Deployment Checklist

- [ ] Run database migration: `npm run migrate`
- [ ] Configure `.env` with Pesepay credentials
- [ ] Test payment flow with mock Pesepay (default)
- [ ] Enable real Pesepay when live
- [ ] Configure Ruijie AP to fetch bandwidth from WISPr callbacks
- [ ] Test end-to-end: Package purchase → EcoCash → Bandwidth enforcement
- [ ] Monitor `wispr_profiles` table for proper session creation
- [ ] Verify traffic shaping on Ruijie AP (tc rules applied)

---

## 🐛 Troubleshooting

**Payment not processing?**
- Check `PESEPAY_API_KEY` configuration
- Verify phone number format (should be 263771... or 0771...)
- Check `payments` table for error_message

**WISPr parameters not applied?**
- Verify `wispr_profiles` table has record for MAC
- Check Ruijie AP logs for WISPr parameter parsing
- Ensure MAC address matches device

**Data quota not enforced?**
- Confirm `is_uncapped=false` in packages table
- Verify `data_quota_bytes` is populated (not NULL)
- Check Ruijie AP traffic shaping rules: `tc qdisc show`

---

## 📚 Additional Resources

- **WISPr Standard:** [RFC 5997](https://tools.ietf.org/html/rfc5997)
- **Pesepay API:** https://docs.pesepay.com
- **EcoCash:** Zimbabwe's leading mobile money platform
- **Ruijie Documentation:** https://www.ruijie.com.cn (for WISPr RADIUS extensions)

---

Generated: May 2026
System: Preyone UltraNet Captive Portal v1.0
