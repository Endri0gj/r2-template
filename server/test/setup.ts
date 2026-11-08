import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

/**
 * Runs once per test file, before any test in it.
 *
 * Storage in the Workers Vitest integration is isolated PER TEST FILE, not per
 * test: every file gets its own empty D1 database and R2 bucket, but the tests
 * inside one file share them. Empty means no tables either, so each file has to
 * create its own schema - and the honest way to do that is to run the same
 * migrations that `wrangler d1 migrations apply` runs in development and
 * production. If a migration is wrong, these tests break.
 *
 * https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/
 * https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#d1
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

/**
 * Because storage is shared within a file, each test truncates it first.
 * Without this, a test asserting "the bucket is empty" would see objects left
 * by whatever ran before it.
 *
 * Note what is NOT reset: the rate limiters. Those are backed by a Durable
 * Object that this code cannot reach, which is why the helpers give each test
 * distinct limiter keys instead. See server/test/helpers.ts.
 */
beforeEach(async () => {
  // `sessions` first: it has a foreign key to `users`, and deleting the parent
  // rows first would either cascade or fail depending on the pragma in force.
  // Being explicit about the order makes the test setup independent of that.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM photos'),
    env.DB.prepare('DELETE FROM users'),
  ]);

  const listed = await env.PHOTOS.list();
  if (listed.objects.length > 0) {
    // delete() takes up to 1000 keys at once.
    await env.PHOTOS.delete(listed.objects.map((object) => object.key));
  }
});
