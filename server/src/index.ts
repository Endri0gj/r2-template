import { me, refresh, signIn, signOut, signOutEverywhere, signUp } from './accounts';
import { authenticate } from './auth';
import { handlePreflight, withCors } from './cors';
import {
  applySecurityHeaders,
  errorResponse,
  jsonResponse,
  rateLimited,
  unauthorized,
} from './http';
import { PHOTO_ID_PATTERN } from './ids';
import { deletePhoto, listPhotos, readPhotoContent, uploadPhoto } from './photos';
import {
  applyLimit,
  AUTH_WINDOW_SECONDS,
  READ_WINDOW_SECONDS,
  UPLOAD_WINDOW_SECONDS,
} from './ratelimit';
import { reconcile } from './reconcile';
import type { Env } from './types';

/**
 * Photo Vault API.
 *
 *   GET    /health              liveness check (no auth)
 *
 *   POST   /auth/signup         create an account
 *   POST   /auth/signin         password -> session
 *   POST   /auth/refresh        refresh token -> new session pair
 *   POST   /auth/signout        revoke this device's session
 *   POST   /auth/signout-all    revoke every session (auth required)
 *   GET    /auth/me             the caller's account (auth required)
 *
 *   GET    /photos              list the caller's photo metadata
 *   POST   /photos              upload one image (raw binary body)
 *   GET    /photos/:id/content  the image bytes
 *   DELETE /photos/:id          delete metadata + bytes
 *
 * There is no routing library. Matching on path segments is shorter than the
 * configuration a router would need at this size, and it keeps the real
 * `fetch(request, env, ctx)` signature visible - which is the thing worth
 * understanding. Reach for Hono when you start wanting middleware chains,
 * nested route groups, or per-route schema validation; see part 3 of the guide.
 */

/**
 * The caller's IP, as Cloudflare saw it.
 *
 * Only used as a coarse rate-limit key on the unauthenticated auth routes, and
 * only because there is no better signal before an account exists. It is NOT
 * used for any authorization decision: `cf-connecting-ip` is trustworthy here
 * because Cloudflare sets it at the edge and overwrites anything the client
 * sent, but it still identifies a network path, not a person.
 *
 * Locally there is no edge, so the header is absent and every caller shares one
 * bucket. That is correct for local development and worth knowing before you
 * wonder why your own rate-limit test behaves differently in production.
 */
function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'local';
}

async function routeAuth(
  request: Request,
  env: Env,
  segments: string[],
): Promise<Response> {
  const action = segments[1];
  const ip = clientIp(request);

  /* ---- routes that establish identity, so cannot require it ---- */

  if (segments.length === 2 && request.method === 'POST') {
    // The two expensive, guessable routes. A coarse per-IP limit applies
    // before any body is read and before any password is hashed; it is the
    // backstop that stops an unauthenticated endpoint being used to burn CPU.
    // The per-email limit that actually stops credential guessing lives
    // inside signIn().
    if (action === 'signup' || action === 'signin') {
      const decision = await applyLimit(
        env.AUTH_LIMITER,
        `auth-ip:${ip}`,
        AUTH_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return action === 'signup' ? signUp(request, env) : signIn(request, env);
    }

    // Refresh and sign-out are deliberately NOT on the auth budget.
    //
    // They are cheap - one indexed read and one update, no password hashing -
    // and, crucially, they are things a legitimate signed-in user does
    // routinely. Ten per minute per IP would be fine for one person and wrong
    // behind a corporate NAT or a carrier gateway, where dozens of real users
    // share an address and each device renews its token every quarter of an
    // hour. Putting them on the generous read budget keeps a runaway client
    // bounded without throttling a building full of people.
    if (action === 'refresh' || action === 'signout') {
      const decision = await applyLimit(
        env.READ_LIMITER,
        `session-ip:${ip}`,
        READ_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return action === 'refresh' ? refresh(request, env) : signOut(request, env);
    }
  }

  /* ---- routes that require an access token ---- */

  if (segments.length === 2 && (action === 'me' || action === 'signout-all')) {
    const auth = await authenticate(request, env);
    if (!auth.ok) return unauthorized();

    // Keyed by the caller now that we know who it is, so one account cannot
    // affect another.
    const decision = await applyLimit(
      env.READ_LIMITER,
      `read:${auth.principal.id}`,
      READ_WINDOW_SECONDS,
    );
    if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);

    if (action === 'me') {
      if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', 'Use GET.');
      return me(env, auth.principal);
    }
    if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'Use POST.');
    return signOutEverywhere(env, auth.principal);
  }

  if (
    segments.length === 2 &&
    ['signup', 'signin', 'refresh', 'signout'].includes(action ?? '')
  ) {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  return errorResponse(404, 'not_found', 'No such route.');
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const segments = pathname.split('/').filter(Boolean);

  // --- /health -----------------------------------------------------------
  //
  // Unauthenticated on purpose: a health check that needs a credential cannot
  // be used by an uptime monitor. It deliberately does NOT query D1 or R2, so
  // an anonymous caller cannot make us spend billable reads.
  if (segments.length === 1 && segments[0] === 'health') {
    if (request.method !== 'GET') {
      return errorResponse(405, 'method_not_allowed', 'Use GET.');
    }
    return jsonResponse({ data: { status: 'ok' } });
  }

  if (segments[0] === 'auth') return routeAuth(request, env, segments);

  if (segments[0] !== 'photos') {
    return errorResponse(404, 'not_found', 'No such route.');
  }

  // Everything below this line requires a valid access token. Authentication
  // happens once, here, before any handler runs - including the image read.
  const auth = await authenticate(request, env);
  if (!auth.ok) return unauthorized();
  const principal = auth.principal;

  // --- /photos -----------------------------------------------------------
  if (segments.length === 1) {
    if (request.method === 'GET') {
      const decision = await applyLimit(
        env.READ_LIMITER,
        `read:${principal.id}`,
        READ_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return listPhotos(env, principal);
    }
    if (request.method === 'POST') {
      const decision = await applyLimit(
        env.UPLOAD_LIMITER,
        `upload:${principal.id}`,
        UPLOAD_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return uploadPhoto(request, env, principal);
    }
    return errorResponse(405, 'method_not_allowed', 'Use GET or POST.');
  }

  const id = segments[1];
  if (!id || !PHOTO_ID_PATTERN.test(id)) {
    return errorResponse(404, 'not_found', 'Photo not found.');
  }

  // --- /photos/:id -------------------------------------------------------
  if (segments.length === 2) {
    if (request.method === 'DELETE') {
      // Shares the upload limiter's budget: both are writes, and a loop that
      // deletes as fast as it can is the other way to abuse this API.
      const decision = await applyLimit(
        env.UPLOAD_LIMITER,
        `delete:${principal.id}`,
        UPLOAD_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return deletePhoto(env, principal, id);
    }
    return errorResponse(405, 'method_not_allowed', 'Use DELETE.');
  }

  // --- /photos/:id/content -----------------------------------------------
  if (segments.length === 3 && segments[2] === 'content') {
    if (request.method === 'GET') {
      const decision = await applyLimit(
        env.READ_LIMITER,
        `read:${principal.id}`,
        READ_WINDOW_SECONDS,
      );
      if (!decision.allowed) return rateLimited(decision.retryAfterSeconds);
      return readPhotoContent(request, env, principal, id);
    }
    return errorResponse(405, 'method_not_allowed', 'Use GET.');
  }

  return errorResponse(404, 'not_found', 'No such route.');
}

export default {
  /**
   * The runtime passes (request, env, ctx). This handler declares only the two
   * it uses - there is no deferred work here, so no ExecutionContext is needed.
   *
   * Both parameters are annotated rather than inferred from
   * `satisfies ExportedHandler<Env>`. Inference would specialise `request` to
   * the incoming-request type, whose `cf` property this Worker never reads, and
   * which makes the handler needlessly hard to call from a test.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    // Browser preflight is answered before authentication: the browser is not
    // allowed to send the Authorization header until we say the method and
    // header are acceptable, so a preflight never carries a credential.
    const preflight = handlePreflight(request, env);
    if (preflight) return applySecurityHeaders(preflight);

    try {
      return applySecurityHeaders(withCors(await route(request, env), request, env));
    } catch (cause) {
      // One place to make sure an unexpected throw becomes a 500 with no stack
      // trace, no SQL and no object key in the response body. The detail goes
      // to Workers Logs, where only you can read it.
      console.error('Unhandled error', { cause: String(cause) });
      return applySecurityHeaders(
        withCors(errorResponse(500, 'internal_error', 'Unexpected error.'), request, env),
      );
    }
  },

  /**
   * Cron Trigger entry point. The schedule lives in `triggers.crons` in
   * wrangler.jsonc; this runs with the same bindings as `fetch` and no request.
   *
   * `controller.scheduledTime` is passed through as "now" so the job's notion
   * of the current time comes from the invocation rather than from a clock read
   * in the middle of it - which also makes it trivially testable.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await reconcile(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
