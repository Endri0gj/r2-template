-- Migration number: 0002 	 2026-11-08T00:00:00.000Z
--
-- Real identity, replacing the pre-shared bearer tokens of 0001.
--
-- Two tables, because an account and a sign-in are different lifetimes: an
-- account lasts years, a sign-in on one device should be revocable on its own
-- without touching the account or the user's other devices.

-- ------------------------------------------------------------------ --
-- users
-- ------------------------------------------------------------------ --
--   id             `usr_<32 hex>`. This value becomes `photos.owner_id` and
--                  the `photos/<id>/...` prefix in R2, so it must be opaque,
--                  stable and URL-safe forever. An email would be none of
--                  those: people change them.
--   email          Stored already normalised (trimmed, lowercased) so the
--                  UNIQUE constraint actually prevents "Me@x.com" and
--                  "me@x.com" becoming two accounts.
--   password_hash  A SELF-DESCRIBING string:
--                    pbkdf2-sha256$<iterations>$<salt_b64url>$<hash_b64url>
--                  The parameters travel with the hash, which is what lets the
--                  iteration count be raised later without invalidating
--                  everybody's password. See server/src/password.ts.
--   disabled_at    Non-null disables sign-in and invalidates existing
--                  sessions. Softer and more reversible than DELETE, and it
--                  keeps the user's photos addressable while you investigate.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

-- ------------------------------------------------------------------ --
-- sessions
-- ------------------------------------------------------------------ --
-- One row per signed-in device. Holds the REFRESH token, not the access token.
--
--   id           `ses_<32 hex>`. Sent to the client in the clear as the first
--                half of the refresh token, so the server can find the row
--                with a primary-key lookup instead of scanning for a hash.
--   token_hash   SHA-256 of the refresh token's secret half. The secret itself
--                is never stored: a dump of this table does not let anyone
--                sign in. (Unlike a password, this secret is 256 bits of
--                CSPRNG output, so there is nothing to brute-force and a
--                plain digest is enough - no salt or iteration count needed.)
--   expires_at   Absolute cutoff, checked in SQL. A session is not valid
--                forever just because nobody got round to deleting it.
--   revoked_at   Set on sign-out and on refresh-token rotation. Rows are KEPT
--                after revocation on purpose: presenting an already-rotated
--                token is the signal that a token was stolen and replayed, and
--                you can only detect that if the old row still exists. The
--                scheduled job in server/src/reconcile.ts purges them later.
--   user_agent   Truncated, display-only, so a "your devices" screen can say
--                something more useful than an opaque id.
--
-- The FOREIGN KEY here is safe to cascade because deleting a user's sessions
-- has no effects outside D1. `photos` deliberately has NO such constraint:
-- cascading a user delete would drop photo rows while leaving their bytes in
-- R2 forever, with nothing left pointing at them. Deleting an account has to
-- be code that deletes R2 objects too - see docs/CLOUDFLARE_R2_EXPO_GUIDE.md.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at   TEXT,
  user_agent   TEXT
);

-- "Revoke every session for this user" (sign out everywhere, account disabled,
-- stolen-token response) and "purge what expired" are the two queries that are
-- not primary-key lookups, so they get the two indexes.
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
