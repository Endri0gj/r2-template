import { useCallback, useEffect, useRef, useState } from 'react';

import { deletePhoto, listPhotos, uploadPhoto } from '@/lib/photo-vault/client';
import { pickPhoto } from '@/lib/photo-vault/picker';
import { PhotoVaultError, type Photo, type PickedPhoto } from '@/lib/photo-vault/types';

/**
 * All of the gallery's behaviour, with no UI in it.
 *
 * Keeping the state machine out of the component is what makes this testable
 * without a renderer for native views: the tests in use-photo-vault.test.ts
 * exercise every state below (empty, loading, upload failure, delete
 * confirmation, refresh) by calling these functions directly.
 */

export type VaultStatus = 'loading' | 'ready' | 'error';

function describeError(cause: unknown): string {
  if (cause instanceof PhotoVaultError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return 'Something went wrong.';
}

function errorCode(cause: unknown): string | null {
  return cause instanceof PhotoVaultError ? cause.code : null;
}

export function usePhotoVault() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [status, setStatus] = useState<VaultStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selected, setSelected] = useState<PickedPhoto | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  /** Set while the user is being asked to confirm; drives the confirm UI. */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Every async path checks this before calling setState. Without it, leaving
  // the screen mid-upload tries to update an unmounted component.
  const isMounted = useRef(true);
  const uploadAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      // Leaving the screen should not leave a request in flight.
      uploadAbort.current?.abort();
    };
  }, []);

  /**
   * Fetches the list and applies the result.
   *
   * Note that NOTHING here touches state before the first `await`. That is
   * deliberate: calling setState synchronously from inside an effect triggers
   * a cascading re-render, and the `react-hooks/set-state-in-effect` lint rule
   * rightly flags it. The initial state of this hook is already
   * `status: 'loading'`, so the mount-time fetch has nothing to announce - and
   * the two callers that DO need to announce something (refresh, retry) are
   * event handlers, where a synchronous setState is fine.
   */
  const fetchPhotos = useCallback(async (refreshing: boolean) => {
    try {
      const next = await listPhotos();
      if (!isMounted.current) return;
      setPhotos(next);
      setStatus('ready');
      setError(null);
    } catch (cause) {
      if (!isMounted.current) return;
      setError(describeError(cause));
      // A failed pull-to-refresh should not blank out a list we already have:
      // show the error alongside the stale data instead of an error screen.
      setStatus((current) => (refreshing && current === 'ready' ? 'ready' : 'error'));
    } finally {
      if (isMounted.current) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // The only lint suppression in this repository, so it is worth being
    // precise about.
    //
    // `react-hooks/set-state-in-effect` objects to setState being called
    // SYNCHRONOUSLY from an effect, because that causes a cascading render.
    // Nothing here does that: every setState in `fetchPhotos` happens after
    // `await listPhotos()`, by which point the effect has long returned. But
    // the rule's analysis is reachability-based - it sees that the function
    // called here eventually calls setState - and cannot tell the two apart.
    //
    // The alternative is to move the photo list into a module-level store and
    // read it with `useSyncExternalStore`, which is what src/hooks/use-auth.ts
    // does. That is the right shape when state must outlive the component or
    // be shared with non-React code, and both are true of the session. Neither
    // is true of this list: it belongs to this screen and dies with it, so a
    // store would add indirection to satisfy a linter.
    //
    // Scoped to this one line so the rule keeps protecting the rest of the file.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchPhotos(false);
  }, [fetchPhotos]);

  /** Pull-to-refresh: keeps the current list visible while re-fetching. */
  const refresh = useCallback(() => {
    setIsRefreshing(true);
    setError(null);
    return fetchPhotos(true);
  }, [fetchPhotos]);

  /** After an error: go back to a full-screen loading state and try again. */
  const retry = useCallback(() => {
    setStatus('loading');
    setError(null);
    return fetchPhotos(false);
  }, [fetchPhotos]);

  /** Opens the system picker. Returns quietly if the user backs out. */
  const selectPhoto = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickPhoto();
      // null means the user tapped Cancel. That is a normal outcome, not a
      // failure, so nothing is shown.
      if (!picked) return;
      if (!isMounted.current) return;
      setSelected(picked);
    } catch (cause) {
      if (isMounted.current) setError(describeError(cause));
    }
  }, []);

  const clearSelection = useCallback(() => setSelected(null), []);

  const upload = useCallback(async () => {
    if (!selected || isUploading) return;

    const controller = new AbortController();
    uploadAbort.current = controller;
    setIsUploading(true);
    setError(null);

    try {
      const photo = await uploadPhoto(selected, controller.signal);
      if (!isMounted.current) return;
      // Prepend: the list is newest-first, and this is the newest. Cheaper and
      // less jarring than re-fetching the whole list.
      setPhotos((current) => [photo, ...current]);
      setSelected(null);
    } catch (cause) {
      if (!isMounted.current) return;
      // A cancellation is something the user asked for, so it is not an error.
      if (errorCode(cause) !== 'cancelled') setError(describeError(cause));
    } finally {
      uploadAbort.current = null;
      if (isMounted.current) setIsUploading(false);
    }
  }, [selected, isUploading]);

  const cancelUpload = useCallback(() => {
    uploadAbort.current?.abort();
  }, []);

  /* --- deletion is two steps, so a tap can never destroy data --- */

  const requestDelete = useCallback((id: string) => setPendingDeleteId(id), []);
  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  const confirmDelete = useCallback(async () => {
    const id = pendingDeleteId;
    if (!id) return;

    setPendingDeleteId(null);
    setDeletingId(id);
    setError(null);

    try {
      await deletePhoto(id);
      if (!isMounted.current) return;
      setPhotos((current) => current.filter((photo) => photo.id !== id));
    } catch (cause) {
      if (!isMounted.current) return;
      if (errorCode(cause) === 'not_found') {
        // Already gone on the server - another device deleted it, or a retry
        // succeeded the first time. Agreeing with the server is the right move.
        setPhotos((current) => current.filter((photo) => photo.id !== id));
      } else {
        setError(describeError(cause));
      }
    } finally {
      if (isMounted.current) setDeletingId(null);
    }
  }, [pendingDeleteId]);

  return {
    photos,
    status,
    error,
    isRefreshing,
    selected,
    isUploading,
    pendingDeleteId,
    deletingId,
    /** True only when the server confirmed there is nothing to show. */
    isEmpty: status === 'ready' && photos.length === 0,
    refresh,
    retry,
    selectPhoto,
    clearSelection,
    upload,
    cancelUpload,
    requestDelete,
    cancelDelete,
    confirmDelete,
    dismissError: useCallback(() => setError(null), []),
  };
}
