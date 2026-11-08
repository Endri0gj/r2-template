/**
 * Byte/string plumbing used by the auth code.
 *
 * Everything here is standard Web Crypto / Web platform API, available in
 * `workerd` with no imports and no dependencies.
 * https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
 */

/**
 * base64url, the URL-safe base64 variant from RFC 4648 §5: `+` becomes `-`,
 * `/` becomes `_`, and the `=` padding is dropped.
 *
 * Why this and not plain base64? These values travel inside JWTs (which are
 * dot-separated base64url by specification) and inside bearer tokens that end
 * up in HTTP headers. `+` and `/` would need percent-encoding in those places,
 * and `=` is a reserved character in several of them.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  // `atob` requires the padding that base64url omits, so put it back.
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 32 bytes (256 bits) of CSPRNG output, base64url-encoded. */
export function randomSecret(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(text) as BufferSource);
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Compares two strings without leaking, through timing, how many leading
 * characters matched. A plain `===` returns faster the earlier it finds a
 * mismatch, which is measurable over many requests.
 *
 * The LENGTH of a token is not a secret (all of ours are fixed-length), so
 * returning early on a length mismatch is fine.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
