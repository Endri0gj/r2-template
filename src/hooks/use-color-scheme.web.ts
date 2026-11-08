import { useSyncExternalStore } from 'react';

/**
 * The web colour scheme, read in a way that is safe for static rendering.
 *
 * ## The problem this solves
 *
 * Expo Router can pre-render pages to HTML, where there is no browser and so
 * no colour scheme to read. If the server renders "light" and the client
 * immediately renders "dark", React sees a hydration mismatch. So the first
 * client render has to agree with the server, and the real value can only be
 * adopted afterwards.
 *
 * ## Why useSyncExternalStore and not an effect
 *
 * This hook previously set state inside `useEffect` to flip from "light" to
 * the real value after hydration. That works, but it is what
 * `react-hooks/set-state-in-effect` warns about - it renders twice and makes
 * the "has hydrated" flag a piece of component state that exists only to
 * describe the environment.
 *
 * `useSyncExternalStore` is the API React provides for this exact shape:
 * subscribe to something outside React, and give hydration a separate
 * snapshot. The third argument is the server snapshot, which React also uses
 * for the first client render - so agreement is structural rather than
 * something we arrange with a flag.
 *
 * It also gets something the old version did not: the value now updates when
 * the user changes their system theme while the page is open, because
 * `matchMedia` notifies us.
 */

const QUERY = '(prefers-color-scheme: dark)';

function mediaQuery(): MediaQueryList | null {
  // Guarded rather than assumed: this module is also reachable from the
  // static-render pass, where `window` does not exist.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

function subscribe(onStoreChange: () => void): () => void {
  const query = mediaQuery();
  if (!query) return () => {};
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getSnapshot(): 'light' | 'dark' {
  return mediaQuery()?.matches ? 'dark' : 'light';
}

/**
 * What the server rendered, and therefore what the first client render must
 * produce. React calls this during hydration instead of `getSnapshot`, then
 * re-renders with the real value once hydration is complete.
 */
function getServerSnapshot(): 'light' | 'dark' {
  return 'light';
}

export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
