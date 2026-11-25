import { describe, expect, it } from 'vitest';
import { buildEmeraldEmail, buildEmeraldOtpEmail } from '../src/services/notificationService';

describe('emerald invoice/POS email shell', () => {
  it('uses the emerald palette, escapes tenant values and keeps the CTA', () => {
    const html = buildEmeraldEmail({
      title: 'Your workspace is ready',
      eyebrow: 'Client onboarding',
      bodyHtml: '<p>Hello</p>',
      details: [['Company', '&lt;Acme&gt;']],
      cta: { label: 'Open Invoice', url: 'https://invoice.preyone.com/' },
    });

    expect(html).toContain('#047857');
    expect(html).toContain('#34d399');
    expect(html).toContain('&lt;Acme&gt;');
    expect(html).toContain('https://invoice.preyone.com/');
    expect(html).toContain('Preyone Invoice &amp; POS');
  });

  it('renders the OTP in a single, selectable block', () => {
    const html = buildEmeraldOtpEmail({
      app: { brand: 'Preyone Invoice', domain: 'invoice.preyone.com' },
      code: '482913',
      fullName: 'Acme Owner',
      copyUrl: 'https://invoice.preyone.com/copy-code#482913',
    });

    expect(html).toContain('482913');
    expect(html).toContain('Expires in 15 minutes');
    expect(html).toContain('invoice.preyone.com');
  });
});
