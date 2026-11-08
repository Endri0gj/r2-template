import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  getAuthState,
  restoreSession,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest,
  subscribe,
  type AuthState,
} from '@/lib/photo-vault/auth';
import { PhotoVaultError } from '@/lib/photo-vault/types';

/**
 * React's view of the session that src/lib/photo-vault/auth.ts owns.
 *
 * The session state is read with `useSyncExternalStore`, which is the API
 * React provides for exactly this shape of problem: state that lives outside
 * React and changes on its own. The alternative - a `useEffect` that
 * subscribes and copies into `useState` - renders once with a stale value and
 * is the thing `react-hooks/set-state-in-effect` warns about.
 *
 * Why the store is outside React at all: the networking layer needs a valid
 * access token and is not a component. See the module comment in auth.ts.
 */

function describeError(cause: unknown): string {
  if (cause instanceof PhotoVaultError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong.';
}

export function useAuth() {
  const state: AuthState = useSyncExternalStore(subscribe, getAuthState, getAuthState);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Turn a stored refresh token back into a live session, once, at startup.
  // This is the one genuine "on mount, go and do something" in the app, and it
  // sets no state of its own - everything it changes lives in the external
  // store, which is what makes it safe here.
  useEffect(() => {
    if (getAuthState().status === 'unknown') void restoreSession();
  }, []);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  const signIn = useCallback(
    (email: string, password: string) => run(() => signInRequest(email, password)),
    [run],
  );

  const signUp = useCallback(
    (email: string, password: string, inviteCode?: string) =>
      run(() => signUpRequest(email, password, inviteCode)),
    [run],
  );

  const signOut = useCallback(() => run(() => signOutRequest()), [run]);

  return {
    status: state.status,
    user: state.user,
    isSignedIn: state.status === 'signed-in',
    /** True until the stored credentials have been checked. */
    isChecking: state.status === 'unknown',
    isSubmitting,
    error,
    signIn,
    signUp,
    signOut,
    dismissError: useCallback(() => setError(null), []),
  };
}
