import type { Env, PhotoRow } from './types';

/**
 * The scheduled maintenance job. Runs from a Cron Trigger; see the
 * `scheduled()` handler in server/src/index.ts and `triggers.crons` in
 * wrangler.jsonc.
 * https://developers.cloudflare.com/workers/configuration/cron-triggers/
 *
 * ## Why this file has to exist
 *
 * R2 and D1 are separate services with no shared transaction. server/src/photos.ts
 * orders its writes so that a failure leaves the *less harmful* inconsistency,
 * and cleans up after itself when it can - but "when it can" excludes the case
 * where the Worker is killed between two statements, and excludes a failed
 * rollback. Those leave real divergence:
 *
 *   ORPHAN OBJECT   bytes in R2 with no row in D1. Invisible to the user,
 *                   costs storage forever.
 *   DANGLING ROW    a row in D1 whose bytes are gone. Visible to the user as
 *                   a photo that never loads.
 *
 * Documenting that these are possible is necessary but not sufficient. A
 * production system has to actually converge, and this is the thing that makes
 * it converge.
 *
 * ## The grace period, which is the part that is easy to get wrong
 *
 * An upload that is *in progress right now* looks exactly like an orphan: the
 * object exists and the row does not yet. Deleting on that basis would destroy
 * live uploads under load - the failure would be rare, data-losing, and would
 * only ever reproduce in production.
 *
 * So nothing is touched until it is older than `GRACE_PERIOD_MS`. R2 records an
 * `uploaded` timestamp on every object, which is what makes this checkable.
 *
 * ## Bounded work
 *
 * A Cron Trigger gets 30 seconds of CPU on the Paid plan (15 minutes if the
 * interval is an hour or more), and listing a large bucket is not free. Every
 * loop here has a hard cap, and the job reports when it hit one instead of
 * pretending it finished.
 */

/** Nothing younger than this is considered divergent. One hour is generous. */
const GRACE_PERIOD_MS = 60 * 60 * 1000;

/** R2 `list()` returns at most 1000 keys per call. */
const R2_PAGE_SIZE = 1000;

/** Caps on one run. Raise with care; see the CPU note above. */
const MAX_OBJECTS_SCANNED = 20_000;
const MAX_ROWS_SCANNED = 20_000;
const MAX_DELETES_PER_RUN = 500;

/** How long a revoked session row is kept before being purged. */
const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReconcileReport {
  objectsScanned: number;
  rowsScanned: number;
  /** True when BOTH sides were enumerated completely. */
  completeScan: boolean;
  orphanObjectsFound: number;
  orphanObjectsDeleted: number;
  danglingRowsFound: number;
  danglingRowsDeleted: number;
  expiredSessionsPurged: number;
  errors: string[];
}

/* ------------------------------------------------------------------ *
 * Session purge
 * ------------------------------------------------------------------ */

/**
 * Deletes session rows that can no longer be used for anything.
 *
 * Revoked rows are kept for a while rather than deleted immediately, because
 * they are what makes refresh-token replay detectable: if the row is gone, a
 * replayed token looks like an unknown token rather than a stolen one, and the
 * "revoke everything" response in accounts.ts never fires.
 */
async function purgeSessions(env: Env, now: Date): Promise<number> {
  const expiredBefore = now.toISOString();
  const revokedBefore = new Date(now.getTime() - REVOKED_SESSION_RETENTION_MS).toISOString();

  const result = await env.DB.prepare(
    `DELETE FROM sessions
      WHERE expires_at <= ?
         OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
  )
    .bind(expiredBefore, revokedBefore)
    .run();

  return result.meta.changes;
}

/* ------------------------------------------------------------------ *
 * Enumeration
 * ------------------------------------------------------------------ */

interface ObjectEntry {
  key: string;
  uploaded: Date;
}

/** Lists every object under `photos/`, or as many as the cap allows. */
async function listAllObjects(
  env: Env,
): Promise<{ objects: ObjectEntry[]; complete: boolean }> {
  const objects: ObjectEntry[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await env.PHOTOS.list({
      prefix: 'photos/',
      limit: R2_PAGE_SIZE,
      cursor,
    });

    for (const object of page.objects) {
      objects.push({ key: object.key, uploaded: object.uploaded });
    }

    // `truncated` is a discriminated union in the R2 types: the cursor only
    // exists on the truncated branch, which is why this is written as a
    // narrowing check rather than reading `page.cursor` directly.
    if (!page.truncated) return { objects, complete: true };
    if (objects.length >= MAX_OBJECTS_SCANNED) return { objects, complete: false };
    cursor = page.cursor;
  }
}

/** Reads every photo row's key, or as many as the cap allows. */
async function listAllRows(
  env: Env,
): Promise<{ rows: Pick<PhotoRow, 'id' | 'object_key' | 'created_at'>[]; complete: boolean }> {
  const rows: Pick<PhotoRow, 'id' | 'object_key' | 'created_at'>[] = [];
  // Keyset pagination on the primary key. OFFSET would re-scan everything it
  // skipped on each page, and D1 bills rows read.
  let after = '';

  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, object_key, created_at FROM photos
        WHERE id > ? ORDER BY id LIMIT ?`,
    )
      .bind(after, R2_PAGE_SIZE)
      .all<Pick<PhotoRow, 'id' | 'object_key' | 'created_at'>>();

    const page = results ?? [];
    rows.push(...page);

    if (page.length < R2_PAGE_SIZE) return { rows, complete: true };
    if (rows.length >= MAX_ROWS_SCANNED) return { rows, complete: false };
    after = page[page.length - 1]!.id;
  }
}

/* ------------------------------------------------------------------ *
 * The job
 * ------------------------------------------------------------------ */

export async function reconcile(env: Env, now = new Date()): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    objectsScanned: 0,
    rowsScanned: 0,
    completeScan: false,
    orphanObjectsFound: 0,
    orphanObjectsDeleted: 0,
    danglingRowsFound: 0,
    danglingRowsDeleted: 0,
    expiredSessionsPurged: 0,
    errors: [],
  };

  try {
    report.expiredSessionsPurged = await purgeSessions(env, now);
  } catch (cause) {
    report.errors.push(`purgeSessions: ${String(cause)}`);
  }

  const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);

  let objects: ObjectEntry[];
  let rows: Pick<PhotoRow, 'id' | 'object_key' | 'created_at'>[];
  let complete: boolean;
  try {
    const listed = await listAllObjects(env);
    const queried = await listAllRows(env);
    objects = listed.objects;
    rows = queried.rows;
    complete = listed.complete && queried.complete;
  } catch (cause) {
    report.errors.push(`enumeration: ${String(cause)}`);
    console.error('Reconciliation could not enumerate storage', report);
    return report;
  }

  report.objectsScanned = objects.length;
  report.rowsScanned = rows.length;
  report.completeScan = complete;

  const keysInDatabase = new Set(rows.map((row) => row.object_key));

  /* ---- orphan objects: bytes with no row ---- */

  const orphanKeys = objects
    .filter((object) => !keysInDatabase.has(object.key) && object.uploaded < cutoff)
    .map((object) => object.key);
  report.orphanObjectsFound = orphanKeys.length;

  if (orphanKeys.length > 0) {
    const batch = orphanKeys.slice(0, MAX_DELETES_PER_RUN);
    try {
      // R2 `delete()` accepts up to 1000 keys in one call.
      await env.PHOTOS.delete(batch);
      report.orphanObjectsDeleted = batch.length;
    } catch (cause) {
      report.errors.push(`orphan delete: ${String(cause)}`);
    }
  }

  /* ---- dangling rows: a row whose bytes are gone ---- */

  // This half is skipped unless the scan was COMPLETE, and that is not a
  // nicety. The test is "this row's key was not among the objects I listed" -
  // which, if the listing stopped early, is true of every row whose key sits
  // past the cap. Acting on a partial listing would delete healthy photos.
  if (complete) {
    const keysInBucket = new Set(objects.map((object) => object.key));
    const dangling = rows.filter(
      (row) => !keysInBucket.has(row.object_key) && new Date(row.created_at) < cutoff,
    );
    report.danglingRowsFound = dangling.length;

    // Deleting these is DESTRUCTIVE and irreversible: the row is the only
    // remaining record that the photo existed. The bytes are already gone, so
    // the row describes something unusable - but that judgement is the
    // operator's to make, not this job's. Off unless explicitly enabled.
    if (dangling.length > 0 && env.RECONCILE_DELETE_DANGLING_ROWS === 'true') {
      const batch = dangling.slice(0, MAX_DELETES_PER_RUN);
      try {
        await env.DB.batch(
          batch.map((row) =>
            env.DB.prepare(`DELETE FROM photos WHERE id = ?`).bind(row.id),
          ),
        );
        report.danglingRowsDeleted = batch.length;
      } catch (cause) {
        report.errors.push(`dangling delete: ${String(cause)}`);
      }
    }
  }

  // One structured line per run. This is the only visibility you get into a
  // job nobody is watching, so it reports what it skipped as loudly as what it
  // did - a run that silently hit its cap every night, forever, would look
  // identical to a healthy one.
  const level = report.errors.length > 0 || !report.completeScan ? console.error : console.log;
  level('Reconciliation complete', report);

  return report;
}
