import { getConfig } from './config';
import { PhotoVaultError, type PhotoVaultErrorCode } from './types';

/**
 * The one place that performs a request and turns a failure into a
 * `PhotoVaultError`.
 *
 * Deliberately knows nothing about credentials. The auth endpoints
 * (src/lib/photo-vault/auth.ts) use it raw, because they are how a credential
 * is obtained in the first place; everything else goes through the wrapper in
 * src/lib/photo-vault/client.ts, which attaches an access token and retries
 * once after refreshing it. Keeping those two concerns apart is what stops a
 * failed sign-in from triggering a token refresh, which would try to sign in
 * again.
 */

interface ApiErrorShape {
  error?: { code?: string; message?: string };
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'CanceledError');
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl } = getConfig();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    if (isAbort(cause)) throw new PhotoVaultError('cancelled', 'Request cancelled.');
    // React Native collapses every transport problem - wrong host, no route,
    // server not running, TLS failure - into "Network request failed". Say
    // where we were trying to go, or this error is undebuggable.
    throw new PhotoVaultError('network', `Could not reach the API at ${baseUrl}.`);
  }

  if (response.ok) return response;

  let code: PhotoVaultErrorCode = 'unknown';
  let message = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as ApiErrorShape;
    if (body.error?.code) code = body.error.code as PhotoVaultErrorCode;
    if (body.error?.message) message = body.error.message;
  } catch {
    // A non-JSON error body (a proxy's HTML page, say). Keep the generic text.
  }

  // 429 carries a Retry-After the user can be told about, and the server's
  // prose ("Too many requests. Slow down.") is less useful than a number.
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      message = `Too many requests. Try again in ${retryAfter} seconds.`;
    }
  }

  throw new PhotoVaultError(code, message, response.status);
}

/** POSTs a JSON body and parses the `{ data }` envelope out of the response. */
export async function postJson<T>(
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<T> {
  const response = await apiFetch(path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as { data: T };
  return parsed.data;
}
