-- Migration number: 0001 	 2026-11-08T00:00:00.000Z
--
-- Photo metadata. The image BYTES live in R2; this table only describes them.
--
-- Column notes:
--   id          Our own opaque identifier. This is what the API and the mobile
--               app pass around. It is NOT derived from the filename or from
--               anything the client controls.
--   owner_id    The authenticated principal that uploaded the photo. Every
--               read/delete query filters on this, so one user can never
--               address another user's photo by guessing an id.
--   object_key  Where the bytes are in R2. Kept separate from `id` so the
--               storage layout can change (prefixes, sharding, re-keying)
--               without breaking any id the client already holds.
--   filename    The ORIGINAL name from the device, kept for display only.
--               Never used to build a storage path.
--   content_type  Sniffed from the file's magic bytes, not trusted from the
--               client header. Needed to serve the image back correctly.
--   size_bytes  Lets the app show sizes and lets us spot a truncated upload
--               without a round trip to R2.
--   created_at  ISO-8601 UTC string. SQLite has no native date type; a
--               sortable text timestamp is the simplest correct choice.

CREATE TABLE photos (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  object_key   TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

-- The gallery query is "my photos, newest first". Without this index D1 scans
-- the whole table on every list, and D1 bills per row READ (scanned), not per
-- row returned. https://developers.cloudflare.com/d1/best-practices/use-indexes/
CREATE INDEX idx_photos_owner_created ON photos (owner_id, created_at DESC);
