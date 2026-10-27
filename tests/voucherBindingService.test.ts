import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db/pool', () => ({ pool: { query } }));

import {
  bindingMacKey,
  normalizeMac,
  resolveSessionAccounts,
  resolveVoucherBinding,
  resolveVoucherBindings,
  resolveVoucherCodesByIp,
  verifyVoucherCode,
  verifyVoucherCodes,
} from '../src/services/voucherBindingService';

/**
 * Regression guard for the ~3% session-PIN coverage bug.
 *
 * voucher_devices.mac_norm and users.mac_address store UPPERCASE 12-hex
 * (deviceBinding.normalizeMac), while Ruijie hands us lowercase MACs through
 * normalizeRuijieMac(). Both copies of the old inline query compared
 * `mac_norm = ANY($1)` with lowercase input, so the primary indexed source
 * never matched — measured live as lowercase=0 rows / uppercase=1 row. Only
 * the users fallback (which lower()ed both sides) could ever hit, which is
 * exactly the one row that produced ~3% coverage.
 */
describe('voucherBindingService', () => {
  const MAC_LOWER = '0cb527edfef4';
  const MAC_UPPER = '0CB527EDFEF4';

  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  describe('bindingMacKey', () => {
    it('reduces every spelling Ruijie and Postgres produce to 12 lowercase hex', () => {
      const expected = '0cb527edfef4';
      expect(bindingMacKey('0CB527EDFEF4')).toBe(expected);
      expect(bindingMacKey('0c:b5:27:ed:fe:f4')).toBe(expected);
      expect(bindingMacKey('0c-b5-27-ed-fe-f4')).toBe(expected);
      // macaddr style, as stored in voucher_redemptions.mac_address
      expect(bindingMacKey('0cb5.27ed.fef4')).toBe(expected);
      expect(bindingMacKey('0cb527edfef4')).toBe(expected);
    });

    it('rejects anything that is not a 12-hex MAC instead of producing a false key', () => {
      expect(bindingMacKey('192.168.1.100')).toBeNull();
      expect(bindingMacKey('0cb5.27ed')).toBeNull();
      expect(bindingMacKey('')).toBeNull();
      expect(bindingMacKey(null)).toBeNull();
      expect(bindingMacKey(undefined)).toBeNull();
      expect(bindingMacKey('M2003J15SC-636333004')).toBeNull();
    });
  });

  describe('resolveVoucherBindings', () => {
    it('queries voucher_devices with UPPERCASE keys so the stored mac_norm matches', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM voucher_devices')) {
          return { rows: [{ mac_norm: MAC_UPPER, voucher_code: 'ebywa6' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const bindings = await resolveVoucherBindings([MAC_LOWER]);

      const deviceCall = query.mock.calls.find(([sql]) => String(sql).includes('FROM voucher_devices'));
      expect(deviceCall).toBeTruthy();
      expect(deviceCall![1]).toEqual([[MAC_UPPER]]);
      expect(bindings.get(MAC_LOWER)).toMatchObject({ code: 'ebywa6', source: 'voucher_devices' });
    });

    it('accepts any input spelling and keys the result by canonical lowercase', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM voucher_devices')) {
          return { rows: [{ mac_norm: MAC_UPPER, voucher_code: 'ebywa6' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const bindings = await resolveVoucherBindings(['0c:b5:27:ed:fe:f4', '0CB527EDFEF4']);

      expect([...bindings.keys()]).toEqual([MAC_LOWER]);
      expect(bindings.get(MAC_LOWER)!.code).toBe('ebywa6');
    });

    it('lets voucher_devices win over the later fallback sources', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM voucher_devices')) {
          return { rows: [{ mac_norm: MAC_UPPER, voucher_code: 'devices' }], rowCount: 1 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [{ mac_key: MAC_LOWER, voucher_code: 'users' }], rowCount: 1 };
        }
        if (sql.includes('holder_name')) {
          return { rows: [{ code: 'devices', holder_name: 'Ada', holder_phone: '+263' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const binding = (await resolveVoucherBinding(MAC_LOWER));

      expect(binding.code).toBe('devices');
      expect(binding.source).toBe('voucher_devices');
      expect(binding.holderName).toBe('Ada');
      expect(binding.holderPhone).toBe('+263');
      // The users fallback must not even have been asked — nothing unresolved.
      expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM users'))).toBe(false);
    });

    it('falls through the sources in precedence order when earlier ones miss', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('voucher_redemptions')) {
          return { rows: [{ mac_key: MAC_LOWER, voucher_code: 'redemption' }], rowCount: 1 };
        }
        if (sql.includes('wispr_profiles')) {
          return { rows: [{ mac_key: MAC_LOWER, voucher_code: 'wispr' }], rowCount: 1 };
        }
        if (sql.includes('FROM users')) {
          return { rows: [{ mac_key: MAC_LOWER, voucher_code: 'users' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const binding = await resolveVoucherBinding('0c-b5-27-ed-fe-f4');

      expect(binding.code).toBe('redemption');
      expect(binding.source).toBe('voucher_redemptions');
      expect(query.mock.calls.some(([sql]) => String(sql).includes('wispr_profiles'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM users'))).toBe(false);
    });

    it('returns nothing for MACs no local source knows, without inventing a code', async () => {
      const bindings = await resolveVoucherBindings(['aabbccddeeff', 'not-a-mac']);

      expect(bindings.size).toBe(0);
      // Every source is asked (they are cheap, indexed probes) but no holder
      // lookup fires — there is no code to look up.
      expect(query.mock.calls[0][1]).toEqual([['AABBCCDDEEFF']]);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('holder_name'))).toBe(false);
    });

    it('survives a failing source instead of losing the whole page', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM voucher_devices')) throw new Error('relation down');
        if (sql.includes('FROM users')) {
          return { rows: [{ mac_key: MAC_LOWER, voucher_code: 'users' }], rowCount: 1 };
        }
        if (sql.includes('holder_name')) {
          return { rows: [{ code: 'users', holder_name: null, holder_phone: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const binding = await resolveVoucherBinding(MAC_LOWER);

      expect(binding.code).toBe('users');
      expect(binding.source).toBe('users');
    });

    it('short-circuits on an empty input without touching the database', async () => {
      const bindings = await resolveVoucherBindings([]);
      expect(bindings.size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('verifyVoucherCode(s) — strict PIN contract', () => {
    it('returns the stored code when the label really is a voucher', async () => {
      query.mockResolvedValue({ rows: [{ code: 'ebywa6' }], rowCount: 1 });

      expect(await verifyVoucherCode('EBYWA6')).toBe('ebywa6');
      expect(await verifyVoucherCode(' ebywa6 ')).toBe('ebywa6');
    });

    it('rejects labels that cannot be voucher codes without spending a query', async () => {
      // Generated codes are alphanumeric (+ optional dash) and never contain
      // whitespace, so a device/person name can be dropped outright.
      expect(await verifyVoucherCode('Samsung Galaxy A24')).toBeNull();
      expect(await verifyVoucherCode('')).toBeNull();
      expect(await verifyVoucherCode('   ')).toBeNull();
      expect(await verifyVoucherCode(null)).toBeNull();
      expect(await verifyVoucherCode(undefined)).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('never returns a device-name style identifier as a PIN', async () => {
      // Shape passes the cheap filter (no spaces, short enough), so it does
      // reach the lookup — and comes back empty. Correctness comes from the
      // vouchers table, not the filter.
      query.mockResolvedValue({ rows: [], rowCount: 0 });
      expect(await verifyVoucherCode('M2003J15SC-636333004')).toBeNull();
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('answers null when the label matches no voucher row', async () => {
      query.mockResolvedValue({ rows: [], rowCount: 0 });
      expect(await verifyVoucherCode('zzzzzz')).toBeNull();
    });

    it('filters a whole page down to one lookup', async () => {
      query.mockResolvedValue({ rows: [{ code: 'y43dzw' }], rowCount: 1 });

      const verified = await verifyVoucherCodes([
        'Y43DZW',
        'Samsung Galaxy A24',
        '',
        null,
      ]);

      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][1]).toEqual([['y43dzw']]);
      expect([...verified.values()]).toEqual(['y43dzw']);
    });
  });

  describe('normalizeMac', () => {
    it('is the shared lowercase 12-hex key used by both resolvers', () => {
      expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
      expect(normalizeMac('aabb.ccdd.eeff')).toBe('aabbccddeeff');
      expect(normalizeMac('aabbccddeeff')).toBe('aabbccddeeff');
      expect(normalizeMac('not-a-mac')).toBeNull();
      expect(normalizeMac(null)).toBeNull();
    });
  });

  describe('resolveVoucherCodesByIp', () => {
    it('maps a recent portal IP to its voucher code', async () => {
      query.mockResolvedValue({
        rows: [{ ip: '192.168.1.5', code: 'ip1', name: null, phone: null, expires_at: null }],
        rowCount: 1,
      });

      const byIp = await resolveVoucherCodesByIp(['::ffff:192.168.1.5']);

      expect(byIp.get('192.168.1.5')).toBe('ip1');
    });
  });

  describe('resolveSessionAccounts — direct code → MAC → IP', () => {
    it('resolves a direct Ruijie PIN before MAC or IP and attaches data/devices', async () => {
      query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('ARRAY_AGG(DISTINCT mac)')) {
          return { rows: [{ code: 'direct1', device_count: 2, device_macs: [MAC_UPPER, '112233445566'] }], rowCount: 1 };
        }
        if (s.includes('data_limit_gb')) {
          return { rows: [{ code: 'direct1', holder_name: 'Ada', holder_phone: '+263', data_limit_gb: '10', is_uncapped: false, data_consumed_mb: '1024' }], rowCount: 1 };
        }
        if (s.includes('data_used_bytes')) return { rows: [], rowCount: 0 };
        if (s.includes('SELECT lower(code) AS code') && s.includes('FROM vouchers')) {
          return { rows: [{ code: 'direct1' }], rowCount: 1 };
        }
        if (s.includes('FROM voucher_devices')) {
          return { rows: [{ mac_norm: MAC_UPPER, voucher_code: 'mac1' }], rowCount: 1 };
        }
        if (s.includes('host(u.ip_address)')) {
          return { rows: [{ ip: '192.168.1.5', code: 'ip1', name: 'IP', phone: null, expires_at: null }], rowCount: 1 };
        }
        if (s.includes('FROM mac_whitelist')) return { rows: [{ mac: MAC_LOWER }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });

      const [account] = await resolveSessionAccounts([
        { mac: MAC_LOWER, ip: '192.168.1.5', codeCandidates: ['direct1'] },
      ]);

      expect(account.code).toBe('direct1');
      expect(account.matchedBy).toBe('code');
      expect(account.bindingSource).toBe('ruijie_user_name');
      expect(account.authMethod).toBe('VOUCHER');
      expect(account.dataLimitBytes).toBe(10 * 1024 * 1024 * 1024);
      expect(account.dataUsedBytes).toBe(1024 * 1024 * 1024);
      expect(account.dataLeftBytes).toBe(9 * 1024 * 1024 * 1024);
      expect(account.activeDeviceCount).toBe(2);
      expect(account.deviceMacs).toEqual([MAC_LOWER, '112233445566']);
      // Direct code wins, so the MAC/IP stages never run.
      expect(query.mock.calls.some(([sql]) => String(sql).includes('host(u.ip_address)'))).toBe(false);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM voucher_devices') && !String(sql).includes('ARRAY_AGG'))).toBe(false);
    });

    it('falls back to the MAC binding when no direct PIN is reported', async () => {
      query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('ARRAY_AGG(DISTINCT mac)')) {
          return { rows: [{ code: 'mac1', device_count: 1, device_macs: [MAC_UPPER] }], rowCount: 1 };
        }
        if (s.includes('data_limit_gb')) {
          return { rows: [{ code: 'mac1', holder_name: 'MAC Holder', holder_phone: null, data_limit_gb: null, is_uncapped: true, data_consumed_mb: null }], rowCount: 1 };
        }
        if (s.includes('data_used_bytes')) return { rows: [], rowCount: 0 };
        if (s.includes('FROM voucher_devices')) {
          return { rows: [{ mac_norm: MAC_UPPER, voucher_code: 'mac1' }], rowCount: 1 };
        }
        if (s.includes('holder_name')) {
          return { rows: [{ code: 'mac1', holder_name: 'MAC Holder', holder_phone: null }], rowCount: 1 };
        }
        if (s.includes('host(u.ip_address)')) {
          return { rows: [{ ip: '192.168.1.5', code: 'ip1', name: 'IP', phone: null, expires_at: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const [account] = await resolveSessionAccounts([
        { mac: MAC_LOWER, ip: '192.168.1.5', codeCandidates: ['Samsung Galaxy A24'] },
      ]);

      expect(account.code).toBe('mac1');
      expect(account.matchedBy).toBe('mac');
      expect(account.bindingSource).toBe('voucher_devices');
      expect(account.isUncapped).toBe(true);
      expect(account.dataLeftBytes).toBeNull();
      expect(query.mock.calls.some(([sql]) => String(sql).includes('host(u.ip_address)'))).toBe(false);
    });

    it('falls back to the recent IP/portal authorization when MAC is unbound', async () => {
      query.mockImplementation(async (sql: string) => {
        const s = String(sql);
        if (s.includes('ARRAY_AGG(DISTINCT mac)')) {
          return { rows: [{ code: 'ip1', device_count: 1, device_macs: [MAC_UPPER] }], rowCount: 1 };
        }
        if (s.includes('data_limit_gb')) {
          return { rows: [{ code: 'ip1', holder_name: null, holder_phone: null, data_limit_gb: '5', is_uncapped: false, data_consumed_mb: '100' }], rowCount: 1 };
        }
        if (s.includes('data_used_bytes')) return { rows: [], rowCount: 0 };
        if (s.includes('host(u.ip_address)')) {
          return { rows: [{ ip: '192.168.1.5', code: 'ip1', name: 'Portal User', phone: '+263', expires_at: new Date('2030-01-01T00:00:00Z') }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const [account] = await resolveSessionAccounts([
        { mac: MAC_LOWER, ip: '192.168.1.5', codeCandidates: [] },
      ]);

      expect(account.code).toBe('ip1');
      expect(account.matchedBy).toBe('ip');
      expect(account.bindingSource).toBe('ip_session');
      expect(account.accountName).toBe('Portal User');
      expect(account.holderName).toBe('Portal User');
      expect(account.accountSessionExpiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('classifies an unbound client as MAC_AUTO and flags the whitelist', async () => {
      query.mockImplementation(async (sql: string) => {
        if (String(sql).includes('FROM mac_whitelist')) {
          return { rows: [{ mac: MAC_LOWER }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const [account] = await resolveSessionAccounts([
        { mac: MAC_LOWER, ip: null, codeCandidates: [] },
      ]);

      expect(account.code).toBeNull();
      expect(account.authMethod).toBe('MAC_AUTO');
      expect(account.macWhitelisted).toBe(true);
      expect(query.mock.calls.some(([sql]) => String(sql).includes('host(u.ip_address)'))).toBe(false);
    });
  });
});
