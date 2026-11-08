/**
 * Shared types for the Photo Vault Worker.
 *
 * `Env` is the second argument the Workers runtime hands to `fetch()`. Each
 * property corresponds to an entry in wrangler.jsonc: bindings are live objects
 * injected by the runtime, the rest are plain strings.
 * https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/
 *
 * Every var is typed `string`, even the numeric ones, because that is what the
 * runtime actually provides - Wrangler does not coerce. Each is parsed through
 * a `resolve*` function that applies a safe default, so a typo in the config
 * degrades to the default instead of producing `NaN` somewhere downstream.
 */
export interface Env {
  /** R2 bucket binding. Stores image bytes. wrangler.jsonc -> r2_buckets[].binding */
  PHOTOS: R2Bucket;
  /** D1 binding. Users, sessions and image metadata. -> d1_databases[].binding */
  DB: D1Database;

  /* ---- secrets (`.dev.vars` locally, `wrangler secret put` in production) -- */

  /**
   * SECRET. The HMAC key that signs access tokens. Anyone holding this can mint
   * a token for any user, so it is the single most sensitive value in the
   * system. At least 32 random bytes; `openssl rand -base64 48` is fine.
   * Rotating it signs every existing access token out (by design).
   */
  AUTH_SECRET: string;
  /**
   * SECRET, optional. Comma-separated invite codes accepted by `/auth/signup`
   * while SIGNUP_MODE is "invite". Unset + "invite" mode means nobody can
   * sign up, which is the correct fail-closed direction.
   */
  SIGNUP_INVITE_CODES?: string;

  /* ---- rate limiters (see server/src/ratelimit.ts) ------------------------ */

  /** Brute-force protection on the auth endpoints. */
  AUTH_LIMITER?: RateLimit;
  /** Caps how fast one account can push bytes into R2. */
  UPLOAD_LIMITER?: RateLimit;
  /** Generous cap on reads, sized for a gallery's first paint. */
  READ_LIMITER?: RateLimit;

  /* ---- plain configuration ----------------------------------------------- */

  /** Max accepted upload size in bytes. */
  MAX_UPLOAD_BYTES?: string;
  /** Comma-separated browser origins allowed to call this API. Empty = none. */
  ALLOWED_ORIGINS?: string;
  /** PBKDF2 iterations for new password hashes. See server/src/password.ts. */
  PASSWORD_ITERATIONS?: string;
  /** Access-token lifetime in seconds. Short on purpose. */
  ACCESS_TOKEN_TTL_SECONDS?: string;
  /** Refresh-token (session) lifetime in seconds. */
  REFRESH_TOKEN_TTL_SECONDS?: string;
  /** "open" | "invite" | "closed". Anything else is treated as "closed". */
  SIGNUP_MODE?: string;
  /**
   * "true" lets the scheduled job DELETE photo rows whose R2 object has gone
   * missing. Defaults to off: that is destructive and unrecoverable, so it is
   * opt-in and never the default.
   */
  RECONCILE_DELETE_DANGLING_ROWS?: string;
}

/* ------------------------------------------------------------------ *
 * Database rows - these mirror the migrations exactly.
 * ------------------------------------------------------------------ */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  disabled_at: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
  user_agent: string | null;
}

/** A row of the `photos` table, exactly as D1 returns it. */
export interface PhotoRow {
  id: string;
  owner_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

/* ------------------------------------------------------------------ *
 * API payloads - deliberately NOT the row shapes.
 * ------------------------------------------------------------------ */

/**
 * What the API sends to the client for a photo. Deliberately different from
 * PhotoRow:
 * - camelCase, because the consumer is TypeScript
 * - `owner_id` and `object_key` are NOT exposed. The client has no use for the
 *   storage layout, and leaking it invites clients to depend on it.
 * - `contentPath` is a relative path, not an absolute URL. The app already
 *   knows its API base URL, and hardcoding one here would break the moment you
 *   move between local dev and production.
 */
export interface Photo {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  contentPath: string;
}

export function toPhoto(row: PhotoRow): Photo {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    contentPath: `/photos/${row.id}/content`,
  };
}

/** The caller's own account. Note the absence of `password_hash`. */
export interface AccountView {
  id: string;
  email: string;
  createdAt: string;
}

export function toAccount(row: Pick<UserRow, 'id' | 'email' | 'created_at'>): AccountView {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

/**
 * What a successful sign-in / sign-up / refresh returns.
 *
 * `expiresIn` is seconds-from-now rather than an absolute timestamp, so the
 * client never has to trust its own clock to be in step with the server's.
 */
export interface SessionView {
  accessToken: string;
  /** Opaque `ses_<id>.<secret>`. Store it in the device keychain, nowhere else. */
  refreshToken: string;
  expiresIn: number;
  user: AccountView;
}

/** Every error this API can return. The app switches on these, not on prose. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'length_required'
  | 'unsupported_media_type'
  | 'bad_request'
  | 'validation_failed'
  | 'email_taken'
  | 'invalid_credentials'
  | 'signup_disabled'
  | 'invalid_invite'
  | 'account_disabled'
  | 'rate_limited'
  | 'forbidden_origin'
  | 'internal_error';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
