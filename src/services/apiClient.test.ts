import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from './apiClient';

describe('ApiClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('normalizes browser fetch failures into an actionable API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(new ApiClient(() => null).datasets()).rejects.toEqual(
      new ApiClientError('NETWORK_ERROR', '无法连接平台服务，请检查网络或联系管理员'),
    );
  });
});
