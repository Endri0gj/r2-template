import { postJson } from './http';
import { clearRefreshToken, readRefreshToken, writeRefreshToken } from './token-store';
import { PhotoVaultError, type Account, type AuthSession } from './types';

/**
 * The device's session: obtaining one, keeping it fresh, giving it up.
 *
 * This is a module with state rather than a React context, for one reason:
 * src/lib/photo-vault/client.ts needs a valid access token and is not a
 * component. Everything React needs is exposed through `subscribe()`, which
 * src/hooks/use-auth.ts adapts into a hook.
 *
 * ## The invariant that matters
 *
 * **Only one refresh may be in flight at a time.** The server rotates refresh
 * tokens and treats a replayed one as theft - it revokes every session for the
 * account. Two concurrent refreshes would send the same token twice, and the
 * second would be read as a replay and sign the user out of everything.
 *
 * `refreshInFlight` below is what prevents that: every caller awaits the same
 * promise. This is not an optimisation. It is a correctness requirement that
 * the server's theft detection places on this client.
 */

interface LiveSession {
  accessToken: string;
  /** Absolute ms timestamp, derived from the server's `expiresIn`. */
  expiresAt: number;
  user: Account;
}

export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out';

export interface AuthState {
  status: AuthStatus;
  user: Account | null;
}

/**
 * Renew this many ms before the token actually expires.
 *
 * Two different problems need this margin. The obvious one is clock skew. The
 * subtler one is that a native image load does not go through our fetch
 * wrapper: expo-image is handed a token and uses it whenever it gets round to
 * that thumbnail, which may be seconds later. Handing out a token that is
 * about to expire produces images that fail for no visible reason.
 */
const RENEW_MARGIN_MS = 60_000;

let session: LiveSession | null = null;
let status: AuthStatus = 'unknown';
let refreshInFlight: Promise<LiveSession> | null = null;

const listeners = new Set<(state: AuthState) => void>();

/**
 * The snapshot handed to `useSyncExternalStore`, cached by identity.
 *
 * This caching is REQUIRED, not an optimisation. React compares successive
 * snapshots with `Object.is` to decide whether to re-render; a `getSnapshot`
 * that builds a fresh object every call therefore always looks changed, React
 * re-renders, calls it again, and the app dies with "Maximum update depth
 * exceeded". A new object is returned only when something has genuinely
 * changed.
 */
let cachedState: AuthState = { status: 'unknown', user: null };

function currentState(): AuthState {
  const user = session?.user ?? null;
  if (cachedState.status !== status || cachedState.user !== user) {
    cachedState = { status, user };
  }
  return cachedState;
}

function publish(): void {
  const state = currentState();
  for (const listener of listeners) listener(state);
}

export function getAuthState(): AuthState {
  return currentState();
}

export function subscribe(listener: (state: AuthState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sameAccount(a: Account, b: Account): boolean {
  return a.id === b.id && a.email === b.email && a.createdAt === b.createdAt;
}

function adopt(result: AuthSession): LiveSession {
  // Every refresh parses a fresh `user` object out of the response. Keeping
  // the previous one when the contents are identical means the snapshot above
  // stays referentially stable, so renewing a token in the background does not
  // re-render the screen for no reason.
  const previous = session?.user;
  const user: Account = previous && sameAccount(previous, result.user) ? previous : result.user;

  // `expiresIn` is relative, so the absolute time is computed here, on the
  // device, from the moment the response arrived. The server's clock and this
  // device's clock never have to agree.
  session = {
    accessToken: result.accessToken,
    expiresAt: Date.now() + result.expiresIn * 1000,
    user,
  };
  status = 'signed-in';
  return session;
}

async function discard(): Promise<void> {
  session = null;
  status = 'signed-out';
  await clearRefreshToken();
  publish();
}

/* ------------------------------------------------------------------ *
 * Sign-up / sign-in / sign-out
 * ------------------------------------------------------------------ */

async function establish(path: string, body: unknown): Promise<Account> {
  const result = await postJson<AuthSession>(path, body);
  const live = adopt(result);
  // Persist AFTER the session is live, so a keychain failure cannot leave the
  // app signed out despite a successful sign-in.
  await writeRefreshToken(result.refreshToken);
  publish();
  return live.user;
}

export async function signIn(email: string, password: string): Promise<Account> {
  return establish('/auth/signin', { email, password });
}

export async function signUp(
  email: string,
  password: string,
  inviteCode?: string,
): Promise<Account> {
  return establish('/auth/signup', {
    email,
    password,
    // Omitted entirely when blank, so a server in "open" mode is not sent an
    // empty string to reason about.
    ...(inviteCode ? { inviteCode } : {}),
  });
}

/**
 * Signs out this device.
 *
 * The server call is best-effort: if it fails, the local credentials are
 * discarded regardless. A user who taps "sign out" on a train with no signal
 * must still end up signed out on this device. The cost is a session row that
 * stays live server-side until it expires or is purged - which is why
 * /auth/signout-all exists for the case where that matters.
 */
export async function signOut(): Promise<void> {
  const refreshToken = await readRefreshToken();
  if (refreshToken) {
    try {
      await postJson('/auth/signout', { refreshToken });
    } catch (cause) {
      console.warn('Sign-out request failed; clearing local credentials anyway', cause);
    }
  }
  await discard();
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

async function performRefresh(): Promise<LiveSession> {
  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    status = 'signed-out';
    throw new PhotoVaultError('signed_out', 'You are signed out.');
  }

  let result: AuthSession;
  try {
    result = await postJson<AuthSession>('/auth/refresh', { refreshToken });
  } catch (cause) {
    // A network failure is NOT a reason to throw away a valid refresh token -
    // the token is probably fine and the user is probably in a tunnel.
    // Clearing it here would sign people out every time connectivity blipped.
    if (cause instanceof PhotoVaultError && cause.code === 'network') throw cause;

    // Anything the server actually answered (401 revoked/expired, 403 disabled)
    // means this token will never work again. Drop it.
    await discard();
    throw cause;
  }

  const live = adopt(result);
  // The server rotated the token, so the old one is already dead. Storing the
  // new one is not optional - a crash before this line means the user has to
  // sign in again.
  await writeRefreshToken(result.refreshToken);
  publish();
  return live;
}

/** Shared across concurrent callers; see the invariant at the top of this file. */
function refreshOnce(): Promise<LiveSession> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Called at startup. Turns a stored refresh token back into a live session, so
 * the user does not re-enter a password every launch.
 */
export async function restoreSession(): Promise<AuthState> {
  try {
    await refreshOnce();
  } catch {
    // Already handled inside performRefresh: either the credentials were
    // cleared, or the network failed and they were kept for the next attempt.
    if (status === 'unknown') status = 'signed-out';
  }
  publish();
  return currentState();
}

/**
 * Returns a usable access token, renewing it first if it is close to expiry.
 * This is what src/lib/photo-vault/client.ts calls before every request.
 */
export async function getAccessToken(): Promise<string> {
  if (session && session.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return session.accessToken;
  }
  const live = await refreshOnce();
  return live.accessToken;
}

/**
 * Forces a renewal after the server has rejected a token we believed was good.
 *
 * That happens for reasons the expiry check cannot see: the signing secret was
 * rotated, the device's clock is wrong, or the session was revoked elsewhere.
 */
export async function refreshAfterUnauthorized(): Promise<string> {
  if (session) session.expiresAt = 0;
  const live = await refreshOnce();
  return live.accessToken;
}

/** Test seam: forget everything this module is holding. */
export function resetAuthForTests(): void {
  session = null;
  status = 'unknown';
  refreshInFlight = null;
  cachedState = { status: 'unknown', user: null };
  listeners.clear();
}
