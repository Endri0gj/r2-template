import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { applyLimit } from '../src/ratelimit';
import { TEST_PASSWORD, call, pngBytes, postJson, signUpAccount, upload } from './helpers';

/**
 * Rate limiting, against Miniflare's real implementation of the Rate Limiting
 * binding (it is backed by a Durable Object locally, so `limit()` genuinely
 * counts).
 *
 * These tests do the opposite of the rest of the suite: they deliberately
 * REUSE one key so the counter builds up. Everywhere else the helpers hand out
 * a fresh email, IP and user per test precisely so this cannot happen by
 * accident.
 *
 * Note what is not asserted: an exact cut-off. The configured limit is 10 per
 * 60 seconds, but the documentation is explicit that the limit is approximate
 * and per Cloudflare location, so "the 11th request fails" is not a promise
 * the platform makes. What is asserted is the property that matters: a
 * sustained burst on one key is eventually refused, with a Retry-After, and a
 * different key is unaffected.
 */

describe('auth rate limiting', () => {
  it('eventually refuses a burst of sign-in attempts against one email', async () => {
    const account = await signUpAccount({ ip: '192.0.2.10' });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await postJson(
        '/auth/signin',
        { email: account.email, password: 'wrong password' },
        // One fixed IP and one fixed email, so both limiter keys are constant.
        { ip: '192.0.2.11' },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        break;
      }
    }

    expect(statuses).toContain(429);
    // And it did not start refusing from the first request.
    expect(statuses[0]).toBe(401);
  });

  it('does not let one account\'s burst lock out a different account', async () => {
    const victim = await signUpAccount({ ip: '192.0.2.20' });
    const attacker = await signUpAccount({ ip: '192.0.2.21' });

    // Burn the attacker's budget.
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await postJson(
        '/auth/signin',
        { email: attacker.email, password: 'wrong' },
        { ip: '192.0.2.21' },
      );
      if (response.status === 429) break;
    }

    // The victim, on a different email and a different IP, is unaffected.
    const response = await postJson(
      '/auth/signin',
      { email: victim.email, password: TEST_PASSWORD },
      { ip: '192.0.2.22' },
    );
    expect(response.status).toBe(200);
  });
});

describe('refresh is not on the auth budget', () => {
  it('still refreshes after the sign-in budget for that IP is exhausted', async () => {
    const ip = '192.0.2.50';
    const account = await signUpAccount({ ip });

    // Burn the AUTH_LIMITER budget for this IP with failed sign-ins.
    let exhausted = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await postJson(
        '/auth/signin',
        { email: `someone-${attempt}@example.test`, password: 'wrong' },
        { ip },
      );
      if (response.status === 429) {
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);

    // A real user on that same address must still be able to renew their
    // session. Behind a corporate NAT this is the difference between "one
    // attacker is throttled" and "the whole office is logged out".
    const refreshed = await postJson(
      '/auth/refresh',
      { refreshToken: account.refreshToken },
      { ip },
    );
    expect(refreshed.status).toBe(200);
  });
});

describe('upload rate limiting', () => {
  it('eventually refuses a burst of uploads from one account', async () => {
    const account = await signUpAccount({ ip: '192.0.2.30' });

    let sawRateLimit = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await upload(account.accessToken, pngBytes(64));
      if (response.status === 429) {
        sawRateLimit = true;
        expect(Number(response.headers.get('retry-after'))).toBe(60);
        break;
      }
      expect(response.status).toBe(201);
    }

    expect(sawRateLimit).toBe(true);
  });

  it('does not refuse reads because writes were limited', async () => {
    const account = await signUpAccount({ ip: '192.0.2.40' });

    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await upload(account.accessToken, pngBytes(64));
      if (response.status === 429) break;
    }

    // READ_LIMITER is a separate namespace with a much larger budget, so the
    // gallery still loads even once uploading has been throttled.
    const listed = await call('/photos', { token: account.accessToken });
    expect(listed.status).toBe(200);
  });
});

describe('applyLimit', () => {
  it('allows the request when the binding is missing, loudly', async () => {
    // Fail-OPEN, deliberately: a rate limiter is availability protection, not
    // an authorization check. See the long comment in server/src/ratelimit.ts.
    const decision = await applyLimit(undefined, 'any-key', 60);
    expect(decision).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('allows the request when the limiter throws', async () => {
    const broken = {
      limit() {
        throw new Error('limiter unavailable');
      },
    } as unknown as RateLimit;

    const decision = await applyLimit(broken, 'any-key', 60);
    expect(decision.allowed).toBe(true);
  });

  it('reports the configured window as the retry delay', async () => {
    const alwaysOver = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;

    const decision = await applyLimit(alwaysOver, 'any-key', 60);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('uses the real binding when one is configured', async () => {
    // Proves the binding exists at all - if wrangler.jsonc lost its
    // `ratelimits` entry, every other test here would silently pass via the
    // fail-open path above.
    expect(env.AUTH_LIMITER).toBeDefined();
    expect(env.UPLOAD_LIMITER).toBeDefined();
    expect(env.READ_LIMITER).toBeDefined();

    const decision = await applyLimit(env.READ_LIMITER, `probe:${crypto.randomUUID()}`, 60);
    expect(decision.allowed).toBe(true);
  });
});
