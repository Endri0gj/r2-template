/**
 * Identifier and object-key generation.
 *
 * `crypto.randomUUID()` is available in the Workers runtime with no imports.
 * https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
 *
 * Every id is a prefix plus 128 bits of random hex. The prefix costs four
 * characters and pays for itself the first time you read a log line, a stack
 * trace or a database row and know immediately what kind of thing you are
 * looking at - and the first time a bug passes a session id where a user id
 * belongs, because the pattern check below rejects it instead of querying for
 * it.
 */

function randomHex(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** Opaque, unguessable photo id. */
export function newPhotoId(): string {
  return `pht_${randomHex()}`;
}

/**
 * User id. This becomes `photos.owner_id` AND the `photos/<id>/` prefix inside
 * R2, so it has to stay stable and URL-safe for the life of the account. That
 * is the reason it is not the email address: people change their email, and
 * re-keying every object in R2 to follow them is not a thing you want to own.
 */
export function newUserId(): string {
  return `usr_${randomHex()}`;
}

export function newSessionId(): string {
  return `ses_${randomHex()}`;
}

export const USER_ID_PATTERN = /^usr_[0-9a-f]{32}$/;
export const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
export const PHOTO_ID_PATTERN = /^pht_[0-9a-f]{32}$/;

/**
 * Builds the R2 object key.
 *
 * Three deliberate choices:
 *
 * 1. The client's filename is NOT in the key. If it were, two users uploading
 *    "IMG_0001.jpg" would collide, and a filename like "../../secret" would
 *    try to escape the prefix. Filenames are untrusted display data.
 * 2. The owner is the first path segment. R2 keys are flat strings, but the
 *    `/` convention lets `list({ prefix: "photos/usr_x/" })` enumerate one
 *    user's objects - which is exactly what deleting an account needs.
 * 3. No file extension. The media type lives in R2's own httpMetadata and in
 *    D1, both of which we control. An extension in the key would be a third
 *    copy of the same fact, free to drift out of sync with the other two.
 */
export function newObjectKey(ownerId: string, photoId: string): string {
  return `photos/${ownerId}/${photoId}`;
}
