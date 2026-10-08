import axios from 'axios';

// Derived from axios.create() rather than importing the named `AxiosInstance`
// type: under this project's commonjs/node10 resolution the named export
// resolves to a namespace and cannot be used as a type. `axios.create()`
// already returns AxiosInstance, so this is the same type with no cast.
type AxiosInstance = ReturnType<typeof axios.create>;

const RUIJIE_BASE_URL = 'https://cloud.ruijienetworks.com';
const ACCESS_TOKEN_URL = '/service/api/oauth20/client/access_token';
const USERGROUP_LIST_URL = '/service/api/intl/usergroup/list';
const VOUCHER_CREATE_URL = '/service/api/open/auth/voucher/create';
const VOUCHER_GET_LIST_URL = '/service/api/open/auth/voucher/getList';

const TOKEN_TTL_MS = 50 * 60 * 1000;

const AUTH_ERROR_CODES = [4010, 4011, 4013];

export class RuijieApiError extends Error {
  readonly code: string | number;
  readonly status: number = 502;
  constructor(code: string | number, message: string) {
    super(message);
    this.name = 'RuijieApiError';
    this.code = code;
  }
}

export interface RuijieUserGroup {
  id: string;
  name: string;
  authProfileId: string;
  timePeriodMin?: number;
  quotaMb?: number;
  noOfDevice?: number;
  rateLimitKbps?: number;
  bindMac?: number;
  comment?: string;
  groupId?: string;
}

export interface RuijieVoucher {
  codeNo: string;
  voucherCode?: string;
  expiryTime?: number;
  profile?: string;
  userGroupId?: string;
  status?: string;
  comment?: string;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export function resetRuijieCloudCache(): void {
  cachedToken = null;
}

export function isRuijieCloudConfigured(): boolean {
  return Boolean(
    process.env.RUIJIE_CLOUD_APPID &&
    process.env.RUIJIE_CLOUD_SECRET &&
    process.env.RUIJIE_CLOUD_GROUP_ID
  );
}

function getConfig() {
  return {
    appid: process.env.RUIJIE_CLOUD_APPID || '',
    secret: process.env.RUIJIE_CLOUD_SECRET || '',
    groupId: process.env.RUIJIE_CLOUD_GROUP_ID || '',
    token: process.env.RUIJIE_CLOUD_TOKEN || '',
    baseUrl: process.env.RUIJIE_CLOUD_BASE_URL || RUIJIE_BASE_URL,
  };
}

function client(): AxiosInstance {
  return axios.create({
    baseURL: getConfig().baseUrl,
    timeout: 15000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

function failIfNotZero(payload: unknown, context: string): asserts payload is { [k: string]: any } {
  const body = payload as { [k: string]: any };
  if (!body || typeof body !== 'object' || body.code !== 0) {
    const msg = body?.msg || body?.message || body?.errorReason || 'Unknown Ruijie API error';
    throw new RuijieApiError(body?.code ?? 'unknown', `${context}: ${msg}`);
  }
}

// Ruijie returns expiryTime either as a numeric epoch-ms string (getList) or as a
// "YYYY-MM-DD HH:mm:ss" string (create). Normalize both to epoch-ms; return
// undefined for anything unparseable so callers store NULL instead of NaN
// (ruijie_expiry is a BIGINT column — inserting NaN would error).
function parseExpiry(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw.replace(' ', 'T') + (raw.includes('T') ? '' : 'Z'));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function getRuijieAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  const cfg = getConfig();
  if (!cfg.appid || !cfg.secret) throw new RuijieApiError('config', 'RUIJIE_CLOUD_APPID/RUIJIE_CLOUD_SECRET not configured');

  const res = await client().post(
    `${ACCESS_TOKEN_URL}?token=${encodeURIComponent(cfg.token)}`,
    { appid: cfg.appid, secret: cfg.secret },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const data = res.data as { code?: number; msg?: string; accessToken?: string; access_token?: string };
  failIfNotZero(res.data, `access_token (appid=${cfg.appid}) -> HTTP ${res.status}`);
  const accessToken = data.accessToken || data.access_token;
  if (!accessToken) throw new RuijieApiError('no_token', 'Ruijie access_token missing from response');
  cachedToken = { accessToken, expiresAt: Date.now() + TOKEN_TTL_MS };
  return accessToken;
}

export async function withTokenRefresh<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
  try {
    const token = await getRuijieAccessToken();
    return await fn(token);
  } catch (err) {
    if (err instanceof RuijieApiError && AUTH_ERROR_CODES.includes(Number(err.code))) {
      const fresh = await getRuijieAccessToken(true);
      return await fn(fresh);
    }
    throw err;
  }
}

function resolveVoucherData(payload: unknown): { [k: string]: any } | null {
  const body = payload as { [k: string]: any };
  if (!body || typeof body !== 'object') return null;
  for (const probe of [body.voucherData, body.data?.voucherData, body.data?.data?.voucherData, body.data]) {
    if (probe && typeof probe === 'object') return probe;
  }
  return null;
}

export async function getRuijieUserGroups(): Promise<RuijieUserGroup[]> {
  return withTokenRefresh(async (accessToken) => {
    const cfg = getConfig();
    const res = await client().get(
      `${USERGROUP_LIST_URL}/${cfg.groupId}?pageIndex=0&pageSize=1000&access_token=${encodeURIComponent(accessToken)}`
    );
    failIfNotZero(res.data, `usergroup/list (groupId=${cfg.groupId}) -> HTTP ${res.status}`);
    const data = res.data.data as { [k: string]: any } | any[];
    const list = Array.isArray(data) ? data : data?.list ?? data?.userGroupList ?? [];
    if (!Array.isArray(list)) throw new RuijieApiError('bad_shape', 'Ruijie usergroup list returned no array');
    return list.map((g: any) => ({
      id: String(g.id),
      name: String(g.name || g.userGroupName || g.groupName || ''),
      authProfileId: String(g.authProfileId || g.authprofile || g.profile || ''),
      timePeriodMin: g.timePeriod != null ? Number(g.timePeriod) : g.timePeriodMin != null ? Number(g.timePeriodMin) : undefined,
      quotaMb: g.quota != null ? Number(g.quota) : g.quotaMb != null ? Number(g.quotaMb) : undefined,
      noOfDevice: g.noOfDevice != null ? Number(g.noOfDevice) : g.deviceLimit != null ? Number(g.deviceLimit) : undefined,
      rateLimitKbps: g.downloadRateLimit != null ? Number(g.downloadRateLimit) : g.rateLimit != null ? Number(g.rateLimit) : g.rateLimitKbps != null ? Number(g.rateLimitKbps) : undefined,
      bindMac: g.bindMac != null ? Number(g.bindMac) : undefined,
      comment: g.comment != null ? String(g.comment) : undefined,
      groupId: g.groupId != null ? String(g.groupId) : undefined,
    }));
  });
}

export interface CreateRuijieVoucherInput {
  profile: string;
  userGroupId: string;
  comment?: string;
}

export async function createRuijieVoucher(input: CreateRuijieVoucherInput): Promise<RuijieVoucher> {
  if (!input.profile || !input.userGroupId) {
    throw new RuijieApiError('config', `No Ruijie profile mapping for package`);
  }
  return withTokenRefresh(async (accessToken) => {
    const cfg = getConfig();
    const comment = (input.comment || '').slice(0, 50);
    const res = await client().post(
      `${VOUCHER_CREATE_URL}/${cfg.groupId}?access_token=${encodeURIComponent(accessToken)}`,
      { quantity: 1, profile: input.profile, userGroupId: input.userGroupId, comment },
      { headers: { 'Content-Type': 'application/json' } }
    );
    failIfNotZero(res.data, `voucher/create (groupId=${cfg.groupId}) -> HTTP ${res.status}`);
    const vd = resolveVoucherData(res.data);
    if (!vd || vd.code !== 0) {
      const msg = vd?.msg || vd?.message || 'Ruijie voucherData.code was not 0';
      throw new RuijieApiError(vd?.code ?? 'voucher_data', `voucher/create inner envelope failed: ${msg}`);
    }
    const entry = Array.isArray(vd.list) ? vd.list[0] : undefined;
    const codeNo = entry?.codeNo ?? entry?.voucherCode;
    if (!codeNo) throw new RuijieApiError('no_code', 'Ruijie create returned no codeNo');
    return {
      codeNo: String(codeNo),
      voucherCode: entry?.voucherCode != null ? String(entry.voucherCode) : undefined,
      expiryTime: parseExpiry(entry?.expiryTime),
      profile: entry?.profile != null ? String(entry.profile) : input.profile,
      userGroupId: entry?.userGroupId != null ? String(entry.userGroupId) : input.userGroupId,
      comment,
    };
  });
}

export interface GetRuijieVouchersInput {
  start?: number;
  pageSize?: number;
  includeStatus?: string;
}

export async function getRuijieVouchers(input: GetRuijieVouchersInput = {}): Promise<RuijieVoucher[]> {
  const start = input.start ?? 0;
  const pageSize = input.pageSize ?? 20;
  return withTokenRefresh(async (accessToken) => {
    const cfg = getConfig();
    const res = await client().get(
      `${VOUCHER_GET_LIST_URL}/${cfg.groupId}?access_token=${encodeURIComponent(accessToken)}&start=${start}&pageSize=${pageSize}`
    );
    failIfNotZero(res.data, `voucher/getList (groupId=${cfg.groupId}) -> HTTP ${res.status}`);
    const vd = resolveVoucherData(res.data);
    const list = vd?.list ?? vd?.voucherList ?? [];
    if (!Array.isArray(list)) throw new RuijieApiError('bad_shape', 'Ruijie voucher getList returned no array');
    return list.map((v: any) => ({
      codeNo: String(v.codeNo ?? v.voucherCode ?? ''),
      voucherCode: v.voucherCode != null ? String(v.voucherCode) : v.codeNo != null ? String(v.codeNo) : undefined,
      expiryTime: parseExpiry(v.expiryTime),
      profile: v.profile != null ? String(v.profile) : undefined,
      userGroupId: v.userGroupId != null ? String(v.userGroupId) : undefined,
      status: v.status != null ? String(v.status) : undefined,
      comment: v.comment != null ? String(v.comment) : undefined,
    }));
  });
}