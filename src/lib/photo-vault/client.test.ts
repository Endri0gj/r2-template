import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The authenticated request wrapper.
 *
 * What is under test is narrow and worth testing precisely: a token is
 * attached, a 401 triggers exactly one renewal and one retry, and any other
 * error is passed straight through. `expo-file-system` is mocked out so the
 * module can be imported at all outside an app.
 */

vi.mock('./http', () => ({
  apiFetch: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(),
  refreshAfterUnauthorized: vi.fn(),
}));

vi.mock('./config', () => ({
  getConfig: () => ({ baseUrl: 'http://localhost:8787' }),
}));

vi.mock('expo-file-system', () => ({
  File: class {
    exists = true;
    size = 0;
    bytes() {
      return Promise.resolve(new Uint8Array());
    }
  },
}));

const { apiFetch } = await import('./http');
const { getAccessToken, refreshAfterUnauthorized } = await import('./auth');
const client = await import('./client');
const { PhotoVaultError } = await import('./types');

const PHOTO = {
  id: 'pht_1',
  filename: 'a.png',
  contentType: 'image/png',
  sizeBytes: 10,
  createdAt: '2026-11-08T00:00:00.000Z',
  contentPath: '/photos/pht_1/content',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Reads the Authorization header off the Nth call to apiFetch. */
function sentToken(callIndex: number): string | null {
  const init = vi.mocked(apiFetch).mock.calls[callIndex]?.[1];
  return new Headers(init?.headers).get('authorization');
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(getAccessToken).mockReset().mockResolvedValue('access-1');
  vi.mocked(refreshAfterUnauthorized).mockReset().mockResolvedValue('access-2');
});

describe('authenticated requests', () => {
  it('attaches the access token as a bearer credential', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ data: { photos: [PHOTO] } }));

    const photos = await client.listPhotos();

    expect(photos).toEqual([PHOTO]);
    expect(sentToken(0)).toBe('Bearer access-1');
  });

  it('renews the token once and retries after a 401', async () => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new PhotoVaultError('unauthorized', 'Invalid access token.', 401))
      .mockResolvedValueOnce(jsonResponse({ data: { photos: [] } }));

    const photos = await client.listPhotos();

    expect(photos).toEqual([]);
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    // The retry carries the NEW token, not the rejected one.
    expect(sentToken(0)).toBe('Bearer access-1');
    expect(sentToken(1)).toBe('Bearer access-2');
  });

  it('gives up after one retry rather than looping', async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new PhotoVaultError('unauthorized', 'Invalid access token.', 401),
    );

    await expect(client.listPhotos()).rejects.toMatchObject({ status: 401 });
    // Two attempts, one renewal. A loop here would hammer /auth/refresh
    // whenever something is genuinely wrong with the signing secret.
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for errors that are not 401', async () => {
    for (const error of [
      new PhotoVaultError('rate_limited', 'Too many requests.', 429),
      new PhotoVaultError('not_found', 'Photo not found.', 404),
      new PhotoVaultError('internal_error', 'Unexpected error.', 500),
      new PhotoVaultError('network', 'Could not reach the API.'),
    ]) {
      vi.mocked(apiFetch).mockReset().mockRejectedValue(error);
      vi.mocked(refreshAfterUnauthorized).mockClear();

      await expect(client.listPhotos()).rejects.toThrow(error.message);
      expect(refreshAfterUnauthorized).not.toHaveBeenCalled();
      expect(apiFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('sends no credential to the unauthenticated health check', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ data: { status: 'ok' } }));

    await client.checkHealth();

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(sentToken(0)).toBeNull();
  });

  it('deletes through the authenticated wrapper', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse({ data: { id: 'pht_1' } }));

    await client.deletePhoto('pht_1');

    expect(apiFetch).toHaveBeenCalledWith('/photos/pht_1', expect.objectContaining({
      method: 'DELETE',
    }));
    expect(sentToken(0)).toBe('Bearer access-1');
  });
});

describe('photoImageSource', () => {
  it('returns a URL plus the header expo-image needs for a private bucket', async () => {
    const source = await client.photoImageSource(PHOTO);

    // The bucket is private: there is no plain URL that renders this image, so
    // the token has to travel with the image request itself.
    expect(source).toEqual({
      uri: 'http://localhost:8787/photos/pht_1/content',
      headers: { authorization: 'Bearer access-1' },
    });
  });
});
