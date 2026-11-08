/**
 * Rate limiting, via the Workers Rate Limiting binding.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 *
 * ## Why this binding and not Durable Objects or KV
 *
 * It is the simplest thing that works: a config entry, a `limit({ key })`
 * call, no storage to manage and no extra request latency (the count is read
 * from a cache local to the Cloudflare location).
 *
 * ## What it is NOT - read this before you rely on it
 *
 * Limits are **approximate** and **per Cloudflare location**. A configured
 * "10 per minute" means roughly 10 per minute in Frankfurt and another
 * roughly 10 per minute in Singapore, and a burst can exceed the number in
 * either before the background counters catch up. The documentation is explicit
 * about this.
 *
 * So: this is a blunt instrument against brute force and runaway clients, and
 * it is appropriate for that. It is NOT a quota, NOT a billing control, and NOT
 * a defence against a distributed attacker who can choose which Cloudflare
 * location serves them. If you need one strict global number, that is what a
 * Durable Object per key is for - route every request for a key through the
 * same object and have it own the counter.
 *
 * ## Choosing the key
 *
 * Cloudflare's guidance is to key on something that identifies an actor, not
 * an IP, because many users share an IP (carrier NAT, VPNs, offices).
 *
 * This code follows that for authenticated routes: the key is the user id, so
 * one account cannot starve another. The auth routes have no user id yet, and
 * that is the awkward case:
 *
 *   sign-in  -> keyed by the email being attempted. Protects the account
 *               someone is guessing at, which is the attack that matters.
 *   sign-up  -> keyed by IP, against the docs' advice and knowingly. An
 *               unauthenticated endpoint that writes a row and burns ~300 ms
 *               of CPU per call has to be limited by *something*, and IP is
 *               the only signal available before an account exists. The
 *               threshold is set loose enough that a shared IP is unlikely to
 *               hit it legitimately.
 */

/**
 * `simple.period` in wrangler.jsonc must be 10 or 60. These must agree with it,
 * because `limit()` tells us whether a key is over budget but not for how long
 * - so the `Retry-After` we send is derived from the configured window.
 */
export const AUTH_WINDOW_SECONDS = 60;
export const UPLOAD_WINDOW_SECONDS = 60;
export const READ_WINDOW_SECONDS = 60;

export interface LimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const ALLOWED: LimitDecision = { allowed: true, retryAfterSeconds: 0 };

/**
 * Applies one limiter, tolerating a missing binding.
 *
 * The missing-binding case is a deliberate fail-OPEN, which deserves an
 * explanation because fail-open is usually the wrong answer. A rate limiter is
 * availability protection, not an authorization check: if it is unavailable,
 * refusing every request converts "the limiter is misconfigured" into "the API
 * is down", which is a worse outcome than "the API is briefly unprotected".
 *
 * What stops this from being a silent hole is that it is loud (an error in
 * Workers Logs on every request) and that the binding is present in BOTH
 * environments in wrangler.jsonc, so there is no path where production quietly
 * lacks one. Authorization, by contrast, fails closed everywhere - see
 * server/src/auth.ts.
 */
/**
 * The part of a key before its colon - `signin`, `upload`, `read`, `auth-ip`.
 *
 * Logs get this, never the key itself. The keys deliberately contain
 * identifying data (an email address on sign-in, an IP on the unauthenticated
 * routes, a user id elsewhere) because that is what makes them useful as
 * limiter keys, and none of it belongs in Workers Logs, where it would sit for
 * the retention period in front of everyone with dashboard access. The bucket
 * name is enough to tell you which limiter is broken, which is the only thing
 * these two messages exist to say.
 */
function keyKind(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? 'unknown' : key.slice(0, colon);
}

export async function applyLimit(
  limiter: RateLimit | undefined,
  key: string,
  windowSeconds: number,
): Promise<LimitDecision> {
  if (!limiter) {
    console.error('Rate limiter binding is missing; request allowed unlimited', {
      limiter: keyKind(key),
    });
    return ALLOWED;
  }

  try {
    const { success } = await limiter.limit({ key });
    return success ? ALLOWED : { allowed: false, retryAfterSeconds: windowSeconds };
  } catch (cause) {
    console.error('Rate limiter threw; request allowed', {
      limiter: keyKind(key),
      cause: String(cause),
    });
    return ALLOWED;
  }
}
