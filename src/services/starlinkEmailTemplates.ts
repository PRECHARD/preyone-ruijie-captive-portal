/**
 * Starlink customer portal — transactional email templates.
 *
 * One shared shell, so every Starlink email looks the same: table layout for
 * Outlook and Gmail, inline styles only, a hidden preheader, a bulletproof CTA,
 * a plain-text alternative, and the portal palette (#00e5ff cyan / #a855f7
 * purple on near-black). The logo is the transparent white Preyone mark that the
 * admin OTP email uses, so it sits on the card with no black box.
 */

const C = {
  bg: '#05060b',
  card: '#0d0f18',
  panel: '#080a12',
  line: '#1e2435',
  text: '#e8edf6',
  mut: '#97a1b5',
  dim: '#64748b',
  cyan: '#00e5ff',
  purple: '#a855f7',
};

// Receipt-specific palette requested for payment confirmations. Existing
// verification/reset emails keep the original cyan/purple shell above.
const RECEIPT: typeof C = {
  ...C,
  bg: '#0D0F18',
  card: '#0a0f1d',
  panel: '#0a0f1d',
  cyan: '#00F0FF',
};

const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Always the Starlink host. Never fall back to BASE_URL, which points at the WiFi portal. */
export function starlinkBaseUrl(): string {
  return (process.env.STARLINK_BASE_URL || 'https://starlink.preyone.com').replace(/\/$/, '');
}

export function firstName(fullName: string): string {
  return esc(fullName.trim().split(/\s+/)[0] || 'there');
}

export function button(href: string, label: string, palette: typeof C = C): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td align="center" bgcolor="${palette.cyan}" style="border-radius:10px;background:linear-gradient(135deg,${palette.cyan},${palette.purple})">
                    <a href="${href}" target="_blank" style="display:inline-block;padding:15px 40px;font:700 15px ${FONT};color:#050505;text-decoration:none;border-radius:10px">${label}</a>
                  </td>
                </tr>
              </table>`;
}

export function layout(opts: {
  preheader: string;
  eyebrow: string;
  heading: string;
  body: string;
  recipient: string;
  base: string;
  palette?: typeof C;
}): string {
  const p = opts.palette ?? C;
  const logo = `${opts.base}/images/preyonenoneglow-logo-zoom-800.png`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Preyone Starlink</title>
</head>
<body style="margin:0;padding:0;background:${p.bg};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${p.bg};padding:32px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${p.card};border:1px solid ${p.line};border-radius:18px;overflow:hidden">

          <tr>
            <td style="padding:34px 24px 8px;text-align:center">
              <img src="${logo}" alt="Preyone" width="200" height="100" style="display:block;margin:0 auto;width:200px;height:auto;border:0" />
              <div style="margin-top:12px;font:600 10.5px ${FONT};letter-spacing:3px;text-transform:uppercase;color:${p.cyan}">${esc(opts.eyebrow)}</div>
            </td>
          </tr>
          <tr>
            <td style="height:3px;background:linear-gradient(90deg,${p.cyan},${p.purple});font-size:0;line-height:0">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding:32px 32px 8px">
              <div style="font:700 25px/1.25 ${FONT};color:${p.text};letter-spacing:0.2px">${opts.heading}</div>
            </td>
          </tr>

          ${opts.body}

          <tr>
            <td style="padding:8px 32px 30px">
              <div style="border-top:1px solid ${p.line};padding-top:18px;font:13px/1.6 ${FONT};color:${p.dim}">
                Didn't ask for this? You can ignore this email. Nothing changes unless the link is used. If you're worried
                about your account, reply to this email or contact
                <a href="mailto:support@preyone.com" style="color:${p.cyan};text-decoration:none">support@preyone.com</a>.
              </div>
            </td>
          </tr>

          <tr>
            <td style="background:${p.panel};border-top:1px solid ${p.line};padding:24px 32px;text-align:center">
              <div style="font:600 13px ${FONT};color:${p.text}">Preyone Starlink Customer Portal</div>
              <div style="margin-top:6px;font:12.5px/1.6 ${FONT};color:${p.mut}">
                <a href="mailto:support@preyone.com" style="color:${p.cyan};text-decoration:none">support@preyone.com</a>
                &nbsp;·&nbsp;
                <a href="tel:+263771327202" style="color:${p.cyan};text-decoration:none">+263 771 327 202</a>
              </div>
              <div style="margin-top:10px;font:12px/1.6 ${FONT};color:${p.dim}">
                <a href="${opts.base}/starlink-privacy.html" style="color:${p.mut};text-decoration:none">Privacy policy</a>
                &nbsp;·&nbsp;
                <a href="https://preyone.com" style="color:${p.mut};text-decoration:none">preyone.com</a>
              </div>
              <div style="margin-top:14px;font:11px/1.6 ${FONT};color:${p.dim}">
                © ${new Date().getFullYear()} Preyone Enterprises (Pvt) Ltd · Harare, Zimbabwe<br />
                You received this email because of activity on the account for ${esc(opts.recipient)}.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildVerificationEmail(input: { fullName: string; verifyUrl: string; email: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const base = starlinkBaseUrl();
  const url = esc(input.verifyUrl);
  const subject = 'Verify your email to activate your Preyone Starlink account';
  const preheader = 'One click to confirm your email. This link expires in 24 hours.';

  const step = (n: string, title: string, detail: string) => `
                <tr>
                  <td style="padding:0 0 14px 0;vertical-align:top;width:44px">
                    <div style="width:32px;height:32px;line-height:32px;text-align:center;border-radius:9px;border:1px solid rgba(0,229,255,0.35);background:rgba(0,229,255,0.08);color:${C.cyan};font:700 13px ${FONT}">${n}</div>
                  </td>
                  <td style="padding:2px 0 14px 0;vertical-align:top;font:14px/1.6 ${FONT};color:${C.mut}">
                    <span style="color:${C.text};font-weight:600">${title}</span><br />${detail}
                  </td>
                </tr>`;

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${C.mut}">
                Hi ${firstName(input.fullName)}, welcome to Preyone Starlink. Confirm this address to secure your
                account and receive billing, renewal and service alerts.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:26px 32px 8px">
              ${button(url, 'Verify email address')}
              <p style="margin:16px 0 0;font:13px/1.6 ${FONT};color:${C.dim}">This link expires in <strong style="color:${C.text}">24 hours</strong>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 22px">
              <div style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:14px 16px">
                <div style="font:600 11px ${FONT};letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};margin-bottom:6px">Button not working?</div>
                <div style="font:12.5px/1.6 ${FONT};color:${C.mut};word-break:break-all">
                  <a href="${url}" style="color:${C.cyan};text-decoration:underline">${url}</a>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:6px 32px 8px">
              <div style="font:700 12px ${FONT};letter-spacing:2px;text-transform:uppercase;color:${C.cyan};margin-bottom:14px">What happens next</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${step('01', 'Verify your email', 'Confirm this address with the button above.')}
                ${step('02', 'Choose your plan', 'Pick the package that fits your home or business.')}
                ${step('03', 'Register your kit', 'Add your Starlink kit serial number and start tracking usage.')}
              </table>
            </td>
          </tr>`;

  const html = layout({
    preheader,
    eyebrow: 'Customer Portal',
    heading: `Confirm your email, ${firstName(input.fullName)}`,
    body,
    recipient: input.email,
    base,
  });

  const text = [
    `Confirm your email, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    'Welcome to Preyone Starlink. Confirm this address to secure your account and receive billing, renewal and service alerts.',
    '',
    `Verify your email: ${input.verifyUrl}`,
    'This link expires in 24 hours.',
    '',
    'What happens next:',
    '1. Verify your email',
    '2. Choose your plan',
    '3. Register your kit',
    '',
    "Didn't create this account? Ignore this email, or contact support@preyone.com.",
    '',
    'Preyone Starlink Customer Portal',
    'support@preyone.com · +263 771 327 202',
    `© ${new Date().getFullYear()} Preyone Enterprises (Pvt) Ltd · Harare, Zimbabwe`,
  ].join('\n');

  return { subject, html, text };
}

export function buildPasswordResetEmail(input: { fullName: string; resetUrl: string; email: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const base = starlinkBaseUrl();
  const url = esc(input.resetUrl);
  const subject = 'Reset your Preyone Starlink password';
  const preheader = 'Reset link valid for 1 hour.';

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${C.mut}">
                Hi ${firstName(input.fullName)}, we received a request to reset the password for your Preyone Starlink
                account. Choose a new password with the button below.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:26px 32px 8px">
              ${button(url, 'Reset password')}
              <p style="margin:16px 0 0;font:13px/1.6 ${FONT};color:${C.dim}">This link expires in <strong style="color:${C.text}">1 hour</strong>.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 22px">
              <div style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:14px 16px">
                <div style="font:600 11px ${FONT};letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};margin-bottom:6px">Button not working?</div>
                <div style="font:12.5px/1.6 ${FONT};color:${C.mut};word-break:break-all">
                  <a href="${url}" style="color:${C.cyan};text-decoration:underline">${url}</a>
                </div>
              </div>
            </td>
          </tr>`;

  const html = layout({
    preheader,
    eyebrow: 'Account security',
    heading: 'Reset your password',
    body,
    recipient: input.email,
    base,
  });

  const text = [
    `Reset your password, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    'We received a request to reset the password for your Preyone Starlink account.',
    '',
    `Reset password: ${input.resetUrl}`,
    'This link expires in 1 hour.',
    '',
    "Didn't ask for this? Ignore this email. Nothing changes unless the link is used.",
    '',
    'Preyone Starlink Customer Portal · support@preyone.com',
  ].join('\n');

  return { subject, html, text };
}

/** Dark-theme receipt sent once after a Starlink invoice moves PENDING -> PAID. */
export function buildPaymentReceiptEmail(input: {
  fullName: string;
  email: string;
  invoiceNumber: string;
  providerReference: string;
  action: string;
  amount: number;
  currency?: string;
  kitSerial?: string | null;
  kitNickname?: string | null;
  walletBalance?: number | null;
  dataBalance?: number | null;
  invoiceUrl?: string;
}): { subject: string; html: string; text: string } {
  const base = starlinkBaseUrl();
  const invoiceUrl = esc(input.invoiceUrl || `${base}/starlink/portal`);
  const amount = `$${Number(input.amount || 0).toFixed(2)} USD`;
  const wallet = input.walletBalance == null ? '—' : `$${Number(input.walletBalance).toFixed(2)}`;
  const data = input.dataBalance == null ? '—' : `${Number(input.dataBalance).toFixed(2)} GB`;
  const kitParts = [input.kitNickname, input.kitSerial].map((v) => String(v || '').trim()).filter(Boolean);
  const kit = kitParts.length ? kitParts.join(' · ') : '—';

  const row = (label: string, value: string, emphasis = false) => `
    <tr>
      <td style="padding:9px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">${esc(label)}</td>
      <td align="right" style="padding:9px 0;font:700 13px/1.5 ${FONT};color:${emphasis ? RECEIPT.cyan : RECEIPT.text}">${value}</td>
    </tr>`;

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${RECEIPT.mut}">
                Hi ${firstName(input.fullName)}, your payment was confirmed. Your Starlink invoice is now marked PAID.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="background:${RECEIPT.panel};border:1px solid ${RECEIPT.line};border-radius:12px;padding:14px 16px">
                ${row('Invoice number', esc(input.invoiceNumber), true)}
                ${row('Payment reference', esc(input.providerReference || '—'))}
                ${row('Payment action', esc(input.action))}
                ${row('Kit', esc(kit))}
                ${row('Amount paid', esc(amount), true)}
                ${row('New wallet balance', esc(wallet))}
                ${row('New data balance', esc(data))}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 6px">
              <div style="font:13px/1.7 ${FONT};color:${RECEIPT.mut}">
                Wallet top-ups, data bundles, kit orders and plan changes are credited automatically. Keep this email for
                your records — the PDF invoice is always available in the Starlink customer portal.
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 32px 8px">
              ${button(invoiceUrl, 'View / download PDF invoice', RECEIPT)}
              <p style="margin:14px 0 0;font:12px/1.6 ${FONT};color:${RECEIPT.dim}">
                Opens from starlink.preyone.com/starlink/portal
              </p>
            </td>
          </tr>`;

  const html = layout({
    preheader: `Payment received for invoice ${input.invoiceNumber}.`,
    eyebrow: 'Payment receipt',
    heading: `Payment confirmed, ${firstName(input.fullName)}`,
    body,
    recipient: input.email,
    base,
    palette: RECEIPT,
  });

  const text = [
    `Payment confirmed, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    `Invoice number: ${input.invoiceNumber}`,
    `Payment reference: ${input.providerReference || '—'}`,
    `Payment action: ${input.action}`,
    `Kit: ${kit}`,
    `Amount paid: ${amount}`,
    `New wallet balance: ${wallet}`,
    `New data balance: ${data}`,
    '',
    'Your Starlink invoice is now marked PAID. View or download the PDF invoice at:',
    `${base}/starlink/portal`,
    '',
    'Preyone Starlink Customer Portal · support@preyone.com',
  ].join('\n');

  return { subject: `Payment receipt · ${input.invoiceNumber}`, html, text };
}

/** Proactive 75/90/100% warning with a one-click return to the portal top-up flow. */
export function buildUsageAlertEmail(input: {
  fullName: string;
  email: string;
  threshold: 75 | 90 | 100;
  kitSerial?: string | null;
  kitNickname?: string | null;
  usedGb: number;
  allowanceGb: number;
  remainingGb: number;
  projectedExhaustionDate?: string | null;
  topupUrl?: string;
}): { subject: string; html: string; text: string } {
  const base = starlinkBaseUrl();
  const topupUrl = esc(input.topupUrl || `${base}/starlink/portal?topup=1`);
  const kitParts = [input.kitNickname, input.kitSerial].map((v) => String(v || '').trim()).filter(Boolean);
  const kit = kitParts.length ? kitParts.join(' · ') : 'your kit';
  const used = `${Number(input.usedGb || 0).toFixed(2)} GB`;
  const allowance = `${Number(input.allowanceGb || 0).toFixed(2)} GB`;
  const remaining = `${Math.max(0, Number(input.remainingGb || 0)).toFixed(2)} GB`;
  const projection = input.projectedExhaustionDate
    ? fmtEmailDate(input.projectedExhaustionDate)
    : 'not yet projected';

  const row = (label: string, value: string, emphasis = false) => `
    <tr>
      <td style="padding:9px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">${esc(label)}</td>
      <td align="right" style="padding:9px 0;font:700 13px/1.5 ${FONT};color:${emphasis ? RECEIPT.cyan : RECEIPT.text}">${value}</td>
    </tr>`;

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${RECEIPT.mut}">
                Hi ${firstName(input.fullName)}, ${kit} has reached <b style="color:${RECEIPT.cyan}">${input.threshold}%</b> of this billing cycle's data allowance.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="background:${RECEIPT.panel};border:1px solid ${RECEIPT.line};border-radius:12px;padding:14px 16px">
                ${row('Kit', esc(kit))}
                ${row('Data used', esc(used))}
                ${row('Cycle allowance', esc(allowance))}
                ${row('Remaining', esc(remaining), true)}
                ${row('Projected exhaustion', esc(projection))}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 6px;font:13px/1.7 ${FONT};color:${RECEIPT.mut}">
              Top up now from the portal to keep this kit online. You can also enable automatic top-up from your
              Starlink wallet so this never catches you out again. Payments are handled by Preyone Payment.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 32px 8px">
              ${button(topupUrl, 'Top up data now', RECEIPT)}
            </td>
          </tr>`;

  const html = layout({
    preheader: `${input.threshold}% of your Starlink data allowance has been used.`,
    eyebrow: 'Usage alert',
    heading: `${input.threshold}% data used, ${firstName(input.fullName)}`,
    body,
    recipient: input.email,
    base,
    palette: RECEIPT,
  });

  const text = [
    `${input.threshold}% data used, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    `Kit: ${kit}`,
    `Data used: ${used}`,
    `Cycle allowance: ${allowance}`,
    `Remaining: ${remaining}`,
    `Projected exhaustion: ${projection}`,
    '',
    `Top up data now: ${topupUrl}`,
    '',
    'Preyone Starlink Customer Portal · support@preyone.com',
  ].join('\n');

  return { subject: `Starlink usage alert · ${input.threshold}% used`, html, text };
}

function fmtEmailDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Dark-theme receipt for a wallet-funded automatic data purchase. */
export function buildAutoTopupEmail(input: {
  fullName: string;
  email: string;
  invoiceNumber: string;
  gb: number;
  amount: number;
  walletBalance: number;
  dataBalance: number;
  kitSerial?: string | null;
  kitNickname?: string | null;
  invoiceUrl?: string;
}): { subject: string; html: string; text: string } {
  const base = starlinkBaseUrl();
  const invoiceUrl = esc(input.invoiceUrl || `${base}/starlink/portal`);
  const kitParts = [input.kitNickname, input.kitSerial].map((v) => String(v || '').trim()).filter(Boolean);
  const kit = kitParts.length ? kitParts.join(' · ') : 'your kit';

  const row = (label: string, value: string, emphasis = false) => `
    <tr>
      <td style="padding:9px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">${esc(label)}</td>
      <td align="right" style="padding:9px 0;font:700 13px/1.5 ${FONT};color:${emphasis ? RECEIPT.cyan : RECEIPT.text}">${value}</td>
    </tr>`;

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${RECEIPT.mut}">
                Hi ${firstName(input.fullName)}, we automatically added data to ${esc(kit)} from your Starlink wallet.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="background:${RECEIPT.panel};border:1px solid ${RECEIPT.line};border-radius:12px;padding:14px 16px">
                ${row('Invoice number', esc(input.invoiceNumber), true)}
                ${row('Payment reference', 'Wallet auto top-up')}
                ${row('Action', 'Automatic data top-up')}
                ${row('Kit', esc(kit))}
                ${row('Data added', `${Number(input.gb || 0).toFixed(2)} GB`, true)}
                ${row('Amount paid', `$${Number(input.amount || 0).toFixed(2)} USD`)}
                ${row('New wallet balance', `$${Number(input.walletBalance || 0).toFixed(2)}`)}
                ${row('New data balance', `${Number(input.dataBalance || 0).toFixed(2)} GB`)}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 32px 8px">
              ${button(invoiceUrl, 'View / download PDF invoice', RECEIPT)}
            </td>
          </tr>`;

  const html = layout({
    preheader: `Automatic ${Number(input.gb || 0).toFixed(0)}GB data top-up receipt.`,
    eyebrow: 'Auto top-up receipt',
    heading: `Data added, ${firstName(input.fullName)}`,
    body,
    recipient: input.email,
    base,
    palette: RECEIPT,
  });

  const text = [
    `Data added, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    `Invoice number: ${input.invoiceNumber}`,
    `Payment reference: Wallet auto top-up`,
    `Action: Automatic data top-up`,
    `Kit: ${kit}`,
    `Data added: ${Number(input.gb || 0).toFixed(2)} GB`,
    `Amount paid: $${Number(input.amount || 0).toFixed(2)} USD`,
    `New wallet balance: $${Number(input.walletBalance || 0).toFixed(2)}`,
    `New data balance: ${Number(input.dataBalance || 0).toFixed(2)} GB`,
    '',
    `View or download the PDF invoice: ${invoiceUrl}`,
    '',
    'Preyone Starlink Customer Portal · support@preyone.com',
  ].join('\n');

  return { subject: `Auto top-up receipt · ${input.invoiceNumber}`, html, text };
}

/** Dark-theme branch-manager / accountant / technician invitation. */
export function buildMemberInviteEmail(input: {
  fullName: string;
  email: string;
  ownerName: string;
  role: 'admin' | 'billing' | 'viewer';
  kitLabels: string[];
  inviteUrl: string;
  expiresLabel: string;
}): { subject: string; html: string; text: string } {
  const base = starlinkBaseUrl();
  const inviteUrl = esc(input.inviteUrl);
  const roleLabel = { admin: 'Fleet administrator', billing: 'Billing / accountant', viewer: 'Site technician (view only)' }[input.role];
  const kits = input.kitLabels.length ? input.kitLabels.map(esc).join(', ') : 'All fleet kits';

  const body = `
          <tr>
            <td style="padding:0 32px 6px">
              <p style="margin:0;font:15px/1.7 ${FONT};color:${RECEIPT.mut}">
                Hi ${firstName(input.fullName)}, ${esc(input.ownerName)} invited you to their Preyone Starlink fleet as
                <b style="color:${RECEIPT.cyan}">${esc(roleLabel)}</b>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                     style="background:${RECEIPT.panel};border:1px solid ${RECEIPT.line};border-radius:12px;padding:14px 16px">
                <tr>
                  <td style="padding:8px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">Access level</td>
                  <td align="right" style="padding:8px 0;font:700 13px/1.5 ${FONT};color:${RECEIPT.text}">${esc(roleLabel)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">Assigned sites</td>
                  <td align="right" style="padding:8px 0;font:700 13px/1.5 ${FONT};color:${RECEIPT.cyan}">${kits}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;font:13px/1.5 ${FONT};color:${RECEIPT.mut}">Link expires</td>
                  <td align="right" style="padding:8px 0;font:700 13px/1.5 ${FONT};color:${RECEIPT.text}">${esc(input.expiresLabel)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 6px;font:13px/1.7 ${FONT};color:${RECEIPT.mut}">
              Open the secure invitation link, choose a password and you will land straight in the fleet portal.
              Nothing changes until you accept. Payments, if enabled for your role, run through Preyone Payment.
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:18px 32px 8px">
              ${button(inviteUrl, 'Accept invitation', RECEIPT)}
            </td>
          </tr>`;

  const html = layout({
    preheader: 'You have been invited to a Preyone Starlink fleet.',
    eyebrow: 'Fleet access',
    heading: `You're invited, ${firstName(input.fullName)}`,
    body,
    recipient: input.email,
    base,
    palette: RECEIPT,
  });

  const text = [
    `You're invited, ${input.fullName.trim().split(/\s+/)[0] || 'there'}`,
    '',
    `${input.ownerName} invited you to their Preyone Starlink fleet.`,
    `Access level: ${roleLabel}`,
    `Assigned sites: ${input.kitLabels.length ? input.kitLabels.join(', ') : 'All fleet kits'}`,
    `Link expires: ${input.expiresLabel}`,
    '',
    `Accept your invitation: ${input.inviteUrl}`,
    '',
    'Preyone Starlink Customer Portal · support@preyone.com',
  ].join('\n');

  return { subject: 'You are invited to a Preyone Starlink fleet', html, text };
}
