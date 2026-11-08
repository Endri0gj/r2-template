import type { ApiErrorBody, ApiErrorCode } from './types';

/**
 * Response helpers. Every endpoint returns either `{ data }` or
 * `{ error: { code, message } }`, so the client has exactly two shapes to
 * handle instead of guessing per route.
 */

/**
 * Headers applied to EVERY response, including errors and image bytes.
 *
 * `x-content-type-options: nosniff` is the one that genuinely matters here,
 * and it matters because this service serves bytes a user uploaded. Without
 * it, a browser may ignore the `Content-Type` we send and guess from the
 * content instead - so a file that passes our JPEG magic-byte check but also
 * contains HTML could be rendered as a document in the user's session rather
 * than displayed as a picture. `nosniff` tells the browser to believe the
 * declared type or render nothing.
 *
 * The rest close off framing, referrer leakage and cross-origin embedding.
 * They cost nothing and remove whole categories of question.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
  // This is a JSON/image API with no HTML and no scripts of its own, so the
  // most restrictive policy that exists is also the correct one.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
};

export function applySecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // `set`, not `append`: a handler that deliberately chose a different value
    // (there are none today) should not end up with two conflicting headers.
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Metadata is per-user and changes on every upload. Never let a CDN or
      // the device cache it. On the auth endpoints this is not a nicety: the
      // response body contains tokens.
      'cache-control': 'no-store',
      ...init.headers,
    },
  });
}

export function errorResponse(status: number, code: ApiErrorCode, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return jsonResponse(body, { status });
}

/**
 * 401 responses advertise the scheme, per RFC 9110. Without this header a
 * client cannot tell "you forgot to authenticate" from "your token is wrong".
 *
 * The message is intentionally the same for a missing token, an expired token
 * and a forged one. The client distinguishes them by refreshing and retrying,
 * which works in all three cases; telling an attacker *which* part of their
 * token was wrong helps only the attacker.
 */
export function unauthorized(message = 'Missing or invalid access token.'): Response {
  const response = errorResponse(401, 'unauthorized', message);
  response.headers.set('www-authenticate', 'Bearer realm="photo-vault"');
  return response;
}

/**
 * 429. `Retry-After` is part of the contract, not decoration: without it a
 * client has to guess, and the usual guess is "retry immediately", which is
 * how a rate limit turns into a hot loop.
 */
export function rateLimited(retryAfterSeconds: number): Response {
  const response = errorResponse(429, 'rate_limited', 'Too many requests. Slow down.');
  response.headers.set('retry-after', String(retryAfterSeconds));
  return response;
}
