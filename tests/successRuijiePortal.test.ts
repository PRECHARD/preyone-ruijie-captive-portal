// @vitest-environment jsdom
import { readFileSync } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const successHtml = readFileSync(
  path.join(process.cwd(), 'public', 'success.html'),
  'utf8'
);
const portalJs = readFileSync(
  path.join(process.cwd(), 'public', 'js', 'portal.js'),
  'utf8'
);

function boot(url: string, referrer = 'https://wifi.preyone.com/manage-account') {
  const dom = new JSDOM(successHtml, {
    url,
    referrer,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const resolve = (dom.window as any).__preyoneResolveRuijiePortal as () => string;
  return { dom, resolve };
}

describe('success page Ruijie portal link', () => {
  it('remembers the Ruijie page when the portal first loads from it', () => {
    const ruijie =
      'https://portal-eu.ruijienetworks.com/download/static/advertisement/maccauth/customizefile/b2726dc01b864da599a95d6c24c006b1/dywns6juafnimjcdbps0a/index.html?timestamp1792567218715&sessionId=dc6e5e3cc92f4144b1c2b5155bfd8c48';
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://wifi.preyone.com/',
      referrer: ruijie,
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    dom.window.eval(portalJs);

    const saved = JSON.parse(
      dom.window.localStorage.getItem('preyone_ruijie_portal') || 'null'
    );
    expect(saved.portalUrl).toBe(ruijie);
    expect(saved.sessionId).toBe('dc6e5e3cc92f4144b1c2b5155bfd8c48');
    dom.window.close();
  });

  it('returns the exact Ruijie page captured when the purchase started', () => {
    const ruijie =
      'https://portal-eu.ruijienetworks.com/download/static/advertisement/maccauth/customizefile/b2726dc01b864da599a95d6c24c006b1/dywns6juafnimjcdbps0a/index.html?timestamp1792567218715&sessionId=dc6e5e3cc92f4144b1c2b5155bfd8c48';
    const { dom, resolve } = boot(
      `https://wifi.preyone.com/success.html?voucher=abc123&ruijiePortal=${encodeURIComponent(ruijie)}`
    );

    expect(resolve()).toBe(ruijie);
    dom.window.close();
  });

  it('rebuilds the portal URL from a dynamic captive-session id', () => {
    const { dom, resolve } = boot(
      'https://wifi.preyone.com/success.html?voucher=abc123&sessionId=dc6e5e3cc92f4144b1c2b5155bfd8c48&timestamp=1792567218715'
    );

    expect(resolve()).toBe(
      'https://portal-eu.ruijienetworks.com/download/static/advertisement/maccauth/customizefile/b2726dc01b864da599a95d6c24c006b1/dywns6juafnimjcdbps0a/index.html?timestamp1792567218715&sessionId=dc6e5e3cc92f4144b1c2b5155bfd8c48'
    );
    dom.window.close();
  });

  it('uses the portal URL remembered when the purchase page first loaded', () => {
    const ruijie =
      'https://portal-eu.ruijienetworks.com/download/static/advertisement/maccauth/customizefile/b2726dc01b864da599a95d6c24c006b1/dywns6juafnimjcdbps0a/index.html?timestamp1792567218715&sessionId=dc6e5e3cc92f4144b1c2b5155bfd8c48';
    const { dom, resolve } = boot(
      'https://wifi.preyone.com/success.html?voucher=abc123'
    );
    dom.window.localStorage.setItem(
      'preyone_ruijie_portal',
      JSON.stringify({ portalUrl: ruijie, savedAt: Date.now() })
    );

    expect(resolve()).toBe(ruijie);
    dom.window.close();
  });

  it('falls back to the current signup flow when no Ruijie session exists', () => {
    const { dom, resolve } = boot(
      'https://wifi.preyone.com/success.html?voucher=abc123',
      'https://evil.example/download/static/advertisement/maccauth/fake/index.html?sessionId=stolen'
    );

    expect(resolve()).toBe('');
    dom.window.close();
  });
});
