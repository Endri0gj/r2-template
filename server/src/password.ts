import { constantTimeEquals, fromBase64Url, toBase64Url, utf8 } from './encoding';

/**
 * Password hashing.
 *
 * ## Why PBKDF2 and not Argon2id or bcrypt
 *
 * Argon2id is the better algorithm and is what you would pick given a free
 * choice. It is not available here: `workerd` exposes Web Crypto, whose
 * `deriveBits` supports PBKDF2, HKDF and ECDH - not Argon2 or bcrypt. Using
 * Argon2 in a Worker means shipping a WebAssembly build of it, which is a real
 * option (see the guide) but a dependency, a bigger bundle, and more startup
 * time. PBKDF2-HMAC-SHA256 at a high iteration count is still an accepted
 * password hash - it is what NIST SP 800-63B and the OWASP Password Storage
 * Cheat Sheet describe - so it is what this uses.
 *
 * ## The CPU-time problem you must know about
 *
 * Deliberately slow hashing costs CPU, and a Worker has a CPU budget:
 *
 *   Workers Free  10 ms per request
 *   Workers Paid  5 min max, 30 s by default
 *
 * https://developers.cloudflare.com/workers/platform/limits/#cpu-time
 *
 * 600,000 PBKDF2 iterations does not fit in 10 ms. It is not close. **Password
 * sign-in in a Worker requires the Workers Paid plan.** Lowering the iteration
 * count until it fits the free tier is not a workaround, it is just a weaker
 * password hash; if you need the free tier, move authentication to a provider
 * that does the hashing for you and have this Worker verify its tokens.
 *
 * Only `/auth/signup`, `/auth/signin` and a password change pay this cost.
 * Every other request verifies a JWT instead, which is one HMAC - microseconds.
 *
 * ## The encoding
 *
 *   pbkdf2-sha256$<iterations>$<salt_b64url>$<hash_b64url>
 *
 * The parameters travel with the hash. That is what lets you raise the
 * iteration count later: old hashes keep verifying with the count they were
 * made at, and `needsRehash()` tells you to re-hash on the user's next
 * successful sign-in, when you have the plaintext in hand anyway.
 */

const ALGORITHM = 'pbkdf2-sha256';
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

/** OWASP Password Storage Cheat Sheet, PBKDF2-HMAC-SHA256. */
export const DEFAULT_ITERATIONS = 600_000;

/**
 * Refuse to run below this. A misconfigured var must not silently downgrade
 * every new password to something crackable. The tests override the var to a
 * small value on purpose - they verify the encoding and the comparison, not
 * the cost factor - and that is why the floor is this low rather than, say,
 * 100,000. Production is protected by `assertProductionIterations()` instead.
 */
const MIN_ITERATIONS = 1_000;

export function resolveIterations(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_ITERATIONS) return DEFAULT_ITERATIONS;
  return Math.floor(parsed);
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  // `importKey` with "raw" + PBKDF2 gives a key usable only for derivation -
  // it cannot be exported or used to encrypt anything.
  const key = await crypto.subtle.importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  // A fresh random salt per password. This is what stops one precomputed table
  // from attacking every account at once, and what makes two users who chose
  // the same password have different hashes.
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupt row
 * must fail closed, not 500 in a way that tells the caller something about it.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [algorithm, iterationsText, saltText, expected] = parts;
  if (algorithm !== ALGORITHM) return false;

  const iterations = Number(iterationsText);
  // An attacker who could write this row could otherwise set iterations to
  // 2_000_000_000 and turn every sign-in attempt into a CPU-limit kill.
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;

  let salt: Uint8Array;
  try {
    salt = fromBase64Url(saltText ?? '');
  } catch {
    return false;
  }
  if (salt.length === 0) return false;

  const actual = toBase64Url(await derive(password, salt, iterations));
  return constantTimeEquals(actual, expected ?? '');
}

/** True when `stored` was made with fewer iterations than we now require. */
export function needsRehash(stored: string, iterations: number): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return true;
  const storedIterations = Number(parts[1]);
  return !Number.isFinite(storedIterations) || storedIterations < iterations;
}

/**
 * A hash of a password nobody knows, used to spend the same CPU on a sign-in
 * attempt for an email that does not exist as one for an email that does.
 *
 * Without this, "unknown email" returns in a fraction of a millisecond while
 * "known email, wrong password" takes a few hundred - which turns the sign-in
 * endpoint into an account-enumeration oracle no matter how carefully the
 * response body is worded.
 *
 * Generated once per isolate at module scope rather than per request, because
 * generating it IS the expensive operation we are trying to mimic. Keyed by
 * iteration count so that raising the cost factor does not leave the decoy
 * burning the old, smaller amount of CPU - which would reopen the timing gap.
 */
const decoyHashes = new Map<number, Promise<string>>();

export function decoyPasswordHash(iterations: number): Promise<string> {
  let pending = decoyHashes.get(iterations);
  if (!pending) {
    pending = hashPassword(crypto.randomUUID(), iterations);
    decoyHashes.set(iterations, pending);
  }
  return pending;
}
