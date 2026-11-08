/**
 * The web implementation of the refresh-token store.
 *
 * ## Read this before shipping a web build
 *
 * `expo-secure-store` does not support web - its platform list is iOS, Android
 * and tvOS. There is no browser equivalent: a web page has no keychain, and
 * anything JavaScript can read, JavaScript injected into the page can also
 * read. So this uses `localStorage`, and that is **weaker than the native
 * store, not equivalent to it**:
 *
 *   - It is not encrypted at rest.
 *   - It is readable by any script running on this origin, which means a
 *     single XSS bug hands over a 30-day credential.
 *
 * It is used anyway because the alternative on web is worse for this app:
 * holding the refresh token in memory only would sign the user out on every
 * page reload, and the usual correct answer - an HttpOnly, Secure, SameSite
 * cookie that JavaScript cannot read at all - is not available to us here. A
 * cookie has to be set by the server on the same site as the page, and this
 * API is a separate origin from the Expo web app by design.
 *
 * So, concretely: if the web build matters to you in production, the change to
 * make is to serve the app and the API from one domain (a Worker route on your
 * own zone, with the app's assets alongside it) and move the refresh token
 * into an HttpOnly cookie set by `/auth/signin`. The access token stays in
 * memory either way. Until then, treat the web build as a convenience for
 * development - which is exactly what it is used for in this repo.
 *
 * The native build is unaffected by any of this; see token-store.ts.
 */

const REFRESH_TOKEN_KEY = 'photoVault.refreshToken';

/**
 * `localStorage` is not always available: Safari in private mode has
 * historically thrown on write, and a browser configured to block site data
 * throws on access. Every call is guarded, and a failure degrades to "signed
 * out" rather than crashing the app.
 */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function readRefreshToken(): Promise<string | null> {
  try {
    return storage()?.getItem(REFRESH_TOKEN_KEY) ?? null;
  } catch (cause) {
    console.warn('Could not read the stored refresh token', cause);
    return null;
  }
}

export async function writeRefreshToken(token: string): Promise<void> {
  try {
    storage()?.setItem(REFRESH_TOKEN_KEY, token);
  } catch (cause) {
    console.warn('Could not persist the refresh token', cause);
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    storage()?.removeItem(REFRESH_TOKEN_KEY);
  } catch (cause) {
    console.warn('Could not clear the stored refresh token', cause);
  }
}
