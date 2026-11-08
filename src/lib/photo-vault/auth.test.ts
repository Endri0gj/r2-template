import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The device's session management, in jsdom.
 *
 * `token-store` is mocked so no native keychain is touched, and `http` is
 * mocked so no network is. What is actually under test is the state machine:
 * which token is handed out, when it is renewed, how many renewals happen at
 * once, and what is thrown away on which kind of failure.
 */

vi.mock('./token-store', () => ({
  readRefreshToken: vi.fn(),
  writeRefreshToken: vi.fn(),
  clearRefreshToken: vi.fn(),
}));

vi.mock('./http', () => ({
  apiFetch: vi.fn(),
  postJson: vi.fn(),
}));

const { postJson } = await import('./http');
const { readRefreshToken, writeRefreshToken, clearRefreshToken } = await import('./token-store');
const auth = await import('./auth');
const { PhotoVaultError } = await import('./types');

const USER = { id: 'usr_1', email: 'me@example.test', createdAt: '2026-11-08T00:00:00.000Z' };

/** A promise whose resolution this test controls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sessionResponse(suffix: string, expiresIn = 900) {
  return {
    accessToken: `access-${suffix}`,
    refreshToken: `ses_${suffix}.secret-${suffix}`,
    expiresIn,
    user: USER,
  };
}

beforeEach(() => {
  auth.resetAuthForTests();
  vi.mocked(readRefreshToken).mockResolvedValue(null);
  vi.mocked(writeRefreshToken).mockResolvedValue(undefined);
  vi.mocked(clearRefreshToken).mockResolvedValue(undefined);
  vi.mocked(postJson).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signIn', () => {
  it('stores the refresh token and reports a signed-in state', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));

    const user = await auth.signIn('me@example.test', 'a long enough password');

    expect(user).toEqual(USER);
    expect(postJson).toHaveBeenCalledWith('/auth/signin', {
      email: 'me@example.test',
      password: 'a long enough password',
    });
    // The long-lived half is persisted...
    expect(writeRefreshToken).toHaveBeenCalledWith('ses_a.secret-a');
    expect(auth.getAuthState()).toEqual({ status: 'signed-in', user: USER });
    // ...and the short-lived half is handed out from memory.
    expect(await auth.getAccessToken()).toBe('access-a');
  });

  it('notifies subscribers', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));
    const listener = vi.fn();
    auth.subscribe(listener);

    await auth.signIn('me@example.test', 'password password');

    expect(listener).toHaveBeenCalledWith({ status: 'signed-in', user: USER });
  });

  it('leaves the state signed-out when the server rejects the password', async () => {
    vi.mocked(postJson).mockRejectedValue(
      new PhotoVaultError('invalid_credentials', 'Incorrect email or password.', 401),
    );

    await expect(auth.signIn('me@example.test', 'wrong')).rejects.toThrow(
      'Incorrect email or password.',
    );
    expect(writeRefreshToken).not.toHaveBeenCalled();
    expect(auth.getAuthState().user).toBeNull();
  });
});

/**
 * `getAuthState` is the `getSnapshot` of a `useSyncExternalStore`, so React
 * compares its results with `Object.is`. Returning a fresh object each call
 * makes every render look like a change, which re-renders, which calls it
 * again - "Maximum update depth exceeded", and a blank screen. This happened;
 * these tests are why it will not happen again.
 */
describe('getAuthState snapshot stability', () => {
  it('returns the identical object when nothing has changed', () => {
    expect(auth.getAuthState()).toBe(auth.getAuthState());
  });

  it('returns a new object when the state actually changes', async () => {
    const before = auth.getAuthState();
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));

    await auth.signIn('me@example.test', 'password password');

    const after = auth.getAuthState();
    expect(after).not.toBe(before);
    expect(after).toBe(auth.getAuthState());
  });

  it('stays identical across a token refresh that changes nothing visible', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a', 30));
    vi.mocked(readRefreshToken).mockResolvedValue('ses_a.secret-a');
    await auth.signIn('me@example.test', 'password password');
    const before = auth.getAuthState();

    // A background renewal returns the same user, just a new token.
    vi.mocked(postJson).mockResolvedValue(sessionResponse('b'));
    await auth.getAccessToken();

    // Same account, so the screen has no reason to re-render.
    expect(auth.getAuthState()).toBe(before);
  });
});

describe('signUp', () => {
  it('omits the invite code entirely when none is given', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));

    await auth.signUp('me@example.test', 'a long enough password');

    expect(postJson).toHaveBeenCalledWith('/auth/signup', {
      email: 'me@example.test',
      password: 'a long enough password',
    });
  });

  it('includes the invite code when one is given', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));

    await auth.signUp('me@example.test', 'a long enough password', 'code-123');

    expect(postJson).toHaveBeenCalledWith('/auth/signup', {
      email: 'me@example.test',
      password: 'a long enough password',
      inviteCode: 'code-123',
    });
  });
});

describe('restoreSession', () => {
  it('turns a stored refresh token into a live session', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_old.secret-old');
    vi.mocked(postJson).mockResolvedValue(sessionResponse('new'));

    const state = await auth.restoreSession();

    expect(postJson).toHaveBeenCalledWith('/auth/refresh', {
      refreshToken: 'ses_old.secret-old',
    });
    expect(state).toEqual({ status: 'signed-in', user: USER });
    // The server rotated the token, so the new one must replace the old one.
    expect(writeRefreshToken).toHaveBeenCalledWith('ses_new.secret-new');
  });

  it('reports signed-out when there is no stored token', async () => {
    const state = await auth.restoreSession();

    expect(state).toEqual({ status: 'signed-out', user: null });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('discards a refresh token the server has rejected', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_revoked.secret');
    vi.mocked(postJson).mockRejectedValue(
      new PhotoVaultError('unauthorized', 'This session has been revoked.', 401),
    );

    const state = await auth.restoreSession();

    expect(state.status).toBe('signed-out');
    expect(clearRefreshToken).toHaveBeenCalled();
  });

  it('KEEPS the refresh token when the failure was the network', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_fine.secret');
    vi.mocked(postJson).mockRejectedValue(
      new PhotoVaultError('network', 'Could not reach the API.'),
    );

    await auth.restoreSession();

    // Being in a tunnel is not a reason to make somebody type their password
    // again. The token is almost certainly still valid.
    expect(clearRefreshToken).not.toHaveBeenCalled();
  });
});

describe('getAccessToken', () => {
  it('reuses the cached token while it is comfortably valid', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));
    await auth.signIn('me@example.test', 'password password');
    vi.mocked(postJson).mockClear();

    expect(await auth.getAccessToken()).toBe('access-a');
    expect(await auth.getAccessToken()).toBe('access-a');
    expect(postJson).not.toHaveBeenCalled();
  });

  it('renews early, before the token has actually expired', async () => {
    // 30 seconds of life left - inside the 60-second renewal margin, so the
    // token is still technically valid but must not be handed out.
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a', 30));
    vi.mocked(readRefreshToken).mockResolvedValue('ses_a.secret-a');
    await auth.signIn('me@example.test', 'password password');

    vi.mocked(postJson).mockResolvedValue(sessionResponse('b'));
    const token = await auth.getAccessToken();

    expect(token).toBe('access-b');
    expect(postJson).toHaveBeenLastCalledWith('/auth/refresh', {
      refreshToken: 'ses_a.secret-a',
    });
  });

  it('throws signed_out when there is nothing to refresh with', async () => {
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' });
  });
});

/**
 * The invariant the server's theft detection depends on.
 *
 * The Worker revokes every session for an account when an already-rotated
 * refresh token is presented again. So two concurrent refreshes from this
 * device would sign the user out of everything - the second request would
 * carry a token the first had just spent. These tests pin the behaviour that
 * prevents it.
 */
describe('refresh concurrency', () => {
  it('coalesces concurrent refreshes into a single request', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_old.secret-old');

    // A refresh that is held open, so all five callers are in flight at once.
    const gate = deferred<ReturnType<typeof sessionResponse>>();
    vi.mocked(postJson).mockImplementation(() => gate.promise as Promise<never>);

    // Five callers all want a token at once - which is exactly what a gallery
    // of thumbnails does on a cold start.
    const waiting = Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.getAccessToken(),
    ]);

    // Let the first call reach postJson.
    await Promise.resolve();
    await Promise.resolve();

    gate.resolve(sessionResponse('shared'));
    const tokens = await waiting;

    expect(tokens).toEqual(Array.from({ length: 5 }, () => 'access-shared'));
    // ONE network call, and therefore one rotation.
    expect(postJson).toHaveBeenCalledTimes(1);
  });

  it('allows a new refresh after the previous one has settled', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_old.secret-old');
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a', 30));

    await auth.getAccessToken();
    expect(postJson).toHaveBeenCalledTimes(1);

    // The token from that refresh is already inside the renewal margin, so the
    // next request legitimately refreshes again.
    vi.mocked(postJson).mockResolvedValue(sessionResponse('b'));
    expect(await auth.getAccessToken()).toBe('access-b');
    expect(postJson).toHaveBeenCalledTimes(2);
  });

  it('does not leave a failed refresh stuck in flight', async () => {
    vi.mocked(readRefreshToken).mockResolvedValue('ses_old.secret-old');
    vi.mocked(postJson).mockRejectedValueOnce(
      new PhotoVaultError('network', 'Could not reach the API.'),
    );

    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: 'network' });

    // A second attempt must actually try again rather than await a dead promise.
    vi.mocked(postJson).mockResolvedValue(sessionResponse('b'));
    expect(await auth.getAccessToken()).toBe('access-b');
  });
});

describe('refreshAfterUnauthorized', () => {
  it('renews even when the cached token looked valid', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));
    vi.mocked(readRefreshToken).mockResolvedValue('ses_a.secret-a');
    await auth.signIn('me@example.test', 'password password');
    vi.mocked(postJson).mockClear();

    // getAccessToken would have returned the cached token happily...
    vi.mocked(postJson).mockResolvedValue(sessionResponse('b'));
    const token = await auth.refreshAfterUnauthorized();

    // ...but a 401 means it is not valid, whatever we believed.
    expect(token).toBe('access-b');
    expect(postJson).toHaveBeenCalledWith('/auth/refresh', { refreshToken: 'ses_a.secret-a' });
  });
});

describe('signOut', () => {
  it('tells the server and clears the local credentials', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));
    await auth.signIn('me@example.test', 'password password');
    vi.mocked(readRefreshToken).mockResolvedValue('ses_a.secret-a');
    vi.mocked(postJson).mockClear();
    vi.mocked(postJson).mockResolvedValue({ signedOut: true });

    await auth.signOut();

    expect(postJson).toHaveBeenCalledWith('/auth/signout', {
      refreshToken: 'ses_a.secret-a',
    });
    expect(clearRefreshToken).toHaveBeenCalled();
    expect(auth.getAuthState()).toEqual({ status: 'signed-out', user: null });
  });

  it('still signs out locally when the server call fails', async () => {
    vi.mocked(postJson).mockResolvedValue(sessionResponse('a'));
    await auth.signIn('me@example.test', 'password password');
    vi.mocked(readRefreshToken).mockResolvedValue('ses_a.secret-a');
    vi.mocked(postJson).mockRejectedValue(
      new PhotoVaultError('network', 'Could not reach the API.'),
    );

    await auth.signOut();

    // Tapping "sign out" with no signal must still sign you out on this
    // device, even though the session row stays live server-side until it
    // expires.
    expect(clearRefreshToken).toHaveBeenCalled();
    expect(auth.getAuthState().status).toBe('signed-out');
  });
});
