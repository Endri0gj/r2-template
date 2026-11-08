import { env } from 'cloudflare:workers';

import worker from '../src/index';

/**
 * Test helpers.
 *
 * ## Why every helper randomises the email and the IP
 *
 * The Worker is rate limited, and the limiters are real in these tests -
 * Miniflare implements the Rate Limiting binding with a Durable Object, so
 * `limit()` actually counts. Storage (including that Durable Object) is
 * isolated per test FILE, not per test, so without care the thirtieth test in
 * a file would start failing with 429s caused by the twenty-nine before it.
 *
 * The limiter keys are `auth-ip:<ip>`, `signin:<email>`, `upload:<user>` and
 * `read:<user>`. Giving each account a fresh email, each request a fresh
 * client IP, and each test its own user therefore gives each test its own
 * counters. The tests that are ABOUT rate limiting deliberately reuse one
 * email and one IP - see ratelimit.spec.ts.
 *
 * This is not test-only trickery: it mirrors how the keys are meant to behave
 * in production, where one account's traffic must not exhaust another's.
 */

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_INVITE_CODE = 'test-invite-code';

let counter = 0;

export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

/** A distinct client IP per call, so the per-IP auth limiter never collides. */
export function uniqueIp(): string {
  counter += 1;
  return `203.0.113.${counter % 250}:${counter}`;
}

/**
 * Cloudflare's example aliases `Request` here to work around the handler being
 * typed for requests that arrived from the internet (which carry extra `cf`
 * properties). Our handler annotates its parameter as a plain `Request`, so no
 * alias is needed - this is kept only as the single place tests build requests.
 * https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
 */
export const IncomingRequest = Request;

export interface CallOptions extends RequestInit {
  /** Bearer access token. `null` sends no Authorization header. */
  token?: string | null;
  /** Overrides the simulated client IP (the per-IP rate-limit key). */
  ip?: string;
}

/** Sends a request through the Worker's real fetch handler and routing. */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const { token = null, ip, headers, ...init } = options;
  const merged = new Headers(headers);
  if (token) merged.set('authorization', `Bearer ${token}`);
  // The edge sets this header in production and overwrites anything a client
  // sent. Here we are the edge, so we set it ourselves.
  merged.set('cf-connecting-ip', ip ?? uniqueIp());

  const request = new IncomingRequest(`https://vault.test${path}`, { ...init, headers: merged });
  // Two arguments, because that is the handler's real signature: this Worker
  // does no `ctx.waitUntil()` work, so there is no ExecutionContext to create
  // and nothing to wait on afterwards. If a handler ever does defer work, add
  // `createExecutionContext()` / `waitOnExecutionContext()` from
  // "cloudflare:test" here, or side effects will be asserted too early.
  return worker.fetch(request, env);
}

export async function postJson(
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<Response> {
  return call(path, {
    ...options,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export interface TestAccount {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

interface SessionResponse {
  data: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: { id: string; email: string; createdAt: string };
  };
}

/** Creates a real account by calling the real sign-up endpoint. */
export async function signUpAccount(
  overrides: { email?: string; password?: string; inviteCode?: string; ip?: string } = {},
): Promise<TestAccount> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? TEST_PASSWORD;

  const response = await postJson(
    '/auth/signup',
    { email, password, inviteCode: overrides.inviteCode },
    { ip: overrides.ip },
  );
  if (response.status !== 201) {
    throw new Error(`signUpAccount failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as SessionResponse;
  return {
    email,
    password,
    userId: body.data.user.id,
    accessToken: body.data.accessToken,
    refreshToken: body.data.refreshToken,
  };
}

export async function signInAccount(
  email: string,
  password: string,
  options: { ip?: string } = {},
): Promise<SessionResponse['data']> {
  const response = await postJson('/auth/signin', { email, password }, { ip: options.ip });
  if (!response.ok) {
    throw new Error(`signInAccount failed: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as SessionResponse).data;
}

/* ------------------------------------------------------------------ *
 * Photos
 * ------------------------------------------------------------------ */

/** Minimal byte sequences with real magic numbers. */
export function pngBytes(size = 128): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

export function jpegBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

export function notAnImage(): Uint8Array {
  return new TextEncoder().encode('<?php system($_GET["c"]); ?>');
}

export async function upload(
  token: string,
  bytes: Uint8Array,
  options: { filename?: string; declaredType?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': options.declaredType ?? 'application/octet-stream',
  };
  if (options.filename) headers['x-filename'] = options.filename;
  return call('/photos', {
    method: 'POST',
    // A fresh ArrayBuffer so the body is not shared between requests.
    body: bytes.slice().buffer as ArrayBuffer,
    headers,
    token,
  });
}

export async function uploadAndGetId(
  token: string,
  bytes = pngBytes(),
  options: { filename?: string } = {},
): Promise<string> {
  const response = await upload(token, bytes, options);
  if (response.status !== 201) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { photo: { id: string } } };
  return body.data.photo.id;
}

/* ------------------------------------------------------------------ *
 * Direct storage access, to prove the handler really did write
 * ------------------------------------------------------------------ */

export async function countRows(table: 'photos' | 'users' | 'sessions'): Promise<number> {
  // Interpolated, not bound - SQLite does not accept a table name as a
  // parameter. Safe here because the argument is a closed union of two
  // literals, and this is test-only code. Never do this with a value that
  // came from a request.
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Lists every key in the real (locally simulated) R2 bucket. */
export async function listObjectKeys(): Promise<string[]> {
  const listed = await env.PHOTOS.list();
  return listed.objects.map((object) => object.key);
}
