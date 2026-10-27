import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMailMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'smtp-user';
  process.env.SMTP_PASS = 'smtp-pass';
  process.env.SMTP_FROM = 'info@preyone.com';
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailMock })),
  },
}));

import { sendOnlinePaymentReceiptEmail } from '../src/services/notificationService';

describe('Online payment advice email', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ accepted: ['ops@preyone.com'] });
  });

  it('sends every accounting and transaction detail to each recipient', async () => {
    const ok = await sendOnlinePaymentReceiptEmail(['OPS@preyone.com', 'ceo@preyone.com'], {
      paymentId: 'pay-123',
      merchantReference: 'PREY-TEST-001',
      gatewayReference: 'PSP-REF-001',
      gateway: 'Pesepay',
      channel: 'Preyone WiFi Portal (wifi.preyone.com)',
      paymentMethod: 'EcoCash (Pesepay)',
      status: 'completed',
      amount: 10,
      currency: 'USD',
      initiatedAt: '2026-10-25T08:00:00Z',
      completedAt: '2026-10-25T08:01:00Z',
      customerName: 'John Doe',
      customerPhone: '+263771327202',
      customerEmail: 'john@example.com',
      clientMac: 'AA:BB:CC:DD:EE:FF',
      packageTier: 'PreLite',
      packageName: 'Daily Basic',
      durationMin: 1440,
      dataLimitGb: 5,
      isUncapped: false,
      bandwidthUpMbps: 5,
      bandwidthDownMbps: 10,
      maxDevices: 1,
      voucherCode: 'CT-TESTCODE1',
      voucherExpiry: '2026-10-26T08:01:00Z',
      saleId: 'sale-123',
      soldByName: 'Prechard Muvirimi',
      saleType: 'new',
    });

    expect(ok).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('ops@preyone.com');
    expect(mail.subject).toContain('Payment received');
    expect(mail.subject).toContain('USD 10.00');
    expect(mail.subject).toContain('CT-TESTCODE1');

    expect(mail.html).toContain('Payment received');
    expect(mail.html).toContain('pay-123');
    expect(mail.html).toContain('PREY-TEST-001');
    expect(mail.html).toContain('PSP-REF-001');
    expect(mail.html).toContain('EcoCash (Pesepay)');
    expect(mail.html).toContain('John Doe');
    expect(mail.html).toContain('+263771327202');
    expect(mail.html).toContain('AA:BB:CC:DD:EE:FF');
    expect(mail.html).toContain('PreLite - Daily Basic');
    expect(mail.html).toContain('5 GB');
    expect(mail.html).toContain('CT-TESTCODE1');
    expect(mail.html).toContain('sale-123');
    expect(mail.html).toContain('Prechard Muvirimi');
    expect(mail.html).toContain('Pesepay clearing / cash-in-transit');
    expect(mail.html).toContain('WiFi access revenue');
    expect(mail.html).toContain('Payment = sale = voucher value: Matched');
    expect(mail.html).toContain('Tax component');
    expect(mail.html).toContain('Not captured');
  });

  it('deduplicates recipients and returns false when none are valid', async () => {
    const ok = await sendOnlinePaymentReceiptEmail(['ops@preyone.com', 'OPS@preyone.com'], {
      paymentId: 'pay-123',
      paymentMethod: 'EcoCash (Pesepay)',
      status: 'completed',
      amount: 1,
      currency: 'USD',
      packageTier: 'PreLite',
      voucherCode: 'CT-TESTCODE1',
    });

    expect(ok).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    await expect(sendOnlinePaymentReceiptEmail([], {
      paymentId: 'pay-123',
      paymentMethod: 'EcoCash (Pesepay)',
      status: 'completed',
      amount: 1,
      currency: 'USD',
      packageTier: 'PreLite',
      voucherCode: 'CT-TESTCODE1',
    })).resolves.toBe(false);
  });
});
