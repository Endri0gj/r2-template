/**
 * Reading an upload body without trusting the client about its size.
 */

export type ReadBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'empty' };

/**
 * Reads the request body into memory, refusing to exceed `limit` bytes.
 *
 * Why not just `await request.arrayBuffer()`?
 *
 * Because that commits to buffering whatever the client sends before you can
 * check it. The `Content-Length` header is a useful FIRST filter - it lets us
 * reject an oversized upload without reading a single byte of it - but it is
 * only a claim, and React Native does not always set it. So we do both: trust
 * the header enough to reject early, then enforce the real limit while
 * streaming, and stop reading the moment the limit is passed.
 *
 * This is only safe because `limit` is small (5 MB by default). For large
 * files you should not be proxying bytes through a Worker at all - see part 12
 * of the guide on presigned uploads.
 */
export async function readBodyWithLimit(request: Request, limit: number): Promise<ReadBodyResult> {
  // Fast path: the client told us it is too big, so we never read the body.
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > limit) {
      return { ok: false, reason: 'too_large' };
    }
  }

  if (!request.body) return { ok: false, reason: 'empty' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        // Stop pulling. We never allocate more than limit + one chunk.
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, reason: 'empty' };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
