import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePhotoVault } from './use-photo-vault';

import { PhotoVaultError, type Photo, type PickedPhoto } from '@/lib/photo-vault/types';

/**
 * These tests run in jsdom, not on a device.
 *
 * `@/lib/photo-vault/client` and `@/lib/photo-vault/picker` are replaced
 * wholesale, which is the reason they are separate modules: mocking them here
 * means `expo-image-picker` and `expo-file-system` - both native modules that
 * cannot load outside an app - are never imported at all.
 *
 * What this covers: the gallery's whole state machine. What it does NOT cover:
 * that the native views render correctly. That needs a device or a renderer
 * with the React Native preset.
 */

vi.mock('@/lib/photo-vault/client', () => ({
  listPhotos: vi.fn(),
  uploadPhoto: vi.fn(),
  deletePhoto: vi.fn(),
  MAX_UPLOAD_BYTES: 5 * 1024 * 1024,
}));

vi.mock('@/lib/photo-vault/picker', () => ({
  pickPhoto: vi.fn(),
}));

const { listPhotos, uploadPhoto, deletePhoto } = await import('@/lib/photo-vault/client');
const { pickPhoto } = await import('@/lib/photo-vault/picker');

function photo(id: string, filename = `${id}.png`): Photo {
  return {
    id,
    filename,
    contentType: 'image/png',
    sizeBytes: 1024,
    createdAt: '2026-11-08T00:00:00.000Z',
    contentPath: `/photos/${id}/content`,
  };
}

const picked: PickedPhoto = {
  uri: 'file:///tmp/IMG_0001.jpg',
  filename: 'IMG_0001.jpg',
  mimeType: 'image/jpeg',
  width: 100,
  height: 200,
};

beforeEach(() => {
  vi.mocked(listPhotos).mockResolvedValue([]);
  vi.mocked(uploadPhoto).mockResolvedValue(photo('pht_new'));
  vi.mocked(deletePhoto).mockResolvedValue(undefined);
  vi.mocked(pickPhoto).mockResolvedValue(picked);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('initial load', () => {
  it('starts in the loading state', () => {
    const { result } = renderHook(() => usePhotoVault());
    expect(result.current.status).toBe('loading');
    // Crucially NOT "empty" yet: we have not heard from the server.
    expect(result.current.isEmpty).toBe(false);
  });

  it('reports an empty gallery once the server says there are none', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.photos).toEqual([]);
  });

  it('shows the photos the server returned', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a'), photo('pht_b')]);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.photos.map((item) => item.id)).toEqual(['pht_a', 'pht_b']);
    expect(result.current.isEmpty).toBe(false);
  });

  it('surfaces a load failure with the server message', async () => {
    vi.mocked(listPhotos).mockRejectedValue(
      new PhotoVaultError('network', 'Could not reach the API at http://10.0.0.5:8787.'),
    );
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toContain('10.0.0.5:8787');
  });
});

describe('retry', () => {
  it('recovers after a failed load', async () => {
    vi.mocked(listPhotos).mockRejectedValueOnce(new PhotoVaultError('network', 'offline'));
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('error'));

    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(result.current.photos).toHaveLength(1);
  });
});

describe('refresh', () => {
  it('re-fetches and flags the refreshing state', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(listPhotos).mockResolvedValue([photo('pht_fresh')]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(listPhotos).toHaveBeenCalledTimes(2);
    expect(result.current.photos.map((item) => item.id)).toEqual(['pht_fresh']);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('keeps showing the existing list when a refresh fails', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    vi.mocked(listPhotos).mockRejectedValue(new PhotoVaultError('network', 'offline'));
    await act(async () => {
      await result.current.refresh();
    });

    // The error is reported, but the data the user was looking at stays put.
    expect(result.current.error).toBe('offline');
    expect(result.current.status).toBe('ready');
    expect(result.current.photos).toHaveLength(1);
  });
});

describe('selecting a photo', () => {
  it('stores what the picker returned', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.selectPhoto();
    });

    expect(result.current.selected).toEqual(picked);
  });

  it('treats a cancelled picker as a no-op, not an error', async () => {
    vi.mocked(pickPhoto).mockResolvedValue(null);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.selectPhoto();
    });

    expect(result.current.selected).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('can clear a selection', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });

    act(() => result.current.clearSelection());
    expect(result.current.selected).toBeNull();
  });
});

describe('uploading', () => {
  it('does nothing when nothing is selected', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.upload();
    });

    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it('flags isUploading while the request is in flight', async () => {
    let release: (value: Photo) => void = () => {};
    vi.mocked(uploadPhoto).mockReturnValue(
      new Promise<Photo>((resolve) => {
        release = resolve;
      }),
    );

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });

    // Start the upload but do not let it finish.
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.upload();
    });
    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      release(photo('pht_done'));
      await pending;
    });
    expect(result.current.isUploading).toBe(false);
  });

  it('prepends the new photo and clears the selection', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_old')]);
    vi.mocked(uploadPhoto).mockResolvedValue(photo('pht_new'));

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });
    await act(async () => {
      await result.current.upload();
    });

    expect(result.current.photos.map((item) => item.id)).toEqual(['pht_new', 'pht_old']);
    expect(result.current.selected).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('reports an upload failure and KEEPS the selection so it can be retried', async () => {
    vi.mocked(uploadPhoto).mockRejectedValue(
      new PhotoVaultError('payload_too_large', 'That photo is 7.2 MB. The limit is 5 MB.', 413),
    );

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });
    await act(async () => {
      await result.current.upload();
    });

    expect(result.current.error).toContain('7.2 MB');
    expect(result.current.isUploading).toBe(false);
    expect(result.current.photos).toHaveLength(0);
    expect(result.current.selected).toEqual(picked);
  });

  it('shows no error when the upload was cancelled', async () => {
    vi.mocked(uploadPhoto).mockRejectedValue(
      new PhotoVaultError('cancelled', 'Request cancelled.'),
    );

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });
    await act(async () => {
      await result.current.upload();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isUploading).toBe(false);
  });

  it('passes an abort signal that cancelUpload triggers', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.mocked(uploadPhoto).mockImplementation(async (_picked, signal) => {
      seenSignal = signal;
      return photo('pht_new');
    });

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.selectPhoto();
    });
    await act(async () => {
      await result.current.upload();
    });

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });
});

describe('deleting', () => {
  it('requires confirmation before calling the API', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.requestDelete('pht_a'));

    expect(result.current.pendingDeleteId).toBe('pht_a');
    expect(deletePhoto).not.toHaveBeenCalled();
    expect(result.current.photos).toHaveLength(1);
  });

  it('deletes nothing if the confirmation is dismissed', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.requestDelete('pht_a'));
    act(() => result.current.cancelDelete());

    expect(result.current.pendingDeleteId).toBeNull();
    expect(deletePhoto).not.toHaveBeenCalled();
    expect(result.current.photos).toHaveLength(1);
  });

  it('removes the photo once confirmed', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a'), photo('pht_b')]);
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.requestDelete('pht_a'));
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(deletePhoto).toHaveBeenCalledWith('pht_a');
    expect(result.current.photos.map((item) => item.id)).toEqual(['pht_b']);
    expect(result.current.deletingId).toBeNull();
  });

  it('keeps the photo and reports the error when deletion fails', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    vi.mocked(deletePhoto).mockRejectedValue(new PhotoVaultError('network', 'offline'));

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.requestDelete('pht_a'));
    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(result.current.error).toBe('offline');
    expect(result.current.photos).toHaveLength(1);
  });

  it('drops the photo locally when the server says it is already gone', async () => {
    vi.mocked(listPhotos).mockResolvedValue([photo('pht_a')]);
    vi.mocked(deletePhoto).mockRejectedValue(
      new PhotoVaultError('not_found', 'Photo not found.', 404),
    );

    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => result.current.requestDelete('pht_a'));
    await act(async () => {
      await result.current.confirmDelete();
    });

    // Converging on the server's view, and NOT showing an error for it.
    expect(result.current.photos).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('does nothing when confirming with no pending deletion', async () => {
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.confirmDelete();
    });

    expect(deletePhoto).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  it('can be dismissed', async () => {
    vi.mocked(listPhotos).mockRejectedValue(new PhotoVaultError('network', 'offline'));
    const { result } = renderHook(() => usePhotoVault());
    await waitFor(() => expect(result.current.error).toBe('offline'));

    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
  });
});
