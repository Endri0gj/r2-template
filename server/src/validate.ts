/**
 * Content validation.
 *
 * The `Content-Type` header on an upload is a CLAIM made by the client. A
 * client can send `Content-Type: image/png` with a zip file, an HTML page, or
 * a shell script in the body. If we stored that and later served it back with
 * the claimed type, we would be running a file host for arbitrary content.
 *
 * So we ignore the claim and look at the first few bytes of the file instead.
 * Every real image format begins with a fixed signature ("magic bytes"). This
 * is not bulletproof - a valid JPEG header can still precede a malformed image
 * - but it is cheap, it has no dependencies, and it reliably rejects "this is
 * not an image at all", which is the attack that matters here.
 */

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** ISO base media file format brands that mean "this is a HEIF/HEIC image". */
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];

/**
 * Returns the real media type of `bytes`, or null if it is not an image format
 * we accept.
 */
export function sniffImageType(bytes: Uint8Array): AllowedImageType | null {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: 89 'P' 'N' 'G' CR LF 1A LF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // WebP: 'RIFF' <4 byte little-endian length> 'WEBP'
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';

  // HEIC (what an iPhone camera produces): a 4-byte box length, then 'ftyp',
  // then a 4-character brand. iOS sometimes hands these straight through the
  // image picker, so rejecting them would break uploads on real devices.
  if (asciiAt(bytes, 4, 'ftyp')) {
    for (const brand of HEIF_BRANDS) {
      if (asciiAt(bytes, 8, brand)) return 'image/heic';
    }
  }

  return null;
}

/**
 * Filenames are display data, never storage paths. We still clamp them so a
 * 10 MB filename or an embedded newline cannot land in the database or in a
 * log line.
 */
export function sanitizeFilename(raw: string | null): string {
  if (!raw) return 'photo';
  const stripped = raw
    // Drop any directory component: "../../etc/passwd" becomes "passwd".
    .replace(/^.*[\\/]/, '')
    // Control characters have no business in a display string.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!stripped) return 'photo';
  return stripped.slice(0, 200);
}

/** Reads MAX_UPLOAD_BYTES, falling back to 5 MB if unset or nonsense. */
export function resolveMaxUploadBytes(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5 * 1024 * 1024;
  return Math.floor(parsed);
}
