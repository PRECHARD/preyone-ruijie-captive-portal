import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RuijieApiError,
  getRuijieAccessToken,
  getRuijieUserGroups,
  createRuijieVoucher,
  getRuijieVouchers,
  isRuijieCloudConfigured,
  resetRuijieCloudCache,
} from '../src/services/ruijieCloud';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('axios', () => ({ default: { create: vi.fn(() => mocks) } }));

const APPID = 'test-appid';
const SECRET = 'test-secret';
const GROUP = '9624342';
const TOKEN = 'd63dss0a81e4415a889ac5b78fsc904a';

function env(on: boolean) {
  if (on) {
    process.env.RUIJIE_CLOUD_APPID = APPID;
    process.env.RUIJIE_CLOUD_SECRET = SECRET;
    process.env.RUIJIE_CLOUD_GROUP_ID = GROUP;
    process.env.RUIJIE_CLOUD_TOKEN = TOKEN;
  } else {
    delete process.env.RUIJIE_CLOUD_APPID;
    delete process.env.RUIJIE_CLOUD_SECRET;
    delete process.env.RUIJIE_CLOUD_GROUP_ID;
    delete process.env.RUIJIE_CLOUD_TOKEN;
  }
}

beforeEach(() => {
  env(true);
  resetRuijieCloudCache();
  mocks.get.mockReset();
  mocks.post.mockReset();
});

afterEach(() => {
  env(false);
});

describe('isRuijieCloudConfigured', () => {
  it('is true only when appid, secret and groupId are present', () => {
    expect(isRuijieCloudConfigured()).toBe(true);
  });
  it('is false when secret is missing', () => {
    delete process.env.RUIJIE_CLOUD_SECRET;
    expect(isRuijieCloudConfigured()).toBe(false);
  });
});

describe('getRuijieAccessToken', () => {
  it('reads body code, not HTTP status, and caches the token', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok-1' } });
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok-2' } });

    const t1 = await getRuijieAccessToken();
    const t2 = await getRuijieAccessToken();
    expect(t1).toBe('tok-1');
    expect(t2).toBe('tok-1');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][1]).toEqual({ appid: APPID, secret: SECRET });
  });

  it('throws RuijieApiError when a bad secret returns HTTP 200 with code != 0', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 1, msg: 'Login failed' } });
    await expect(getRuijieAccessToken()).rejects.toThrow(RuijieApiError);
  });

  it('throws when accessToken is missing', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0 } });
    await expect(getRuijieAccessToken()).rejects.toThrow(RuijieApiError);
  });
});

describe('getRuijieUserGroups', () => {
  it('parses user groups and uses intl path with access_token param', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.get.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: {
          list: [
            { id: 127498, name: 'preLite_Daily', authProfileId: '30113648274480073538014045592098', timePeriod: 1440, quota: 5120, noOfDevice: 1, rateLimit: 5120, bindMac: 1 },
          ],
        },
      },
    });

    const groups = await getRuijieUserGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: '127498',
      name: 'preLite_Daily',
      authProfileId: '30113648274480073538014045592098',
      timePeriodMin: 1440,
      quotaMb: 5120,
      noOfDevice: 1,
      rateLimitKbps: 5120,
      bindMac: 1,
    });
    expect(mocks.get.mock.calls[0][0]).toContain(`/service/api/intl/usergroup/list/${GROUP}`);
    expect(mocks.get.mock.calls[0][0]).toContain('access_token=tok');
    expect(mocks.get.mock.calls[0][0]).toContain('pageSize=1000');
  });

  it('parses the live response shape (data is a bare array, downloadRateLimit)', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.get.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: [
          {
            id: 156098,
            name: 'preTesting',
            authProfileId: '00156278731586786064150749743580',
            timePeriod: 30,
            quota: 500,
            noOfDevice: 1,
            downloadRateLimit: 1024,
            bindMac: 1,
          },
        ],
      },
    });

    const groups = await getRuijieUserGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: '156098',
      name: 'preTesting',
      authProfileId: '00156278731586786064150749743580',
      timePeriodMin: 30,
      quotaMb: 500,
      noOfDevice: 1,
      rateLimitKbps: 1024,
    });
  });

  it('throws on non-zero outer envelope', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.get.mockResolvedValueOnce({ status: 200, data: { code: 2015, msg: 'Group does not exist' } });
    await expect(getRuijieUserGroups()).rejects.toThrow(RuijieApiError);
  });
});

describe('createRuijieVoucher', () => {
  const profile = '30113648274480073538014045592098';
  const userGroupId = '127498';

  it('forces quantity to 1 and extracts codeNo from voucherData.list', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        voucherData: { code: 0, list: [{ codeNo: 'ABC123' }] },
      },
    });

    const voucher = await createRuijieVoucher({ profile, userGroupId, comment: 'Payment abc' });
    expect(voucher.codeNo).toBe('ABC123');
    const body = mocks.post.mock.calls[1][1];
    expect(body).toMatchObject({ quantity: 1, profile, userGroupId, comment: 'Payment abc' });
  });

  it('truncates comment to 50 chars', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, voucherData: { code: 0, list: [{ codeNo: 'XYZ789' }] } },
    });
    const long = 'x'.repeat(120);
    const v = await createRuijieVoucher({ profile, userGroupId, comment: long });
    expect((mocks.post.mock.calls[1][1] as any).comment).toHaveLength(50);
    expect(v.comment).toHaveLength(50);
  });

  it('parses the create response expiryTime date-string into epoch ms', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        voucherData: { code: 0, list: [{ codeNo: 'DTE123', expiryTime: '2125-10-01 18:04:45' }] },
      },
    });

    const v = await createRuijieVoucher({ profile, userGroupId });
    expect(v.expiryTime).toBeDefined();
    expect(Number.isNaN(v.expiryTime as number)).toBe(false);
    // epoch ms, not a string/NaN — ruijie_expiry is a BIGINT column.
    expect(typeof v.expiryTime).toBe('number');
  });

  it('returns undefined expiryTime (not NaN) for an unparseable expiry', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, voucherData: { code: 0, list: [{ codeNo: 'NAN001', expiryTime: 'not-a-date' }] } },
    });

    const v = await createRuijieVoucher({ profile, userGroupId });
    expect(v.expiryTime).toBeUndefined();
  });

  it('throws when inner voucherData.code is non-zero', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, voucherData: { code: 1, msg: 'No permission' } },
    });
    await expect(createRuijieVoucher({ profile, userGroupId })).rejects.toThrow(RuijieApiError);
  });

  it('throws when no codeNo is returned', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, voucherData: { code: 0, list: [] } } });
    await expect(createRuijieVoucher({ profile, userGroupId })).rejects.toThrow(RuijieApiError);
  });

  it('throws config error when profile is missing', async () => {
    await expect(createRuijieVoucher({ profile: '', userGroupId })).rejects.toThrow(RuijieApiError);
  });

  it('refreshes token once and retries on auth error code', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'stale' } });
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 4013, msg: 'token expired' } });
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'fresh' } });
    mocks.post.mockResolvedValueOnce({
      status: 200,
      data: { code: 0, voucherData: { code: 0, list: [{ codeNo: 'RETRY1' }] } },
    });

    const v = await createRuijieVoucher({ profile, userGroupId });
    expect(v.codeNo).toBe('RETRY1');
    // token call + failed create + token refresh + successful create
    expect(mocks.post.mock.calls[2][1]).toEqual({ appid: APPID, secret: SECRET });
  });
});

describe('getRuijieVouchers', () => {
  it('uses start (not pageIndex) and reads back codes with status', async () => {
    mocks.post.mockResolvedValueOnce({ status: 200, data: { code: 0, accessToken: 'tok' } });
    mocks.get.mockResolvedValueOnce({
      status: 200,
      data: {
        code: 0,
        data: { list: [{ voucherCode: 'ABC123', status: '1', expiryTime: 4922215200000 }] },
      },
    });

    const list = await getRuijieVouchers({ start: 0, pageSize: 20 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ voucherCode: 'ABC123', codeNo: 'ABC123', status: '1' });
    expect(mocks.get.mock.calls[0][0]).toContain('start=0');
    expect(mocks.get.mock.calls[0][0]).toContain('pageSize=20');
    expect(mocks.get.mock.calls[0][0]).not.toContain('pageIndex');
  });
});