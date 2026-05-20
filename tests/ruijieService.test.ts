import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
const mockAxios = vi.mocked(axios);

import { bypassRuijieFirewall } from '../src/services/ruijieService';

describe('bypassRuijieFirewall', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  it('returns false if no auth URL provided', async () => {
    const result = await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', '', null, null);
    expect(result).toBe(false);
    expect(mockAxios.get).not.toHaveBeenCalled();
  });

  it('calls Ruijie auth URL with MAC and default password', async () => {
    mockAxios.get.mockResolvedValue({ status: 200 });

    const result = await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth', null, null);

    expect(result).toBe(true);
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('username=AA%3ABB%3ACC%3ADD%3AEE%3AFF'),
      expect.any(Object)
    );
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('password=PreyoneNetAccess'),
      expect.any(Object)
    );
  });

  it('appends bandwidth parameters when speedBits is provided', async () => {
    mockAxios.get.mockResolvedValue({ status: 200 });

    await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth', 10000, null);

    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('wispr_bandwidth_max_down=10000'),
      expect.any(Object)
    );
    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('wispr_bandwidth_max_up=5000'),
      expect.any(Object)
    );
  });

  it('appends data quota when dataBytes is provided', async () => {
    mockAxios.get.mockResolvedValue({ status: 200 });

    await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth', null, 10737418240);

    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('wispr_max_bytes=10737418240'),
      expect.any(Object)
    );
  });

  it('handles URL already having a query string', async () => {
    mockAxios.get.mockResolvedValue({ status: 200 });

    await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth?gw_id=xyz', null, null);

    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('gw_id=xyz&username='),
      expect.any(Object)
    );
  });

  it('returns false on network error', async () => {
    mockAxios.get.mockRejectedValue(new Error('Network timeout'));

    const result = await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth', null, null);

    expect(result).toBe(false);
  });

  it('has a 5-second timeout on requests', async () => {
    mockAxios.get.mockResolvedValue({ status: 200 });

    await bypassRuijieFirewall('AA:BB:CC:DD:EE:FF', 'http://ruijie.local/auth', null, null);

    expect(mockAxios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 5000 })
    );
  });
});
