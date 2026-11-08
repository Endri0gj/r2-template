import { constantTimeEquals, fromBase64Url, toBase64Url, utf8 } from './encoding';

/**
 * HS256 JSON Web Tokens, hand-rolled on Web Crypto.
 *
 * ## Why a JWT at all, instead of an opaque session token
 *
 * Because of the gallery. Rendering 50 thumbnails means 50 requests to
 * `GET /photos/:id/content`. With an opaque token, every one of those must hit
 * D1 to find out who is calling - 50 extra billed row reads to serve a screen.
 * A signed token carries the answer with it, so authentication costs one HMAC
 * (microseconds, no I/O) and the only D1 read left is the one that checks the
 * photo belongs to the caller.
 *
 * ## What you give up, stated plainly
 *
 * A signed token cannot be un-signed. Revoking a session sets `revoked_at` in
 * D1, but an access token already in someone's hands keeps verifying until it
 * expires - we are deliberately not checking the database on every request, so
 * we cannot notice. That window is the access token's lifetime, 15 minutes.
 *
 * This is the standard trade and the standard mitigation: keep access tokens
 * short, keep the refresh token in the database where it CAN be revoked
 * instantly, and accept a bounded window. If your threat model cannot accept
 * 15 minutes, the fix is not a longer JWT - it is to look the session up on
 * every request (and pay for it), or to keep a revocation list in KV and read
 * that instead.
 *
 * ## Why not a library
 *
 * `jose` is excellent and is what you should use if you need JWE, key sets,
 * multiple algorithms or OIDC discovery. For one algorithm with one local
 * secret, the whole implementation is the 80 lines below, and writing them out
 * means the two mistakes that matter are visible rather than trusted:
 *
 *   1. The `alg` header is NOT consulted when verifying. We verify with HS256
 *      because that is what we chose. Honouring the token's own `alg` field is
 *      the classic JWT vulnerability - a forged `{"alg":"none"}` header, or an
 *      RS256 public key used as an HS256 secret.
 *   2. The signature is compared in constant time, and BEFORE the payload is
 *      parsed. Nothing from an unverified token reaches any other code.
 */

export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  /** Session id, so a token can be traced back to the sign-in that issued it. */
  sid: string;
  iss: string;
  aud: string;
  /** Seconds since the epoch, per RFC 7519 (NOT milliseconds). */
  iat: number;
  exp: number;
}

export const JWT_ISSUER = 'photo-vault-api';
export const JWT_AUDIENCE = 'photo-vault-app';

/**
 * Small clock skew allowance. Devices disagree with Cloudflare's clock by a
 * second or two routinely; rejecting a token because the phone is 400 ms ahead
 * is an outage, not security.
 */
const CLOCK_SKEW_SECONDS = 30;

const HEADER = toBase64Url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, utf8(data) as BufferSource);
  return toBase64Url(new Uint8Array(signature));
}

export async function issueAccessToken(
  claims: Omit<AccessTokenClaims, 'iss' | 'aud'>,
  secret: string,
): Promise<string> {
  const full: AccessTokenClaims = { ...claims, iss: JWT_ISSUER, aud: JWT_AUDIENCE };
  const payload = toBase64Url(utf8(JSON.stringify(full)));
  const data = `${HEADER}.${payload}`;
  return `${data}.${await sign(data, secret)}`;
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'wrong_claims';

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: VerifyFailure };

/** Verifies the signature first, then the claims. Never throws. */
export async function verifyAccessToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return { ok: false, reason: 'malformed' };

  const expected = await sign(`${header}.${payload}`, secret);
  if (!constantTimeEquals(signature, expected)) return { ok: false, reason: 'bad_signature' };

  // Only now, with the signature proven, is it safe to look at the contents.
  let claims: AccessTokenClaims;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (decoded === null || typeof decoded !== 'object') return { ok: false, reason: 'malformed' };
    claims = decoded as AccessTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.iss !== JWT_ISSUER || claims.aud !== JWT_AUDIENCE) {
    return { ok: false, reason: 'wrong_claims' };
  }
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
    return { ok: false, reason: 'wrong_claims' };
  }
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    return { ok: false, reason: 'wrong_claims' };
  }

  const nowSeconds = Math.floor(now / 1000);
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return { ok: false, reason: 'expired' };
  // A token minted in the future is either a clock problem or a forgery
  // attempt with a tampered `iat`; either way it is not usable.
  if (claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) return { ok: false, reason: 'wrong_claims' };

  return { ok: true, claims };
}
