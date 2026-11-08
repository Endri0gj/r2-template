import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import { uploadPhoto } from '../src/photos';
import type { PhotoRow } from '../src/types';
import {
  IncomingRequest,
  call,
  countRows,
  jpegBytes,
  listObjectKeys,
  notAnImage,
  pngBytes,
  signUpAccount,
  upload,
  uploadAndGetId,
  type TestAccount,
} from './helpers';

/**
 * These tests run inside workerd against a real, locally simulated R2 bucket,
 * D1 database and rate limiter. When a test asserts "the object is gone from
 * R2", it is reading the actual bucket, not a mock. When a test signs in, it
 * really runs PBKDF2 and really inserts a session row.
 *
 * MAX_UPLOAD_BYTES is 2048 here (set in vitest.config.mts) so the size-limit
 * tests do not have to allocate megabytes.
 */

/** Two real accounts, created fresh for every test. */
let alice: TestAccount;
let bob: TestAccount;

beforeEach(async () => {
  alice = await signUpAccount({ email: undefined });
  bob = await signUpAccount({ email: undefined });
});

describe('GET /health', () => {
  it('is reachable without a token', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: 'ok' } });
  });

  it('rejects a non-GET method', async () => {
    const response = await call('/health', { method: 'POST' });
    expect(response.status).toBe(405);
  });
});

describe('routing', () => {
  it('404s an unknown route', async () => {
    const response = await call('/nope', { token: alice.accessToken });
    expect(response.status).toBe(404);
  });

  it('404s a malformed photo id without touching the database', async () => {
    const response = await call('/photos/not-a-real-id/content', { token: alice.accessToken });
    expect(response.status).toBe(404);
  });
});

describe('authentication', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await call('/photos');
    expect(response.status).toBe(401);
    // Tells the client which scheme to use instead of leaving it guessing.
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a token that is not a JWT at all', async () => {
    const response = await call('/photos', { token: 'tok_not_real' });
    expect(response.status).toBe(401);
  });

  it('rejects a token sent without the Bearer scheme', async () => {
    const response = await call('/photos', {
      headers: { authorization: alice.accessToken },
    });
    expect(response.status).toBe(401);
  });

  it('requires a token to read image bytes, not just to list', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    const response = await call(`/photos/${id}/content`);
    expect(response.status).toBe(401);
  });
});

describe('POST /photos', () => {
  it('stores the bytes in R2 and the metadata in D1', async () => {
    const bytes = pngBytes(256);
    const response = await upload(alice.accessToken, bytes, { filename: 'holiday.png' });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      data: { photo: { id: string; contentType: string; sizeBytes: number; contentPath: string } };
    };
    const photo = body.data.photo;
    expect(photo.contentType).toBe('image/png');
    expect(photo.sizeBytes).toBe(256);
    expect(photo.contentPath).toBe(`/photos/${photo.id}/content`);

    // The D1 row really exists, and is scoped to the authenticated principal.
    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?')
      .bind(photo.id)
      .first<PhotoRow>();
    expect(row).not.toBeNull();
    expect(row?.owner_id).toBe(alice.userId);
    expect(row?.filename).toBe('holiday.png');
    expect(row?.size_bytes).toBe(256);

    // The R2 object really exists, at the key the row points to, with the
    // media type we sniffed.
    const object = await env.PHOTOS.get(row!.object_key);
    expect(object).not.toBeNull();
    expect(object?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
  });

  it('accepts JPEG as well as PNG', async () => {
    const response = await upload(alice.accessToken, jpegBytes());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { photo: { contentType: string } } };
    expect(body.data.photo.contentType).toBe('image/jpeg');
  });

  it('ignores a lying Content-Type and uses the real bytes', async () => {
    // Client claims PNG, body is actually a JPEG.
    const response = await upload(alice.accessToken, jpegBytes(), { declaredType: 'image/png' });
    const body = (await response.json()) as { data: { photo: { contentType: string } } };
    expect(body.data.photo.contentType).toBe('image/jpeg');
  });

  it('rejects a non-image and writes nothing anywhere', async () => {
    const response = await upload(alice.accessToken, notAnImage(), {
      declaredType: 'image/png',
    });
    expect(response.status).toBe(415);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_media_type',
    );
    expect(await countRows('photos')).toBe(0);
    expect(await listObjectKeys()).toEqual([]);
  });

  it('rejects a body larger than the limit, reported via Content-Length', async () => {
    const response = await upload(alice.accessToken, pngBytes(4096));
    expect(response.status).toBe(413);
    expect(await countRows('photos')).toBe(0);
  });

  it('rejects an oversized body even when Content-Length is absent', async () => {
    // A streamed body carries no Content-Length, so the only thing standing
    // between us and an unbounded allocation is the limit inside the read loop.
    const big = pngBytes(4096);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big.slice(0, 1024));
        controller.enqueue(big.slice(1024, 2048));
        controller.enqueue(big.slice(2048));
        controller.close();
      },
    });

    const request = new IncomingRequest('https://vault.test/photos', {
      method: 'POST',
      body: stream,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      // Required by the runtime for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const response = await worker.fetch(request, env);

    expect(response.headers.get('content-length')).toBeNull();
    expect(response.status).toBe(413);
    expect(await countRows('photos')).toBe(0);
  });

  it('rejects an empty body', async () => {
    const response = await call('/photos', {
      method: 'POST',
      body: new ArrayBuffer(0),
      token: alice.accessToken,
    });
    expect(response.status).toBe(400);
  });

  it('strips directory components out of the supplied filename', async () => {
    const response = await upload(alice.accessToken, pngBytes(), {
      filename: '../../../etc/passwd.png',
    });
    const body = (await response.json()) as { data: { photo: { id: string } } };
    const row = await env.DB.prepare('SELECT filename, object_key FROM photos WHERE id = ?')
      .bind(body.data.photo.id)
      .first<Pick<PhotoRow, 'filename' | 'object_key'>>();

    expect(row?.filename).toBe('passwd.png');
    // And the untrusted name never reaches the storage key.
    expect(row?.object_key).not.toContain('passwd');
    expect(row?.object_key).toBe(`photos/${alice.userId}/${body.data.photo.id}`);
  });

  it('falls back to a default filename when the header is absent', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    const row = await env.DB.prepare('SELECT filename FROM photos WHERE id = ?')
      .bind(id)
      .first<{ filename: string }>();
    expect(row?.filename).toBe('photo');
  });
});

describe('GET /photos', () => {
  it('returns an empty list for a new account', async () => {
    const response = await call('/photos', { token: alice.accessToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { photos: [] } });
  });

  it('returns newest first', async () => {
    const first = await uploadAndGetId(alice.accessToken, pngBytes(16), { filename: 'first.png' });
    // created_at has millisecond resolution; make the ordering unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await uploadAndGetId(alice.accessToken, pngBytes(32), {
      filename: 'second.png',
    });

    const response = await call('/photos', { token: alice.accessToken });
    const body = (await response.json()) as { data: { photos: { id: string }[] } };
    expect(body.data.photos.map((photo) => photo.id)).toEqual([second, first]);
  });

  it('never exposes owner_id or object_key', async () => {
    await uploadAndGetId(alice.accessToken);
    const response = await call('/photos', { token: alice.accessToken });
    const text = await response.text();
    expect(text).not.toContain('owner_id');
    expect(text).not.toContain('object_key');
    expect(text).not.toContain(alice.userId);
  });
});

describe('GET /photos/:id/content', () => {
  it('returns the exact bytes with the stored media type', async () => {
    const bytes = pngBytes(200);
    const id = await uploadAndGetId(alice.accessToken, bytes);

    const response = await call(`/photos/${id}/content`, { token: alice.accessToken });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // `private` keeps shared caches out; the bucket is not public.
    expect(response.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('tells the browser not to sniff the type of bytes a user uploaded', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    const response = await call(`/photos/${id}/content`, { token: alice.accessToken });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    const first = await call(`/photos/${id}/content`, { token: alice.accessToken });
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await call(`/photos/${id}/content`, {
      token: alice.accessToken,
      headers: { 'if-none-match': etag! },
    });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  it('404s an id that does not exist', async () => {
    const response = await call('/photos/pht_00000000000000000000000000000000/content', {
      token: alice.accessToken,
    });
    expect(response.status).toBe(404);
  });

  it('404s when D1 has a row but R2 lost the object', async () => {
    // Simulates the inconsistent state the two-service design permits.
    const id = await uploadAndGetId(alice.accessToken);
    const row = await env.DB.prepare('SELECT object_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ object_key: string }>();
    await env.PHOTOS.delete(row!.object_key);

    const response = await call(`/photos/${id}/content`, { token: alice.accessToken });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('ownership', () => {
  it("hides one user's photos from another user's list", async () => {
    await uploadAndGetId(alice.accessToken);

    const response = await call('/photos', { token: bob.accessToken });
    expect(await response.json()).toEqual({ data: { photos: [] } });
  });

  it("refuses to serve another user's image bytes", async () => {
    const id = await uploadAndGetId(alice.accessToken);

    const response = await call(`/photos/${id}/content`, { token: bob.accessToken });
    // 404, not 403: a 403 would confirm the id exists.
    expect(response.status).toBe(404);
  });

  it("refuses to delete another user's photo, and leaves it intact", async () => {
    const id = await uploadAndGetId(alice.accessToken);

    const response = await call(`/photos/${id}`, { method: 'DELETE', token: bob.accessToken });
    expect(response.status).toBe(404);

    // Alice's photo survived.
    expect(await countRows('photos')).toBe(1);
    const stillThere = await call(`/photos/${id}/content`, { token: alice.accessToken });
    expect(stillThere.status).toBe(200);
  });

  it('scopes R2 keys by user, so one prefix lists exactly one account', async () => {
    await uploadAndGetId(alice.accessToken);
    await uploadAndGetId(bob.accessToken);

    const alicesObjects = await env.PHOTOS.list({ prefix: `photos/${alice.userId}/` });
    expect(alicesObjects.objects).toHaveLength(1);
    expect(await listObjectKeys()).toHaveLength(2);
  });
});

describe('DELETE /photos/:id', () => {
  it('removes the D1 row and the R2 object', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    const row = await env.DB.prepare('SELECT object_key FROM photos WHERE id = ?')
      .bind(id)
      .first<{ object_key: string }>();

    const response = await call(`/photos/${id}`, { method: 'DELETE', token: alice.accessToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id } });

    expect(await countRows('photos')).toBe(0);
    expect(await env.PHOTOS.get(row!.object_key)).toBeNull();
  });

  it('404s a second delete of the same photo', async () => {
    const id = await uploadAndGetId(alice.accessToken);
    expect(
      (await call(`/photos/${id}`, { method: 'DELETE', token: alice.accessToken })).status,
    ).toBe(200);
    expect(
      (await call(`/photos/${id}`, { method: 'DELETE', token: alice.accessToken })).status,
    ).toBe(404);
  });

  it('rejects the wrong method on the collection and the item', async () => {
    expect((await call('/photos', { method: 'DELETE', token: alice.accessToken })).status).toBe(
      405,
    );
    const id = await uploadAndGetId(alice.accessToken);
    expect((await call(`/photos/${id}`, { method: 'GET', token: alice.accessToken })).status).toBe(
      405,
    );
  });
});

/**
 * Partial-failure behaviour.
 *
 * R2 and D1 cannot be written atomically, so what matters is which side fails
 * first and whether we clean up after ourselves. These tests inject a broken
 * binding while leaving the other one real.
 */
describe('partial failures across R2 and D1', () => {
  it('deletes the uploaded object when the D1 insert fails', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    const request = new IncomingRequest('https://vault.test/photos', {
      method: 'POST',
      body: pngBytes().slice().buffer as ArrayBuffer,
    });

    const response = await uploadPhoto(
      request,
      { ...env, DB: brokenDb },
      { id: alice.userId, sessionId: 'ses_00000000000000000000000000000000' },
    );

    expect(response.status).toBe(500);
    // The crucial assertion: no orphan left behind in the real bucket.
    expect(await listObjectKeys()).toEqual([]);
  });

  it('writes no metadata when the R2 put fails', async () => {
    const brokenBucket = {
      put() {
        throw new Error('R2 unavailable');
      },
    } as unknown as R2Bucket;

    const request = new IncomingRequest('https://vault.test/photos', {
      method: 'POST',
      body: pngBytes().slice().buffer as ArrayBuffer,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });

    const response = await worker.fetch(request, { ...env, PHOTOS: brokenBucket });

    // Mapped to a 500 by the top-level handler, with no internal detail leaked.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).not.toContain('R2 unavailable');

    expect(await countRows('photos')).toBe(0);
  });
});

describe('CORS', () => {
  it('answers a preflight from an allowed origin', async () => {
    const response = await call('/photos', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:8081',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('refuses a preflight from an unlisted origin', async () => {
    const response = await call('/photos', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('sends no CORS header to an unlisted origin on a real request', async () => {
    const response = await call('/photos', {
      token: alice.accessToken,
      headers: { origin: 'https://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
