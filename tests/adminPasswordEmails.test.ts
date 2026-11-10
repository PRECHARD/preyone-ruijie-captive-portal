import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailMock })),
  },
}));

import {
  sendAdminPasswordChangedEmail,
  sendPasswordResetEmail,
  sendPortalPasswordChangedEmail,
} from '../src/services/notificationService';

describe('admin password emails', () => {
  beforeEach(() => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'support@preyone.com';
    process.env.SMTP_PASS = 'test-password';
    process.env.BASE_URL = 'https://wifi.preyone.com';
    process.env.ADMIN_BASE_URL = 'https://admin.preyone.com';
    sendMailMock.mockReset().mockResolvedValue({ messageId: 'message-1', response: '250 accepted' });
  });

  it('uses the OTP brand and standalone footer logo for reset emails', async () => {
    await sendPasswordResetEmail('staff@preyone.com', 'reset token', '<Staff>');

    const message = sendMailMock.mock.calls[0][0];
    expect(message.to).toBe('staff@preyone.com');
    expect(message.html).toContain('https://admin.preyone.com/?token=reset%20token');
    expect(message.html).toContain('#0a0d17');
    expect(message.html).toContain('#ff00ff');
    expect(message.html).toContain('Hi <strong style="color:#f8fbff">&lt;Staff&gt;</strong>');
    expect(message.html).not.toContain('preyone-logo-mainInverse-optimized.png');
    expect(message.html.match(/preyonelogomainzw-email\.png/g)).toHaveLength(2);
    expect(message.from).toContain('support@preyone.com');
  });

  it('sends a branded password-changed alert to the affected account', async () => {
    await sendAdminPasswordChangedEmail('staff@preyone.com', 'Staff Member');

    const message = sendMailMock.mock.calls[0][0];
    expect(message.to).toBe('staff@preyone.com');
    expect(message.subject).toBe('Your Preyone password was changed');
    expect(message.html).toContain('Your Preyone Admin Console password was successfully changed.');
    expect(message.html).not.toContain('preyone-logo-mainInverse-optimized.png');
    expect(message.html.match(/preyonelogomainzw-email\.png/g)).toHaveLength(2);
  });

  it('sends the portal password-changed alert in the same brand genre', async () => {
    await sendPortalPasswordChangedEmail('guest@example.com', 'Guest User');

    const message = sendMailMock.mock.calls[0][0];
    expect(message.to).toBe('guest@example.com');
    expect(message.subject).toBe('Your Preyone WiFi password was changed');
    expect(message.html).toContain('Your Preyone WiFi account password was successfully changed.');
    expect(message.html).toContain('#6a0dad');
    expect(message.html).toContain('#ff00ff');
    expect(message.html.match(/preyonelogomainzw-email\.png/g)).toHaveLength(2);
  });

  it('gives every email a unique reference so Gmail does not collapse repeated messages', async () => {
    await sendPasswordResetEmail('staff@preyone.com', 'first-token', 'Staff Member');
    await sendPasswordResetEmail('staff@preyone.com', 'second-token', 'Staff Member');

    const firstRef = sendMailMock.mock.calls[0][0].headers['X-Entity-Ref-ID'];
    const secondRef = sendMailMock.mock.calls[1][0].headers['X-Entity-Ref-ID'];
    expect(firstRef).toMatch(/^preyone-/);
    expect(secondRef).toMatch(/^preyone-/);
    expect(firstRef).not.toBe(secondRef);
  });
});
