import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { PhotoVaultError } from './types';

/**
 * Where the backend is.
 *
 * That is ALL this file decides. There is deliberately no credential here any
 * more: an earlier version of this app shipped a bearer token as
 * `EXPO_PUBLIC_PHOTO_VAULT_TOKEN`, and `EXPO_PUBLIC_` values are inlined into
 * the JS bundle in plain text - so every install carried the same readable
 * key, it could not be revoked without shipping an app update, and every user
 * shared one `owner_id`. Credentials now come from signing in; see
 * src/lib/photo-vault/auth.ts.
 *
 * ## How the URL is chosen
 *
 * 1. `EXPO_PUBLIC_PHOTO_VAULT_API_URL` if set. This is what you use for
 *    production, and to point at a tunnel or a colleague's machine.
 * 2. Otherwise, in development, the Metro dev server's own host with the
 *    Worker's port. `Constants.expoConfig.hostUri` is something like
 *    `192.168.1.24:8081` - the address your phone just used to download the
 *    JS bundle, so it is by definition an address the phone can reach.
 *
 * Step 2 exists because `http://localhost:8787` means different things
 * depending on where the code runs:
 *
 *   iOS simulator    shares the Mac's network stack, so localhost works.
 *   Android emulator localhost is the EMULATOR. The host machine is 10.0.2.2.
 *   Physical phone   localhost is the PHONE. Nothing is listening there, and
 *                    you get "Network request failed" with no further detail.
 *   Web browser      localhost works, but the request is cross-origin, so the
 *                    Worker's ALLOWED_ORIGINS must include the Expo dev origin.
 *
 * Deriving the host from Metro gets all four right without you editing a file
 * when your router hands out a new lease.
 *
 * Remember to start the Worker so it listens on more than loopback:
 *   cd server && npm run dev:lan      (wrangler dev --ip 0.0.0.0)
 */

const WORKER_DEV_PORT = 8787;

export interface PhotoVaultConfig {
  baseUrl: string;
}

function metroDerivedBaseUrl(): string | null {
  // Guarded, because guessing a dev host in a production build would hide a
  // missing configuration behind a confusing connection error.
  if (!__DEV__) return null;

  // Native: the host the device used to download the JS bundle. Only present
  // when running through the Expo CLI during development.
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  if (host) return `http://${host}:${WORKER_DEV_PORT}`;

  // Web: `hostUri` is not populated, because the browser did not connect to
  // Metro the way a device does - it just loaded a page. The page's own
  // hostname is the dev server's hostname, which is the same thing we want.
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hostname) {
    return `http://${window.location.hostname}:${WORKER_DEV_PORT}`;
  }

  return null;
}

function resolveBaseUrl(): string {
  // Must be a literal `process.env.X` dot access: Expo CLI substitutes these
  // textually at bundle time, so `process.env[name]` would not be replaced.
  const configured = process.env.EXPO_PUBLIC_PHOTO_VAULT_API_URL;
  if (configured) return configured.replace(/\/+$/, '');

  const derived = metroDerivedBaseUrl();
  if (derived) return derived;

  throw new PhotoVaultError(
    'not_configured',
    'Set EXPO_PUBLIC_PHOTO_VAULT_API_URL in .env.local (see .env.example).',
  );
}

/**
 * Resolved once per app session. The value is inlined into the JS bundle at
 * build time, so re-reading it per request would gain nothing.
 *
 * Note that a base URL is the right KIND of thing to put in an `EXPO_PUBLIC_`
 * variable: it is configuration, not a secret. Anyone can see which API the
 * app talks to by watching one request. Compare the removed token, which was
 * the wrong kind of thing entirely.
 */
let cached: PhotoVaultConfig | null = null;

export function getConfig(): PhotoVaultConfig {
  cached ??= { baseUrl: resolveBaseUrl() };
  return cached;
}

/** Test seam: forget the memoized values. */
export function resetConfigCache(): void {
  cached = null;
}
