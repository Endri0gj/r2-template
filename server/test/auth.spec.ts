import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { issueAccessToken, verifyAccessToken } from '../src/jwt';
import { DEFAULT_ITERATIONS, hashPassword, resolveIterations, verifyPassword } from '../src/password';
import type { Env, SessionRow } from '../src/types';
import {
  TEST_PASSWORD,
  call,
  countRows,
  pngBytes,
  postJson,
  signInAccount,
  signUpAccount,
  uniqueEmail,
  upload,
  uploadAndGetId,
} from './helpers';

/**
 * Authentication and session management, against the real local D1.
 *
 * PASSWORD_ITERATIONS is 1000 here (vitest.config.mts) rather than the
 * production 600,000 - see the comment there. The cost factor itself is
 * asserted separately at the bottom of this file.
 */

describe('POST /auth/signup', () => {
  it('creates a user, a session, and returns a usable access token', async () => {
    const email = uniqueEmail();
    const response = await postJson('/auth/signup', { email, password: TEST_PASSWORD });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        user: { id: string; email: string };
      };
    };

    expect(body.data.user.email).toBe(email);
    expect(body.data.user.id).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(body.data.refreshToken).toMatch(/^ses_[0-9a-f]{32}\./);
    expect(body.data.expiresIn).toBe(900);

    expect(await countRows('users')).toBe(1);
    expect(await countRows('sessions')).toBe(1);

    // The token actually works.
    const listed = await call('/photos', { token: body.data.accessToken });
    expect(listed.status).toBe(200);
  });

  it('never returns the password hash', async () => {
    const response = await postJson('/auth/signup', {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
    });
    const text = await response.text();
    expect(text).not.toContain('password');
    expect(text).not.toContain('pbkdf2');
  });

  it('stores the email lowercased, so case cannot create two accounts', async () => {
    const email = uniqueEmail();
    const first = await postJson('/auth/signup', {
      email: email.toUpperCase(),
      password: TEST_PASSWORD,
    });
    expect(first.status).toBe(201);

    const second = await postJson('/auth/signup', { email, password: TEST_PASSWORD });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('email_taken');
    expect(await countRows('users')).toBe(1);
  });

  it('rejects a short password', async () => {
    const response = await postJson('/auth/signup', { email: uniqueEmail(), password: 'short' });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toContain('12 characters');
    expect(await countRows('users')).toBe(0);
  });

  it('rejects a malformed email', async () => {
    const response = await postJson('/auth/signup', {
      email: 'not-an-email',
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(422);
    expect(await countRows('users')).toBe(0);
  });

  it('rejects a non-JSON body', async () => {
    const response = await call('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);
  });

  it('rejects an oversized JSON body before parsing it', async () => {
    const response = await postJson('/auth/signup', {
      email: uniqueEmail(),
      password: 'x'.repeat(8192),
    });
    expect(response.status).toBe(413);
    expect(await countRows('users')).toBe(0);
  });

  it('rejects a GET', async () => {
    const response = await call('/auth/signup');
    expect(response.status).toBe(405);
  });
});

describe('POST /auth/signup with an invite gate', () => {
  // SIGNUP_MODE comes from the config as "open", so these tests override it
  // per call. That is the same mechanism production uses - a var - which is
  // why it can be exercised this way at all.
  //
  // Note the type: `Env` from ../src/types, NOT `typeof env`. `wrangler types`
  // generates `Cloudflare.Env` by reading wrangler.jsonc, and it narrows each
  // var to a literal union of the values it finds there - so `SIGNUP_MODE`
  // comes out as `"open" | "invite"`, and "closed" is not assignable to it
  // even though the Worker handles it. That narrowing is exactly why the
  // Worker declares its own `Env` instead of using the generated one.
  const inviteEnv: Env = { ...env, SIGNUP_MODE: 'invite' };
  const closedEnv: Env = { ...env, SIGNUP_MODE: 'closed' };

  async function signupWith(overrideEnv: Env, body: Record<string, unknown>): Promise<Response> {
    const worker = (await import('../src/index')).default;
    const request = new Request('https://vault.test/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify(body),
    });
    return worker.fetch(request, overrideEnv);
  }

  it('accepts a valid invite code', async () => {
    const response = await signupWith(inviteEnv, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      inviteCode: 'test-invite-code',
    });
    expect(response.status).toBe(201);
  });

  it('refuses a wrong invite code and creates nothing', async () => {
    const response = await signupWith(inviteEnv, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      inviteCode: 'wrong-code',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_invite',
    );
    expect(await countRows('users')).toBe(0);
  });

  it('refuses a missing invite code', async () => {
    const response = await signupWith(inviteEnv, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(403);
  });

  it('refuses everything when sign-up is closed', async () => {
    const response = await signupWith(closedEnv, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
      inviteCode: 'test-invite-code',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'signup_disabled',
    );
  });

  it('treats an unrecognised SIGNUP_MODE as closed, not open', async () => {
    const response = await signupWith({ ...env, SIGNUP_MODE: 'opne' }, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(403);
  });

  it('treats an unset SIGNUP_MODE as closed', async () => {
    const response = await signupWith({ ...env, SIGNUP_MODE: undefined }, {
      email: uniqueEmail(),
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(403);
  });
});

describe('POST /auth/signin', () => {
  it('exchanges a correct password for a new session', async () => {
    const account = await signUpAccount();
    expect(await countRows('sessions')).toBe(1);

    const session = await signInAccount(account.email, account.password);
    expect(session.user.id).toBe(account.userId);
    expect(session.accessToken).not.toBe(account.accessToken);
    expect(session.refreshToken).not.toBe(account.refreshToken);

    // Signing in on a second device adds a session; it does not replace one.
    expect(await countRows('sessions')).toBe(2);
  });

  it('accepts a differently-cased email', async () => {
    const account = await signUpAccount();
    const session = await signInAccount(account.email.toUpperCase(), account.password);
    expect(session.user.id).toBe(account.userId);
  });

  it('rejects a wrong password', async () => {
    const account = await signUpAccount();
    const response = await postJson('/auth/signin', {
      email: account.email,
      password: 'definitely not the password',
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_credentials',
    );
  });

  it('gives an unknown email the identical answer to a wrong password', async () => {
    const account = await signUpAccount();

    const unknown = await postJson('/auth/signin', {
      email: uniqueEmail('nobody'),
      password: TEST_PASSWORD,
    });
    const wrongPassword = await postJson('/auth/signin', {
      email: account.email,
      password: 'wrong password entirely',
    });

    // Same status, same code, same prose. This endpoint must not reveal which
    // email addresses have accounts.
    expect(unknown.status).toBe(wrongPassword.status);
    expect(await unknown.text()).toBe(await wrongPassword.text());
  });

  it('refuses a disabled account', async () => {
    const account = await signUpAccount();
    await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), account.userId)
      .run();

    const response = await postJson('/auth/signin', {
      email: account.email,
      password: account.password,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'account_disabled',
    );
  });

  it('upgrades a password hash made with fewer iterations', async () => {
    const account = await signUpAccount();

    // Re-derive the hash at a genuinely lower cost factor - which is what an
    // old account's row looks like after you raise PASSWORD_ITERATIONS.
    const weak = await hashPassword(account.password, 500);
    expect(weak).toContain('$500$');
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(weak, account.userId)
      .run();

    // Sign-in still works...
    const response = await postJson(
      '/auth/signin',
      { email: account.email, password: account.password },
      { ip: '198.51.100.9' },
    );
    expect(response.status).toBe(200);

    // ...and the hash has been rewritten at the current cost factor.
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(account.userId)
      .first<{ password_hash: string }>();
    expect(row?.password_hash.startsWith('pbkdf2-sha256$1000$')).toBe(true);
    expect(await verifyPassword(account.password, row!.password_hash)).toBe(true);
  });
});

describe('GET /auth/me', () => {
  it('returns the caller and nothing else', async () => {
    const account = await signUpAccount();
    const response = await call('/auth/me', { token: account.accessToken });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { user: { id: string; email: string; createdAt: string } };
    };
    expect(body.data.user.id).toBe(account.userId);
    expect(body.data.user.email).toBe(account.email);
    expect(Object.keys(body.data.user).sort()).toEqual(['createdAt', 'email', 'id']);
  });

  it('401s without a token', async () => {
    const response = await call('/auth/me');
    expect(response.status).toBe(401);
  });

  it('401s for a token whose user row has been deleted', async () => {
    const account = await signUpAccount();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(account.userId).run();

    const response = await call('/auth/me', { token: account.accessToken });
    expect(response.status).toBe(401);
  });

  it('403s for a token whose account was disabled after the token was minted', async () => {
    const account = await signUpAccount();
    await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), account.userId)
      .run();

    const response = await call('/auth/me', { token: account.accessToken });
    expect(response.status).toBe(403);
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new pair and rotates the old one', async () => {
    const account = await signUpAccount();

    const response = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { accessToken: string; refreshToken: string; user: { id: string } };
    };

    expect(body.data.user.id).toBe(account.userId);
    expect(body.data.refreshToken).not.toBe(account.refreshToken);

    // The new access token works.
    expect((await call('/photos', { token: body.data.accessToken })).status).toBe(200);

    // The old session row is revoked, and a new one exists alongside it.
    const oldSessionId = account.refreshToken.split('.')[0]!;
    const old = await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind(oldSessionId)
      .first<Pick<SessionRow, 'revoked_at'>>();
    expect(old?.revoked_at).not.toBeNull();
    expect(await countRows('sessions')).toBe(2);
  });

  it('rejects a refresh token with a wrong secret half', async () => {
    const account = await signUpAccount();
    const sessionId = account.refreshToken.split('.')[0]!;

    const response = await postJson('/auth/refresh', {
      refreshToken: `${sessionId}.totally-wrong-secret`,
    });
    expect(response.status).toBe(401);

    // And the real session is untouched - a failed guess must not be able to
    // lock the legitimate device out.
    const row = await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<Pick<SessionRow, 'revoked_at'>>();
    expect(row?.revoked_at).toBeNull();
  });

  it('rejects a malformed refresh token', async () => {
    for (const refreshToken of ['', 'nonsense', 'ses_short.secret', '.secret', 'ses_x.']) {
      const response = await postJson('/auth/refresh', { refreshToken });
      expect(response.status).toBe(401);
    }
  });

  it('rejects an expired session', async () => {
    const account = await signUpAccount();
    const sessionId = account.refreshToken.split('.')[0]!;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), sessionId)
      .run();

    const response = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(response.status).toBe(401);
  });

  it('revokes every session when an already-rotated token is replayed', async () => {
    const account = await signUpAccount();
    // A second device, so there is something else to lose.
    await signInAccount(account.email, account.password, { ip: '198.51.100.21' });
    expect(await countRows('sessions')).toBe(2);

    // Legitimate rotation.
    const rotated = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(rotated.status).toBe(200);

    // Now replay the token that was rotated away - what a thief with a stolen
    // copy would do.
    const replay = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(replay.status).toBe(401);

    // Everything is revoked, including the session the replay created nothing
    // from and the unrelated second device.
    const { results } = await env.DB.prepare('SELECT revoked_at FROM sessions')
      .all<Pick<SessionRow, 'revoked_at'>>();
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('refuses to refresh a disabled account and revokes its sessions', async () => {
    const account = await signUpAccount();
    await env.DB.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), account.userId)
      .run();

    const response = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(response.status).toBe(403);

    const sessionId = account.refreshToken.split('.')[0]!;
    const row = await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<Pick<SessionRow, 'revoked_at'>>();
    expect(row?.revoked_at).not.toBeNull();
  });
});

describe('POST /auth/signout', () => {
  it('revokes the presented session so it can no longer be refreshed', async () => {
    const account = await signUpAccount();

    const response = await postJson('/auth/signout', { refreshToken: account.refreshToken });
    expect(response.status).toBe(200);

    const refreshed = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it('does not let a session id alone sign somebody out', async () => {
    const account = await signUpAccount();
    const sessionId = account.refreshToken.split('.')[0]!;

    // The id is the non-secret half of the token. Knowing it must not be
    // enough to end the session.
    const response = await postJson('/auth/signout', {
      refreshToken: `${sessionId}.guessed-secret`,
    });
    expect(response.status).toBe(200); // deliberately not an error

    const row = await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind(sessionId)
      .first<Pick<SessionRow, 'revoked_at'>>();
    expect(row?.revoked_at).toBeNull();
  });

  it('answers 200 for a token that never existed, revealing nothing', async () => {
    const response = await postJson('/auth/signout', {
      refreshToken: 'ses_00000000000000000000000000000000.whatever',
    });
    expect(response.status).toBe(200);
  });
});

describe('POST /auth/signout-all', () => {
  it('revokes every session for the caller only', async () => {
    const account = await signUpAccount();
    await signInAccount(account.email, account.password, { ip: '198.51.100.31' });
    const other = await signUpAccount();

    const response = await call('/auth/signout-all', {
      method: 'POST',
      token: account.accessToken,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { sessionsRevoked: number } };
    expect(body.data.sessionsRevoked).toBe(2);

    // The other account's session is untouched.
    const refreshed = await postJson('/auth/refresh', { refreshToken: other.refreshToken });
    expect(refreshed.status).toBe(200);
  });

  it('401s without a token', async () => {
    const response = await call('/auth/signout-all', { method: 'POST' });
    expect(response.status).toBe(401);
  });
});

/**
 * The revocation window, stated as a test rather than only as a comment.
 *
 * This is the documented trade of using a signed access token: revoking a
 * session stops refreshes immediately, but an access token already issued
 * keeps working until it expires. If this test ever starts failing because the
 * access token is rejected, someone has added a database lookup to the hot
 * path - which is a legitimate choice, but a different one.
 */
describe('the access-token revocation window', () => {
  it('still accepts an access token after its session was revoked', async () => {
    const account = await signUpAccount();
    await postJson('/auth/signout', { refreshToken: account.refreshToken });

    const listed = await call('/photos', { token: account.accessToken });
    expect(listed.status).toBe(200);

    // But it cannot be renewed, so the window is bounded by the token's TTL.
    const refreshed = await postJson('/auth/refresh', { refreshToken: account.refreshToken });
    expect(refreshed.status).toBe(401);
  });
});

describe('access token verification', () => {
  const secret = env.AUTH_SECRET;

  it('rejects a token signed with a different secret', async () => {
    const account = await signUpAccount();
    const forged = await issueAccessToken(
      {
        sub: account.userId,
        sid: 'ses_00000000000000000000000000000000',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      'not-the-real-signing-secret',
    );

    const response = await call('/photos', { token: forged });
    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const account = await signUpAccount();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = await issueAccessToken(
      { sub: account.userId, sid: 'ses_00000000000000000000000000000000', iat: past, exp: past + 60 },
      secret,
    );

    const response = await call('/photos', { token: expired });
    expect(response.status).toBe(401);
  });

  it('ignores the token\'s own alg header instead of honouring it', async () => {
    // The classic JWT attack: claim "alg":"none" and present no signature.
    const payload = { sub: 'usr_'.padEnd(36, '0'), sid: 'ses_x', iat: 0, exp: 9_999_999_999 };
    const b64 = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;

    const response = await call('/photos', { token: unsigned });
    expect(response.status).toBe(401);
  });

  it('rejects a token whose payload was edited after signing', async () => {
    const account = await signUpAccount();
    const victim = await signUpAccount();

    const [header, , signature] = account.accessToken.split('.');
    const tamperedPayload = btoa(
      JSON.stringify({
        sub: victim.userId,
        sid: 'ses_00000000000000000000000000000000',
        iss: 'photo-vault-api',
        aud: 'photo-vault-app',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await call('/photos', {
      token: `${header}.${tamperedPayload}.${signature}`,
    });
    expect(response.status).toBe(401);
  });

  it('rejects a token with the wrong audience', async () => {
    const account = await signUpAccount();
    const claims = {
      sub: account.userId,
      sid: 'ses_00000000000000000000000000000000',
      iss: 'photo-vault-api',
      aud: 'some-other-app',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    // Sign it properly, but for a different audience.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const b64 = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    const bytes = new Uint8Array(signature);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const token = `${data}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

    expect((await call('/photos', { token })).status).toBe(401);
    // Confirm it really is only the audience that is wrong.
    const verified = await verifyAccessToken(token, secret);
    expect(verified).toEqual({ ok: false, reason: 'wrong_claims' });
  });

  it('refuses every authenticated request when AUTH_SECRET is unset', async () => {
    const account = await signUpAccount();
    const worker = (await import('../src/index')).default;
    const request = new Request('https://vault.test/photos', {
      headers: { authorization: `Bearer ${account.accessToken}` },
    });

    // Fails closed: no signing secret means no trusted tokens, not "allow all".
    const response = await worker.fetch(request, { ...env, AUTH_SECRET: '' });
    expect(response.status).toBe(401);
  });
});

describe('password hashing', () => {
  it('produces a self-describing hash with a unique salt each time', async () => {
    const a = await hashPassword('the same password', 1000);
    const b = await hashPassword('the same password', 1000);

    expect(a).toMatch(/^pbkdf2-sha256\$1000\$[\w-]+\$[\w-]+$/);
    // Same input, different output: the salt did its job.
    expect(a).not.toBe(b);
    expect(await verifyPassword('the same password', a)).toBe(true);
    expect(await verifyPassword('the same password', b)).toBe(true);
    expect(await verifyPassword('a different password', a)).toBe(false);
  });

  it('fails closed on a corrupt or hostile stored hash', async () => {
    for (const stored of [
      '',
      'garbage',
      'pbkdf2-sha256$1000$onlythree',
      'bcrypt$10$salt$hash',
      // An absurd iteration count would otherwise be a way to burn the CPU
      // limit on every sign-in attempt.
      'pbkdf2-sha256$99999999999$c2FsdA$aGFzaA',
      'pbkdf2-sha256$0$c2FsdA$aGFzaA',
      'pbkdf2-sha256$1000$$aGFzaA',
    ]) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('defaults to the OWASP iteration count and refuses a weaker override', async () => {
    expect(DEFAULT_ITERATIONS).toBe(600_000);
    // A missing, nonsensical or dangerously low value falls back to the
    // default rather than being used as given.
    expect(resolveIterations(undefined)).toBe(DEFAULT_ITERATIONS);
    expect(resolveIterations('not a number')).toBe(DEFAULT_ITERATIONS);
    expect(resolveIterations('10')).toBe(DEFAULT_ITERATIONS);
    expect(resolveIterations('-5')).toBe(DEFAULT_ITERATIONS);
    // An explicit, sane value is honoured.
    expect(resolveIterations('700000')).toBe(700_000);
  });
});

describe('photos are scoped to the account that uploaded them', () => {
  it('gives a freshly created account an empty gallery, not somebody else\'s', async () => {
    const first = await signUpAccount();
    await upload(first.accessToken, pngBytes());

    const second = await signUpAccount();
    const response = await call('/photos', { token: second.accessToken });
    expect(await response.json()).toEqual({ data: { photos: [] } });
  });

  it('survives a token refresh: the same photos are still there', async () => {
    const account = await signUpAccount();
    const id = await uploadAndGetId(account.accessToken);

    const refreshed = (await (
      await postJson('/auth/refresh', { refreshToken: account.refreshToken })
    ).json()) as { data: { accessToken: string } };

    const response = await call('/photos', { token: refreshed.data.accessToken });
    const body = (await response.json()) as { data: { photos: { id: string }[] } };
    expect(body.data.photos.map((photo) => photo.id)).toEqual([id]);
  });
});
