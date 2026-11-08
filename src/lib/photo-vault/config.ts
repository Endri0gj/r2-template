import Constants from 'expo-constants';
import { NativeModules, Platform } from 'react-native';

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
 * 2. Otherwise, in development, the address this device used to reach the
 *    Metro dev server, with the Worker's port.
 *
 * Step 2 exists because `http://localhost:8787` means four different things:
 *
 *   iOS simulator    shares the Mac's network stack, so localhost works.
 *   Android emulator localhost is the EMULATOR. The host machine is 10.0.2.2.
 *   Physical phone   localhost is the PHONE. Nothing is listening there, and
 *                    you get "Network request failed" with no further detail.
 *   Web browser      localhost works, but the request is cross-origin, so the
 *                    Worker's ALLOWED_ORIGINS must include the Expo dev origin.
 *
 * Deriving the host rather than hardcoding it gets all four right, and keeps
 * working when your router hands out a new lease.
 *
 * Remember to start the Worker so it listens on more than loopback:
 *   cd server && npm run dev:lan      (wrangler dev --ip 0.0.0.0)
 */

const WORKER_DEV_PORT = 8787;

export interface PhotoVaultConfig {
  baseUrl: string;
}

/**
 * The host from the URL Metro served this bundle from.
 *
 * This is the fallback that actually carries the weight, and it is worth
 * knowing why `Constants.expoConfig.hostUri` is not enough on its own.
 *
 * `hostUri` is populated from the manifest a dev server hands to Expo Go or to
 * a dev-client build. An app built with plain `npx expo run:android` /
 * `run:ios` has no `expo-dev-client`, so it never performs that handshake:
 * `Constants.executionEnvironment` is `"bare"` and every manifest field,
 * `hostUri` included, is null. Verified on an Android emulator, where the
 * screen showed "Set EXPO_PUBLIC_PHOTO_VAULT_API_URL" instead of a sign-in
 * form.
 *
 * The bundle still came from somewhere, though, and React Native records
 * where. On that same emulator the script URL was
 * `http://10.0.2.2:8081/.expo/.virtual-metro-entry.bundle?...` - 10.0.2.2
 * being precisely the address an Android emulator uses for its host machine.
 * So this is not merely a fallback, it is the most trustworthy signal
 * available: the one address this device has already proved it can reach.
 *
 * `NativeModules.SourceCode` is long-standing React Native API rather than a
 * documented Expo one, hence the defensive access - if it ever disappears,
 * this returns null and the explicit env var still works.
 */
function metroScriptHost(): string | null {
  try {
    const sourceCode = NativeModules?.SourceCode as
      | { getConstants?: () => { scriptURL?: string }; scriptURL?: string }
      | undefined;
    const scriptUrl = sourceCode?.getConstants?.().scriptURL ?? sourceCode?.scriptURL;
    if (!scriptUrl) return null;

    // Parsed with a regex rather than `new URL()`: React Native's URL
    // implementation is a partial polyfill, and the bracketed-IPv6 case is
    // exactly the sort of thing it gets wrong. The brackets are kept, because
    // `http://[::1]:8787` is how an IPv6 host has to be written back out.
    const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(scriptUrl);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function metroDerivedBaseUrl(): string | null {
  // Guarded, because guessing a dev host in a production build would hide a
  // missing configuration behind a confusing connection error.
  if (!__DEV__) return null;

  // Expo Go and dev-client builds: the host the manifest declared. Bare debug
  // builds: the host Metro actually served the bundle from.
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0] ?? metroScriptHost();
  if (host) return `http://${host}:${WORKER_DEV_PORT}`;

  // Web: neither of the above exists, because the browser did not connect to
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

/** Test seam: forget the memoized value. */
export function resetConfigCache(): void {
  cached = null;
}
