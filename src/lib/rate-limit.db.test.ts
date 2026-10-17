import { describe, expect, it } from 'vitest';
import { hasDatabase, useTestDatabase } from '@/test/db';

const service = { kind: 'service' } as const;
const anon = { kind: 'anon' } as const;

describe.skipIf(!hasDatabase)('fn_rate_limit (database)', () => {
  const { db } = useTestDatabase();

  it('enforces limit and returns false once hits exceed max', async () => {
    const bucket = 'test_bucket_' + crypto.randomUUID();

    // Call 1: hits = 1 <= 2 -> allowed
    const [{ r1 }] = await db().as<{ r1: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 2, 60) AS r1',
      [bucket]
    );
    expect(r1).toBe(true);

    // Call 2: hits = 2 <= 2 -> allowed
    const [{ r2 }] = await db().as<{ r2: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 2, 60) AS r2',
      [bucket]
    );
    expect(r2).toBe(true);

    // Call 3: hits = 3 > 2 -> rejected
    const [{ r3 }] = await db().as<{ r3: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 2, 60) AS r3',
      [bucket]
    );
    expect(r3).toBe(false);

    // Hits in table is 3
    const row = await db().one<{ hits: number }>(
      'SELECT hits FROM rate_limit_hits WHERE bucket = $1',
      [bucket]
    );
    expect(row.hits).toBe(3);
  });

  it('rolls over to a new window when time advances (window_start in the past)', async () => {
    const bucket = 'test_rollover_' + crypto.randomUUID();

    // First call consumes the single allowed slot in the current window
    const [{ r1 }] = await db().as<{ r1: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 1, 60) AS r1',
      [bucket]
    );
    expect(r1).toBe(true);

    // Second call is blocked
    const [{ r2 }] = await db().as<{ r2: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 1, 60) AS r2',
      [bucket]
    );
    expect(r2).toBe(false);

    // Simulate window expiry by shifting window_start into the past (> 60s ago)
    await db().q(
      "UPDATE rate_limit_hits SET window_start = now() - interval '2 minutes' WHERE bucket = $1",
      [bucket]
    );

    // In the new current window, a new row is created and request succeeds
    const [{ r3 }] = await db().as<{ r3: boolean }>(
      service,
      'SELECT fn_rate_limit($1, 1, 60) AS r3',
      [bucket]
    );
    expect(r3).toBe(true);

    // There should now be 2 window rows for this bucket (the past one and the current one)
    const rows = await db().q<{ hits: number }>(
      'SELECT hits FROM rate_limit_hits WHERE bucket = $1 ORDER BY window_start ASC',
      [bucket]
    );
    expect(rows).toHaveLength(2);
  });

  it('cleans up windows older than 1 day via fn_rate_limit_cleanup', async () => {
    const oldBucket = 'cleanup_old_' + crypto.randomUUID();
    const newBucket = 'cleanup_new_' + crypto.randomUUID();

    await db().as(service, 'SELECT fn_rate_limit($1, 10, 60)', [oldBucket]);
    await db().as(service, 'SELECT fn_rate_limit($1, 10, 60)', [newBucket]);

    // Move oldBucket window_start 2 days into the past
    await db().q(
      "UPDATE rate_limit_hits SET window_start = now() - interval '2 days' WHERE bucket = $1",
      [oldBucket]
    );

    const [{ deleted }] = await db().as<{ deleted: number }>(
      service,
      'SELECT fn_rate_limit_cleanup() AS deleted'
    );
    expect(deleted).toBeGreaterThanOrEqual(1);

    const oldRows = await db().q('SELECT * FROM rate_limit_hits WHERE bucket = $1', [oldBucket]);
    expect(oldRows).toHaveLength(0);

    const newRows = await db().q('SELECT * FROM rate_limit_hits WHERE bucket = $1', [newBucket]);
    expect(newRows).toHaveLength(1);
  });

  it('revokes execute from anon and authenticated', async () => {
    const bucket = 'perm_test_' + crypto.randomUUID();
    const err = await db().rejects(
      anon,
      'SELECT fn_rate_limit($1, 10, 60)',
      [bucket]
    );
    expect(err).toMatch(/permission denied/i);
  });
});
