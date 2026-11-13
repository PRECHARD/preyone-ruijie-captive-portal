import { describe, expect, it } from 'vitest';
import { isAllowedAppUrl, isExternalBrowserUrl, isShellUrl } from '../src/shared/navigation';
import { printFollowUp } from '../src/shared/print';
import { deviceRegistrationMessage } from '../src/shared/device';

describe('guest navigation allowlist', () => {
  it('allows Preyone sites over https only', () => {
    expect(isAllowedAppUrl('https://pos.preyone.com/till')).toBe(true);
    expect(isAllowedAppUrl('https://invoice.preyone.com/documents')).toBe(true);
    expect(isAllowedAppUrl('https://app.preyone.com/')).toBe(true);
    expect(isAllowedAppUrl('https://preyone.com/downloads/app.exe')).toBe(true);
  });

  it('rejects other hosts, lookalike domains, and non-https links', () => {
    expect(isAllowedAppUrl('https://payments.pesepay.com/pay')).toBe(false);
    expect(isAllowedAppUrl('https://preyone.com.evil.com/')).toBe(false);
    expect(isAllowedAppUrl('https://notpreyone.com/')).toBe(false);
    expect(isAllowedAppUrl('http://pos.preyone.com/')).toBe(false);
    expect(isAllowedAppUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedAppUrl('not a url')).toBe(false);
  });

  it('opens only http and https links outside the app', () => {
    expect(isExternalBrowserUrl('https://payments.pesepay.com/pay')).toBe(true);
    expect(isExternalBrowserUrl('http://192.168.1.20/receipt')).toBe(true);
    expect(isExternalBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(isExternalBrowserUrl('smb://till/share')).toBe(false);
    expect(isExternalBrowserUrl('myapp://open')).toBe(false);
    expect(isExternalBrowserUrl('javascript:alert(1)')).toBe(false);
  });

  it('keeps the shell on its own file or the dev server', () => {
    expect(isShellUrl('file:///app/index.html', null)).toBe(true);
    expect(isShellUrl('http://127.0.0.1:5176/index.html', 'http://127.0.0.1:5176')).toBe(true);
    expect(isShellUrl('https://pos.preyone.com/', 'http://127.0.0.1:5176')).toBe(false);
    expect(isShellUrl('http://127.0.0.1:9999/', 'http://127.0.0.1:5176')).toBe(false);
  });
});

describe('receipt print fallback', () => {
  it('opens the dialog only after a silent print fails', () => {
    expect(printFollowUp(true, false)).toBe('dialog');
    expect(printFollowUp(true, true)).toBe('done');
    expect(printFollowUp(false, false)).toBe('stop');
    expect(printFollowUp(false, true)).toBe('done');
  });
});

describe('device cap message', () => {
  it('uses the server message when the plan is full', () => {
    const message = deviceRegistrationMessage(403, {
      code: 'DEVICE_LIMIT_EXCEEDED',
      error: 'Device limit reached: your subscription allows 1 active device(s).',
      max_devices: 1,
    });
    expect(message).toMatch(/Device limit reached/);
  });

  it('stays quiet when registration succeeds', () => {
    expect(deviceRegistrationMessage(201, {})).toBeNull();
  });
});
