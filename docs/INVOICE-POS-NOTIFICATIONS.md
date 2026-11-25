# Preyone Invoice & POS — notifications and tenant records

## Transactional emails

| Event | Recipient | Trigger | Template |
|---|---|---|---|
| Client provisioned / welcome | Client CEO | `POST /api/admin/tenants/provision` | Emerald welcome with plan, expiry, login URLs, till code and temporary password |
| Sign-in OTP | Account owner | `POST /api/admin/auth/login` | Emerald 6-digit code (invoice/POS); admin/WiFi keep their existing skins |
| Password reset | Account owner | Invoice/POS "Forgot password?", or house CEO **Reset link** on a client row | Emerald reset link to `invoice.preyone.com/recover-password` |
| Password changed | Account owner | `POST /api/admin/auth/reset-password` | Emerald security notice |
| Subscription expiry — 3 days | Company billing email | Daily subscription cron | Emerald reminder + plan table |
| Subscription expiry — tomorrow | Company billing email | Daily subscription cron | Emerald urgent reminder |
| Subscription payment received | Company billing email | Cash subscription endpoint and Pesepay subscription webhook | Emerald receipt with plan, amount, method, reference and new expiry |
| Month-End report | Configured report recipients | Report scheduler / on-demand email | Emerald `monthEndReport.html` with Excel attachment |
| Document delivery | Customer email | "Send" in the invoice/POS document drawer | Emerald tenant-branded email with the PDF attached |

All mail is sent through the single `Preyone Enterprises <support@preyone.com>` sender identity.

## Where tenant records live

| Record | Table | Notes |
|---|---|---|
| Company profile, plan, expiry, branding | `companies` | `plan_type` is the entitlement source of truth; `subscription_expires_at` drives reminders and suspension |
| Owner and staff accounts | `admin_users` | `portal_company_id` binds a person to the tenant. `password_hash` is bcrypt; plaintext passwords are never stored |
| Module mirror rows | `subscriptions` | Kept in step with `plan_type` for older readers |
| Paired tills | `pos_devices` | Includes device token, status and tenant |
| Provisioning, plan changes, cash receipts, password resets | `admin_audit_log` | Append-only operator trail with actor, action, target and timestamp |
| Cash subscription receipt | `pos_documents` + `pos_document_payments` + `accounting_ledger` | Revenue is booked in the **house** tenant, never in the client's books |
| Reports | `reports` / scheduler logs + the emailed Excel workbook | Month-End runs on the 3rd at 08:00 |

## Password recovery

Passwords are one-way bcrypt hashes, so they cannot be read back. Recovery is a one-hour reset link:

1. **Client owner:** Invoice sign-in → **Forgot password?** → enter the account email.
2. **House CEO:** Invoice → **Settings & Branding → Client Tenants → Reset link** on the client row.
3. The link opens `invoice.preyone.com/recover-password?token=…`, sets a new password and revokes every existing session.

The temporary password created during provisioning is included once in the welcome email. It is not stored anywhere after the bcrypt hash is written.
