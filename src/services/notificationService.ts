import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';
import { buildPasswordResetEmail, buildVerificationEmail, starlinkBaseUrl } from './starlinkEmailTemplates';

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
    <p style="margin:6px 0 0;font-size:10px;color:#334155;font-style:italic;letter-spacing:0.3px">Innovating with IT Excellence, Driven by Faith, Growing Beyond Boundaries.</p>
  </div>`;
}

// ── Generic email helper ──────────────────────────────────────────────

/**
 * One sender identity for every transactional message. Mail clients show the
 * display name, so this is always "Preyone Enterprises" regardless of which
 * app (invoice, POS, WiFi, Starlink, admin) triggered the message. The
 * envelope address is the verified SMTP_FROM mailbox so SPF/DKIM alignment
 * stays on support@preyone.com.
 */
const TRANSACTIONAL_FROM_NAME = 'Preyone Enterprises';

function senderAddress(): string {
  const configured = String(process.env.SMTP_FROM || '').trim();
  const bracketed = /<([^>]+)>/.exec(configured)?.[1]?.trim();
  if (bracketed) return bracketed;
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(configured)) return configured;
  return 'support@preyone.com';
}

async function sendMail(
  to: string,
  subject: string,
  html: string,
  _fromName?: string,
  _fromEmail?: string,
  attachments?: Array<{ filename: string; content: Buffer; cid?: string }>,
  headers?: Record<string, string>,
  text?: string
): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    console.log('[NOTIFICATION] Email not sent (SMTP not configured). To:', to);
    return false;
  }
  // Per-call fromName/fromEmail are kept in the signature for compatibility
  // but deliberately ignored: every message must present the same brand and
  // the same verified mailbox.
  const from = `"${TRANSACTIONAL_FROM_NAME}" <${senderAddress()}>`;
  try {
    const info = await t.sendMail({ from, to, subject, html, text, attachments, headers });
    // The relay's response is the only proof of acceptance we get (the SMTP
    // command succeeding is not delivery). Log it so a future "no email"
    // report can be traced to the exact relay message instead of guesswork.
    const response = (info as { response?: string } | undefined)?.response;
    console.log('[NOTIFICATION] Email sent to', to, '-', subject, response ? `- ${response}` : '');
    return true;
  } catch (err) {
    console.error('[NOTIFICATION] Email send failed:', err);
    return false;
  }
}

// ── Emerald invoicing / POS email shell ───────────────────────────────
//
// The WiFi and admin mails predate the invoicing brand and use the original
// green/cyan skin. Every invoice or POS notification goes through this shell
// instead: deep emerald glass, the house mark, one clear action, and the same
// table-based markup that survives Gmail and Outlook.

const EMERALD = {
  ink: '#050b08',
  panel: '#0a1410',
  panelSoft: '#0d1c16',
  line: '#173a2c',
  accent: '#34d399',
  accentStrong: '#10b981',
  accentDeep: '#047857',
  cyan: '#00f0ff',
  text: '#eafff7',
  muted: '#93b8aa',
  dim: '#647d72',
};

function appBaseUrl(app: 'invoice' | 'pos' | 'admin' | 'wifi' | 'starlink' = 'invoice'): string {
  if (app === 'invoice') {
    return (process.env.INVOICE_BASE_URL || 'https://invoice.preyone.com').replace(/\/$/, '');
  }
  if (app === 'pos') {
    return (process.env.POS_BASE_URL || 'https://pos.preyone.com').replace(/\/$/, '');
  }
  if (app === 'admin') {
    return (process.env.ADMIN_BASE_URL || process.env.BASE_URL || 'https://admin.preyone.com').replace(/\/$/, '');
  }
  return (process.env.BASE_URL || 'https://preyone.com').replace(/\/$/, '');
}

function escapeEmailHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emeraldDetails(rows: Array<[string, string]>): string {
  if (rows.length === 0) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;background:${EMERALD.panelSoft};border:1px solid ${EMERALD.line};border-radius:14px;margin:18px 0">
    ${rows
      .map(
        ([label, value]) => `<tr>
          <td style="padding:10px 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.45;color:${EMERALD.muted};border-bottom:1px solid ${EMERALD.line};width:38%;vertical-align:top">${escapeEmailHtml(
            label
          )}</td>
          <td style="padding:10px 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.45;color:${EMERALD.text};border-bottom:1px solid ${EMERALD.line};font-weight:600;word-break:break-word">${value}</td>
        </tr>`
      )
      .join('')}
  </table>`;
}

function emeraldButton(label: string, url: string, secondary = false): string {
  const bg = secondary
    ? `background:${EMERALD.panelSoft};border:1px solid ${EMERALD.line};color:${EMERALD.accent}`
    : `background:${EMERALD.accentDeep};background-image:linear-gradient(135deg,${EMERALD.accentDeep},${EMERALD.accentStrong});border:1px solid ${EMERALD.accentStrong};color:#03110b`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto">
    <tr><td align="center" style="border-radius:11px;${bg}">
      <a href="${escapeEmailHtml(url)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1;font-weight:700;text-decoration:none;border-radius:11px;color:${secondary ? EMERALD.accent : '#03110b'}">${escapeEmailHtml(
        label
      )}</a>
    </td></tr>
  </table>`;
}

export function buildEmeraldEmail(opts: {
  title: string;
  eyebrow?: string;
  preheader?: string;
  bodyHtml: string;
  details?: Array<[string, string]>;
  cta?: { label: string; url: string };
  secondaryCta?: { label: string; url: string };
  noteHtml?: string;
  footerNote?: string;
}): string {
  const invoiceUrl = appBaseUrl('invoice');
  const posUrl = appBaseUrl('pos');
  const logo = `${appBaseUrl('invoice')}/images/preyonelogomainzw-email.png`;
  const sans = "'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Arial,sans-serif";
  const eyebrow = opts.eyebrow || 'Preyone Invoice & POS';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${escapeEmailHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${EMERALD.ink};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeEmailHtml(opts.preheader)}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EMERALD.ink}">
    <tr><td align="center" style="padding:38px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;width:100%">
        <tr><td style="background:${EMERALD.panel};border:1px solid ${EMERALD.line};border-radius:18px;overflow:hidden">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="height:3px;background:linear-gradient(90deg,${EMERALD.accentDeep},${EMERALD.accent},${EMERALD.cyan});font-size:1px;line-height:1px">&nbsp;</td></tr>
          </table>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td align="center" style="padding:30px 28px 2px">
              <img src="${logo}" width="170" alt="Preyone" style="display:block;width:170px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none">
            </td></tr>
            <tr><td align="center" style="padding:16px 28px 0">
              <div style="font-family:${sans};font-size:10px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:${EMERALD.accent}">${escapeEmailHtml(
                eyebrow
              )}</div>
            </td></tr>
            <tr><td align="center" style="padding:10px 28px 0">
              <h1 style="margin:0;font-family:${sans};font-size:24px;line-height:1.3;font-weight:700;color:${EMERALD.text};letter-spacing:-0.2px">${escapeEmailHtml(
                opts.title
              )}</h1>
            </td></tr>
          </table>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="padding:18px 30px 0;font-family:${sans};font-size:15px;line-height:1.65;color:${EMERALD.muted}">
              ${opts.bodyHtml}
            </td></tr>
          </table>
          ${opts.details ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:0 30px">${emeraldDetails(
            opts.details
          )}</td></tr></table>` : ''}
          ${
            opts.cta
              ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:8px 30px 0">${emeraldButton(
                  opts.cta.label,
                  opts.cta.url
                )}${
                  opts.secondaryCta
                    ? `${emeraldButton(opts.secondaryCta.label, opts.secondaryCta.url, true)}`
                    : ''
                }</td></tr></table>`
              : ''
          }
          ${
            opts.noteHtml
              ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:10px 30px 0;font-family:${sans};font-size:12px;line-height:1.6;color:${EMERALD.dim};text-align:center">${opts.noteHtml}</td></tr></table>`
              : ''
          }
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="padding:26px 30px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid ${EMERALD.line};font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr>
          </table>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td align="center" style="padding:20px 30px 4px;font-family:${sans};font-size:12px;line-height:1.7;color:${EMERALD.dim}">
              <a href="${invoiceUrl}" style="color:${EMERALD.accent};text-decoration:none">Invoice</a>
              <span style="color:${EMERALD.line}">&nbsp;|&nbsp;</span>
              <a href="${posUrl}" style="color:${EMERALD.accent};text-decoration:none">POS</a>
              <span style="color:${EMERALD.line}">&nbsp;|&nbsp;</span>
              <a href="mailto:support@preyone.com" style="color:${EMERALD.accent};text-decoration:none">support@preyone.com</a>
            </td></tr>
            <tr><td align="center" style="padding:6px 30px 0">
              <a href="https://wa.me/263771327202" style="display:inline-block;background:${EMERALD.accentDeep};color:#ffffff;padding:10px 24px;border-radius:8px;text-decoration:none;font-family:${sans};font-size:12px;font-weight:700;letter-spacing:0.02em">Chat on WhatsApp</a>
            </td></tr>
            <tr><td align="center" style="padding:16px 30px 24px;font-family:${sans};font-size:11px;line-height:1.7;color:${EMERALD.dim}">
              ${escapeEmailHtml(opts.footerNote || 'Preyone Invoice & POS · Connecting People. Powering Business.')}<br>
              &copy; ${new Date().getFullYear()} Preyone Enterprises. All rights reserved.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Welcome mail sent at the moment a client tenant is provisioned. */
export async function sendClientProvisionedEmail(opts: {
  to: string;
  ownerName: string;
  companyName: string;
  planName: string;
  durationDays: number;
  expiresAt: Date | string;
  tempPassword: string;
  tillCode: string;
}): Promise<boolean> {
  const invoiceUrl = `${appBaseUrl('invoice')}/`;
  const posUrl = `${appBaseUrl('pos')}/`;
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const html = buildEmeraldEmail({
    title: 'Your Preyone workspace is ready',
    eyebrow: 'Client onboarding',
    preheader: `${opts.companyName} is live on ${opts.planName}.`,
    bodyHtml: `<p style="margin:0 0 12px">Hi <strong style="color:${EMERALD.text}">${escapeEmailHtml(
      opts.ownerName
    )}</strong>,</p>
      <p style="margin:0">Your company has been created in Preyone Invoice and POS. You can sign in immediately with the details below.</p>`,
    details: [
      ['Company', escapeEmailHtml(opts.companyName)],
      ['Plan', `${escapeEmailHtml(opts.planName)} · ${opts.durationDays} days`],
      ['Access until', escapeEmailHtml(expires)],
      ['Sign-in email', escapeEmailHtml(opts.to)],
      [
        'Temporary password',
        `<span style="font-family:Consolas,monospace;font-size:14px;letter-spacing:0.4px">${escapeEmailHtml(
          opts.tempPassword
        )}</span>`,
      ],
      [
        'Till code',
        `<span style="font-family:Consolas,monospace;font-size:11px;word-break:break-all">${escapeEmailHtml(
          opts.tillCode
        )}</span>`,
      ],
    ],
    cta: { label: 'Sign in to Invoice', url: invoiceUrl },
    secondaryCta: { label: 'Open POS', url: posUrl },
    noteHtml:
      'Change the temporary password after your first sign-in. On a new till, enter the till code once under <strong>Company till code</strong>.',
    footerNote: 'Preyone Invoice & POS · secure business workspace',
  });
  const text = [
    `Hi ${opts.ownerName},`,
    '',
    `${opts.companyName} is live on ${opts.planName} for ${opts.durationDays} days (until ${expires}).`,
    `Invoice: ${invoiceUrl}`,
    `POS: ${posUrl}`,
    `Sign-in email: ${opts.to}`,
    `Temporary password: ${opts.tempPassword}`,
    `Till code: ${opts.tillCode}`,
    '',
    'Change the temporary password after your first sign-in.',
    'Preyone Enterprises · support@preyone.com',
  ].join('\n');
  return sendMail(
    opts.to,
    `Welcome to Preyone — ${opts.companyName} is ready`,
    html,
    'Preyone Invoice',
    'support@preyone.com',
    undefined,
    undefined,
    text
  );
}

/** Receipt for a cash or Pesepay subscription payment. */
export async function sendSubscriptionPaymentReceiptEmail(opts: {
  to: string;
  companyName: string;
  planName: string;
  amount: number;
  currency: string;
  method: string;
  reference?: string | null;
  paidAt?: Date | string;
  expiresAt: Date | string;
}): Promise<boolean> {
  const invoiceUrl = `${appBaseUrl('invoice')}/`;
  const posUrl = `${appBaseUrl('pos')}/`;
  const paid = new Date(opts.paidAt || Date.now()).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const expires = new Date(opts.expiresAt).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const amount = `${opts.currency} ${Number(opts.amount).toFixed(2)}`;
  const html = buildEmeraldEmail({
    title: 'Subscription payment received',
    eyebrow: 'Billing receipt',
    preheader: `${amount} received for ${opts.companyName}.`,
    bodyHtml: `<p style="margin:0 0 12px">Hi <strong style="color:${EMERALD.text}">${escapeEmailHtml(
      opts.companyName
    )}</strong>,</p>
      <p style="margin:0">We have received your subscription payment. Your access is active and the new expiry is shown below.</p>`,
    details: [
      ['Plan', escapeEmailHtml(opts.planName)],
      ['Amount', escapeEmailHtml(amount)],
      ['Method', escapeEmailHtml(opts.method)],
      ['Paid', escapeEmailHtml(paid)],
      ['Access until', escapeEmailHtml(expires)],
      ...(opts.reference ? ([['Reference', escapeEmailHtml(opts.reference)]] as Array<[string, string]>) : []),
    ],
    cta: { label: 'Open Invoice', url: invoiceUrl },
    secondaryCta: { label: 'Open POS', url: posUrl },
    noteHtml: 'Keep this email as your subscription receipt.',
    footerNote: 'Preyone Invoice & POS · billing receipt',
  });
  const text = [
    `Payment received for ${opts.companyName}`,
    `Plan: ${opts.planName}`,
    `Amount: ${amount}`,
    `Method: ${opts.method}`,
    `Paid: ${paid}`,
    `Access until: ${expires}`,
    opts.reference ? `Reference: ${opts.reference}` : '',
    '',
    'Preyone Enterprises · support@preyone.com',
  ]
    .filter(Boolean)
    .join('\n');
  return sendMail(
    opts.to,
    `Payment received — ${opts.planName} for ${opts.companyName}`,
    html,
    'Preyone Invoice',
    'support@preyone.com',
    undefined,
    undefined,
    text
  );
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
      'Preyone', 'admin@preyone.com'
    );
  }
  return sendMail(
    email,
    `⏳ Your Preyone Staff Account — Pending Approval`,
    buildAdminWelcomeHtml(fullName, email, role, 'pending', verifyUrl),
    'Preyone', 'admin@preyone.com'
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
    'Preyone', 'admin@preyone.com'
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
  const adminUrl = process.env.ADMIN_BASE_URL || process.env.BASE_URL || 'https://admin.preyone.com';
  const html = `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
    ${emailHeader('New Staff Signup')}
    <div style="padding:24px 32px">
      <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(19,216,255,0.12),rgba(139,77,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(19,216,255,0.12)">
        <span style="font-size:28px">👤</span>
      </div>
      <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.6;text-align:center">A new staff member has signed up and needs your approval:</p>
      <div style="background:linear-gradient(135deg,rgba(113,255,47,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06);padding:16px;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#64748b;font-size:14px;border-bottom:1px solid rgba(255,255,255,0.04)">Name</td><td style="padding:8px 0;font-size:14px;font-weight:600;text-align:right;color:#ffffff;border-bottom:1px solid rgba(255,255,255,0.04)">${staffName}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:14px">Email</td><td style="padding:8px 0;font-size:14px;font-weight:600;text-align:right;color:#13d8ff">${staffEmail}</td></tr>
        </table>
      </div>
      <p style="margin:0 0 16px;font-size:14px;color:#94a3b8;text-align:center">Log in to the admin panel to approve or reject this account.</p>
      <p style="text-align:center;margin:0 0 8px">
        <a href="${adminUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Go to Admin Panel</a>
      </p>
      ${emailFooter()}
    </div>
  </div>`;
  for (const email of adminEmails) {
    await sendMail(email, 'New Staff Signup — Pending Approval', html, 'Preyone', 'admin@preyone.com');
  }
  return true;
}

// ── Admin rejection: notify staff their account was declined ──────────
export async function sendAdminRejectedNotification(email: string, fullName: string): Promise<boolean> {
  return sendMail(
    email,
    'Your Preyone Staff Account Application',
    `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12)">
  ${emailHeader('Application Status')}

  <!-- Hero -->
  <div style="padding:28px 32px 0;text-align:center">
    <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,rgba(255,107,107,0.12),rgba(139,77,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 30px rgba(255,107,107,0.15)">
      <span style="font-size:36px">💫</span>
    </div>
    <h1 style="margin:0 0 6px;font-size:24px;color:#ffffff;font-weight:800;letter-spacing:-0.5px">Application Update</h1>
    <p style="margin:0 0 4px;font-size:15px;color:#13d8ff;font-weight:500">Preyone Admin Console</p>
  </div>

  <!-- Intro -->
  <div style="padding:24px 32px 0">
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
    <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.7">Thank you for your interest in joining the Preyone team. After careful review, we are unable to approve your staff account application at this time.</p>
  </div>

  <!-- Next Steps -->
  <div style="margin:0 32px;padding:20px;background:linear-gradient(135deg,rgba(255,107,107,0.04),rgba(139,77,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06)">
    <p style="margin:0 0 14px;font-size:14px;color:#ff6b6b;font-weight:700">💡 What you can do</p>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">1.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">Contact Support.</strong> If you believe this was a mistake, reach out to our team for clarification.</td>
      </tr>
      <tr>
        <td style="padding:6px 0;vertical-align:top;width:28px;color:#13d8ff;font-weight:700;font-size:14px">2.</td>
        <td style="padding:6px 0;font-size:14px;color:#94a3b8;line-height:1.5"><strong style="color:#ffffff">Re-apply.</strong> You may submit a new application in the future.</td>
      </tr>
    </table>
  </div>

  <!-- Support -->
  <div style="padding:20px 32px 0">
    <div style="padding:16px;background:rgba(139,77,255,0.05);border-radius:8px;border:1px solid rgba(139,77,255,0.1)">
      <p style="margin:0 0 8px;font-size:13px;color:#8b4dff;font-weight:600">Need more information?</p>
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.5">Please contact our support desk at <a href="mailto:admin@preyone.com" style="color:#71ff2f;text-decoration:underline">admin@preyone.com</a> if you have any questions.</p>
    </div>
  </div>

  <!-- Sign-off -->
  <div style="padding:24px 32px 0;text-align:center">
    <p style="margin:0 0 4px;font-size:14px;color:#cbd5e1;line-height:1.6">We appreciate your understanding and wish you all the best.</p>
    <p style="margin:16px 0 0;font-size:14px;color:#ffffff;font-weight:600">Best regards,</p>
    <p style="margin:4px 0 0;font-size:14px;color:#71ff2f;font-weight:700">The Preyone Team</p>
    <p style="margin:4px 0 0"><a href="https://admin.preyone.com" style="font-size:13px;color:#13d8ff;text-decoration:none">admin.preyone.com</a></p>
  </div>

  ${emailFooter()}
</div>`,
    'Preyone', 'admin@preyone.com'
  );
}

// ── Password reset email ───────────────────────────────────────────────
export async function sendPasswordResetEmail(
  email: string,
  resetToken: string,
  fullName: string,
  client: 'invoice' | 'pos' | 'admin' | 'wifi' | 'starlink' = 'admin'
): Promise<boolean> {
  const portal = client === 'invoice' || client === 'pos';
  const resetUrl = portal
    ? `${appBaseUrl('invoice')}/recover-password?token=${encodeURIComponent(resetToken)}`
    : `${appBaseUrl('admin')}/?token=${resetToken}`;

  if (portal) {
    const html = buildEmeraldEmail({
      title: 'Reset your Preyone password',
      eyebrow: 'Account recovery',
      preheader: 'A password reset was requested for your Preyone workspace.',
      bodyHtml: `<p style="margin:0 0 12px">Hi <strong style="color:${EMERALD.text}">${escapeEmailHtml(
        fullName
      )}</strong>,</p>
        <p style="margin:0">We received a request to reset the password for your Preyone Invoice / POS account. The link below is valid for <strong style="color:${EMERALD.accent}">1 hour</strong>.</p>`,
      cta: { label: 'Set a new password', url: resetUrl },
      noteHtml:
        'If you did not request this, ignore this email. Your current password will keep working until the link is used.',
      footerNote: 'Preyone Invoice & POS · account recovery',
    });
    const text = [
      `Hi ${fullName},`,
      '',
      'Reset your Preyone Invoice / POS password:',
      resetUrl,
      '',
      'This link expires in 1 hour. If you did not request it, ignore this email.',
      'Preyone Enterprises · support@preyone.com',
    ].join('\n');
    return sendMail(
      email,
      'Reset your Preyone Invoice / POS password',
      html,
      'Preyone Invoice',
      'support@preyone.com',
      undefined,
      undefined,
      text
    );
  }

  return sendMail(
    email,
    'Reset Your Preyone Admin Password',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
      ${emailHeader('Password Reset')}
      <div style="padding:24px 32px;text-align:center">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.12),rgba(19,216,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(113,255,47,0.12)">
          <span style="font-size:28px">🔒</span>
        </div>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;line-height:1.6">We received a request to reset your admin password. Click the button below to set a new one. This link expires in <strong style="color:#71ff2f">1 hour</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Reset Password</a>
        <p style="margin:16px 0 0;font-size:13px;color:#64748b">If you didn't request this, you can safely ignore this email.</p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone', 'admin@preyone.com'
  );
}

// ── Portal email verification ─────────────────────────────────────────
export async function sendPortalEmailVerification(email: string, token: string, fullName: string): Promise<boolean> {
  // Must hit the MOUNTED portal route (authRouter -> /api/auth/verify-email),
  // which reads users.email_verification_token. A bare /verify-email path is
  // swallowed by the SPA fallback, so the link rendered, the token was never
  // consumed, and email_verified never flipped to true.
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail(
    email,
    'Verify Your Email — Preyone WiFi',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
      ${emailHeader('Verify Your Email')}
      <div style="padding:24px 32px;text-align:center">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(19,216,255,0.12),rgba(139,77,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(19,216,255,0.12)">
          <span style="font-size:28px">📧</span>
        </div>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;line-height:1.6">Please confirm your email address by clicking the button below. This link expires in <strong style="color:#13d8ff">24 hours</strong>.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Verify Email</a>
        <p style="margin:16px 0 0;font-size:13px;color:#64748b">If you didn't create an account, you can safely ignore this email.</p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}

// ── Portal forgot password ───────────────────────────────────────────
export async function sendPortalForgotPassword(email: string, token: string, fullName: string): Promise<boolean> {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const resetUrl = `${baseUrl}/reset-password.html?token=${token}`;
  return sendMail(
    email,
    'Reset Your Password — Preyone WiFi',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
      ${emailHeader('Reset Your Password')}
      <div style="padding:24px 32px;text-align:center">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.12),rgba(19,216,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(113,255,47,0.12)">
          <span style="font-size:28px">🔑</span>
        </div>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
        <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;line-height:1.6">We received a request to reset your Preyone WiFi account password. Click the button below to set a new one. This link expires in <strong style="color:#71ff2f">1 hour</strong>.</p>
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Reset Password</a>
        <p style="margin:16px 0 0;font-size:13px;color:#64748b">If you didn't request this, you can safely ignore this email.</p>
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
  // Same mounted-route requirement as sendPortalEmailVerification above.
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
  const loginUrl = `${baseUrl}/login`;
  return sendMail(
    email,
    'Your Preyone WiFi Account Has Been Created — Verify Your Email',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
      ${emailHeader('Account Created')}
      <div style="padding:24px 32px">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.12),rgba(19,216,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(113,255,47,0.12)">
          <span style="font-size:28px">🎉</span>
        </div>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Welcome to <strong style="color:#71ff2f">Preyone UltraNet WiFi</strong>! Your account has been created successfully.</p>
        <p style="margin:0 0 16px;font-size:14px;color:#64748b">Your account email: <strong style="color:#13d8ff">${email}</strong></p>

        <div style="background:linear-gradient(135deg,rgba(113,255,47,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06);padding:16px;margin-bottom:16px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#71ff2f">Next Steps:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;color:#94a3b8;line-height:1.8">
            <li>Verify your email using the button below</li>
            <li>Sign in to manage your account, view data usage, and top up</li>
            <li>Connect to the <strong style="color:#ffffff">Preyone UltraNet</strong> WiFi network and enjoy high-speed internet</li>
          </ol>
        </div>

        <p style="text-align:center;margin:16px 0">
          <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#71ff2f,#13d8ff);color:#0a0a0a;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;box-shadow:0 4px 20px rgba(113,255,47,0.3)">Verify Email Address</a>
        </p>
        <p style="text-align:center;margin:0 0 16px">
          <a href="${loginUrl}" style="display:inline-block;background:rgba(19,216,255,0.1);color:#13d8ff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;border:1px solid rgba(19,216,255,0.3)">Sign In to Manage Account</a>
        </p>

        <div style="background:linear-gradient(135deg,rgba(139,77,255,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06);padding:16px;margin-bottom:16px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#8b4dff">Quick Connect:</p>
          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6">
            To connect immediately, open your WiFi settings, select <strong style="color:#ffffff">Preyone UltraNet</strong>, and follow the on-screen instructions. No voucher needed for instant access.
          </p>
        </div>

        <p style="font-size:12px;color:#64748b;text-align:center;margin:0">
          Need a voucher or top-up? Visit our <a href="${baseUrl}" style="color:#71ff2f">WiFi Portal</a> or any Preyone agent near you.
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
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return sendMail(
    email,
    'Your Preyone WiFi Session is Ready',
    `<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:32px auto;background:#0a0a0a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.12),0 0 40px rgba(113,255,47,0.08)">
      ${emailHeader('Welcome to Preyone WiFi!')}
      <div style="padding:24px 32px">
        <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,rgba(113,255,47,0.12),rgba(19,216,255,0.12));display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 0 20px rgba(113,255,47,0.12)">
          <span style="font-size:28px">✅</span>
        </div>
        <p style="margin:0 0 12px;font-size:15px;color:#cbd5e1;line-height:1.6">Hi <strong style="color:#ffffff">${fullName}</strong>,</p>
        <p style="margin:0 0 16px;font-size:15px;color:#cbd5e1;line-height:1.6">Your WiFi session has been activated using voucher <strong style="color:#71ff2f">${voucherCode}</strong>.</p>

        <div style="background:linear-gradient(135deg,rgba(113,255,47,0.04),rgba(19,216,255,0.04));border-radius:12px;border:1px solid rgba(255,255,255,0.06);padding:16px;margin-bottom:16px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#71ff2f">How to Connect:</p>
          <ol style="margin:0;padding-left:20px;font-size:13px;color:#94a3b8;line-height:1.8">
            <li>Open your device WiFi settings</li>
            <li>Select the network <strong style="color:#ffffff">Preyone UltraNet</strong></li>
            <li>You will be redirected to the portal &mdash; you're already online!</li>
          </ol>
        </div>

        <div style="background:rgba(113,255,47,0.08);border:1px solid rgba(113,255,47,0.2);border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:1px;font-weight:600">Your Voucher Code</p>
          <p style="margin:0;font-size:22px;font-weight:800;letter-spacing:2px;color:#71ff2f;text-shadow:0 0 15px rgba(113,255,47,0.3);font-family:'Courier New',monospace">${voucherCode}</p>
        </div>

        <p style="font-size:12px;color:#64748b;text-align:center;margin:0">
          <a href="${baseUrl}" style="color:#71ff2f">Visit WiFi Portal</a> to manage your account, check data usage, or purchase a new voucher.
        </p>
        ${emailFooter()}
      </div>
    </div>`,
    'Preyone UltraNet WiFi'
  );
}

// Starlink portal: any branded template (customer or admin recipient)
export async function sendStarlinkEmail(to: string, tpl: { subject: string; html: string; text: string }): Promise<boolean> {
  return sendMail(to, tpl.subject, tpl.html, 'Preyone Starlink', undefined, undefined, undefined, tpl.text);
}

// Starlink portal: welcome + email verification (branded template in starlinkEmailTemplates.ts)
export async function sendStarlinkVerificationEmail(email: string, fullName: string, verifyUrl: string): Promise<boolean> {
  const tpl = buildVerificationEmail({ fullName, verifyUrl, email });
  return sendMail(email, tpl.subject, tpl.html, 'Preyone Starlink', undefined, undefined, undefined, tpl.text);
}

// Starlink portal: customer password reset link (additive � admin/WiFi flows untouched)
export async function sendStarlinkPasswordReset(email: string, resetToken: string, fullName: string): Promise<boolean> {
  const resetUrl = `${starlinkBaseUrl()}/starlink/portal?mode=reset&token=${resetToken}`;
  const tpl = buildPasswordResetEmail({ fullName, resetUrl, email });
  return sendMail(email, tpl.subject, tpl.html, 'Preyone Starlink', undefined, undefined, undefined, tpl.text);
}

// ── Subscription dunning (3-tier SaaS engine) ────────────────────────────
// Sent by src/jobs/subscriptionCron.ts: a 3-day warning, then a 1-day urgent
// notice. Company names are admin-entered, so they are escaped before they go
// into the HTML.
function escapeSubscriptionText(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatExpiryDate(value: Date | string): string {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
}

const SUBSCRIPTION_PLAN_SUMMARY =
  'PreTill $10 · POS only · 1 device<br>PreBiz $15 · POS + Invoice · 3 devices<br>PrePro $20 · POS + Invoice · 6 devices<br>PreUnlimited $30 · POS + Invoice · unlimited devices';

// 3-day warning: the subscription is still valid, everything keeps running.
export async function sendSubscriptionExpiryWarningEmail(
  to: string,
  companyName: string,
  expiresAt: Date | string,
  daysLeft: number
): Promise<boolean> {
  const safeName = escapeSubscriptionText(companyName || 'there');
  const formatted = formatExpiryDate(expiresAt);
  const dayLabel = `${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  const html = buildEmeraldEmail({
    title: 'Your subscription expires soon',
    eyebrow: 'Billing reminder',
    preheader: `${companyName} expires in ${dayLabel}.`,
    bodyHtml: `<p style="margin:0 0 12px">Hi <strong style="color:${EMERALD.text}">${safeName}</strong>,</p>
      <p style="margin:0 0 12px">Your Preyone subscription expires on <strong style="color:${EMERALD.accent}">${escapeEmailHtml(
        formatted
      )}</strong> — that is ${dayLabel} from now.</p>
      <p style="margin:0">Renew before then to keep POS, invoicing and device registrations running without interruption. Once the subscription lapses, new sales and new invoices are blocked until you renew.</p>`,
    details: [
      ['Expires', escapeEmailHtml(formatted)],
      ['Days left', escapeEmailHtml(dayLabel)],
      ['Plans', SUBSCRIPTION_PLAN_SUMMARY],
    ],
    cta: { label: 'Renew in Invoice', url: `${appBaseUrl('invoice')}/` },
    secondaryCta: { label: 'Open POS billing', url: `${appBaseUrl('pos')}/` },
    footerNote: 'Preyone Invoice & POS · billing reminder',
  });
  return sendMail(
    to,
    `Your Preyone subscription expires in ${dayLabel}`,
    html,
    'Preyone Invoice',
    'support@preyone.com'
  );
}

// 1-day urgent notice: expires tomorrow, suspension follows automatically.
export async function sendSubscriptionExpiryUrgentEmail(
  to: string,
  companyName: string,
  expiresAt: Date | string
): Promise<boolean> {
  const safeName = escapeSubscriptionText(companyName || 'there');
  const formatted = formatExpiryDate(expiresAt);
  const html = buildEmeraldEmail({
    title: 'Your subscription expires tomorrow',
    eyebrow: 'Urgent billing reminder',
    preheader: `${companyName} expires tomorrow.`,
    bodyHtml: `<p style="margin:0 0 12px">Hi <strong style="color:${EMERALD.text}">${safeName}</strong>,</p>
      <p style="margin:0 0 12px"><strong style="color:#fca5a5">Your Preyone subscription expires tomorrow</strong>, on <strong style="color:${EMERALD.accent}">${escapeEmailHtml(
        formatted
      )}</strong>.</p>
      <p style="margin:0">Renew today. When the subscription lapses, new sales and new invoices stop until the plan is renewed.</p>`,
    details: [
      ['Expires', escapeEmailHtml(formatted)],
      ['Plans', SUBSCRIPTION_PLAN_SUMMARY],
    ],
    cta: { label: 'Renew now', url: `${appBaseUrl('invoice')}/` },
    secondaryCta: { label: 'Open POS billing', url: `${appBaseUrl('pos')}/` },
    footerNote: 'Preyone Invoice & POS · urgent billing reminder',
  });
  return sendMail(
    to,
    'URGENT: Your Preyone subscription expires tomorrow',
    html,
    'Preyone Invoice',
    'support@preyone.com'
  );
}

// ── Admin 2FA login code ─────────────────────────────────────────────

/**
 * Which Preyone app a sign-in code belongs to. The subject, heading and body
 * are branded per app so a user who signs in at invoice.preyone.com gets an
 * "Invoice" code, not a generic one they might mistake for another product.
 */
export type MailClient = 'invoice' | 'pos' | 'admin' | 'wifi' | 'starlink';

const MAIL_CLIENTS: Record<MailClient, { brand: string; domain: string }> = {
  invoice: { brand: 'Preyone Invoice', domain: 'invoice.preyone.com' },
  pos: { brand: 'Preyone POS', domain: 'pos.preyone.com' },
  admin: { brand: 'Preyone Admin', domain: 'admin.preyone.com' },
  wifi: { brand: 'Preyone WiFi', domain: 'wifi.preyone.com' },
  starlink: { brand: 'Preyone Starlink', domain: 'starlink.preyone.com' },
};

/** Narrow an untrusted value (request body / JWT claim) to a known app. */
export function resolveMailClient(value: unknown): MailClient {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MAIL_CLIENTS, value)
    ? (value as MailClient)
    : 'admin';
}

export function buildEmeraldOtpEmail(opts: {
  app: { brand: string; domain: string };
  code: string;
  fullName: string;
  copyUrl: string;
}): string {
  const mono = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
  return buildEmeraldEmail({
    title: `Your ${opts.app.brand} sign-in code`,
    eyebrow: opts.app.brand,
    preheader: `Your one-time code for ${opts.app.domain}.`,
    bodyHtml: `<p style="margin:0 0 10px">Hi <strong style="color:${EMERALD.text}">${escapeEmailHtml(
      opts.fullName
    )}</strong>,</p>
      <p style="margin:0">Use the code below to finish signing in to ${escapeEmailHtml(
        opts.app.brand
      )} (<span style="color:${EMERALD.accent}">${escapeEmailHtml(opts.app.domain)}</span>).</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 8px;background:${EMERALD.panelSoft};border:1px solid ${EMERALD.line};border-radius:14px">
        <tr><td align="center" style="padding:24px 14px">
          <div style="font-family:${mono};font-size:38px;line-height:1;font-weight:700;letter-spacing:12px;padding-left:12px;color:${EMERALD.text};user-select:all;-webkit-user-select:all;-moz-user-select:all;mso-user-select:all">${escapeEmailHtml(
            opts.code
          )}</div>
        </td></tr>
      </table>
      <p style="margin:0;text-align:center;font-size:12px;color:${EMERALD.dim}">Expires in 15 minutes · single use</p>`,
    cta: { label: 'Copy code', url: opts.copyUrl },
    noteHtml:
      'Didn’t request this? Ignore the email and consider changing your password.',
    footerNote: 'Preyone Invoice & POS · secure sign-in',
  });
}

export async function sendAdminLoginCode(
  email: string,
  fullName: string,
  code: string,
  client: MailClient = 'admin'
): Promise<boolean> {
  const app = MAIL_CLIENTS[resolveMailClient(client)];
  // Self-contained template: the shared emailHeader()/emailFooter() helpers
  // are styled for the older green skin and are reused by a dozen other
  // transactional emails. Restyling them here would silently change all of
  // them, so this OTP mail carries its own markup in the preyone.com palette
  // (ink #050505, panel #0a0d17, brand #6a0dad, magenta #ff00ff, frost
  // #f8fbff). PNG only — Gmail and Outlook do not render WebP.
  const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const logo = `${baseUrl}/images/preyonenoneglow-logo-zoom-800.png`;
  const footerMark = `${baseUrl}/images/preyonelogomainzw-email.png`;
  const sans = "'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Arial,sans-serif";
  const mono = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

  // Gmail and Outlook group transactional mails that share a subject into one
  // conversation and hide the repeated body behind a "..." (three dots) that
  // has to be tapped to expand. A timestamped subject plus a per-message
  // X-Entity-Ref-ID keeps every OTP a standalone message, so the code is
  // visible immediately without expanding anything.
  const stamp = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Harare',
  }).format(new Date());
  const threadRef = randomUUID();

  // The code travels in the URL fragment, which browsers never send to the
  // server: it cannot leak into access logs, Referer headers or link scanners.
  const copyUrl = `${baseUrl}/copy-code#${encodeURIComponent(code)}`;

  // Plain-text alternative. HTML-only mail is a well-known spam signal, and
  // some clients/previewers only show the text part.
  const text = [
    `Hi ${fullName},`,
    '',
    `Your ${app.brand} sign-in code is: ${code}`,
    '',
    `It expires in 15 minutes and can only be used once. This code is for ${app.domain}.`,
    'If you did not try to sign in, you can ignore this email and consider changing your password.',
    '',
    'Preyone Enterprises',
    'support@preyone.com',
    '+263 771 327 202',
  ].join('\n');

  if (client === 'invoice' || client === 'pos') {
    return sendMail(
      email,
      `Your ${app.brand} sign-in code \u00b7 ${stamp}`,
      buildEmeraldOtpEmail({ app, code, fullName, copyUrl }),
      'Preyone Invoice',
      'support@preyone.com',
      undefined,
      { 'X-Entity-Ref-ID': threadRef },
      text
    );
  }

  return sendMail(
    email,
    `Your ${app.brand} sign-in code \u00b7 ${stamp}`,
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>Your ${app.brand} sign-in code</title>
</head>
<body style="margin:0;padding:0;background:#050505;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505">
    <tr>
      <td align="center" style="padding:40px 16px">
        <!--[if mso]><table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td><![endif]-->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;width:100%">
          <tr>
            <td style="background:#0a0d17;border:1px solid #1c2438;border-radius:16px;overflow:hidden">

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="height:3px;background:linear-gradient(90deg,#6a0dad,#ff00ff);font-size:1px;line-height:1px">&nbsp;</td></tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:34px 32px 4px">
                    <img src="${logo}" width="190" alt="${app.brand}" style="display:block;width:190px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none">
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:22px 32px 0">
                    <h1 style="margin:0;font-family:${sans};font-size:24px;line-height:1.3;font-weight:700;color:#f8fbff;letter-spacing:-0.2px">Your ${app.brand} sign-in code</h1>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:22px 32px 0;font-family:${sans};font-size:15px;line-height:1.6;color:#94a3b8">
                    <p style="margin:0 0 10px">Hi <strong style="color:#f8fbff;font-weight:600">${fullName}</strong>,</p>
                    <p style="margin:0">Use the code below to finish signing in to ${app.brand} (<span style="color:#7be0ff">${app.domain}</span>).</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:24px 32px 0">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#111827;border:1px solid #263049;border-radius:12px">
                      <tr>
                        <td align="center" style="padding:24px 16px 22px">
                          <div style="font-family:${mono};font-size:38px;line-height:1;font-weight:700;letter-spacing:12px;padding-left:12px;color:#f8fbff;user-select:all;-webkit-user-select:all;-moz-user-select:all;mso-user-select:all">${code}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:20px 32px 0">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                      <tr>
                        <td align="center" style="border-radius:10px;background:#6a0dad;background-image:linear-gradient(135deg,#6a0dad,#ff00ff)">
                          <a href="${copyUrl}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:${sans};font-size:15px;line-height:1;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">Copy code</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:12px 32px 0;font-family:${sans};font-size:12px;line-height:1.5;color:#64748b">
                    Opens a page that copies the code to your clipboard. You can also press and hold the code above.
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:18px 32px 0;font-family:${sans};font-size:13px;line-height:1.6;color:#64748b" align="center">
                    This code expires in <strong style="color:#7be0ff;font-weight:600">15 minutes</strong>. It can only be used once.
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 32px 0;font-family:${sans};font-size:13px;line-height:1.6;color:#64748b" align="center">
                    Didn&rsquo;t request this? You can safely ignore this email &mdash; and we recommend changing your password.
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:30px 32px 0">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr><td style="border-top:1px solid #1c2438;font-size:1px;line-height:1px">&nbsp;</td></tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:26px 32px 8px">
                    <img src="${footerMark}" width="150" alt="Preyone Enterprises" style="display:block;width:150px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none">
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:14px 32px 0">
                    <a href="https://wa.me/263771327202" style="display:inline-block;background:#6a0dad;color:#ffffff;padding:11px 26px;border-radius:8px;text-decoration:none;font-family:${sans};font-size:13px;font-weight:700;letter-spacing:0.02em;border:1px solid #8b18c9">Chat on WhatsApp</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:18px 32px 0;font-family:${sans};font-size:12px;line-height:1.7;color:#64748b">
                    <a href="mailto:support@preyone.com" style="color:#7be0ff;text-decoration:none">support@preyone.com</a>
                    <span style="color:#263049">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
                    <a href="tel:+263771327202" style="color:#7be0ff;text-decoration:none">+263 771 327 202</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:16px 32px 30px;font-family:${sans};font-size:11px;line-height:1.6;color:#475569">
                    &copy; ${new Date().getFullYear()} Preyone Enterprises. All rights reserved.
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`,
    undefined,
    undefined,
    undefined,
    { 'X-Entity-Ref-ID': threadRef, 'X-Auto-Response-Suppress': 'All', 'Reply-To': 'support@preyone.com' },
    text
  );
}

export async function sendAdminPasswordChangedEmail(email: string, fullName: string): Promise<boolean> {
  const safeName = escapeEmailHtml(fullName);
  const html = buildEmeraldEmail({
    title: 'Your password was changed',
    eyebrow: 'Security notice',
    preheader: 'Your Preyone password was changed and all sessions were signed out.',
    bodyHtml: `<p style="margin:0 0 10px">Hi <strong style="color:${EMERALD.text}">${safeName}</strong>,</p>
      <p style="margin:0">Your Preyone password was successfully changed. All existing sessions have been signed out.</p>`,
    noteHtml:
      'If you made this change, no further action is needed. If you did not, contact <a href="mailto:support@preyone.com" style="color:#fca5a5">support@preyone.com</a> immediately.',
    footerNote: 'Preyone Invoice & POS · security notice',
  });
  return sendMail(
    email,
    'Your Preyone password was changed',
    html,
    'Preyone Invoice',
    'support@preyone.com'
  );
}


// -- Cash handover notifications -------------------------------------------------
export interface CashHandoverEmailData {
  handoverId: string;
  staffName: string;
  amount: number;
  saleCount: number;
  submittedAt?: string | Date | null;
  decidedBy?: string | null;
  remainingCount?: number;
  remainingAmount?: number;
}

function escapeHandoverText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function handoverEmailHtml(
  data: CashHandoverEmailData,
  mode: 'submitted' | 'approved' | 'rejected'
): string {
  const approved = mode === 'approved';
  const rejected = mode === 'rejected';
  const adminUrl = (process.env.ADMIN_BASE_URL || 'https://admin.preyone.com').replace(/\/$/, '');
  const baseUrl = (process.env.BASE_URL || 'https://wifi.preyone.com').replace(/\/$/, '');
  const logoUrl = `${baseUrl}/images/preyonenoneglow-logo-zoom-800.png`;
  const statusColor = approved ? '#22e6a8' : rejected ? '#ff4d6d' : '#00ccff';
  const statusBg = approved ? 'rgba(34,230,168,0.12)' : rejected ? 'rgba(255,77,109,0.12)' : 'rgba(0,204,255,0.12)';
  const title = approved ? 'Cash handover approved' : rejected ? 'Cash handover rejected' : 'Cash handover submitted';
  const lead = approved
    ? 'The handover has been approved and the cash is now confirmed.'
    : rejected
      ? 'The handover was rejected. The sales have been returned to pending and must be resubmitted.'
      : 'A staff cash handover is waiting for manager or CEO approval.';
  const stamp = data.submittedAt ? new Date(data.submittedAt).toLocaleString() : new Date().toLocaleString();
  const remaining = data.remainingCount != null
    ? `<tr>
         <td style="padding:9px 0;color:#94a3b8;font-size:13px">Still pending</td>
         <td style="padding:9px 0;color:#f8fbff;font-size:13px;font-weight:600;text-align:right">${data.remainingCount} sale(s) &middot; $${Number(data.remainingAmount || 0).toFixed(2)}</td>
       </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#05070d;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#05070d">
    <tr>
      <td align="center" style="padding:36px 16px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;width:100%">
          <tr>
            <td style="background:#0a0f1d;border:1px solid #1c2740;border-radius:16px;overflow:hidden">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="height:3px;background:linear-gradient(90deg,#00ccff,#ff2d95);font-size:1px;line-height:1px">&nbsp;</td></tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:30px 32px 0;font-family:'Segoe UI',Arial,sans-serif">
                    <img src="${logoUrl}" alt="Preyone UltraNet" width="180" style="display:block;width:180px;max-width:100%;height:auto;margin:0 0 18px" />
                    <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#00ccff;font-weight:700">Preyone UltraNet</div>
                    <h1 style="margin:8px 0 0;font-size:23px;line-height:1.3;color:#f8fbff">${title}</h1>
                    <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#94a3b8">${lead}</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:20px 32px 0">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#111827;border:1px solid #263049;border-radius:12px">
                      <tr>
                        <td align="center" style="padding:22px 16px 20px;font-family:'Segoe UI',Arial,sans-serif">
                          <div style="font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#64748b">Handover amount</div>
                          <div style="margin-top:6px;font-size:34px;line-height:1;font-weight:700;color:#f8fbff">$${Number(data.amount || 0).toFixed(2)}</div>
                          <div style="margin-top:12px;display:inline-block;padding:5px 12px;border-radius:999px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${mode}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding:16px 32px 0;font-family:'Segoe UI',Arial,sans-serif">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding:9px 0;color:#94a3b8;font-size:13px">Staff</td>
                        <td style="padding:9px 0;color:#f8fbff;font-size:13px;font-weight:600;text-align:right">${escapeHandoverText(data.staffName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:9px 0;color:#94a3b8;font-size:13px">Sales</td>
                        <td style="padding:9px 0;color:#f8fbff;font-size:13px;font-weight:600;text-align:right">${data.saleCount} sale(s)</td>
                      </tr>
                      <tr>
                        <td style="padding:9px 0;color:#94a3b8;font-size:13px">Submitted</td>
                        <td style="padding:9px 0;color:#f8fbff;font-size:13px;font-weight:600;text-align:right">${escapeHandoverText(stamp)}</td>
                      </tr>
                      ${data.decidedBy ? `<tr>
                        <td style="padding:9px 0;color:#94a3b8;font-size:13px">${approved ? 'Approved' : 'Rejected'} by</td>
                        <td style="padding:9px 0;color:#f8fbff;font-size:13px;font-weight:600;text-align:right">${escapeHandoverText(data.decidedBy)}</td>
                      </tr>` : ''}
                      ${remaining}
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding:24px 32px 0">
                    <a href="${adminUrl}/#/ultranet/reports" style="display:inline-block;background:#00ccff;color:#031018;padding:11px 24px;border-radius:8px;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;font-weight:700">Open Payment Logs</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:26px 32px 30px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;line-height:1.7;color:#475569">
                    Handover reference: ${escapeHandoverText(data.handoverId)}<br>
                    &copy; ${new Date().getFullYear()} Preyone Enterprises. All rights reserved.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendCashHandoverSubmittedEmail(
  recipients: string[],
  data: CashHandoverEmailData
): Promise<boolean> {
  const to = [...new Set(recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (to.length === 0) return false;
  const staff = String(data.staffName || '').trim() || 'Staff';
  const subject = `Cash handover awaiting approval - ${staff} - $${Number(data.amount || 0).toFixed(2)}`;
  const html = handoverEmailHtml(data, 'submitted');
  const results = await Promise.all(
    to.map((email) => sendMail(email, subject, html, 'Preyone', 'admin@preyone.com'))
  );
  return results.some(Boolean);
}

export async function sendCashHandoverDecisionEmail(
  recipients: string[],
  decision: 'approved' | 'rejected',
  data: CashHandoverEmailData
): Promise<boolean> {
  const to = [...new Set(recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (to.length === 0) return false;
  const staff = String(data.staffName || '').trim() || 'Staff';
  const subject = `Cash handover ${decision} - ${staff} - $${Number(data.amount || 0).toFixed(2)}`;
  const html = handoverEmailHtml(data, decision);
  const results = await Promise.all(
    to.map((email) => sendMail(email, subject, html, 'Preyone', 'admin@preyone.com'))
  );
  return results.some(Boolean);
}

export async function sendTransactionalEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  fromName?: string;
  fromEmail?: string;
  attachments?: Array<{ filename: string; content: Buffer; cid?: string }>;
}): Promise<boolean> {
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;
  const results = await Promise.all(recipients.map((recipient) => sendMail(
    recipient,
    opts.subject,
    opts.html,
    opts.fromName ?? 'Preyone UltraNet',
    opts.fromEmail ?? 'support@preyone.com',
    opts.attachments
  )));
  return results.every(Boolean);
}

export function buildEmailShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;width:100%;background:#050505;font-family:'Montserrat','Segoe UI',Arial,sans-serif;color:#f8fbff">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#050505">
    <tr>
      <td align="center" style="padding:0;background:#050505">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:0 auto;border-collapse:collapse">
          <tr><td style="padding:0">${emailHeader(title)}</td></tr>
          <tr>
            <td style="padding:8px 16px 32px;background:#050505">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;margin:0 auto;border-collapse:separate;background:#0a0d17;border:1px solid #1c2438;border-radius:16px">
                <tr>
                  <td style="padding:28px 22px;background:#0a0d17;border-radius:16px;box-shadow:0 0 28px rgba(106,13,173,0.22),0 18px 48px rgba(0,0,0,0.45)">
                    ${bodyHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="padding:0">${emailFooter()}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
