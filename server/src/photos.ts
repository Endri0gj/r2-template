import type { Principal } from './auth';
import { readBodyWithLimit } from './body';
import { errorResponse, jsonResponse } from './http';
import { newObjectKey, newPhotoId } from './ids';
import { toPhoto, type Env, type Photo, type PhotoRow } from './types';
import { resolveMaxUploadBytes, sanitizeFilename, sniffImageType } from './validate';

/** Hard cap on how many rows one list request can return. */
const LIST_LIMIT = 200;

/* ------------------------------------------------------------------ *
 * GET /photos
 * ------------------------------------------------------------------ */

export async function listPhotos(env: Env, principal: Principal): Promise<Response> {
  // `.bind()` is what makes this injection-proof: the value never becomes part
  // of the SQL text, it is sent to SQLite as a separate parameter.
  // https://developers.cloudflare.com/d1/worker-api/prepared-statements/#bind
  const { results } = await env.DB.prepare(
    `SELECT id, owner_id, object_key, filename, content_type, size_bytes, created_at
       FROM photos
      WHERE owner_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(principal.id, LIST_LIMIT)
    .all<PhotoRow>();

  const photos: Photo[] = (results ?? []).map(toPhoto);
  return jsonResponse({ data: { photos } });
}

/* ------------------------------------------------------------------ *
 * POST /photos
 * ------------------------------------------------------------------ */

export async function uploadPhoto(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const limit = resolveMaxUploadBytes(env.MAX_UPLOAD_BYTES);

  // 1. Read the bytes, refusing to buffer more than the limit.
  const body = await readBodyWithLimit(request, limit);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      return errorResponse(
        413,
        'payload_too_large',
        `Image exceeds the ${limit}-byte limit.`,
      );
    }
    return errorResponse(400, 'bad_request', 'Request body was empty.');
  }

  // 2. Decide the media type from the BYTES, not from the client's header.
  const contentType = sniffImageType(body.bytes);
  if (!contentType) {
    return errorResponse(
      415,
      'unsupported_media_type',
      'Body is not a JPEG, PNG, WebP or HEIC image.',
    );
  }

  const filename = sanitizeFilename(request.headers.get('x-filename'));
  const id = newPhotoId();
  const objectKey = newObjectKey(principal.id, id);
  const createdAt = new Date().toISOString();

  // 3. Bytes into R2 first.
  //
  // Why this order? The two writes cannot be atomic (see below), so one of
  // them has to go first, and the failure modes are not symmetrical:
  //   - object written, row missing  -> an orphan object. Invisible to the
  //     user, costs a little storage, cleanable.
  //   - row written, object missing  -> a broken photo in the gallery. The
  //     user sees it and it never works.
  // The first is clearly the better failure, so R2 goes first.
  await env.PHOTOS.put(objectKey, body.bytes, {
    httpMetadata: {
      contentType,
      // Keys are unique and objects are never overwritten, so the bytes at a
      // key can never change. `immutable` is therefore truthful here.
      cacheControl: 'private, max-age=31536000, immutable',
    },
  });

  // 4. Metadata into D1.
  //
  // IMPORTANT: R2 and D1 are separate services. There is no transaction that
  // spans them, and `D1Database.batch()` does not help - it is a transaction
  // over D1 statements only. So if this insert fails, we have already written
  // the object, and we clean it up ourselves.
  try {
    await env.DB.prepare(
      `INSERT INTO photos (id, owner_id, object_key, filename, content_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, principal.id, objectKey, filename, contentType, body.bytes.byteLength, createdAt)
      .run();
  } catch (cause) {
    console.error('D1 insert failed after R2 put; rolling back the object', {
      objectKey,
      cause: String(cause),
    });
    // Best effort. If this delete also fails the object is orphaned - logged,
    // not fatal, and reconcilable by sweeping R2 for keys with no D1 row.
    try {
      await env.PHOTOS.delete(objectKey);
    } catch (deleteCause) {
      console.error('Failed to roll back orphaned R2 object', {
        objectKey,
        cause: String(deleteCause),
      });
    }
    return errorResponse(500, 'internal_error', 'Could not save the photo.');
  }

  const photo = toPhoto({
    id,
    owner_id: principal.id,
    object_key: objectKey,
    filename,
    content_type: contentType,
    size_bytes: body.bytes.byteLength,
    created_at: createdAt,
  });

  return jsonResponse({ data: { photo } }, { status: 201 });
}

/* ------------------------------------------------------------------ *
 * GET /photos/:id/content
 * ------------------------------------------------------------------ */

export async function readPhotoContent(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
): Promise<Response> {
  // Ownership is enforced HERE, on the image read, not only on the list. An
  // endpoint that serves bytes to anyone holding an id is a public bucket with
  // extra steps.
  const row = await env.DB.prepare(
    `SELECT object_key, content_type FROM photos WHERE id = ? AND owner_id = ?`,
  )
    .bind(id, principal.id)
    .first<Pick<PhotoRow, 'object_key' | 'content_type'>>();

  // Deliberately 404 and not 403: a 403 would confirm that this id exists and
  // belongs to somebody else.
  if (!row) return errorResponse(404, 'not_found', 'Photo not found.');

  const object = await env.PHOTOS.get(row.object_key);
  if (!object) {
    // D1 says it exists, R2 says it does not. This is the inconsistent state
    // the two-service design allows, so it is logged loudly rather than
    // silently returning an empty image.
    console.error('D1 row has no matching R2 object', { id, objectKey: row.object_key });
    return errorResponse(404, 'not_found', 'Photo content is missing.');
  }

  const headers = new Headers();
  // Copies contentType/cacheControl that we set at upload time back out as
  // real HTTP headers.
  object.writeHttpMetadata(headers);
  // Belt and braces: if an older object predates the metadata we now set,
  // fall back to the type recorded in D1 rather than serving no type.
  if (!headers.has('content-type')) headers.set('content-type', row.content_type);
  headers.set('etag', object.httpEtag);
  // `private` keeps shared caches out of it. The bucket is not public and
  // these bytes are one user's.
  headers.set('cache-control', 'private, max-age=31536000, immutable');

  // Conditional request support: the device already has these bytes, so send
  // 304 and no body. This is the cheapest possible gallery scroll - it costs
  // one D1 read and one R2 HeadObject-equivalent instead of transferring the
  // image again.
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // `object.body` is a ReadableStream: the bytes flow from R2 to the client
  // without the Worker buffering the whole image.
  return new Response(object.body, { status: 200, headers });
}

/* ------------------------------------------------------------------ *
 * DELETE /photos/:id
 * ------------------------------------------------------------------ */

export async function deletePhoto(env: Env, principal: Principal, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT object_key FROM photos WHERE id = ? AND owner_id = ?`,
  )
    .bind(id, principal.id)
    .first<Pick<PhotoRow, 'object_key'>>();

  if (!row) return errorResponse(404, 'not_found', 'Photo not found.');

  // Delete order is the mirror image of the upload order, for the same reason:
  // the row goes first, so the worst case is an orphan object rather than a
  // gallery entry whose image 404s.
  //
  // The owner_id predicate is repeated here on purpose. The SELECT above
  // already checked it, but between the two statements nothing stops a
  // concurrent request, and authorization belongs on the statement that
  // actually mutates data.
  const result = await env.DB.prepare(`DELETE FROM photos WHERE id = ? AND owner_id = ?`)
    .bind(id, principal.id)
    .run();

  // `meta.changes` is how many rows the statement actually affected. Zero means
  // a concurrent request deleted it first, which is not an error for DELETE.
  if (result.meta.changes === 0) {
    return errorResponse(404, 'not_found', 'Photo not found.');
  }

  try {
    await env.PHOTOS.delete(row.object_key);
  } catch (cause) {
    // The user's gallery is already correct, so this is not a failed request.
    console.error('R2 delete failed; object is now orphaned', {
      objectKey: row.object_key,
      cause: String(cause),
    });
  }

  return jsonResponse({ data: { id } });
}
