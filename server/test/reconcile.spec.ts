import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { reconcile } from '../src/reconcile';
import {
  countRows,
  listObjectKeys,
  pngBytes,
  signInAccount,
  signUpAccount,
  uploadAndGetId,
} from './helpers';

/**
 * The scheduled maintenance job, against the real local R2 and D1.
 *
 * The time-dependent cases are driven by passing an explicit `now` into
 * `reconcile()` rather than by mocking the clock - the job takes it as a
 * parameter precisely so this is possible.
 */

const HOUR = 60 * 60 * 1000;

/** Writes an object into R2 with no matching D1 row: a real orphan. */
async function createOrphan(key: string): Promise<void> {
  await env.PHOTOS.put(key, pngBytes(32), {
    httpMetadata: { contentType: 'image/png' },
  });
}

describe('orphaned R2 objects', () => {
  it('deletes an object with no database row once it is past the grace period', async () => {
    const account = await signUpAccount();
    const keptId = await uploadAndGetId(account.accessToken);
    await createOrphan(`photos/${account.userId}/pht_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);

    expect(await listObjectKeys()).toHaveLength(2);

    // Two hours from now, so both objects are older than the one-hour grace.
    const report = await reconcile(env, new Date(Date.now() + 2 * HOUR));

    expect(report.orphanObjectsFound).toBe(1);
    expect(report.orphanObjectsDeleted).toBe(1);
    expect(report.completeScan).toBe(true);

    // The orphan is gone and the real photo is untouched.
    const keys = await listObjectKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`photos/${account.userId}/${keptId}`);
    expect(await countRows('photos')).toBe(1);
  });

  it('leaves a recent orphan alone, because it may be an upload in flight', async () => {
    const account = await signUpAccount();
    await createOrphan(`photos/${account.userId}/pht_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`);

    // "Now" is now: the object was uploaded milliseconds ago.
    const report = await reconcile(env);

    // This is the single most important assertion in this file. An upload that
    // has written its bytes but not yet its row looks exactly like an orphan,
    // and deleting it would destroy live data under load.
    expect(report.orphanObjectsFound).toBe(0);
    expect(report.orphanObjectsDeleted).toBe(0);
    expect(await listObjectKeys()).toHaveLength(1);
  });
});

describe('dangling database rows', () => {
  it('reports a row whose bytes are gone but does not delete it by default', async () => {
    const account = await signUpAccount();
    const id = await uploadAndGetId(account.accessToken);
    const row = await env.DB.prepare('SELECT object_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ object_key: string }>();
    await env.PHOTOS.delete(row!.object_key);

    const report = await reconcile(env, new Date(Date.now() + 2 * HOUR));

    expect(report.danglingRowsFound).toBe(1);
    // RECONCILE_DELETE_DANGLING_ROWS defaults to "false". Deleting the row
    // destroys the only remaining record that the photo existed, so it is the
    // operator's call, not the job's.
    expect(report.danglingRowsDeleted).toBe(0);
    expect(await countRows('photos')).toBe(1);
  });

  it('deletes the row when the destructive repair is explicitly enabled', async () => {
    const account = await signUpAccount();
    const id = await uploadAndGetId(account.accessToken);
    const row = await env.DB.prepare('SELECT object_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ object_key: string }>();
    await env.PHOTOS.delete(row!.object_key);

    const report = await reconcile(
      { ...env, RECONCILE_DELETE_DANGLING_ROWS: 'true' },
      new Date(Date.now() + 2 * HOUR),
    );

    expect(report.danglingRowsFound).toBe(1);
    expect(report.danglingRowsDeleted).toBe(1);
    expect(await countRows('photos')).toBe(0);
  });

  it('leaves a recently created row alone even with the repair enabled', async () => {
    const account = await signUpAccount();
    const id = await uploadAndGetId(account.accessToken);
    const row = await env.DB.prepare('SELECT object_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ object_key: string }>();
    await env.PHOTOS.delete(row!.object_key);

    const report = await reconcile({ ...env, RECONCILE_DELETE_DANGLING_ROWS: 'true' }, new Date());

    expect(report.danglingRowsFound).toBe(0);
    expect(await countRows('photos')).toBe(1);
  });
});

describe('a healthy system', () => {
  it('finds nothing to do', async () => {
    const account = await signUpAccount();
    await uploadAndGetId(account.accessToken);
    await uploadAndGetId(account.accessToken);

    const report = await reconcile(env, new Date(Date.now() + 2 * HOUR));

    expect(report.orphanObjectsFound).toBe(0);
    expect(report.danglingRowsFound).toBe(0);
    expect(report.errors).toEqual([]);
    expect(report.objectsScanned).toBe(2);
    expect(report.rowsScanned).toBe(2);
    expect(await countRows('photos')).toBe(2);
    expect(await listObjectKeys()).toHaveLength(2);
  });
});

describe('session purging', () => {
  it('deletes expired sessions', async () => {
    const account = await signUpAccount();
    await signInAccount(account.email, account.password, { ip: '198.51.100.51' });
    expect(await countRows('sessions')).toBe(2);

    const sessionId = account.refreshToken.split('.')[0]!;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), sessionId)
      .run();

    const report = await reconcile(env);

    expect(report.expiredSessionsPurged).toBe(1);
    expect(await countRows('sessions')).toBe(1);
  });

  it('keeps a recently revoked session, so token replay stays detectable', async () => {
    const account = await signUpAccount();
    const sessionId = account.refreshToken.split('.')[0]!;
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), sessionId)
      .run();

    const report = await reconcile(env);

    // If this row were purged immediately, a replayed refresh token would look
    // like an unknown token rather than a stolen one, and the "revoke
    // everything" response in accounts.ts would never fire.
    expect(report.expiredSessionsPurged).toBe(0);
    expect(await countRows('sessions')).toBe(1);
  });

  it('purges a revoked session once the retention period has passed', async () => {
    const account = await signUpAccount();
    const sessionId = account.refreshToken.split('.')[0]!;
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), sessionId)
      .run();

    // 31 days later.
    const report = await reconcile(env, new Date(Date.now() + 31 * 24 * HOUR));

    expect(report.expiredSessionsPurged).toBe(1);
    expect(await countRows('sessions')).toBe(0);
  });
});

describe('failure handling', () => {
  it('records the error and does not delete anything when R2 cannot be listed', async () => {
    const account = await signUpAccount();
    await uploadAndGetId(account.accessToken);

    const brokenBucket = {
      list() {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;

    const report = await reconcile(
      { ...env, PHOTOS: brokenBucket },
      new Date(Date.now() + 2 * HOUR),
    );

    expect(report.errors.join(' ')).toContain('R2 unavailable');
    expect(report.completeScan).toBe(false);
    // Crucially: a failed enumeration must not be mistaken for "nothing is
    // there", which would make every row look dangling.
    expect(report.danglingRowsFound).toBe(0);
    expect(await countRows('photos')).toBe(1);
  });

  it('runs through the scheduled handler the Cron Trigger calls', async () => {
    const account = await signUpAccount();
    await uploadAndGetId(account.accessToken);
    await createOrphan(`photos/${account.userId}/pht_cccccccccccccccccccccccccccccccc`);

    const worker = (await import('../src/index')).default;
    // The real entry point, with a scheduledTime two hours in the future so
    // the grace period has passed.
    await worker.scheduled(
      {
        scheduledTime: Date.now() + 2 * HOUR,
        cron: '17 3 * * *',
        noRetry() {},
      } as ScheduledController,
      env,
    );

    expect(await listObjectKeys()).toHaveLength(1);
  });
});
