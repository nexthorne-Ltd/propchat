import { serviceClient } from '@/lib/supabase/service';

/**
 * Checks whether an action in `bucket` is within its limit of `max` hits per
 * `windowSeconds`. Calls the `fn_rate_limit` RPC with the service-role client.
 *
 * If the RPC fails or throws (database outage, missing key, etc.), the request
 * is allowed so that infrastructure issues never block customers.
 *
 * Returns true if allowed, false if rate limited.
 */
export async function checkRateLimit(
  bucket: string,
  max: number,
  windowSeconds: number
): Promise<boolean> {
  try {
    const supabase = serviceClient();
    if (typeof supabase?.rpc !== 'function') {
      return true;
    }
    const { data, error } = await supabase.rpc('fn_rate_limit', {
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.warn('[RateLimit] RPC error, allowing request:', error.message);
      return true;
    }

    return data !== false;
  } catch (err: unknown) {
    console.warn('[RateLimit] Unexpected error, allowing request:', err);
    return true;
  }
}
