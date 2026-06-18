import nodemailer from 'nodemailer';

interface PaymentNotification {
  fullName: string;
  email?: string;
  phone: string;
  voucherCode: string;
  packageTier: string;
  amount: number;
  currency: string;
  bandwidthUp: number;
  bandwidthDown: number;
  dataLimitGb: number | null;
  isUncapped: boolean;
  durationMin: number;
  sessionExpiresAt: Date;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) return null;
  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465,
    auth: { user, pass },
  });
  return transporter;
}

export async function sendEmailReceipt(notification: PaymentNotification): Promise<boolean> {
  const t = getTransporter();
  if (!t || !notification.email) {
    console.log('[NOTIFICATION] Email not sent (SMTP not configured or no email). Voucher:', notification.voucherCode);
    return false;
  }

  const dataText = notification.isUncapped
    ? 'Unlimited'
    : notification.dataLimitGb ? `${notification.dataLimitGb} GB` : '—';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
    ${emailHeader('Payment Confirmed')}
    <div style="padding:24px">
      <p style="margin:0 0 16px;color:#333">Hi <strong>${notification.fullName}</strong>,</p>
      <p style="margin:0 0 16px;color:#333">Your payment was successful. Here are your connection details:</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:16px;text-align:center">
        <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;color:#666">Your Voucher Code</p>
        <p style="margin:0;font-size:24px;font-weight:700;letter-spacing:2px;color:#16a34a">${notification.voucherCode}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#666">Use this code to reconnect on any device</p>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#666;font-size:14px">Package</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${notification.packageTier}</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:14px">Speed</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${notification.bandwidthDown} Mbps</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:14px">Data</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${dataText}</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:14px">Expires</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${notification.sessionExpiresAt.toLocaleString()}</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:14px">Amount Paid</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${notification.currency} ${notification.amount}</td></tr>
      </table>
      ${emailFooter()}
    </div>
  </div>
</body>
</html>`;

  return sendMail(notification.email, `Preyone UltraNet WiFi — Voucher ${notification.voucherCode}`, html, 'Preyone UltraNet WiFi');
}

export async function sendSmsReceipt(notification: PaymentNotification): Promise<boolean> {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) {
    console.log('[NOTIFICATION] SMS not sent (no SMS_PROVIDER configured). Voucher:', notification.voucherCode);
    return false;
  }

  const message = `Preyone WiFi: Payment confirmed! Your voucher: ${notification.voucherCode}. Speed: ${notification.bandwidthDown}Mbps, Data: ${notification.isUncapped ? 'Unlimited' : notification.dataLimitGb + 'GB'}. Expires: ${notification.sessionExpiresAt.toLocaleTimeString()}. Use code to reconnect.`;

  try {
    if (provider === 'gikko') {
      const apiKey = process.env.GIKKO_API_KEY;
      const senderId = process.env.SMS_SENDER_ID || 'PREYONE';
      if (!apiKey) {
        console.log('[NOTIFICATION] Gikko not configured');
        return false;
      }
      const response = await fetch('https://api.gikko.co.zw/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          sender_id: senderId,
          recipient: notification.phone,
          message,
        }),
      });
      if (!response.ok) {
        console.error('[NOTIFICATION] Gikko SMS failed:', await response.text());
        return false;
      }
      console.log('[NOTIFICATION] SMS sent via Gikko to', notification.phone);
      return true;
    }
    console.log('[NOTIFICATION] Unknown SMS provider:', provider);
    return false;
  } catch (err) {
    console.error('[NOTIFICATION] SMS send error:', err);
    return false;
  }
}

export async function sendPaymentNotifications(notification: PaymentNotification): Promise<void> {
  await sendEmailReceipt(notification);
  await sendSmsReceipt(notification);
}

// ── Email header helper with logo ─────────────────────────────────────
function emailHeader(title: string): string {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return `<div style="background:#0a0a0a;padding:32px 24px 16px;text-align:center">
    <img src="${baseUrl}/images/preyone-logo-mainInverse.png" alt="Preyone UltraNet WiFi" style="max-width:160px;height:auto;margin-bottom:12px;display:block;margin-left:auto;margin-right:auto" />
    <h1 style="color:#ffffff;margin:0 0 16px;font-size:22px;font-family:'Montserrat',Arial,sans-serif;font-weight:600">${title}</h1>
    <div style="height:3px;background:linear-gradient(90deg,#ff00ff,#00d4ff);border-radius:2px"></div>
  </div>`;
}

// ── Email footer helper with WhatsApp + links ─────────────────────
function emailFooter(): string {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return `<div style="background:#0a0a0a;padding:28px 24px 20px;text-align:center;font-family:'Montserrat',Arial,sans-serif;border-top:2px solid #1a1a2e">
    <img src="${baseUrl}/images/preyone-logo-mainInverse.png" alt="Preyone" style="max-width:120px;height:auto;margin-bottom:16px;display:block;margin-left:auto;margin-right:auto" />
    <div style="margin-bottom:16px">
      <a href="https://wa.me/263771327202" style="display:inline-block;background:linear-gradient(135deg,#25D366,#128C7E);color:#ffffff;padding:10px 28px;border-radius:50px;text-decoration:none;font-size:13px;font-weight:700;box-shadow:0 4px 14px rgba(37,211,102,0.3)">Chat on WhatsApp</a>
    </div>
    <p style="margin:0 0 12px;font-size:13px;color:#94a3b8">
      <a href="mailto:support@preyone.com" style="color:#71ff2f;text-decoration:none;font-weight:600">support@preyone.com</a>
      <span style="color:#334155;margin:0 8px">|</span>
      <a href="tel:+263771327202" style="color:#13d8ff;text-decoration:none;font-weight:600">+263 771 327 202</a>
    </p>
    <div style="margin-bottom:14px;font-size:12px;color:#475569">
      <a href="${baseUrl}/terms.html" style="color:#13d8ff;text-decoration:none;margin:0 10px;font-weight:500">Terms of Service</a>
      <span style="color:#334155">•</span>
      <a href="https://www.preyone.com" style="color:#71ff2f;text-decoration:none;margin:0 10px;font-weight:500">Main Website</a>
      <span style="color:#334155">•</span>
      <a href="${baseUrl}" style="color:#8b4dff;text-decoration:none;margin:0 10px;font-weight:500">WiFi Portal</a>
    </div>
    <div style="height:2px;background:linear-gradient(90deg,#71ff2f,#13d8ff,#8b4dff);border-radius:2px;margin-bottom:14px;max-width:300px;margin-left:auto;margin-right:auto"></div>
    <p style="margin:0;font-size:11px;color:#475569">&copy; ${new Date().getFullYear()} Preyone Enterprises. All rights reserved.</p>
    <p style="margin:4px 0 0;font-size:10px;color:#334155">Powered by Starlink Business Infrastructure</p>
  </div>`;
}

// ── Generic email helper ──────────────────────────────────────────────
async function sendMail(to: string, subject: string, html: string, fromName?: string, fromEmail?: string): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.log('[NOTIFICATION] Email not sent (SMTP not configured). To:', to);
    return false;
  }
  const email = fromEmail || process.env.SMTP_FROM || 'info@preyone.com';
  const from = fromName ? `"${fromName}" <${email}>` : email;
  try {
    await t.sendMail({ from, to, subject, html });
    console.log('[NOTIFICATION] Email sent to', to, '-', subject);
    return true;
  } catch (err) {
    console.error('[NOTIFICATION] Email send failed:', err);
    return false;
  }
}

// ── Admin signup: confirmation to the new user ────────────────────────
export async function sendAdminSignupConfirmation(
  email: string,
  fullName: string,
  role: string,
  approved: boolean,
  verificationToken?: string
): Promise<boolean> {
  const adminUrl = process.env.ADMIN_BASE_URL || process.env.BASE_URL || 'https://admin.preyone.com';
  const verifyUrl = verificationToken ? `${adminUrl}/api/admin/auth/verify-email?token=${verificationToken}` : null;
  const signInUrl = `${adminUrl}/`;

  if (approved) {
    return sendMail(
      email,
      `🎉 Welcome to Preyone — ${role} Account Activated`,
      buildAdminWelcomeHtml(fullName, email, role, 'activated', verifyUrl),
      'Preyone', 'info@preyone.com'
    );
  }
  return sendMail(
    email,
    `⏳ Your Preyone Staff Account — Pending Approval`,
    buildAdminWelcomeHtml(fullName, email, role, 'pending', verifyUrl),
    'Preyone', 'info@preyone.com'
  );
}

function buildAdminWelcomeHtml(fullName: string, email: string, role: string, status: 'activated' | 'pending', verifyUrl: string | null): string {
  const isActivated = status === 'activated';
  const roleBadgeColor = role === 'CEO' ? '#ffd700' : role === 'Manager' ? '#367cff' : '#10b981';
  const roleBadgeBg = role === 'CEO' ? '#fff8e1' : role === 'Manager' ? '#e8f0ff' : '#e6f7ee';
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  if (isActivated) {
    return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
  ${emailHeader('Admin Console')}

  <!-- Hero Section -->
  <div style="padding:32px 32px 0;text-align:center">
    <div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.15),rgba(19,216,255,0.15));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(113,255,47,0.2)">
      <span style="font-size:32px">✅</span>
    </div>
    <h1 style="margin:0 0 4px;font-size:22px;color:#ffffff;font-weight:700">Account Activated</h1>
    <p style="margin:0 0 20px;font-size:14px;color:#13d8ff">Preyone Admin Console</p>
  </div>

  <!-- User Card -->
  <div style="margin:0 32px;padding:20px;background:rgba(255,255,255,0.03);border-radius:12px;border:1px solid rgba(255,255,255,0.08)">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#64748b;width:80px">Name</td>
        <td style="padding:6px 12px;font-size:14px;color:#ffffff;font-weight:600">${fullName}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#64748b">Email</td>
        <td style="padding:6px 12px;font-size:14px;color:#ffffff">${email}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#64748b">Role</td>
        <td style="padding:6px 12px">
          <span style="display:inline-block;padding:2px 12px;border-radius:100px;font-size:12px;font-weight:600;background:${roleBadgeBg};color:${roleBadgeColor}">${role}</span>
        </td>
      </tr>
    </table>
  </div>

  <!-- Body -->
  <div style="padding:24px 32px 0">
    <p style="margin:0 0 12px;font-size:14px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
    <p style="margin:0 0 12px;font-size:14px;color:#cbd5e1;line-height:1.6">Your <strong style="color:#71ff2f">${role}</strong> account is ready. Please verify your email address to activate your account and gain full access to the <strong style="color:#13d8ff">Preyone Admin Console</strong>.</p>
  </div>

  <!-- Verify Email Button -->
  ${verifyUrl ? `
  <div style="padding:16px 32px;text-align:center">
    <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Verify Email Address</a>
    <p style="margin:8px 0 0;font-size:12px;color:#64748b">Link expires in 24 hours</p>
  </div>
  ` : ''}

  <!-- Divider -->
  <div style="margin:16px 32px 0;border-top:1px solid rgba(255,255,255,0.06)"></div>

  <!-- Quick Links -->
  <div style="padding:16px 32px 0">
    <p style="margin:0 0 8px;font-size:11px;color:#64748b;font-weight:600;letter-spacing:1px">QUICK LINKS</p>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:4px 0"><a href="${baseUrl}" style="font-size:13px;color:#71ff2f;text-decoration:none">🔑 Sign In to Admin Console</a></td>
      </tr>
      <tr>
        <td style="padding:4px 0"><a href="${baseUrl}/forgot-password" style="font-size:13px;color:#13d8ff;text-decoration:none">🔒 Reset Your Password</a></td>
      </tr>
      <tr>
        <td style="padding:4px 0"><a href="https://www.preyone.com" style="font-size:13px;color:#8b4dff;text-decoration:none">🌐 Preyone Website</a></td>
      </tr>
    </table>
  </div>

  <!-- Need Help -->
  <div style="margin:16px 32px 24px;padding:16px;background:rgba(19,216,255,0.05);border-radius:8px;border:1px solid rgba(19,216,255,0.1)">
    <p style="margin:0 0 4px;font-size:13px;color:#13d8ff;font-weight:600">Need help?</p>
    <p style="margin:0;font-size:12px;color:#64748b">Contact support at <a href="mailto:support@preyone.com" style="color:#71ff2f;text-decoration:underline">support@preyone.com</a> or call <a href="tel:+263771327202" style="color:#13d8ff;text-decoration:none">+263 771 327 202</a></p>
  </div>

  ${emailFooter()}
</div>`;
  }

  return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
  ${emailHeader('Staff Account Created')}

  <!-- Hero -->
  <div style="padding:28px 32px 0;text-align:center">
    <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,rgba(19,216,255,0.12),rgba(139,77,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 30px rgba(19,216,255,0.15)">
      <span style="font-size:36px">🎉</span>
    </div>
    <h1 style="margin:0 0 6px;font-size:24px;color:#ffffff;font-weight:800;letter-spacing:-0.5px">Welcome to the Team!</h1>
    <p style="margin:0 0 4px;font-size:15px;color:#13d8ff;font-weight:500">Preyone Admin Console</p>
  </div>

  <!-- Intro -->
  <div style="padding:24px 32px 0">
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Great news—your staff account has been successfully created! To keep our workspace secure, a Manager or member of our Executive Team just needs to give your account a quick final approval before you can officially sign in.</p>
  </div>

  <!-- Steps -->
  <div style="margin:0 32px;padding:20px;background:linear-gradient(135deg,rgba(113,255,47,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06)">
    <p style="margin:0 0 14px;font-size:14px;color:#71ff2f;font-weight:700">🚀 What happens next?</p>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">1.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Review.</strong> Our leadership team is already on it.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">2.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Notification.</strong> As soon as you're approved, we'll drop a fresh link straight into your inbox.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">3.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Launch.</strong> You'll set your password, log in, and dive right in.</td>
      </tr>
    </table>
  </div>

  <!-- Verify Email -->
  ${verifyUrl ? `
  <div style="padding:20px 32px 0;text-align:center">
    <p style="margin:0 0 10px;font-size:13px;color:#64748b">While you wait, please verify your email address:</p>
    <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Verify Email Address</a>
    <p style="margin:8px 0 0;font-size:12px;color:#64748b">Link expires in 24 hours</p>
  </div>
  ` : ''}

  <!-- Support -->
  <div style="padding:20px 32px 0">
    <div style="padding:16px;background:rgba(139,77,255,0.05);border-radius:8px;border:1px solid rgba(139,77,255,0.1)">
      <p style="margin:0 0 8px;font-size:13px;color:#8b4dff;font-weight:600">Need a hand in the meantime?</p>
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5">If you have any immediate questions or feel there's been a delay, feel free to reach out to our support desk at <a href="mailto:support@preyone.com" style="color:#71ff2f;text-decoration:underline">support@preyone.com</a>.</p>
    </div>
  </div>

  <!-- Sign-off -->
  <div style="padding:24px 32px 0;text-align:center">
    <p style="margin:0 0 4px;font-size:14px;color:#cbd5e1;line-height:1.6">We are incredibly excited to have you on board and can't wait to help you get started!</p>
    <p style="margin:16px 0 0;font-size:14px;color:#ffffff;font-weight:600">Best regards,</p>
    <p style="margin:4px 0 0;font-size:14px;color:#71ff2f;font-weight:700">The Preyone Team</p>
    <p style="margin:4px 0 0"><a href="https://www.preyone.com" style="font-size:13px;color:#13d8ff;text-decoration:none">www.preyone.com</a></p>
  </div>

  ${emailFooter()}
</div>`;
}

// ── Admin approval: notify staff they've been approved ──────────────────
export async function sendAdminApprovedNotification(email: string, fullName: string): Promise<boolean> {
  return sendMail(
    email,
    'Your Preyone Staff Account Has Been Approved',
    `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
  ${emailHeader('Account Approved')}

  <!-- Hero -->
  <div style="padding:28px 32px 0;text-align:center">
    <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.12),rgba(19,216,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 30px rgba(113,255,47,0.15)">
      <span style="font-size:36px">✅</span>
    </div>
    <h1 style="margin:0 0 6px;font-size:24px;color:#ffffff;font-weight:800;letter-spacing:-0.5px">You're Approved!</h1>
    <p style="margin:0 0 4px;font-size:15px;color:#13d8ff;font-weight:500">Preyone Admin Console</p>
  </div>

  <!-- Intro -->
  <div style="padding:24px 32px 0">
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Great news—your staff account has been successfully approved! A Manager or member of our Executive Team has reviewed and authorised your account.</p>
  </div>

  <!-- Steps -->
  <div style="margin:0 32px;padding:20px;background:linear-gradient(135deg,rgba(113,255,47,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06)">
    <p style="margin:0 0 14px;font-size:14px;color:#71ff2f;font-weight:700">🚀 What happens next?</p>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">1.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Review.</strong> Our leadership team is already on it.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">2.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Notification.</strong> As soon as you're approved, we'll drop a fresh link straight into your inbox.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">3.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">The Launch.</strong> Log in, and dive right in.</td>
      </tr>
    </table>
  </div>

  <!-- Sign In Button -->
  <div style="padding:24px 32px 0;text-align:center">
    <a href="https://admin.preyone.com" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Sign In to Admin Console</a>
  </div>

  <!-- Support -->
  <div style="padding:20px 32px 0">
    <div style="padding:16px;background:rgba(139,77,255,0.05);border-radius:8px;border:1px solid rgba(139,77,255,0.1)">
      <p style="margin:0 0 8px;font-size:13px;color:#8b4dff;font-weight:600">Need a hand in the meantime?</p>
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5">If you have any immediate questions or feel there's been a delay, feel free to reach out to our support desk at <a href="mailto:admin@preyone.com" style="color:#71ff2f;text-decoration:underline">admin@preyone.com</a>.</p>
    </div>
  </div>

  <!-- Sign-off -->
  <div style="padding:24px 32px 0;text-align:center">
    <p style="margin:0 0 4px;font-size:14px;color:#cbd5e1;line-height:1.6">We are incredibly excited to have you on board and can't wait to help you get started!</p>
    <p style="margin:16px 0 0;font-size:14px;color:#ffffff;font-weight:600">Best regards,</p>
    <p style="margin:4px 0 0;font-size:14px;color:#71ff2f;font-weight:700">The Preyone Team</p>
    <p style="margin:4px 0 0"><a href="https://admin.preyone.com" style="font-size:13px;color:#13d8ff;text-decoration:none">admin.preyone.com</a></p>
  </div>

  ${emailFooter()}
</div>`,
    'Preyone', 'info@preyone.com'
  );
}

// ── Admin signup: notify CEO/Manager about new Staff ────────────────────
export async function sendAdminSignupNotification(
  staffName: string,
  staffEmail: string
): Promise<boolean> {
  const { rows } = await (await import('../db/pool')).pool.query(
    "SELECT email FROM admin_users WHERE role IN ('CEO','Manager') AND approved = true"
  );
  if (rows.length === 0) {
    console.log('[NOTIFICATION] No admin recipients found for staff signup notification');
    return false;
  }
  const adminEmails: string[] = rows.map((r: any) => r.email);
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
    ${emailHeader('New Staff Signup')}
    <div style="padding:24px">
      <p>A new staff member has signed up and needs your approval:</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#666">Name</td><td style="padding:6px 0;font-weight:600;text-align:right">${staffName}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0;font-weight:600;text-align:right">${staffEmail}</td></tr>
      </table>
      <p style="margin-top:16px">Log in to the admin panel to approve or reject this account.</p>
      <p style="text-align:center;margin-top:16px">
        <a href="https://admin.preyone.com" style="display:inline-block;background:#367cff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Go to Admin Panel</a>
      </p>
      ${emailFooter()}
    </div>
  </div>`;
  for (const email of adminEmails) {
    await sendMail(email, 'New Staff Signup — Pending Approval', html, 'Preyone', 'info@preyone.com');
  }
  return true;
}

// ── Password reset email ───────────────────────────────────────────────
export async function sendPasswordResetEmail(email: string, resetToken: string, fullName: string): Promise<boolean> {
  const baseUrl = process.env.ADMIN_BASE_URL || process.env.BASE_URL || 'https://admin.preyone.com';
  const resetUrl = `${baseUrl}/?token=${resetToken}`;
  return sendMail(
    email,
    'Reset Your Preyone Admin Password',
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      ${emailHeader('Password Reset')}
      <div style="padding:24px">
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>We received a request to reset your admin password. Click the button below to set a new password. This link expires in 1 hour.</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#367cff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        </p>
        <p style="font-size:13px;color:#666">If you didn't request this, you can safely ignore this email.</p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone', 'info@preyone.com'
  );
}

// ── Portal email verification ─────────────────────────────────────────
export async function sendPortalEmailVerification(email: string, token: string, fullName: string): Promise<boolean> {
  const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/verify-email?token=${token}`;
  return sendMail(
    email,
    'Verify Your Email — Preyone WiFi',
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      ${emailHeader('Verify Your Email')}
      <div style="padding:24px">
        <p style="color:#333;line-height:1.6">Hi <strong>${fullName}</strong>,</p>
        <p style="color:#333;line-height:1.6">Please confirm your email address by clicking the button below. This link expires in <strong>24 hours</strong>.</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(90deg,#7c3aed,#6d28d9);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
        </p>
        <p style="font-size:13px;color:#888">If you didn't create an account, you can safely ignore this email.</p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}

// ── Portal forgot password ───────────────────────────────────────────
export async function sendPortalForgotPassword(email: string, token: string, fullName: string): Promise<boolean> {
  const resetUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
  return sendMail(
    email,
    'Reset Your Password — Preyone WiFi',
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      ${emailHeader('Reset Your Password')}
      <div style="padding:24px">
        <p style="color:#333;line-height:1.6">Hi <strong>${fullName}</strong>,</p>
        <p style="color:#333;line-height:1.6">We received a request to reset your Preyone WiFi account password. Click the button below to set a new one. This link expires in <strong>1 hour</strong>.</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(90deg,#7c3aed,#6d28d9);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        </p>
        <p style="font-size:13px;color:#888">If you didn't request this, you can safely ignore this email.</p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}

// ── Portal user account created (no voucher) ──────────────────────────
export async function sendPortalAccountCreated(
  email: string,
  fullName: string,
  verifyToken: string
): Promise<boolean> {
  const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/verify-email?token=${verifyToken}`;
  const loginUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/login`;
  const portalUrl = process.env.BASE_URL || 'http://localhost:3000';
  return sendMail(
    email,
    'Your Preyone WiFi Account Has Been Created — Verify Your Email',
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      ${emailHeader('Account Created')}
      <div style="padding:24px">
        <p>Hi <strong>${fullName}</strong>,</p>
        <p style="color:#333;line-height:1.6">Welcome to <strong>Preyone UltraNet WiFi</strong>! Your account has been created successfully.</p>
        <p style="font-size:13px;color:#555">Your account email: <strong>${email}</strong></p>

        <div style="background:#f5f3ff;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b21a8">Next Steps:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;color:#4c1d95;line-height:1.8">
            <li>Verify your email using the button below</li>
            <li>Sign in to manage your account, view data usage, and top up</li>
            <li>Connect to the <strong>Preyone UltraNet</strong> WiFi network and enjoy high-speed internet</li>
          </ol>
        </div>

        <p style="text-align:center;margin:20px 0">
          <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(90deg,#7c3aed,#6d28d9);color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email Address</a>
        </p>
        <p style="text-align:center;margin:20px 0">
          <a href="${loginUrl}" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Sign In to Manage Account</a>
        </p>

        <div style="background:#f0fdf4;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#15803d">Quick Connect:</p>
          <p style="margin:0;font-size:13px;color:#166534;line-height:1.6">
            To connect immediately, open your WiFi settings, select <strong>Preyone UltraNet</strong>, and follow the on-screen instructions. No voucher needed for instant access.
          </p>
        </div>

        <p style="font-size:12px;color:#888;text-align:center;margin:16px 0 0">
          Need a voucher or top-up? Visit our <a href="${portalUrl}" style="color:#7c3aed">WiFi Portal</a> or any Preyone agent near you.
        </p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}

// ── Portal user signup confirmation (voucher redemption) ──────────────
export async function sendPortalSignupConfirmation(
  email: string,
  fullName: string,
  voucherCode: string
): Promise<boolean> {
  const portalUrl = process.env.BASE_URL || 'http://localhost:3000';
  return sendMail(
    email,
    'Your Preyone WiFi Session is Ready',
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      ${emailHeader('Welcome to Preyone WiFi!')}
      <div style="padding:24px">
        <p style="color:#333;line-height:1.6">Hi <strong>${fullName}</strong>,</p>
        <p style="color:#333;line-height:1.6">Your WiFi session has been activated using voucher <strong style="color:#7c3aed">${voucherCode}</strong>.</p>

        <div style="background:#f0fdf4;border-radius:8px;padding:16px;margin:16px 0">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#15803d">How to Connect:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;color:#166534;line-height:1.8">
            <li>Open your device WiFi settings</li>
            <li>Select the network <strong>Preyone UltraNet</strong></li>
            <li>You will be redirected to the portal &mdash; you're already online!</li>
          </ol>
        </div>

        <p style="font-size:13px;color:#555;text-align:center;margin:16px 0">
          Reconnect anytime using voucher code: <strong style="font-size:18px;color:#7c3aed">${voucherCode}</strong>
        </p>

        <p style="font-size:12px;color:#888;text-align:center;margin:16px 0 0">
          <a href="${portalUrl}" style="color:#7c3aed">Visit WiFi Portal</a> to manage your account, check data usage, or purchase a new voucher.
        </p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}
