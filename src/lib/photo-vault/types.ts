/**
 * The client's view of the API contract.
 *
 * These types are written out by hand rather than imported from `server/src`.
 * The two packages have separate dependency trees and separate TypeScript
 * configs, and Metro should not be following imports out of `src/`. The cost is
 * that this file and the Worker's types must be kept in step; the benefit is
 * that the mobile build stays independent of the backend's toolchain. If the
 * API grows, the right fix is a third package that both import - not a relative
 * import across the boundary.
 */

export interface Photo {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  /** Relative to the API base URL, e.g. "/photos/pht_abc/content". */
  contentPath: string;
}

export interface Account {
  id: string;
  email: string;
  createdAt: string;
}

/**
 * What the server returns from sign-up, sign-in and refresh.
 *
 * The two tokens are stored in different places on purpose:
 *
 *   accessToken   memory only. It lives ~15 minutes, and writing it to disk
 *                 would put a working credential somewhere it can be read
 *                 later for no benefit.
 *   refreshToken  the OS keychain (expo-secure-store). It is long-lived, so it
 *                 has to survive an app restart, which means it has to be
 *                 somewhere - and the keychain is the only "somewhere" on a
 *                 phone that is encrypted at rest.
 */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds from when the response was received, not an absolute time. */
  expiresIn: number;
  user: Account;
}

/** Mirrors the Worker's ApiErrorCode, plus client-only failure modes. */
export type PhotoVaultErrorCode =
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
  | 'internal_error'
  // Raised on the device, never returned by the server:
  | 'network'
  | 'not_configured'
  | 'cancelled'
  | 'signed_out'
  | 'unknown';

export class PhotoVaultError extends Error {
  readonly code: PhotoVaultErrorCode;
  readonly status: number | null;

  constructor(code: PhotoVaultErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'PhotoVaultError';
    this.code = code;
    this.status = status;
  }
}

/** A photo chosen on the device, before it has been uploaded anywhere. */
export interface PickedPhoto {
  /**
   * A LOCAL URI, e.g. `file:///var/mobile/.../IMG_0004.jpg` or
   * `ph://...` on iOS. It is a path on this one device. It is not a URL anyone
   * else can open, it is not an R2 URL, and sending it to the server would
   * accomplish nothing - the bytes have to travel.
   */
  uri: string;
  filename: string;
  /** What the OS claims the type is. The server re-checks the real bytes. */
  mimeType: string | null;
  width: number;
  height: number;
}
