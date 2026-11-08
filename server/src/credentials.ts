/**
 * Validation and normalisation of the things a user types.
 *
 * Kept separate from server/src/validate.ts (which checks uploaded bytes)
 * because these rules are policy, not facts: you may well want a different
 * minimum password length, and this is the one file to change.
 */

/** RFC 5321's maximum length for a forward path. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Minimum password length.
 *
 * Length, and nothing else. No "must contain a digit and a symbol": NIST
 * SP 800-63B explicitly recommends against composition rules, because they
 * push people towards `Password1!` and towards reusing the one string that
 * satisfies every site. Length is the property that actually buys entropy.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Bounded so a 10 MB request body cannot be fed to PBKDF2. The derivation cost
 * is dominated by the iteration count rather than the input length, but there
 * is no reason to accept an unbounded string into a CPU-limited operation.
 */
const MAX_PASSWORD_LENGTH = 1024;

/**
 * A deliberately boring email check.
 *
 * It is not RFC 5322 and does not try to be: a fully correct address grammar
 * accepts things no mail server will deliver to, and rejecting a valid-but-odd
 * address is a worse bug than accepting one. The only properties we need are
 * "has exactly one @, with something either side, and a dot in the domain" -
 * enough to catch a typo and to guarantee the value is safe as a display
 * string. Real verification is sending mail to it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Lowercases and trims, so `  Me@Example.COM ` and `me@example.com` cannot
 * become two accounts. Normalisation happens BEFORE the uniqueness check and
 * before storage, which is what makes the UNIQUE constraint in the migration
 * mean what it looks like it means.
 *
 * Note that lowercasing the local part is technically a choice: `A@x.com` and
 * `a@x.com` may be different mailboxes by the standard. Every mail provider in
 * practice treats them as one, and every user expects that, so this follows
 * the expectation rather than the standard.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type CredentialProblem = { field: 'email' | 'password'; message: string };

export function validateEmail(raw: unknown): CredentialProblem | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { field: 'email', message: 'Email is required.' };
  }
  const email = normalizeEmail(raw);
  if (email.length > MAX_EMAIL_LENGTH) {
    return { field: 'email', message: 'That email address is too long.' };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { field: 'email', message: 'That does not look like an email address.' };
  }
  return null;
}

export function validatePassword(raw: unknown): CredentialProblem | null {
  if (typeof raw !== 'string' || raw === '') {
    return { field: 'password', message: 'Password is required.' };
  }
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return {
      field: 'password',
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    return { field: 'password', message: 'Password is too long.' };
  }
  return null;
}

/** Truncated for storage; display-only, so a long header cannot bloat a row. */
export function sanitizeUserAgent(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return stripped ? stripped.slice(0, 200) : null;
}

export type SignupMode = 'open' | 'invite' | 'closed';

/**
 * Anything unrecognised - including unset - becomes "closed".
 *
 * This is the fail-closed direction, and it is the direction that matters: a
 * typo in the config should make sign-up stop working (which you notice
 * immediately) rather than open your storage to the internet (which you notice
 * on the bill).
 */
export function resolveSignupMode(raw: string | undefined): SignupMode {
  if (raw === 'open' || raw === 'invite') return raw;
  return 'closed';
}

/**
 * Invite codes come from a secret, comma-separated. Compared in constant time
 * by the caller.
 */
export function parseInviteCodes(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}
