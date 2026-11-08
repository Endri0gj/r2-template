import { resolveAccessTtlSeconds, resolveRefreshTtlSeconds, type Principal } from './auth';
import {
  normalizeEmail,
  parseInviteCodes,
  resolveSignupMode,
  sanitizeUserAgent,
  validateEmail,
  validatePassword,
} from './credentials';
import { constantTimeEquals, randomSecret, sha256Base64Url } from './encoding';
import { errorResponse, jsonResponse, rateLimited, unauthorized } from './http';
import { newSessionId, newUserId, SESSION_ID_PATTERN } from './ids';
import { issueAccessToken } from './jwt';
import { applyLimit, AUTH_WINDOW_SECONDS } from './ratelimit';
import {
  decoyPasswordHash,
  hashPassword,
  needsRehash,
  resolveIterations,
  verifyPassword,
} from './password';
import {
  toAccount,
  type AccountView,
  type Env,
  type SessionRow,
  type SessionView,
  type UserRow,
} from './types';

/**
 * Accounts and sessions.
 *
 *   POST /auth/signup      create an account, return a session
 *   POST /auth/signin      exchange a password for a session
 *   POST /auth/refresh     exchange a refresh token for a new session pair
 *   POST /auth/signout     revoke one session (this device)
 *   POST /auth/signout-all revoke every session for the caller
 *   GET  /auth/me          who am I
 *
 * ## The two-token design, and why it is not one token
 *
 * A single long-lived token would be simpler and would be wrong in one of two
 * ways: either it is a JWT, in which case signing out does nothing until it
 * expires, or it is a database token, in which case every request - including
 * every thumbnail in the gallery - costs a D1 read to resolve.
 *
 * So there are two:
 *
 *   ACCESS token   A signed JWT, 15 minutes, verified with one HMAC and zero
 *                  database reads. Sent on every request. Not revocable.
 *   REFRESH token  An opaque `ses_<id>.<secret>`, 30 days, stored HASHED in
 *                  D1. Sent only to /auth/refresh. Instantly revocable,
 *                  because every refresh reads and writes its row.
 *
 * The device keeps the refresh token in the OS keychain and the access token in
 * memory only.
 *
 * ## Refresh rotation and theft detection
 *
 * Every refresh invalidates the token it was called with and issues a new one.
 * That means a stolen refresh token is usable at most once before the real
 * device's next refresh breaks it - and, more usefully, that presenting an
 * already-rotated token is a detectable event. When that happens we revoke
 * every session for that user, on the assumption that a token was copied.
 *
 * The honest caveat: two concurrent refreshes from the same device would also
 * look like this and would sign the user out. The client prevents it by
 * keeping only one refresh in flight (see src/lib/photo-vault/auth.ts), which
 * is a requirement this design places on the client, not an accident.
 */

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const MAX_JSON_BODY_BYTES = 4 * 1024;

type JsonResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Reads a small JSON body. Bounded, because this runs before authentication on
 * three of the six routes above - an unauthenticated endpoint that will buffer
 * whatever you send it is a free memory-pressure lever.
 */
async function readJson(request: Request): Promise<JsonResult<Record<string, unknown>>> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > MAX_JSON_BODY_BYTES) {
    return {
      ok: false,
      response: errorResponse(413, 'payload_too_large', 'Request body is too large.'),
    };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, 'bad_request', 'Could not read the body.') };
  }

  // A chunked request has no Content-Length, so the real limit is checked here
  // too - after reading, which is acceptable only because the value is small.
  if (text.length > MAX_JSON_BODY_BYTES) {
    return {
      ok: false,
      response: errorResponse(413, 'payload_too_large', 'Request body is too large.'),
    };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        response: errorResponse(400, 'bad_request', 'Body must be a JSON object.'),
      };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorResponse(400, 'bad_request', 'Body must be valid JSON.') };
  }
}

function requireAuthSecret(env: Env): Response | null {
  if (env.AUTH_SECRET) return null;
  console.error('AUTH_SECRET is not set; cannot issue tokens.');
  return errorResponse(500, 'internal_error', 'Server is not configured.');
}

/**
 * Creates a session row and returns the tokens for it.
 *
 * The refresh token is `<session id>.<secret>`. Splitting it this way means the
 * lookup is a primary-key read rather than a scan over hashes, while the half
 * that proves ownership is never stored - only its SHA-256 is.
 */
async function createSession(
  env: Env,
  user: Pick<UserRow, 'id' | 'email' | 'created_at'>,
  userAgent: string | null,
  now: Date,
): Promise<SessionView> {
  const accessTtl = resolveAccessTtlSeconds(env.ACCESS_TOKEN_TTL_SECONDS);
  const refreshTtl = resolveRefreshTtlSeconds(env.REFRESH_TOKEN_TTL_SECONDS);

  const sessionId = newSessionId();
  const secret = randomSecret();
  const nowIso = now.toISOString();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      user.id,
      await sha256Base64Url(secret),
      nowIso,
      new Date(now.getTime() + refreshTtl * 1000).toISOString(),
      nowIso,
      userAgent,
    )
    .run();

  const issuedAt = Math.floor(now.getTime() / 1000);
  const accessToken = await issueAccessToken(
    { sub: user.id, sid: sessionId, iat: issuedAt, exp: issuedAt + accessTtl },
    env.AUTH_SECRET,
  );

  return {
    accessToken,
    refreshToken: `${sessionId}.${secret}`,
    expiresIn: accessTtl,
    user: toAccount(user),
  };
}

/* ------------------------------------------------------------------ *
 * POST /auth/signup
 * ------------------------------------------------------------------ */

export async function signUp(request: Request, env: Env): Promise<Response> {
  const configError = requireAuthSecret(env);
  if (configError) return configError;

  const mode = resolveSignupMode(env.SIGNUP_MODE);
  if (mode === 'closed') {
    return errorResponse(403, 'signup_disabled', 'Sign-up is not open on this server.');
  }

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const emailProblem = validateEmail(body.value.email);
  if (emailProblem) return errorResponse(422, 'validation_failed', emailProblem.message);
  const passwordProblem = validatePassword(body.value.password);
  if (passwordProblem) return errorResponse(422, 'validation_failed', passwordProblem.message);

  if (mode === 'invite') {
    const presented = typeof body.value.inviteCode === 'string' ? body.value.inviteCode : '';
    const codes = parseInviteCodes(env.SIGNUP_INVITE_CODES);
    // `some` over a constant-time compare: the number of configured codes is
    // not a secret, but which one matched - and how much of it matched - is.
    const accepted =
      presented !== '' && codes.some((code) => constantTimeEquals(code, presented));
    if (!accepted) {
      return errorResponse(403, 'invalid_invite', 'That invite code is not valid.');
    }
  }

  const email = normalizeEmail(body.value.email as string);
  const password = body.value.password as string;
  const iterations = resolveIterations(env.PASSWORD_ITERATIONS);
  const now = new Date();
  const user: Pick<UserRow, 'id' | 'email' | 'created_at'> = {
    id: newUserId(),
    email,
    created_at: now.toISOString(),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(user.id, user.email, await hashPassword(password, iterations), user.created_at)
      .run();
  } catch (cause) {
    // The UNIQUE constraint on `email` is what decides this, not a prior
    // SELECT. Checking first and inserting second is a race: two simultaneous
    // sign-ups with the same address would both see "available". Letting the
    // database be the authority removes the race entirely.
    const message = String(cause);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return errorResponse(409, 'email_taken', 'An account with that email already exists.');
    }
    throw cause;
  }

  const session = await createSession(
    env,
    user,
    sanitizeUserAgent(request.headers.get('user-agent')),
    now,
  );
  return jsonResponse({ data: session }, { status: 201 });
}

/* ------------------------------------------------------------------ *
 * POST /auth/signin
 * ------------------------------------------------------------------ */

export async function signIn(request: Request, env: Env): Promise<Response> {
  const configError = requireAuthSecret(env);
  if (configError) return configError;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  // Deliberately NOT the detailed validation errors sign-up returns. On
  // sign-in, "that is not a valid email" and "wrong password" must be the same
  // answer, or the endpoint reports which addresses have accounts.
  if (typeof body.value.email !== 'string' || typeof body.value.password !== 'string') {
    return errorResponse(400, 'bad_request', 'Email and password are required.');
  }

  const email = normalizeEmail(body.value.email);
  const password = body.value.password;
  const iterations = resolveIterations(env.PASSWORD_ITERATIONS);

  // Per-account limit, on top of the per-IP limit the router already applied.
  // This is the one that stops credential guessing: an attacker with a
  // botnet defeats a per-IP limit trivially, but every one of their requests
  // targets the same email, so they all land in this bucket.
  //
  // Keyed on the attempted email, which means it costs nothing when the
  // address has no account - and that is on purpose. Limiting only known
  // accounts would make the 429 itself an account-enumeration signal.
  const limit = await applyLimit(env.AUTH_LIMITER, `signin:${email}`, AUTH_WINDOW_SECONDS);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, created_at, disabled_at FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>();

  // Hash against a decoy when the account does not exist, so that the response
  // takes the same few hundred milliseconds either way. Skipping the work here
  // would make this endpoint a fast, reliable account-enumeration oracle no
  // matter what the response body says.
  const storedHash = user?.password_hash ?? (await decoyPasswordHash(iterations));
  const passwordMatches = await verifyPassword(password, storedHash);

  if (!user || !passwordMatches) {
    return errorResponse(401, 'invalid_credentials', 'Incorrect email or password.');
  }

  if (user.disabled_at) {
    return errorResponse(403, 'account_disabled', 'This account has been disabled.');
  }

  // The user just proved they know the password, so this is the one moment we
  // can upgrade a hash made with a lower iteration count - we have the
  // plaintext, and we will not have it again. Failure here must not fail the
  // sign-in: they authenticated correctly.
  if (needsRehash(user.password_hash, iterations)) {
    try {
      await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
        .bind(await hashPassword(password, iterations), user.id)
        .run();
    } catch (cause) {
      console.error('Could not upgrade password hash', { userId: user.id, cause: String(cause) });
    }
  }

  const session = await createSession(
    env,
    user,
    sanitizeUserAgent(request.headers.get('user-agent')),
    new Date(),
  );
  return jsonResponse({ data: session });
}

/* ------------------------------------------------------------------ *
 * POST /auth/refresh
 * ------------------------------------------------------------------ */

interface ParsedRefreshToken {
  sessionId: string;
  secret: string;
}

function parseRefreshToken(raw: unknown): ParsedRefreshToken | null {
  if (typeof raw !== 'string') return null;
  const separator = raw.indexOf('.');
  if (separator <= 0) return null;
  const sessionId = raw.slice(0, separator);
  const secret = raw.slice(separator + 1);
  if (!SESSION_ID_PATTERN.test(sessionId) || secret.length === 0) return null;
  return { sessionId, secret };
}

/** Revokes every live session for a user. Used on logout-everywhere and on theft. */
async function revokeAllSessions(env: Env, userId: string, nowIso: string): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  )
    .bind(nowIso, userId)
    .run();
  return result.meta.changes;
}

export async function refresh(request: Request, env: Env): Promise<Response> {
  const configError = requireAuthSecret(env);
  if (configError) return configError;

  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = parseRefreshToken(body.value.refreshToken);
  if (!parsed) return unauthorized('Invalid refresh token.');

  const session = await env.DB.prepare(
    `SELECT id, user_id, token_hash, created_at, expires_at, last_used_at, revoked_at, user_agent
       FROM sessions WHERE id = ?`,
  )
    .bind(parsed.sessionId)
    .first<SessionRow>();

  if (!session) return unauthorized('Invalid refresh token.');

  const presentedHash = await sha256Base64Url(parsed.secret);
  if (!constantTimeEquals(presentedHash, session.token_hash)) {
    return unauthorized('Invalid refresh token.');
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // The secret was correct but this token has already been rotated away. Either
  // a copy of it leaked, or the client broke its one-refresh-at-a-time rule.
  // Both are answered the same way: assume the worst and end every session.
  if (session.revoked_at) {
    const revoked = await revokeAllSessions(env, session.user_id, nowIso);
    console.error('Revoked refresh token was replayed; signing out all sessions', {
      sessionId: session.id,
      userId: session.user_id,
      sessionsRevoked: revoked,
    });
    return unauthorized('This session has been revoked. Sign in again.');
  }

  // Expiry is compared as text, which works because every timestamp in this
  // schema is an ISO-8601 UTC string - fixed width, so lexicographic order and
  // chronological order are the same thing.
  if (session.expires_at <= nowIso) {
    return unauthorized('This session has expired. Sign in again.');
  }

  const user = await env.DB.prepare(
    `SELECT id, email, password_hash, created_at, disabled_at FROM users WHERE id = ?`,
  )
    .bind(session.user_id)
    .first<UserRow>();

  if (!user) {
    // The account went away under a live session. Nothing to refresh into.
    await revokeAllSessions(env, session.user_id, nowIso);
    return unauthorized('This session is no longer valid.');
  }
  if (user.disabled_at) {
    await revokeAllSessions(env, user.id, nowIso);
    return errorResponse(403, 'account_disabled', 'This account has been disabled.');
  }

  // Rotate: mark the presented token spent, then issue a fresh pair. Marking
  // first means a crash between the two statements leaves the user needing to
  // sign in again - annoying, and far better than a token that stays valid
  // after it has been handed out twice.
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ?, last_used_at = ? WHERE id = ?`)
    .bind(nowIso, nowIso, session.id)
    .run();

  const next = await createSession(
    env,
    user,
    sanitizeUserAgent(request.headers.get('user-agent')) ?? session.user_agent,
    now,
  );
  return jsonResponse({ data: next });
}

/* ------------------------------------------------------------------ *
 * POST /auth/signout
 * ------------------------------------------------------------------ */

/**
 * Revokes one session. Takes the refresh token rather than reading the access
 * token, so that signing out works even once the access token has expired -
 * which is exactly when a user is most likely to want it to.
 *
 * Always answers 200. "That token was already invalid" is not a problem the
 * caller can act on, and reporting it would let an unauthenticated caller
 * probe which session ids exist.
 */
export async function signOut(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;

  const parsed = parseRefreshToken(body.value.refreshToken);
  if (parsed) {
    const session = await env.DB.prepare(`SELECT token_hash FROM sessions WHERE id = ?`)
      .bind(parsed.sessionId)
      .first<Pick<SessionRow, 'token_hash'>>();

    // Still verify the secret. Without this, knowing a session id - which is
    // the non-secret half of somebody's token - would be enough to sign them
    // out at will.
    if (session && constantTimeEquals(await sha256Base64Url(parsed.secret), session.token_hash)) {
      await env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      )
        .bind(new Date().toISOString(), parsed.sessionId)
        .run();
    }
  }

  return jsonResponse({ data: { signedOut: true } });
}

/** Revokes every session for the authenticated caller. */
export async function signOutEverywhere(env: Env, principal: Principal): Promise<Response> {
  const revoked = await revokeAllSessions(env, principal.id, new Date().toISOString());
  return jsonResponse({ data: { signedOut: true, sessionsRevoked: revoked } });
}

/* ------------------------------------------------------------------ *
 * GET /auth/me
 * ------------------------------------------------------------------ */

export async function me(env: Env, principal: Principal): Promise<Response> {
  const user = await env.DB.prepare(
    `SELECT id, email, created_at, disabled_at FROM users WHERE id = ?`,
  )
    .bind(principal.id)
    .first<Pick<UserRow, 'id' | 'email' | 'created_at' | 'disabled_at'>>();

  // A valid token for a user who no longer exists, or who was disabled after
  // the token was minted. This route is where the app notices, because it is
  // the one route that does read the user row.
  if (!user) return unauthorized('This session is no longer valid.');
  if (user.disabled_at) {
    return errorResponse(403, 'account_disabled', 'This account has been disabled.');
  }

  const account: AccountView = toAccount(user);
  return jsonResponse({ data: { user: account } });
}
