import * as SecureStore from 'expo-secure-store';

/**
 * Where the refresh token lives on a device.
 *
 * `expo-secure-store` writes to the iOS Keychain and to Android's
 * `SharedPreferences` encrypted with the Android Keystore - i.e. storage that
 * is encrypted at rest and tied to this app. That is the right place for a
 * long-lived credential and the only reason this dependency exists.
 * https://docs.expo.dev/versions/latest/sdk/securestore/
 *
 * ## What is NOT stored here
 *
 * The access token. It expires in 15 minutes and is held in memory by
 * src/lib/photo-vault/auth.ts. Persisting it would put a working credential on
 * disk in exchange for saving one refresh call at launch.
 *
 * ## Platform note
 *
 * There is a `.web.ts` version of this file, because SecureStore has no web
 * implementation. Metro picks the platform file automatically.
 *
 * ## Two things to know about the native behaviour
 *
 * 1. iOS Keychain entries SURVIVE app uninstallation when the app is
 *    reinstalled with the same bundle id; Android's do not. So a reinstalled
 *    iOS app may come back already signed in. That is Apple's behaviour, not a
 *    bug, but it means "delete the app" is not a way to sign out - which is
 *    why the sign-out button has to exist.
 * 2. iOS has historically refused values above roughly 2 KB. Our refresh token
 *    is about 80 bytes, so there is plenty of headroom; a future change that
 *    stores something bigger here needs to know about the ceiling.
 */

const REFRESH_TOKEN_KEY = 'photoVault.refreshToken';

/**
 * Every function here swallows its errors and reports "no token".
 *
 * Keychain access can genuinely fail - a locked device, a restored backup
 * whose Keystore entries no longer decrypt, a simulator in an odd state. The
 * correct response to all of those is "treat the user as signed out", which is
 * recoverable by signing in again. Throwing instead would turn a storage
 * hiccup into an app that cannot start.
 */
export async function readRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch (cause) {
    console.warn('Could not read the stored refresh token', cause);
    return null;
  }
}

export async function writeRefreshToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
  } catch (cause) {
    // The session still works for this launch; it just will not survive a
    // restart. Worth a warning, not worth failing the sign-in the user just
    // completed successfully.
    console.warn('Could not persist the refresh token', cause);
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  } catch (cause) {
    console.warn('Could not clear the stored refresh token', cause);
  }
}
