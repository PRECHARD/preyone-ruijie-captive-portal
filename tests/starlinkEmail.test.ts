import { describe, it, expect } from 'vitest';
import {
  buildAutoTopupEmail,
  buildUsageAlertEmail,
  buildVerificationEmail,
} from '../src/services/starlinkEmailTemplates';

const verifyUrl = 'https://starlink.preyone.com/api/starlink/auth/verify-email?token=' + 'a'.repeat(64);

describe('Starlink verification email', () => {
  it('links the verify button and plain-text fallback to the token URL', () => {
    const tpl = buildVerificationEmail({ fullName: 'Tendai Moyo', verifyUrl, email: 'tendai@example.com' });
    expect(tpl.html).toContain(verifyUrl);
    expect(tpl.text).toContain(`Verify your email: ${verifyUrl}`);
    expect(tpl.subject).toMatch(/Verify your email/);
  });

  it('greets by first name and escapes HTML in user-supplied fields', () => {
    const tpl = buildVerificationEmail({
      fullName: '<script>x</script> Eve',
      verifyUrl,
      email: 'eve@example.com',
    });
    expect(tpl.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(tpl.html).not.toContain('<script>x</script>');
  });

  it('carries no Terms of Service link', () => {
    const tpl = buildVerificationEmail({ fullName: 'Ann', verifyUrl, email: 'ann@example.com' });
    expect(tpl.html.toLowerCase()).not.toContain('terms');
    expect(tpl.text.toLowerCase()).not.toContain('terms');
  });
});

describe('Starlink telemetry emails', () => {
  it('sends a dark 75% warning with a one-click top-up link', () => {
    const topupUrl = 'https://starlink.preyone.com/starlink/portal?topup=1';
    const tpl = buildUsageAlertEmail({
      fullName: 'Tendai Moyo',
      email: 'tendai@example.com',
      threshold: 75,
      kitSerial: 'KIT-123',
      usedGb: 75,
      allowanceGb: 100,
      remainingGb: 25,
      projectedExhaustionDate: '2026-12-04',
      topupUrl,
    });

    expect(tpl.subject).toContain('75%');
    expect(tpl.html).toContain('#0D0F18');
    expect(tpl.html).toContain('#00F0FF');
    expect(tpl.html).toContain(topupUrl);
    expect(tpl.text).toContain(topupUrl);
    expect(tpl.html).toContain('Preyone Payment');
    expect(`${tpl.html} ${tpl.text}`.toLowerCase()).not.toContain('pesepay');
  });

  it('renders a dark wallet-funded auto top-up receipt', () => {
    const tpl = buildAutoTopupEmail({
      fullName: 'Ann',
      email: 'ann@example.com',
      invoiceNumber: 'SL-202611-0007',
      gb: 10,
      amount: 5,
      walletBalance: 45,
      dataBalance: 12,
    });

    expect(tpl.subject).toContain('SL-202611-0007');
    expect(tpl.html).toContain('#0D0F18');
    expect(tpl.html).toContain('#00F0FF');
    expect(tpl.text).toContain('New data balance: 12.00 GB');
  });
});
