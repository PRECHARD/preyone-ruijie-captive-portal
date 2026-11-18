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

export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="center">
                <tr>
                  <td align="center" bgcolor="${C.cyan}" style="border-radius:10px;background:linear-gradient(135deg,${C.cyan},${C.purple})">
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
}): string {
  const logo = `${opts.base}/images/preyonenoneglow-logo-zoom-800.png`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Preyone Starlink</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:32px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden">

          <tr>
            <td style="padding:34px 24px 8px;text-align:center">
              <img src="${logo}" alt="Preyone" width="200" height="100" style="display:block;margin:0 auto;width:200px;height:auto;border:0" />
              <div style="margin-top:12px;font:600 10.5px ${FONT};letter-spacing:3px;text-transform:uppercase;color:${C.cyan}">${esc(opts.eyebrow)}</div>
            </td>
          </tr>
          <tr>
            <td style="height:3px;background:linear-gradient(90deg,${C.cyan},${C.purple});font-size:0;line-height:0">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding:32px 32px 8px">
              <div style="font:700 25px/1.25 ${FONT};color:${C.text};letter-spacing:0.2px">${opts.heading}</div>
            </td>
          </tr>

          ${opts.body}

          <tr>
            <td style="padding:8px 32px 30px">
              <div style="border-top:1px solid ${C.line};padding-top:18px;font:13px/1.6 ${FONT};color:${C.dim}">
                Didn't ask for this? You can ignore this email. Nothing changes unless the link is used. If you're worried
                about your account, reply to this email or contact
                <a href="mailto:support@preyone.com" style="color:${C.cyan};text-decoration:none">support@preyone.com</a>.
              </div>
            </td>
          </tr>

          <tr>
            <td style="background:${C.panel};border-top:1px solid ${C.line};padding:24px 32px;text-align:center">
              <div style="font:600 13px ${FONT};color:${C.text}">Preyone Starlink Customer Portal</div>
              <div style="margin-top:6px;font:12.5px/1.6 ${FONT};color:${C.mut}">
                <a href="mailto:support@preyone.com" style="color:${C.cyan};text-decoration:none">support@preyone.com</a>
                &nbsp;·&nbsp;
                <a href="tel:+263771327202" style="color:${C.cyan};text-decoration:none">+263 771 327 202</a>
              </div>
              <div style="margin-top:10px;font:12px/1.6 ${FONT};color:${C.dim}">
                <a href="${opts.base}/starlink-privacy.html" style="color:${C.mut};text-decoration:none">Privacy policy</a>
                &nbsp;·&nbsp;
                <a href="https://preyone.com" style="color:${C.mut};text-decoration:none">preyone.com</a>
              </div>
              <div style="margin-top:14px;font:11px/1.6 ${FONT};color:${C.dim}">
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
