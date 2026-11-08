import path from 'node:path';

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * One Vitest installation, two projects, because the two halves of this repo
 * run in genuinely different places:
 *
 *   worker  -> runs inside `workerd`, the real Workers runtime, with real
 *              (locally simulated) R2, D1 and rate-limiter bindings. Not
 *              mocks: an upload in a test really writes bytes into a local R2
 *              bucket, and a sign-in really runs PBKDF2 and really inserts a
 *              session row.
 *   app     -> runs in jsdom, and tests the React state machines that drive
 *              the gallery and the sign-in screens.
 *
 * Run both with `npm test`, or one with `npm test -- --project=worker`.
 */

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          // The options factory may be async, which is how the migration SQL
          // gets read in Node (the test code itself runs inside workerd and has
          // no filesystem).
          cloudflareTest(async () => ({
            // Reuse the real Worker config so tests and `wrangler dev` cannot
            // drift apart. Bindings, vars, rate limiters and the compatibility
            // date all come from the same file you deploy with.
            wrangler: { configPath: './server/wrangler.jsonc' },
            miniflare: {
              bindings: {
                // A fixed signing key, so a token minted in one test can be
                // asserted against in another. Its value is irrelevant - what
                // matters is that it is present, because the Worker refuses to
                // authenticate anything when AUTH_SECRET is missing.
                AUTH_SECRET: 'test-signing-secret-not-used-anywhere-else',

                /**
                 * The cost factor is turned DOWN for tests, and this is worth
                 * being explicit about: these tests verify the password hash's
                 * encoding, its verification and its upgrade path - not how
                 * expensive it is. At the production 600,000 iterations the
                 * suite would spend most of its time in PBKDF2 for no extra
                 * coverage.
                 *
                 * The cost factor itself is covered separately, by asserting
                 * on DEFAULT_ITERATIONS and on resolveIterations()' floor.
                 */
                PASSWORD_ITERATIONS: '1000',

                // Short enough that an "expired access token" test can be
                // written without mocking the clock.
                ACCESS_TOKEN_TTL_SECONDS: '900',
                REFRESH_TOKEN_TTL_SECONDS: '2592000',

                SIGNUP_MODE: 'open',
                SIGNUP_INVITE_CODES: 'test-invite-code,second-test-code',

                // Kept small so the "too large" test does not have to build a
                // 5 MB buffer.
                MAX_UPLOAD_BYTES: '2048',
                ALLOWED_ORIGINS: 'http://localhost:8081',

                // Read at config time, in Node. The SQL arrives inside the
                // Worker as an ordinary binding.
                TEST_MIGRATIONS: await readD1Migrations(
                  path.join(import.meta.dirname, 'server/migrations'),
                ),
              },
            },
          })),
        ],
        test: {
          name: 'worker',
          include: ['server/test/**/*.spec.ts'],
          setupFiles: ['./server/test/setup.ts'],
        },
      },
      {
        test: {
          name: 'app',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        },
        resolve: {
          alias: {
            '@': path.join(import.meta.dirname, 'src'),
          },
        },
      },
    ],
  },
});
