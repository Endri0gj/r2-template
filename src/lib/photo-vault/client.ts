import { File } from 'expo-file-system';

import { getAccessToken, refreshAfterUnauthorized } from './auth';
import { getConfig } from './config';
import { apiFetch } from './http';
import { PhotoVaultError, type Photo, type PickedPhoto } from './types';

/**
 * The only module that knows how to talk to the Worker about photos.
 *
 * No React in here on purpose: everything below is plain async functions, so
 * the UI can be re-written without touching the networking, and the networking
 * can be tested without rendering anything.
 */

/**
 * Must match MAX_UPLOAD_BYTES in server/wrangler.jsonc. Checking on the device
 * too is not redundant: it turns "upload 4 MB over cellular, then get a 413"
 * into an instant, explainable error. The server check is the one that
 * actually enforces the rule; this one is a courtesy.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Performs an authenticated request, renewing the access token once if the
 * server rejects it.
 *
 * The retry exists because a token can stop being valid for reasons the
 * client's own expiry check cannot predict: the server's signing secret was
 * rotated, or this device's clock is wrong. Exactly ONE retry - a loop here
 * would hammer /auth/refresh whenever something is genuinely broken.
 *
 * Note that the body is re-sent on the retry. That is safe for everything this
 * client does: GET and DELETE are idempotent, and a rejected POST never
 * reached the handler, so nothing was stored.
 */
async function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  // A fresh Headers per attempt. Mutating one object and sending it twice
  // would work, but it makes the two requests share mutable state - the first
  // attempt's headers would appear to change after the fact, which is
  // confusing in a log and wrong if anything ever retains the init.
  const withToken = (token: string): RequestInit => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return { ...init, headers };
  };

  try {
    return await apiFetch(path, withToken(await getAccessToken()));
  } catch (cause) {
    if (!(cause instanceof PhotoVaultError) || cause.status !== 401) throw cause;
    return apiFetch(path, withToken(await refreshAfterUnauthorized()));
  }
}

export async function checkHealth(signal?: AbortSignal): Promise<void> {
  // No credential: /health is deliberately unauthenticated so an uptime
  // monitor can use it.
  await apiFetch('/health', { signal });
}

export async function listPhotos(signal?: AbortSignal): Promise<Photo[]> {
  const response = await authorized('/photos', { signal });
  const body = (await response.json()) as { data: { photos: Photo[] } };
  return body.data.photos;
}

/**
 * Uploads one picked photo.
 *
 * The flow, and why each step is there:
 *
 *   1. Wrap the local URI in a `File`. Nothing is read yet - a `File` is just
 *      a reference to a path.
 *   2. Check `exists` and `size`. This is why expo-file-system is a dependency:
 *      ImagePicker hands back a URI, and we need the real size before deciding
 *      to send anything.
 *   3. Read the bytes. For a <= 5 MB cap, holding the image in memory is fine
 *      and gives us a body with a known length, which is what lets the Worker
 *      stream it straight into R2.
 *   4. POST the raw bytes. Not multipart, not base64. Base64 would inflate the
 *      payload by ~33% and force the Worker to decode it before it could store
 *      anything.
 */
export async function uploadPhoto(picked: PickedPhoto, signal?: AbortSignal): Promise<Photo> {
  const file = new File(picked.uri);

  if (!file.exists) {
    throw new PhotoVaultError('bad_request', 'That photo is no longer available on this device.');
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const megabytes = (MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0);
    throw new PhotoVaultError(
      'payload_too_large',
      `That photo is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${megabytes} MB.`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch {
    throw new PhotoVaultError('bad_request', 'Could not read that photo from the device.');
  }

  const response = await authorized('/photos', {
    method: 'POST',
    signal,
    headers: {
      // A claim the server will verify against the actual bytes.
      'content-type': picked.mimeType ?? 'application/octet-stream',
      // Display name only. The server strips any path and never uses it as a
      // storage key.
      'x-filename': picked.filename,
    },
    body: bytes as unknown as BodyInit,
  });

  const body = (await response.json()) as { data: { photo: Photo } };
  return body.data.photo;
}

export async function deletePhoto(id: string, signal?: AbortSignal): Promise<void> {
  await authorized(`/photos/${id}`, { method: 'DELETE', signal });
}

/**
 * Builds what `expo-image` needs to render a photo straight out of the private
 * R2 bucket.
 *
 * The bucket has no public access, so there is no plain URL that shows an
 * image. Every read goes through the Worker and carries a token, which is why
 * `headers` is part of the image source rather than just a `uri`. expo-image
 * supports exactly this.
 *
 * It is async because the token may need renewing first - and unlike every
 * other call here, expo-image is handed the header and uses it later, on its
 * own schedule. That is also why auth.ts renews a minute early: a token that
 * is valid now but expires in two seconds would produce thumbnails that fail
 * with no visible cause.
 */
export async function photoImageSource(
  photo: Photo,
): Promise<{ uri: string; headers: Record<string, string> }> {
  const { baseUrl } = getConfig();
  const token = await getAccessToken();
  return {
    uri: `${baseUrl}${photo.contentPath}`,
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Fetches the bytes of one photo. Used by the web build, which cannot attach
 * headers to an `<img>` and so loads the image itself and wraps it in a
 * `blob:` URL.
 */
export async function fetchPhotoBlob(photo: Photo, signal?: AbortSignal): Promise<Blob> {
  const response = await authorized(photo.contentPath, { signal });
  return response.blob();
}
