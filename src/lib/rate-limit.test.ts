import { describe, expect, it, vi } from 'vitest';
import { checkRateLimit } from './rate-limit';

const mockRpc = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => ({
    rpc: mockRpc,
  }),
}));

describe('checkRateLimit', () => {
  it('returns true when fn_rate_limit returns true', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });

    const allowed = await checkRateLimit('test_bucket', 10, 60);
    expect(allowed).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('fn_rate_limit', {
      p_bucket: 'test_bucket',
      p_max: 10,
      p_window_seconds: 60,
    });
  });

  it('returns false when fn_rate_limit returns false (over limit)', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const allowed = await checkRateLimit('test_bucket', 10, 60);
    expect(allowed).toBe(false);
  });

  it('allows the request (returns true) if the RPC fails so an outage never blocks customers', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection timeout' } });

    const allowed = await checkRateLimit('test_bucket', 10, 60);
    expect(allowed).toBe(true);
  });

  it('allows the request (returns true) if the RPC throws an exception', async () => {
    mockRpc.mockRejectedValueOnce(new Error('Network error'));

    const allowed = await checkRateLimit('test_bucket', 10, 60);
    expect(allowed).toBe(true);
  });
});
