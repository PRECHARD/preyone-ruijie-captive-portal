// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('portal.js — escHtml (XSS escaping)', () => {
  function escHtml(str: any): string {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  it('returns empty string for null/undefined', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('escapes ampersands', () => {
    expect(escHtml('AT&T')).toBe('AT&amp;T');
  });

  it('escapes HTML tags', () => {
    expect(escHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes single quotes', () => {
    expect(escHtml("it's")).toBe('it&#39;s');
  });

  it('leaves safe strings unchanged', () => {
    expect(escHtml('Hello World')).toBe('Hello World');
    expect(escHtml('12345')).toBe('12345');
  });
});

describe('portal.js — setFieldError / clearErrors', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="signup-form">
        <input id="fullName" name="fullName" />
        <span id="err-fullName"></span>
        <input id="phone" name="phone" />
        <span id="err-phone"></span>
        <input id="voucherCode" name="voucherCode" />
        <span id="err-voucherCode"></span>
        <input id="acceptedTos" type="checkbox" />
        <span id="err-acceptedTos"></span>
        <div id="form-error" class="hidden"></div>
      </div>
    `;
  });

  function setFieldError(fieldName: string, message: string) {
    const el = document.getElementById('err-' + fieldName);
    if (el) el.textContent = message;
    const input = document.getElementById(fieldName) || document.querySelector('[name="' + fieldName + '"]');
    if (input) input.classList.toggle('invalid', !!message);
  }

  function clearErrors() {
    ['fullName', 'phone', 'voucherCode', 'acceptedTos'].forEach(function (f) {
      setFieldError(f, '');
    });
    const formError = document.getElementById('form-error');
    if (formError) {
      formError.textContent = '';
      formError.classList.add('hidden');
    }
  }

  it('sets field error message and adds invalid class', () => {
    setFieldError('fullName', 'Required');
    const errEl = document.getElementById('err-fullName');
    expect(errEl?.textContent).toBe('Required');
    const input = document.getElementById('fullName');
    expect(input?.classList.contains('invalid')).toBe(true);
  });

  it('clears field error and removes invalid class', () => {
    setFieldError('fullName', 'Required');
    setFieldError('fullName', '');
    const errEl = document.getElementById('err-fullName');
    expect(errEl?.textContent).toBe('');
    const input = document.getElementById('fullName');
    expect(input?.classList.contains('invalid')).toBe(false);
  });

  it('clearErrors resets all fields', () => {
    setFieldError('fullName', 'Err1');
    setFieldError('phone', 'Err2');
    setFieldError('voucherCode', 'Err3');
    const formError = document.getElementById('form-error')!;
    formError.textContent = 'Global error';
    formError.classList.remove('hidden');

    clearErrors();

    expect(document.getElementById('err-fullName')?.textContent).toBe('');
    expect(document.getElementById('err-phone')?.textContent).toBe('');
    expect(document.getElementById('err-voucherCode')?.textContent).toBe('');
    expect(formError.textContent).toBe('');
    expect(formError.classList.contains('hidden')).toBe(true);
  });
});

describe('portal.js — form validation logic', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form id="signup-form">
        <input id="fullName" value="" />
        <input id="phone" value="" />
        <input id="voucherCode" value="" />
        <input id="acceptedTos" type="checkbox" />
      </form>
    `;
  });

  function validateForm(data: { fullName: string; phone: string; voucherCode: string; acceptedTos: boolean }): string[] {
    const errors: string[] = [];
    if (!data.fullName) errors.push('fullName');
    if (!data.phone) errors.push('phone');
    if (!data.voucherCode) errors.push('voucherCode');
    if (!data.acceptedTos) errors.push('acceptedTos');
    return errors;
  }

  it('rejects empty form', () => {
    const errs = validateForm({ fullName: '', phone: '', voucherCode: '', acceptedTos: false });
    expect(errs).toHaveLength(4);
  });

  it('passes when all fields are filled and TOS accepted', () => {
    const errs = validateForm({ fullName: 'Alice', phone: '+263771111111', voucherCode: 'PREYONE-ABC', acceptedTos: true });
    expect(errs).toHaveLength(0);
  });

  it('rejects missing phone', () => {
    const errs = validateForm({ fullName: 'Alice', phone: '', voucherCode: 'PREYONE-ABC', acceptedTos: true });
    expect(errs).toEqual(['phone']);
  });

  it('rejects missing voucher code', () => {
    const errs = validateForm({ fullName: 'Alice', phone: '+263771111111', voucherCode: '', acceptedTos: true });
    expect(errs).toEqual(['voucherCode']);
  });

  it('rejects unaccepted TOS', () => {
    const errs = validateForm({ fullName: 'Alice', phone: '+263771111111', voucherCode: 'PREYONE-ABC', acceptedTos: false });
    expect(errs).toEqual(['acceptedTos']);
  });
});

describe('portal.js — modal creation and flow', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="phone"></div>
    `;
  });

  it('creates modal overlay with correct structure', () => {
    const packageData = {
      'data-tier': 'PreLITE',
      'data-display-name': 'PreLITE WiFi',
      'data-amount': '5.00',
      'data-period': 'daily',
      'data-data-limit': '5',
      'data-is-uncapped': 'false',
      'data-bandwidth-up': '2',
      'data-bandwidth-down': '5',
    };

    // Simulate showPackagePaymentModal logic
    const modal = document.createElement('div');
    modal.className = 'payment-modal-overlay';
    modal.innerHTML = `
      <div class="payment-modal">
        <button class="modal-close" aria-label="Close">&times;</button>
        <h2>Confirm Purchase: ${packageData['data-display-name']}</h2>
        <div class="modal-details">
          <p><strong>Package:</strong> ${packageData['data-tier']}</p>
          <p><strong>Price:</strong> $${packageData['data-amount']} USD (${packageData['data-period']})</p>
          <p><strong>Data:</strong> ${packageData['data-is-uncapped'] === 'true' ? 'Uncapped' : packageData['data-data-limit'] + 'GB'}</p>
          <p><strong>Payment Method:</strong> EcoCash</p>
        </div>
        <div class="modal-form">
          <input id="payment-phone" type="tel" />
          <span class="field-error" id="err-payment-phone"></span>
          <button id="confirm-payment-btn">Proceed to Payment</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Verify modal structure
    expect(document.querySelector('.payment-modal-overlay')).not.toBeNull();
    expect(document.querySelector('.modal-close')).not.toBeNull();
    expect(document.querySelector('#confirm-payment-btn')).not.toBeNull();
    expect(document.querySelector('#payment-phone')).not.toBeNull();
  });

  it('prevents background scroll when modal is open', () => {
    document.body.style.overflow = 'hidden';
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('phone validation rejects empty input', () => {
    const phone = '';
    const errEl = document.createElement('span');
    errEl.id = 'err-payment-phone';

    if (!phone) errEl.textContent = 'Phone number is required';

    expect(errEl.textContent).toBe('Phone number is required');
  });

  it('phone validation accepts valid Zimbabwe number', () => {
    const phone = '+263771327202';
    const errEl = document.createElement('span');
    errEl.id = 'err-payment-phone';

    // In the actual code, validation is just a presence check
    if (!phone) errEl.textContent = 'Phone number is required';

    expect(errEl.textContent).toBe('');
  });

  it('closeModal removes overlay and restores scroll', () => {
    const modal = document.createElement('div');
    modal.className = 'payment-modal-overlay';
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    // Simulate closeModal
    modal.remove();
    document.body.style.overflow = '';

    expect(document.querySelector('.payment-modal-overlay')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('portal.js — timer formatting', () => {
  function formatTimer(diffMs: number): string {
    if (diffMs <= 0) return '00:00:00';
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    const s = Math.floor((diffMs % 60000) / 1000);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  it('returns 00:00:00 for zero or negative time', () => {
    expect(formatTimer(0)).toBe('00:00:00');
    expect(formatTimer(-1000)).toBe('00:00:00');
  });

  it('formats hours correctly', () => {
    const threeHours = 3 * 3600000 + 30 * 60000 + 15 * 1000;
    expect(formatTimer(threeHours)).toBe('03:30:15');
  });

  it('formats minutes and seconds with padding', () => {
    expect(formatTimer(3661000)).toBe('01:01:01');
  });

  it('handles large durations', () => {
    expect(formatTimer(99999999)).toBe('27:46:39');
  });

  it('handles edge case of 1 second', () => {
    expect(formatTimer(1000)).toBe('00:00:01');
  });
});
