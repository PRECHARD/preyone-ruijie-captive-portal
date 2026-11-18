import { describe, it, expect } from 'vitest';
import { buildVerificationEmail } from '../src/services/starlinkEmailTemplates';

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
