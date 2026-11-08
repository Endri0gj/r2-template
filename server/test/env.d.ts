import type { D1Migration } from '@cloudflare/vitest-plugin';

/**
 * Adds the test-only binding to the type of `env`.
 *
 * `wrangler types` generates `Cloudflare.Env` from wrangler.jsonc, and says in
 * its own output that a project may extend it by redeclaring it - TypeScript
 * merges the declarations. `TEST_MIGRATIONS` exists only under Vitest (it is
 * injected by vitest.config.mts), so it is declared here rather than in the
 * Worker's own types.
 *
 * Note: the Cloudflare docs show augmenting a `ProvidedEnv` interface instead.
 * That pattern predates the `wrangler types`-generated `Cloudflare.Env`, and
 * does not apply here - `env` from "cloudflare:workers" is typed as
 * `Cloudflare.Env`.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
