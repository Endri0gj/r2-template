import type { Env } from './types';

/**
 * CORS, only for the browser.
 *
 * A native iOS/Android app is not a browser: it has no origin and the
 * same-origin policy does not apply to it, so none of this is needed for the
 * phone. It is needed only when you run `npx expo start --web`, because then
 * the app is a web page on localhost:8081 calling an API on localhost:8787.
 *
 * The allowlist is explicit and defaults to empty. `Access-Control-Allow-Origin: *`
 * would be wrong here: this API requires an Authorization header, and a
 * wildcard origin combined with credentials is exactly how you build a
 * cross-site data leak.
 */

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Headers to merge into a real response, or null if this origin gets none. */
export function corsHeaders(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // Not a browser request.
  if (!allowedOrigins(env).includes(origin)) return null;

  return {
    'access-control-allow-origin': origin,
    // Tells caches that the response body depends on the Origin header, so a
    // response generated for one origin is never reused for another.
    vary: 'Origin',
  };
}

/**
 * Answers the browser's preflight `OPTIONS` request. The browser sends this
 * before any request carrying an Authorization header, and will not send the
 * real request unless the answer explicitly permits the method and header.
 */
export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;

  const headers = corsHeaders(request, env);
  if (!headers) return new Response(null, { status: 403 });

  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-filename, if-none-match',
      'access-control-expose-headers': 'etag',
      'access-control-max-age': '86400',
    },
  });
}

export function withCors(response: Response, request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  if (!headers) return response;
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}
