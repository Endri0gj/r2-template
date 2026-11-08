import { USER_ID_PATTERN } from './ids';
import { verifyAccessToken } from './jwt';
import type { Env } from './types';

/**
 * Request authentication: turning an `Authorization` header into a user.
 *
 * The shape to notice is that this returns a `Principal` or nothing, and every
 * query in server/src/photos.ts filters on `principal.id`. Authentication
 * answers "who is this", authorization is the `WHERE owner_id = ?` on the
 * statement that actually touches data, and the two are kept separate on
 * purpose: there is no code path that reads or writes a photo without an owner
 * predicate, so forgetting the check is not possible by omission.
 *
 * There is no "unauthenticated local mode", no dev bypass and no flag that
 * turns this off. Local development signs in for real against the local D1.
 * The code path you test is the code path you deploy.
 */

export interface Principal {
  /** The user id. Also the R2 key prefix and `photos.owner_id`. */
  id: string;
  /** The session that issued this token, for logging and targeted revocation. */
  sessionId: string;
}

export type AuthFailure = 'missing' | 'invalid';

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: AuthFailure };

/** Access-token lifetime. Short, because a JWT cannot be revoked early. */
export function resolveAccessTtlSeconds(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15 * 60;
  // Capped. A long-lived access token defeats the entire refresh design, so a
  // config mistake must not be able to produce one.
  return Math.min(Math.floor(parsed), 60 * 60);
}

/** Session lifetime: how long a device stays signed in without re-entering a password. */
export function resolveRefreshTtlSeconds(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30 * 24 * 60 * 60;
  return Math.min(Math.floor(parsed), 365 * 24 * 60 * 60);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolves the caller from a signed access token.
 *
 * No database read happens here, and that is the point - see the note on
 * revocation windows in server/src/jwt.ts. The trade is explicit: an access
 * token stays usable for up to its TTL after the session behind it is revoked.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const token = bearerToken(request);
  if (!token) return { ok: false, reason: 'missing' };

  // A missing signing secret must never degrade to "accept anything". An empty
  // HMAC key is a valid HMAC key, so this has to be checked explicitly rather
  // than relying on verification to fail.
  if (!env.AUTH_SECRET) {
    console.error('AUTH_SECRET is not set; refusing all authenticated requests.');
    return { ok: false, reason: 'invalid' };
  }

  const verified = await verifyAccessToken(token, env.AUTH_SECRET);
  if (!verified.ok) return { ok: false, reason: 'invalid' };

  // The id is pattern-checked even though we signed the token ourselves. It
  // becomes an R2 key prefix and a SQL parameter, and "we signed it" is an
  // argument about this version of the code, not about every row and token that
  // will ever exist.
  if (!USER_ID_PATTERN.test(verified.claims.sub)) {
    console.error('Access token carried a malformed subject', { sub: verified.claims.sub });
    return { ok: false, reason: 'invalid' };
  }

  return { ok: true, principal: { id: verified.claims.sub, sessionId: verified.claims.sid } };
}
