# Photo Vault: Expo + Cloudflare Workers + R2 + D1

A complete, standalone tutorial for the feature in this repository. Written to
be re-readable: every command, filename and failure mode below is real and was
run against this codebase.

**Versions this was built and verified against** (2026-11-08):

| | |
|---|---|
| Expo SDK | 58.0.23 |
| React Native | 0.88.1 / React 19.3.0 |
| expo-router | 58.0.30 |
| expo-image-picker | 58.0.10 |
| expo-file-system | 58.0.13 |
| expo-secure-store | 58.0.2 |
| Wrangler | 4.158.0 |
| Vitest | 5.1.0 |
| `@cloudflare/vitest-plugin` | 1.6.0 |

> Cloudflare and Expo both ship breaking changes often. When something below
> does not match what you see, trust the docs link next to it over this file,
> and see Part 10 for how to tell a current page from a stale one.

> **If you read an earlier version of this guide:** the pre-shared
> `API_TOKENS` / `EXPO_PUBLIC_PHOTO_VAULT_TOKEN` scheme is gone. The app has
> real accounts now — sign-up, sign-in, hashed passwords, short-lived access
> tokens and revocable sessions — along with rate limiting and a nightly
> reconciliation job. Part 9 explains what changed and why, including what the
> old design got wrong.

---

## Contents

1. [The problem](#part-1--the-problem)
2. [Understanding the services](#part-2--understanding-the-services)
3. [Architecture decisions](#part-3--architecture-decisions)
4. [Setting up the backend](#part-4--setting-up-the-backend)
5. [Local storage and database](#part-5--local-storage-and-database)
6. [Connecting Expo](#part-6--connecting-expo)
7. [Understanding every request](#part-7--understanding-every-request)
8. [Testing and debugging](#part-8--testing-and-debugging)
9. [Security and production](#part-9--security-and-production)
10. [Cloudflare documentation navigation](#part-10--cloudflare-documentation-navigation)
11. [Common mistakes](#part-11--common-mistakes)
12. [Future improvements](#part-12--future-improvements)

---

# Part 1 — The problem

Photo Vault does five things:

1. Sign in (or create an account).
2. Pick a photo from the phone.
3. Upload it.
4. Show *your* uploaded photos in a gallery.
5. Delete one.

Plus one requirement that changes everything: **the photos are still there after
you restart the app, and after you reinstall it, and on your other phone.**

That last line is why this is an infrastructure problem and not a UI problem.
Without it, you would write ~40 lines using the device's own filesystem and be
done. With it, the bytes have to live somewhere that is not the device — and as
soon as that is true you need to answer:

- Where do the image **bytes** go?
- Where does the **list** of images go — the thing you query to render a gallery?
- Who is allowed to read and delete them?

The answer we build: bytes in **R2**, list in **D1**, access decided by a
**Cloudflare Worker**, and the phone holding no storage credentials at all.

```text
Expo app (iOS / Android / web)
       │
       │  HTTPS. Carries a short-lived access token the user signed in for.
       │  Never carries an R2 key, and nothing secret is in the bundle.
       ▼
Cloudflare Worker  ──────────┬──────────────┐
  (TypeScript, your code)    │              │
                             ▼              ▼
                     Cloudflare D1    Cloudflare R2
                     users, sessions  the image bytes
                     photo metadata   (object storage)
                     (SQLite)
```

The word *your* in point 4 is the one that costs the most work. A gallery that
shows everyone's photos to everyone is a weekend project; one that knows who is
asking, on every single request including each thumbnail, is most of Part 9.

---

# Part 2 — Understanding the services

Each service below follows the same shape: what it is, why it exists, a real
example, where this project uses it, the docs, and the misunderstanding that
costs people an afternoon.

## Object storage, and R2

**What it is.** A service that stores *blobs of bytes under string keys*. You
`put("some/key", bytes)` and later `get("some/key")`. That is nearly the whole
API.

**Why it exists.** Because databases are bad at large binary data and
filesystems are bad at being shared. A 3 MB JPEG in a database row makes every
query touching that table slower, bloats backups, and still has to be streamed
out somehow. Object storage is built for exactly one access pattern — "give me
the bytes at this key" — and is cheap and effectively unbounded as a result.

**Real example.** Every image on a photo-sharing site, every video on a video
site, every build artifact in a CI system.

**Where we use it.** `server/src/photos.ts`, via `env.PHOTOS`:

```ts
await env.PHOTOS.put(objectKey, body.bytes, {
  httpMetadata: { contentType, cacheControl: 'private, max-age=31536000, immutable' },
});
```

**Docs.** <https://developers.cloudflare.com/r2/>

**The misunderstanding.** *"R2 is a database, I will just query it."* You
cannot. There is no `WHERE`, no sort, no join, no "photos uploaded this week".
`list()` can filter by key **prefix** and that is it — it returns up to 1000
keys at a time, in lexicographic order. Building a gallery from `list()` means
fetching every key and sorting in memory, which gets slower and more expensive
with every upload and cannot answer "whose photo is this?" without encoding the
answer into the key. **That** is why D1 is in this design.

## Relational storage, and D1

**What it is.** A managed **SQLite** database, replicated across Cloudflare's
network, which you query from a Worker.

**Why it exists.** Because the questions a gallery asks are relational
questions: "the newest 50 photos belonging to user X". Those need indexes,
ordering and filtering — the things SQL is for.

**Real example.** The `photos` table in this project:

```sql
CREATE TABLE photos (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  object_key   TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
```

**Where we use it.** `server/migrations/0001_create_photos.sql` defines it;
`server/src/photos.ts` queries it via `env.DB`.

**Docs.** <https://developers.cloudflare.com/d1/>

**The misunderstanding.** *"It is SQLite, so it is a toy."* SQLite is one of the
most heavily tested pieces of software in existence and runs a large share of
the world's applications. The real constraints are different: D1 bills by
**rows read** (rows *scanned*, not rows returned), so a query without a usable
index is expensive even when it returns one row — which is why this project adds
`idx_photos_owner_created`. And a single D1 database has a size limit, which is
a reason to keep image bytes out of it, not a reason to avoid it.

## Cloudflare Workers

**What it is.** Your JavaScript/TypeScript running on Cloudflare's edge, in
response to HTTP requests. You export an object with a `fetch` method; the
runtime calls it.

**Why it exists.** You need *somewhere* to put the code that decides who may
read what. That code cannot live in the phone app, because the phone app is in
the user's hands and can be modified. A Worker is a server, but with no server
to run: no container, no process manager, no region to pick, no idle cost.

**Real example.** The whole backend, `server/src/index.ts`:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> { /* ... */ },
} satisfies ExportedHandler<Env>;
```

**Docs.** <https://developers.cloudflare.com/workers/>

**The misunderstanding.** *"It is Node.js."* It is not. There is no `fs`, no
`net`, no `process` by default. What you get is the **web platform**: `fetch`,
`Request`, `Response`, `ReadableStream`, `crypto.subtle`, `URL`,
`TextEncoder`. In practice this is why `server/src/body.ts` reads the upload
with `request.body.getReader()` rather than a Node stream, and why
`crypto.randomUUID()` needs no import. Some Node APIs are available behind the
`nodejs_compat` flag, but reaching for it usually means you have imported a
library that does not belong at the edge.

## Bindings — the central concept

**What it is.** A **binding** is a named capability that the runtime injects
into your Worker as a property of `env`. You declare it in configuration; the
runtime hands you a live object.

Declared in `server/wrangler.jsonc`:

```jsonc
"r2_buckets": [{ "binding": "PHOTOS", "bucket_name": "photo-vault-dev" }],
"d1_databases": [{ "binding": "DB", "database_name": "photo-vault-dev", "...": "..." }]
```

Used in `server/src/photos.ts`:

```ts
await env.PHOTOS.put(...)   // the R2 bucket
await env.DB.prepare(...)   // the D1 database
```

**Why it exists.** So that *no credential exists* for your Worker to leak.

This is the part most worth internalising. The two ways to reach a Cloudflare
resource are not just two syntaxes:

| | **Binding** | **API token** |
|---|---|---|
| What it is | A capability granted by config | A secret string (a bearer credential) |
| Where the secret lives | Nowhere. There is no secret | In your code, env vars, or a secrets manager |
| How access is granted | Cloudflare knows this Worker may use this bucket | Anyone holding the string has the access |
| Can be stolen? | No — nothing to steal | Yes. Leak it and the bucket is theirs |
| Network path | In-process call, same datacentre | HTTPS to an API endpoint |
| Works from | A Worker | Anywhere |
| We use it for | Everything | Nothing |

An API token is what you would need for the S3-compatible API — for example
from a Node server, or from a phone (never do this). A binding is strictly
better when you are already in a Worker, and we always are.

**Docs.** <https://developers.cloudflare.com/workers/runtime-apis/bindings/>

**The misunderstanding.** *"`binding` must match the bucket name."* No —
`binding` is the **variable name in your code** and `bucket_name` is the
resource. This indirection is the point: in `server/wrangler.jsonc` the binding
`PHOTOS` points at `photo-vault-dev` locally and `photo-vault-prod` in
production, and `server/src/photos.ts` never mentions either name.

## Wrangler and Miniflare

**Wrangler** is the CLI: it runs your Worker locally, creates buckets and
databases, applies migrations, deploys, and streams logs. **Miniflare** is the
local simulator Wrangler uses under the hood — it runs the real `workerd`
runtime on your machine and provides local implementations of R2, D1, KV and
the rest.

You will rarely invoke Miniflare directly; you will care about it because it is
what makes `.wrangler/state` exist and what makes local development free.

**Docs.** <https://developers.cloudflare.com/workers/wrangler/> and
<https://developers.cloudflare.com/workers/local-development/>

**The misunderstanding.** *"`wrangler dev` talks to my real account."* By
default it does not. Bindings run against local simulations, and `wrangler dev`
prints a `Mode` column saying so — see Part 5.

## Expo

**What it is.** A toolchain and a set of native modules on top of React Native.
`expo-router` gives this app file-based routing: every file under `src/app/` is
a screen.

**Where we use it.** `src/app/vault.tsx` is the gallery, reachable at `/vault`
because of its filename.

**Docs.** <https://docs.expo.dev/> — and for this SDK specifically,
<https://docs.expo.dev/versions/v58.0.0/>

**The misunderstanding.** *"Expo means Expo Go."* Expo Go is a pre-built
sandbox app containing a fixed set of native modules. The moment you add a
native module it does not bundle — `expo-image-picker` and `expo-file-system`
both qualify — Expo Go can no longer run your app, and you need a **development
build** (`npx expo run:ios`). That is not a downgrade; it is the normal way to
build an app that uses native capabilities.

---

# Part 3 — Architecture decisions

## The four candidate architectures

### A. Expo → R2 directly

The phone holds an R2 access key and talks to the S3-compatible API.

- **Gained:** no backend to write or deploy. Fewest moving parts.
- **Lost:** everything. The key is in the app binary, which is on a device you
  do not control. Extracting strings from an app bundle is a beginner exercise.
  Whoever extracts it can read, overwrite and delete **every object in the
  bucket**, including other users'. There is also nowhere to validate anything,
  and no way to list "my photos" without giving each client the ability to list
  everyone's.
- **Verdict: never.** Not "not yet" — there is no version of this that is safe.
  A credential that grants bucket-wide access does not become safe by being
  obfuscated.

### B. Expo → Node.js + local SQLite → R2

A Node server with an API token for R2 and a SQLite file on its own disk.

- **Gained:** familiar. Any Node library works. Full filesystem.
- **Lost:** you now operate a server — a host, a process manager, TLS
  certificates, an OS to patch, and a bill that runs while nobody is using the
  app. The SQLite file is on **one machine's disk**, so you cannot run two
  instances, and if that disk dies the metadata is gone while the bytes in R2
  survive. You also hold an R2 API token, which is a secret you can leak.
- **Verdict:** reasonable if you already run Node servers and have the operating
  practice for it. Strictly more work than C for this workload.

### C. Expo → Worker + D1 + R2 ← *we chose this*

- **Gained:** no credentials anywhere (bindings, not tokens). No server to
  operate. Scale-to-zero cost. Local development that simulates all three
  pieces. One language end to end. D1 is replicated, so metadata is not tied to
  one disk.
- **Lost:** the Workers runtime is not Node, so some libraries will not run.
  Worker CPU and request-size limits make it the wrong place to proxy very
  large files. And you are on Cloudflare — this is a platform commitment.
- **Verdict: chosen.** It is the simplest option that is actually safe, and it
  stays appropriate for a small production deployment.

### D. Expo → Supabase (Storage + Postgres)

- **Gained:** the biggest thing D1+R2 does *not* give you — real
  **authentication** (email, OAuth, magic links) with row-level security tied
  to the signed-in user. Also real Postgres, and a generated client.
- **Lost:** Postgres does not scale to zero the way D1 does; row-level security
  is powerful and easy to get subtly wrong; and you are on a different platform
  commitment.
- **Verdict:** **a sound choice, and not a step down**, especially if you want
  email verification, password reset and MFA without writing them. This
  project builds its own accounts instead (decision D8): the whole thing is
  ~400 lines on Web Crypto with no new services, which fits a tutorial whose
  point is that you could recreate it. What it does *not* give you is the
  account-recovery machinery an identity provider includes for free — see
  Part 9 for exactly what is missing.

## Decision records

Each of these follows the same four questions: the problem, the alternatives,
what the docs say, and what would change our mind.

### D1: R2 binding, not the S3-compatible API

- **Problem.** How does the Worker talk to R2?
- **Alternatives.** (a) the `env.PHOTOS` binding; (b) `@aws-sdk/client-s3`
  against R2's S3-compatible endpoint.
- **Docs.** The Workers API reference opens by saying the in-Worker API is
  reached "by binding an R2 bucket to a Worker", and points to the
  S3-compatible API only "if you need S3 compatibility".
  <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- **Chosen:** the binding. It needs no credential, no SDK (the AWS SDK is a
  large dependency to ship to the edge), and no signing. The whole backend has
  **zero runtime dependencies** as a result.
- **Would change our mind:** needing to run the same code outside a Worker, or
  needing presigned URLs — which require S3-style signing (Part 12).

### D2: upload through the Worker, not presigned URLs

- **Problem.** How do bytes get from the phone into R2?
- **Alternatives.** (a) POST to the Worker, which writes to R2; (b) ask the
  Worker for a presigned URL and PUT straight to R2.
- **Chosen:** (a). It is one round trip instead of three, it is the only option
  where the server **sees the bytes** (so it can reject a file that is not an
  image at all), and there is no window in which a half-finished upload exists
  with no database row.
- **Would change our mind:** the triggers are specific — files above ~10 MB,
  the Worker's CPU time becoming a cost, or wanting resumable uploads. See
  Part 12 for how to recognise this and what the redesign looks like.

### D3: 5 MB limit, buffered, with a streaming guard

- **Problem.** How much do we accept, and how do we avoid holding a large file
  in Worker memory?
- **Chosen:** a configurable limit (`MAX_UPLOAD_BYTES`, default 5 MB),
  enforced twice — rejected from `Content-Length` before reading anything, and
  enforced again inside the read loop in `server/src/body.ts` because
  `Content-Length` is a *claim* and React Native does not always send one.
- **Docs note.** This is also why we buffer at all. The R2 reference says a
  `ReadableStream` passed to `put()` "must have a known length… Otherwise
  `put()` throws `TypeError`". Streaming `request.body` straight into R2 works
  only when the client sent `Content-Length`; buffering a bounded 5 MB is the
  version that always works.
- **Would change our mind:** raising the limit much past 10 MB. Then the answer
  is not a bigger buffer, it is D2 reversed.

### D4: no routing library

- **Problem.** Five routes, two with a path parameter.
- **Alternatives.** (a) match on path segments; (b) Hono.
- **Chosen:** (a) — about 30 lines in `server/src/index.ts`, less than Hono's
  own setup, and it keeps the real `fetch(request, env)` signature visible,
  which is the thing worth learning.
- **Would change our mind:** any of — more than ~10 routes, wanting middleware
  chains, wanting per-route schema validation, or wanting typed route params.
  Hono is a good library; it is just not yet earning its place here.

### D5: no ORM

- **Problem.** Writing SQL by hand is error-prone.
- **Chosen:** `env.DB.prepare(sql).bind(values)`. The injection risk — the main
  reason people reach for an ORM — is already handled: `bind()` sends values to
  SQLite *separately from the SQL text*, so a value can never become syntax.
- **Would change our mind:** enough tables that migrations become painful by
  hand. Drizzle supports D1 and Wrangler supports its nested migration layout
  via `migrations_pattern`.

### D6: D1, not SQLite on the device

- **Problem.** The metadata has to live somewhere.
- **Chosen:** D1. `expo-sqlite` on the device is genuinely the right answer for
  data that belongs to one installation — a local cache, drafts, offline state.
  It is the wrong answer here because the requirement is "my photos on my other
  phone": device-local SQLite cannot be read by a second device, is lost on
  uninstall, and cannot be the authority on who owns an object in a shared
  bucket.
- **Worth knowing:** the strongest design is often *both* — D1 as the authority,
  `expo-sqlite` as an offline cache in front of it. That is listed in Part 12.

### D7: authentication always on, even locally

- **Problem.** A gallery with open upload/list/delete is not safe to deploy.
- **Alternatives.** (a) skip auth locally and add it for production; (b) require
  a token everywhere, with local dev reading one from `.dev.vars`.
- **Chosen:** (b). With (a), the code path you test is not the code path you
  deploy, and shipping an open API is one forgotten flag away. With (b) there
  is no flag to forget.
- **What would change it.** Nothing. This one has survived a complete rewrite
  of *how* the caller is identified — pre-shared tokens became accounts with
  passwords and sessions — without the decision itself changing, which is a
  decent sign it was the right level to decide at. Local development now signs
  in for real against the local D1.

### D8: our own accounts, not an identity provider

- **Problem.** The first version shipped a bearer token through
  `EXPO_PUBLIC_PHOTO_VAULT_TOKEN`, which is embedded in the app bundle in plain
  text. Every install shared one extractable credential and one `owner_id`.
- **Alternatives.** (a) keep it and call the app single-user; (b) an identity
  provider (Clerk, Auth0, Firebase, Supabase Auth); (c) accounts in D1, with
  password hashing and sessions in the Worker.
- **Chosen:** (c). (a) was not honest for anything with sign-ups. (b) is a
  perfectly good answer and is what you should pick if you want email
  verification, password reset and MFA without writing them — but it adds a
  service, a vendor and a JWKS fetch to a project whose point is to be
  recreatable from first principles. (c) is ~400 lines, no new dependencies,
  and every primitive is in Web Crypto.
- **What would change it.** Needing password reset or email verification. Both
  require an email provider, and at that point an identity provider is doing
  more for you than it costs. The seam is one function — see Part 9.

### D9: two tokens, not one

- **Problem.** A single credential cannot be both cheap to verify and
  instantly revocable.
- **Alternatives.** (a) one long-lived JWT — free to verify, impossible to
  revoke; (b) one opaque DB-backed token — revocable, but a D1 read on every
  request including every thumbnail; (c) both, with different jobs.
- **Chosen:** (c). A 15-minute signed access token for every request, and a
  30-day opaque refresh token that only ever touches `/auth/refresh`.
- **What would change it.** A requirement that revocation take effect in under
  15 minutes. Then you pay for the lookup, or keep a revocation list in KV.

---

# Part 4 — Setting up the backend

## Why `server/` is its own package

This repository is a single-package Expo app, not a monorepo. The backend lives
in `server/` with **its own `package.json`**, because the two halves target
different runtimes: `wrangler` and the `workerd` type definitions have no
business in the dependency tree that `expo-doctor` validates and Metro bundles,
and `server/` stays independently deployable.

The exception is tests: there is **one Vitest at the repository root** with two
projects (`vitest.config.mts`), so `npm test` runs both halves.

```text
r2-template/
├── src/                        the Expo app
├── docs/CLOUDFLARE_R2_EXPO_GUIDE.md
├── vitest.config.mts           one test runner, two projects
├── .env.example                app-side configuration template
└── server/                     the Cloudflare Worker
    ├── package.json            its own dependencies
    ├── wrangler.jsonc          bindings, vars, environments
    ├── tsconfig.json
    ├── worker-configuration.d.ts   GENERATED by `wrangler types`
    ├── .dev.vars.example       local secrets template
    ├── migrations/
    │   └── 0001_create_photos.sql
    ├── src/
    │   ├── index.ts            fetch handler + routing
    │   ├── photos.ts           the four photo operations
    │   ├── auth.ts             token → principal
    │   ├── validate.ts         magic-byte sniffing, filename clamping
    │   ├── body.ts             bounded body reader
    │   ├── cors.ts             browser-only
    │   ├── http.ts             response helpers
    │   └── types.ts            Env + API contracts
    └── test/
        ├── setup.ts            applies migrations, truncates between tests
        ├── helpers.ts
        └── photos.spec.ts
```

## Recreating it from nothing

```bash
mkdir -p server/src server/migrations server/test
cd server
npm init -y
npm install --save-dev wrangler typescript
```

Then `server/wrangler.jsonc` — the whole backend configuration. The important
properties:

| Key | What it does |
|---|---|
| `name` | The Worker's name, and part of its `*.workers.dev` URL |
| `main` | Entry file. Wrangler bundles from here |
| `compatibility_date` | Pins runtime behaviour. Raising it can change semantics, so it is a deliberate edit |
| `r2_buckets[].binding` | The variable name on `env` |
| `r2_buckets[].bucket_name` | The actual bucket |
| `d1_databases[].database_id` | The real database's UUID. Ignored in local mode |
| `d1_databases[].migrations_dir` | Where `.sql` migrations live |
| `vars` | Non-secret config. **Visible in the dashboard** |
| `env.production` | A separate environment. **Inherits nothing** |
| `observability.enabled` | Required for `wrangler tail` to be useful |

The single most important thing in that file is that the development and
production resources have **different names** (`photo-vault-dev` vs
`photo-vault-prod`). A command aimed at one therefore cannot silently hit the
other.

> `env.production` inherits nothing from the top level. Every binding and every
> var is repeated inside it. Forgetting this is a classic way to deploy a Worker
> whose `vars` are all `undefined`.

## Generate the binding types

```bash
cd server && npx wrangler types
```

This writes `server/worker-configuration.d.ts` (~16,000 lines) containing the
Workers runtime types **and** a `Cloudflare.Env` interface derived from your
bindings. Re-run it whenever you change `wrangler.jsonc`.

Two things worth knowing, both of which contradict older tutorials:

1. **You do not need `@cloudflare/workers-types` any more.** `wrangler types`
   now emits the runtime types itself. This project installed that package,
   found it redundant, and removed it.
2. **The generated `Cloudflare.Env` is not what the Worker code should depend
   on.** It bakes in your *local* values as literal types — `MAX_UPLOAD_BYTES`
   comes out as the literal `"5242880"`, and `SIGNUP_MODE` as
   `"open" | "invite"` because those are the two values in the file — so
   `"closed"`, which the Worker handles, is not even assignable. It also only
   knows about a secret like `AUTH_SECRET` if you happen to have a `.dev.vars`
   file. So `server/src/types.ts` declares
   its own `Env` interface by hand, and the generated file is used for the
   runtime types (`R2Bucket`, `D1Database`, …). Use the generated types for
   discovery; depend on the hand-written one.

## Create the local secrets

```bash
cd server
cp .dev.vars.example .dev.vars
```

`.dev.vars` is how Wrangler gives **secrets** to the local Worker. It is the
local counterpart of `wrangler secret put`, it is never uploaded, and it is
gitignored.

Generate your own signing key rather than using the placeholder:

```bash
openssl rand -base64 48
```

```ini
# server/.dev.vars
AUTH_SECRET=<the output of that command>
```

`AUTH_SECRET` is the HMAC key that signs access tokens; anyone holding it can
mint a token for any user. Use a different one in production. The Worker
refuses every authenticated request when it is unset, rather than treating an
empty string as a valid key.

The second secret, `SIGNUP_INVITE_CODES`, is unused locally because local
development runs with `SIGNUP_MODE=open` (see `wrangler.jsonc`). Production
defaults to `invite` and will need it.

## Run it

```bash
cd server
npx wrangler d1 migrations apply photo-vault-dev --local   # once
npm run dev                                                # or: npm run dev:lan
```

From the repository root the same two steps are:

```bash
npm run server:migrate
npm run server
```

`wrangler dev` prints exactly what your Worker can reach, which is the fastest
way to confirm your config is what you think it is:

```text
Binding                                             Resource                Mode
env.DB (photo-vault-dev)                            D1 Database             local
env.PHOTOS (photo-vault-dev)                        R2 Bucket               local
env.AUTH_LIMITER (10 requests/60s)                  Rate Limit              local
env.UPLOAD_LIMITER (30 requests/60s)                Rate Limit              local
env.READ_LIMITER (600 requests/60s)                 Rate Limit              local
env.MAX_UPLOAD_BYTES ("5242880")                    Environment Variable    local
env.ALLOWED_ORIGINS ("http://localhost:8081,...")   Environment Variable    local
env.SIGNUP_MODE ("open")                            Environment Variable    local
env.AUTH_SECRET ("(hidden)")                        Environment Variable    local

[wrangler:info] Ready on http://127.0.0.1:8787
```

Read that `Mode` column every time. `local` means Miniflare. Anything saying
`remote` is touching your real account.

## The API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | no | Liveness check |
| POST | `/auth/signup` | no | Create an account, return a session |
| POST | `/auth/signin` | no | Password → session |
| POST | `/auth/refresh` | refresh token | New access + refresh pair |
| POST | `/auth/signout` | refresh token | Revoke this device's session |
| POST | `/auth/signout-all` | yes | Revoke every session |
| GET | `/auth/me` | yes | The caller's account |
| GET | `/photos` | yes | List the caller's metadata |
| POST | `/photos` | yes | Upload one image (raw binary body) |
| GET | `/photos/:id/content` | yes | The image bytes |
| DELETE | `/photos/:id` | yes | Delete metadata and bytes |

"Auth: yes" means a Bearer **access token**. The four `no`/`refresh token`
routes are the ones that establish a credential, so they cannot require one —
which is exactly why they are the most heavily rate limited (Part 9).

`/health` is deliberately unauthenticated — a health check that needs a
credential is useless to an uptime monitor — and it deliberately queries
*nothing*, so an anonymous caller cannot make you spend billable D1 reads.

There is also a `scheduled()` handler with no route: it is invoked by a Cron
Trigger, not by HTTP. See Part 9.

Every response has one of two shapes:

```jsonc
{ "data": { "...": "..." } }
{ "error": { "code": "unsupported_media_type", "message": "…" } }
```

`code` is a closed set (`server/src/types.ts`) and is what the app switches on.
Never parse `message`.

---

# Part 5 — Local storage and database

## What runs where

| Piece | Local development | Production |
|---|---|---|
| Expo app | Your phone / simulator / browser | The installed app |
| Metro bundler | Your machine, port 8081 | Not involved |
| Worker code | `workerd` on your machine, port 8787 | Cloudflare's edge |
| R2 bucket | **Simulated** on your disk | Real bucket, real bill |
| D1 database | **Real SQLite file** on your disk | Real D1, replicated |
| Secrets | `server/.dev.vars` | `wrangler secret put` |

`workerd` is the same runtime Cloudflare runs in production, compiled for your
machine — so local development is not an emulator with different semantics. The
*bindings* are the simulated part.

```text
LOCAL                                 PRODUCTION
Expo                                  Expo
  → http://<LAN-IP>:8787                → https://photo-vault-api.<you>.workers.dev
    → workerd (your Mac)                  → Worker (Cloudflare edge)
      → local D1  (a SQLite file)           → D1  photo-vault-prod
      → local R2  (files on disk)           → R2  photo-vault-prod
```

## Where local state lives

Everything is under `server/.wrangler/state/` — gitignored:

```text
server/.wrangler/state/v3/
├── d1/miniflare-D1DatabaseObject/     your local database (SQLite files)
├── r2/miniflare-R2BucketObject/       object metadata
├── r2/photo-vault-dev/                the stored blobs
├── kv/, cache/, observability/        unused here
```

It persists across restarts. **Restarting Wrangler does not clear it** — your
test photos and your applied migrations are still there. That is the default and
it is what you want; it is also why "I deleted the table and it came back" is
usually "you never deleted it".

To put it somewhere else, use `wrangler dev --persist-to <DIR>` — and then pass
the same `--persist-to <DIR>` to *every* other local command, or they will read
the default location instead.

## Migrations

A migration is a numbered `.sql` file. Wrangler records which ones have been
applied in a `d1_migrations` table **inside the database**, so each one runs
once per database. Local and production are different databases, hence different
`d1_migrations` tables, hence applying to one tells you nothing about the other.

```bash
cd server

# create a new empty migration
npx wrangler d1 migrations create photo-vault-dev add_caption

# see what has not been applied
npx wrangler d1 migrations list photo-vault-dev --local

# apply to LOCAL
npx wrangler d1 migrations apply photo-vault-dev --local

# apply to PRODUCTION (needs your account; see Part 9 first)
npx wrangler d1 migrations apply photo-vault-prod --remote --env production
```

Real output from this project:

This project has two:

```text
Migrations to be applied:
┌────────────────────────────────────┐
│ name                               │
├────────────────────────────────────┤
│ 0002_create_users_and_sessions.sql │
└────────────────────────────────────┘
🌀 Executing on local database photo-vault-dev … from .wrangler/state/v3/d1:
🚣 5 commands executed successfully.
```

Note that `0001_create_photos.sql` is absent from that list: it had already
been applied, and Wrangler tracks applied migrations **by filename**. Which is
also the warning — editing an applied migration does nothing, because the name
is already recorded. Always add a new forward migration instead.

Five commands for `0002`, because it contains two `CREATE TABLE`s, two
`CREATE INDEX`es and the bookkeeping.

> `--local` and `--remote` are the whole safety story for migrations. There is
> no default-to-local for `apply` in every Wrangler version, so **type the flag
> every time** rather than relying on the default. The npm scripts in
> `server/package.json` encode the flag so you do not have to remember:
> `migrate:local` and `migrate:remote`.

## Inspecting local data

```bash
cd server

# any SQL you like
npx wrangler d1 execute photo-vault-dev --local \
  --command "SELECT id, filename, size_bytes, created_at FROM photos ORDER BY created_at DESC"

# machine-readable
npx wrangler d1 execute photo-vault-dev --local --command "SELECT COUNT(*) FROM photos" --json

# R2: read one object back out
npx wrangler r2 object get photo-vault-dev/photos/user_dev/pht_abc --local --pipe > out.png

# R2: put a file in by hand
npx wrangler r2 object put photo-vault-dev/some/key --file=./img.png --local
```

A real result from this project's local database:

```json
[{
  "id": "pht_4013ee265d1740898a55fafc1b1a5956",
  "owner_id": "user_dev",
  "object_key": "photos/user_dev/pht_4013ee265d1740898a55fafc1b1a5956",
  "filename": "passwd.png",
  "content_type": "image/png",
  "size_bytes": 1129
}]
```

(The filename is `passwd.png` because that row came from a test that uploaded
with `X-Filename: ../../etc/passwd.png`. Note what the `object_key` does *not*
contain.)

## Resetting development data

```bash
# everything: D1, R2, rate-limiter counters, caches
rm -rf server/.wrangler/state

# just the database
rm -rf server/.wrangler/state/v3/d1

# just the objects
rm -rf server/.wrangler/state/v3/r2

# just the rate-limiter counters (useful when you have locked yourself out
# of /auth/signin while testing)
rm -rf server/.wrangler/state/v3/ratelimit
```

Miniflare recreates whatever is missing on the next `wrangler dev`. After
deleting the D1 directory you must re-apply migrations — the `d1_migrations`
bookkeeping went with it, so `migrations apply` will correctly want to run
both files again.

To clear the data but keep the schema, which is usually what you want:

```bash
cd server
npx wrangler d1 execute photo-vault-dev --local   --command "DELETE FROM sessions; DELETE FROM photos; DELETE FROM users;"
```

Note the order: `sessions` has a foreign key to `users`. Being explicit about
it makes the command independent of whichever `PRAGMA foreign_keys` setting is
in force.

## Not touching production by accident

Five habits, in order of how much they save you:

1. **Different resource names per environment.** `photo-vault-dev` and
   `photo-vault-prod` are not interchangeable, so a command cannot hit the wrong
   one by default.
2. **Use the database *name*, not the binding name,** in migration commands.
   Binding names are shared across environments; database names are not. (The
   Cloudflare migrations page recommends exactly this.)
3. **Read the `Mode` column** that `wrangler dev` prints.
4. **Keep `--remote` out of your shell history** except in the two deploy
   commands. Never alias it.
5. **Never pass `--remote` to `wrangler dev`.** It exists, it binds your local
   code to production data, and it is the single easiest way to delete real
   objects while "just testing".

---

# Part 6 — Connecting Expo

## The file layout

```text
src/
├── app/vault.tsx                       the screen (route: /vault)
├── components/
│   ├── app-tabs.tsx                    native tab bar — Vault tab added here
│   ├── app-tabs.web.tsx                web tab bar — and here too
│   └── photo-vault/
│       ├── photo-tile.tsx              one thumbnail
│       └── sign-in-panel.tsx           the sign-in / sign-up form
├── hooks/
│   ├── use-auth.ts                     React's view of the session
│   ├── use-photo-vault.ts              all the gallery behaviour
│   └── use-photo-vault.test.ts
└── lib/photo-vault/
    ├── types.ts                        the API contract, client side
    ├── config.ts                       base URL resolution (no credentials)
    ├── http.ts                         fetch + error mapping, no credentials
    ├── auth.ts                         the session: obtain, renew, discard
    ├── token-store.ts                  refresh token -> OS keychain
    ├── token-store.web.ts              …and the weaker web fallback
    ├── client.ts                       photo calls, with auth and retry
    └── picker.ts                       ImagePicker wrapper
```

The layering is deliberate: `client.ts` has no React in it,
`use-photo-vault.ts` has no UI in it, and `vault.tsx` has no networking in it.
That is what makes the hooks testable in jsdom without a native renderer
(Part 8).

`auth.ts` is a module with state rather than a React context, for one concrete
reason: `client.ts` needs a valid access token and is not a component.
`use-auth.ts` adapts it for React with `useSyncExternalStore`.

> **Two tab files.** This template renders tabs natively on iOS/Android
> (`app-tabs.tsx`, using `NativeTabs`) and with `expo-router/ui` on the web
> (`app-tabs.web.tsx`). A new tab must be registered in **both**, or it will be
> missing on one platform. This is the kind of thing that only repository
> inspection tells you.

## What ImagePicker gives you

```ts
const result = await ImagePicker.launchImageLibraryAsync({
  mediaTypes: ['images'],
  allowsMultipleSelection: false,
  quality: 0.8,
  exif: false,
});
```

The result is a union:

```ts
{ canceled: true,  assets: null }
{ canceled: false, assets: ImagePickerAsset[] }
```

Each asset has `uri`, `width`, `height` guaranteed, and `fileName`, `fileSize`,
`mimeType` **optional** — they really are often absent, which is why
`src/lib/photo-vault/picker.ts` has fallbacks.

Two SDK-58 specifics that older tutorials get wrong:

- `mediaTypes` takes an **array of strings** (`['images']`). The
  `ImagePicker.MediaTypeOptions.Images` enum is deprecated. If you see that
  enum, the tutorial predates SDK 51.
- No permission request is needed to launch the **library** picker. The system
  picker runs out of process and returns only what the user chose. (The camera
  is different, and so is reading an original video file on iOS.)

Docs: <https://docs.expo.dev/versions/v58.0.0/sdk/imagepicker/>

## What a local image URI is — and is not

`asset.uri` looks like `file:///var/mobile/Containers/.../IMG_0004.jpg`, or
`ph://...` on iOS, or `content://...` on Android.

It is **a path on this one device**. It is:

- not a URL anybody else can open;
- not an R2 URL, and will not become one;
- not stable — the OS may clear the cache directory;
- not useful to the server. Sending the string to the Worker would accomplish
  nothing, because the Worker cannot read your phone's filesystem.

The bytes have to travel. That is what the upload is.

## Sending the bytes

```ts
const file = new File(picked.uri);        // expo-file-system; reads nothing yet
if (!file.exists) { /* … */ }
if (file.size > MAX_UPLOAD_BYTES) { /* reject here, before any network use */ }
const bytes = await file.bytes();         // Uint8Array

await fetch(`${baseUrl}/photos`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': picked.mimeType ?? 'application/octet-stream',
    'x-filename': picked.filename,
  },
  body: bytes,
});
```

Why this shape:

- **Raw binary, not `multipart/form-data`.** There is one file and no other
  fields, so a multipart envelope would only add parsing on both ends.
- **Raw binary, not base64 JSON.** Base64 inflates the payload by about 33% —
  you would pay for a third more bandwidth and force the Worker to decode the
  whole thing before it could store any of it.
- **`file.size` checked first.** This is the reason `expo-file-system` is a
  dependency at all. Rejecting a 12 MB photo instantly, on device, is a much
  better experience than uploading it over cellular and receiving a 413.
- **A `Uint8Array` body** has a length the platform knows, so `Content-Length`
  gets set, which lets the Worker reject oversized uploads without reading them.

## Networking: the part that actually wastes people's time

`http://localhost:8787` means something different in every place your code can
run:

| Where the app runs | What `localhost` means there | Works? |
|---|---|---|
| iOS **simulator** | Your Mac (shared network stack) | ✅ |
| Android **emulator** | The emulator itself. Your Mac is `10.0.2.2` | ❌ |
| **Physical phone** | The phone. Nothing is listening | ❌ |
| Web browser on your Mac | Your Mac | ✅ but cross-origin |

So this project does not hardcode a host. `src/lib/photo-vault/config.ts`:

```ts
const hostUri = Constants.expoConfig?.hostUri;   // e.g. "192.168.1.24:8081"
const host = hostUri.split(':')[0];
return `http://${host}:${WORKER_DEV_PORT}`;      // → http://192.168.1.24:8787
```

`hostUri` is the address your device **just used to download the JS bundle** —
so by definition it is an address the device can reach. That makes the right
thing happen on a simulator, an emulator and a physical phone with no
configuration, and survives your router handing out a new DHCP lease.

**On web, `hostUri` is `undefined`.** A browser loads a page from Metro; it does
not register with it the way a native client does. So `config.ts` falls back to
`window.location.hostname`, which is the same dev host by definition. Both
branches are wrapped in `if (!__DEV__) return null`, so a production build never
guesses a host — it reports a missing `EXPO_PUBLIC_PHOTO_VAULT_API_URL` instead,
which is a far easier error to act on than a connection timeout.

Two things you must still do yourself:

1. **Bind the Worker to more than loopback.** `wrangler dev` listens on
   127.0.0.1 by default, which a phone cannot reach. Use:

   ```bash
   cd server && npm run dev:lan      # wrangler dev --ip 0.0.0.0
   ```

2. **Be on the same network.** Same Wi-Fi, and a firewall that allows inbound
   8787. If the network isolates clients (common on guest and corporate Wi-Fi),
   no LAN address will work and you need a tunnel (`cloudflared tunnel`,
   `ngrok`) with `EXPO_PUBLIC_PHOTO_VAULT_API_URL` pointed at it.

**For the web**, the request is cross-origin, so the Worker's `ALLOWED_ORIGINS`
var must include the Expo dev origin. It already does:
`http://localhost:8081,http://127.0.0.1:8081`.

## Configuring the app

```bash
cp .env.example .env.local
```

```ini
# Leave UNSET in local development — the Metro host is derived automatically.
# EXPO_PUBLIC_PHOTO_VAULT_API_URL=https://photo-vault-api.YOU.workers.dev
```

That is the entire file. **There is no credential in it**, and that is the
point — see the next box.

How `EXPO_PUBLIC_` works, and its sharp edges:

- Expo CLI **textually replaces** every literal `process.env.EXPO_PUBLIC_NAME`
  in your source at bundle time. It must be a dot access —
  `process.env['EXPO_PUBLIC_X']` and `const { EXPO_PUBLIC_X } = process.env`
  are **not** substituted. This is why `config.ts` writes them out longhand.
- In SDK 58 the files loaded are, highest priority first:
  `.env.development.local`, `.env.local`, `.env.development`, `.env` in
  development; the `.production.*` equivalents in production. SDK 58 **no
  longer loads** arbitrary files like `.env.staging`.
- `.env*.local` is already in this repo's `.gitignore`.

> 🔴 **`EXPO_PUBLIC_` values are embedded in the shipped bundle in plain text.**
> They are configuration, not secrets.
>
> An API's address is the right kind of thing to put here: anyone can discover
> it by watching one request. A credential is not. An earlier version of this
> project shipped `EXPO_PUBLIC_PHOTO_VAULT_TOKEN`, which meant every install
> carried the same extractable string, it could not be revoked without an app
> update, and every user shared one account. It is gone; the device signs in
> instead. Part 9 has the full story.

Docs: <https://docs.expo.dev/guides/environment-variables/>

## Where the credentials live instead

```text
access token    in memory, in src/lib/photo-vault/auth.ts.  ~15 minutes.
refresh token   in the OS keychain, via expo-secure-store.  30 days.
```

`expo-secure-store` writes to the iOS Keychain and to Android's
`SharedPreferences` encrypted with the Android Keystore — storage that is
encrypted at rest and tied to this app. The access token is deliberately *not*
persisted: it expires in 15 minutes, so writing it to disk would put a working
credential somewhere readable in exchange for saving one refresh call at launch.

Two native behaviours worth knowing:

- **iOS Keychain entries survive app uninstallation** when the app is
  reinstalled with the same bundle id. Android's do not. So a reinstalled iOS
  app may come back already signed in — which is Apple's behaviour, not a bug,
  but it means "delete the app" is not a way to sign out. Hence the button.
- iOS has historically refused values above roughly 2 KB. Our refresh token is
  about 80 bytes; something larger would need to know about the ceiling.

> **Web is weaker, and the code says so.** `expo-secure-store` has no web
> implementation — there is no browser keychain, and anything JavaScript can
> read, injected JavaScript can read too. `token-store.web.ts` uses
> `localStorage`, which is not encrypted at rest and is reachable by any script
> on the origin, so one XSS bug hands over a 30-day credential.
>
> It is used anyway because the alternatives are worse here: memory-only would
> sign the user out on every page reload, and the correct answer — an HttpOnly,
> Secure, SameSite cookie that JavaScript cannot read — requires the app and
> the API to be the same site, which they are not in this architecture. If the
> web build matters in production, serve both from one domain and move the
> refresh token into an HttpOnly cookie set by `/auth/signin`. Until then,
> treat the web build as a development convenience.

Since the app config now uses `expo-secure-store`, `app.json` also sets
`ios.config.usesNonExemptEncryption: false`, which answers App Store Connect's
export-compliance prompt automatically.

## Showing an image from a private bucket

The bucket has no public access, so there is no URL that renders an image on its
own. Every read goes through the Worker and must carry an access token.

On **native**, `expo-image` accepts headers on its source:

```tsx
<Image source={{ uri: `${baseUrl}${photo.contentPath}`, headers: { authorization: `Bearer ${token}` } }} />
```

On **web** this is impossible — an `<img>` tag cannot send an `Authorization`
header. That is a browser fact, not an expo-image limitation. So
`src/components/photo-vault/photo-tile.tsx` fetches the bytes itself and wraps
them in a `blob:` URL, revoking it on unmount.

One consequence of real tokens: `photoImageSource()` is **async**, because
obtaining a token may require renewing it first. And unlike every other call,
`expo-image` is handed the header and then uses it on its own schedule, perhaps
seconds later — which is why `auth.ts` renews a full minute before expiry. A
token that is valid now but expires in two seconds produces thumbnails that
fail for no visible reason.

## Honest loading states

`src/app/vault.tsx` shows a spinner during upload and **no percentage**. React
Native's `fetch` exposes no upload-progress events, so any number would be
invented. If you want a real percentage you need an API that reports it —
`XMLHttpRequest`'s `upload.onprogress`, or `expo-file-system`'s
`File.createUploadTask()`, which was built for this.

Cancellation is real, though: the hook passes an `AbortSignal` into the upload
and aborts it both on an explicit "Cancel upload" and on unmount.

---

# Part 7 — Understanding every request

One sign-in and one photo, all the way down and back. The outputs below are
real, captured against `wrangler dev` with local R2, D1 and rate limiters.

## Sign-in — the request that makes all the others possible

```text
 1. User types an email and a password, taps "Sign in".
 2. POST /auth/signin   {"email":"…","password":"…"}
      ↓
 3. Worker: routeAuth() → AUTH_LIMITER.limit({ key: "auth-ip:<ip>" })
 4. readJson(): reject anything over 4 KB BEFORE parsing — this route is
    unauthenticated, so it must not buffer whatever it is sent
 5. normalizeEmail()  "  Me@Example.COM " → "me@example.com"
 6. AUTH_LIMITER.limit({ key: "signin:me@example.com" })
      ← the limit that actually stops credential guessing
 7. SELECT … FROM users WHERE email = ?
 8. verifyPassword(password, row?.password_hash ?? decoyPasswordHash())
      ← the decoy is why an unknown email costs the same ~60 ms as a known one
 9. needsRehash()? → re-hash at the current cost factor and UPDATE
10. createSession():
      sessionId = "ses_" + 32 hex
      secret    = 32 random bytes, base64url
      INSERT INTO sessions (…, token_hash = SHA-256(secret), …)
      accessToken = HS256 JWT { sub, sid, iat, exp, iss, aud }
11. 200 { "data": { accessToken, refreshToken: "<sessionId>.<secret>", … } }
      Cache-Control: no-store      ← the body contains credentials
      ↓
12. auth.ts keeps accessToken in memory, writes refreshToken to the keychain.
```

The decoded access token, captured from a real run:

```json
{
  "sub": "usr_9367b5108b3643aab7c488c69aa78134",
  "sid": "ses_ca72518b64d447e2adaa9fbd862a8643",
  "iat": 1794174237,
  "exp": 1794175137,
  "iss": "photo-vault-api",
  "aud": "photo-vault-app"
}
```

900 seconds apart. Note what is **not** in it: no email, no roles, no
permissions. A JWT is readable by anyone holding it — base64, not encryption —
so it carries an opaque id and nothing a leak would regret.

### Refresh

```text
 1. Access token is within 60 s of expiry, or a request just got a 401.
 2. auth.ts: refreshOnce() — if a refresh is already running, await THAT one.
      ← not an optimisation; see the replay rule below
 3. POST /auth/refresh   {"refreshToken":"ses_abc.secret"}
 4. Split on the first ".", SELECT … FROM sessions WHERE id = ?
 5. constantTimeEquals(SHA-256(secret), row.token_hash)
 6. row.revoked_at set?  → THIS TOKEN WAS ALREADY SPENT.
       UPDATE sessions SET revoked_at = now WHERE user_id = ? AND revoked_at IS NULL
       → every session for the account ends. 401.
 7. expired? disabled account? → 401 / 403
 8. UPDATE sessions SET revoked_at = now WHERE id = ?     ← spend the old one
 9. createSession() → a brand-new pair
10. 200 { data: { accessToken, refreshToken, … } }
```

Step 8 happens *before* step 9 deliberately: a crash between them leaves the
user needing to sign in again, which is annoying. The other order would leave a
refresh token valid after it had been handed out twice, which is a security
bug.

## Upload

```text
 1. User taps "Select photo".
 2. launchImageLibraryAsync() → { canceled: false, assets: [{ uri: "file:///…/IMG_0004.jpg", … }] }
 3. picker.ts normalises it to PickedPhoto. Nothing has been read or sent.
 4. User taps "Upload".
 5. client.ts: new File(uri) → check .exists → check .size ≤ 5 MB → .bytes()
 6. POST /photos      Authorization: Bearer …   Content-Type: image/jpeg
                      X-Filename: IMG_0004.jpg  Content-Length: 1129
      ↓
 7. Worker: route() matches ['photos'] + POST
 8. authenticate() → Bearer JWT → HS256 verify → { id: "usr_…", sessionId: "ses_…" }
    (no database read: that is the whole point of a signed token — see Part 9)
 8b. UPLOAD_LIMITER.limit({ key: "upload:usr_…" })
 9. readBodyWithLimit(): Content-Length ≤ limit, then read the stream,
    aborting if the real byte count ever exceeds the limit
10. sniffImageType(bytes) → first 3 bytes are FF D8 FF → "image/jpeg"
    (the client's Content-Type header is IGNORED)
11. id         = "pht_" + 32 hex   → pht_5a5521405d2b441c9f190a86b83dddb4
    objectKey  = photos/usr_9367b510…/pht_5a5521405d2b441c9f190a86b83dddb4
12. env.PHOTOS.put(objectKey, bytes, { httpMetadata: { contentType, cacheControl } })
13. env.DB.prepare(INSERT …).bind(…).run()
      on failure → env.PHOTOS.delete(objectKey), return 500
14. 201 { "data": { "photo": { … } } }
      ↓
15. The hook prepends the photo to its list. No re-fetch.
```

Real response:

```json
{"data":{"photo":{
  "id":"pht_5a5521405d2b441c9f190a86b83dddb4",
  "filename":"final-check.png",
  "contentType":"image/png",
  "sizeBytes":1129,
  "createdAt":"2026-11-08T12:30:00.871Z",
  "contentPath":"/photos/pht_5a5521405d2b441c9f190a86b83dddb4/content"
}}}
```

Note what is **not** in it: no `owner_id`, no `object_key`, no bucket name, no
absolute URL. The client gets an id and a relative path; the storage layout
stays the server's business, which means it can change without breaking any id
a client already holds.

### Why keys and ids are different things

The database `id` and the R2 `object_key` could have been the same string. They
are not, on purpose:

- **The id is the public handle.** It is in URLs and in app state. It must never
  need to change.
- **The key is an implementation detail.** Today it is
  `photos/<owner>/<id>`. Tomorrow you might want `photos/<owner>/<year>/<id>`
  for lifecycle rules, or a hash prefix to spread load. With the key stored as
  its own column, that is a migration. With the key *derived* from the id, it is
  a breaking change.
- **The owner is in the key** so that `list({ prefix: "photos/user_dev/" })` can
  enumerate one user's objects — useful for cleanup and account deletion.
- **The filename is never in the key.** Two users uploading `IMG_0001.jpg` would
  collide, and a name like `../../secret` would try to escape the prefix. The
  filename is display data: `sanitizeFilename()` strips any directory
  component and clamps the length, and that is all it is ever used for. The
  real test in this project uploads `../../../etc/passwd.png` and the stored key
  is `photos/user_alice/pht_…` with no trace of it.
- **No file extension in the key.** The media type is already recorded in R2's
  `httpMetadata` and in D1. A third copy would be free to drift out of sync.

### Why `content_type` and `size_bytes` are columns

Both are *also* available from R2, via a `HEAD`-equivalent on the object. Storing
them in D1 means the list endpoint answers in **one D1 query and zero R2
operations**. Rendering a gallery of 50 photos would otherwise cost 50 Class B
R2 operations just to learn their sizes. `content_type` additionally serves as
the fallback if an object's metadata is ever missing.

### Why not store a full R2 URL

Because there is not one. The bucket is private, so no URL serves the bytes
directly; the only thing that does is the Worker. And a stored absolute URL
would hardcode the environment — the row written on your laptop would point at
`http://192.168.1.24:8787` forever. The client already knows its own base URL,
so the server sends a relative `contentPath` and the two are composed on the
device.

## Read

```text
GET /photos/pht_5a55…/content      Authorization: Bearer …
  1. authenticate() → { id: "user_dev" }
  2. SELECT object_key, content_type FROM photos WHERE id = ? AND owner_id = ?
       ← the ownership check. Not optional, and not only on the list endpoint.
  3. no row → 404 (not 403: a 403 would confirm the id exists)
  4. env.PHOTOS.get(object_key)
  5. null → log loudly, 404. D1 says it exists and R2 disagrees: the
     inconsistent state this architecture permits.
  6. object.writeHttpMetadata(headers)   ← copies the contentType we stored
     headers.etag = object.httpEtag
     headers['cache-control'] = 'private, max-age=31536000, immutable'
  7. If-None-Match matches the ETag → 304, empty body
  8. new Response(object.body, …)    ← a ReadableStream. The Worker never
                                       buffers the image.
```

Verified:

```text
HTTP/1.1 200 OK
Content-Length: 1129
Content-Type: image/png
Cache-Control: private, max-age=31536000, immutable
ETag: "d9f444efbdfbe7931aa93beada07318a"
```

and the round-tripped bytes are byte-identical to the uploaded file (same
SHA-256). A second request with `If-None-Match: "d9f444…"` returns
`status=304 bytes=0`.

`immutable` is truthful here because keys are unique and objects are never
overwritten — the bytes at a key genuinely cannot change. `private` keeps shared
caches out, because these bytes belong to one user.

## Delete

```text
DELETE /photos/pht_5a55…
  1. authenticate()
  2. SELECT object_key WHERE id = ? AND owner_id = ?   → 404 if none
  3. DELETE FROM photos WHERE id = ? AND owner_id = ?  ← owner predicate REPEATED
  4. meta.changes === 0 → 404 (someone else deleted it between 2 and 3)
  5. env.PHOTOS.delete(object_key)
       on failure → log. The request still succeeds.
  6. 200 { "data": { "id": "pht_5a55…" } }
```

The owner predicate is on the `DELETE` as well as the `SELECT` on purpose.
Nothing stops a concurrent request between the two statements, and authorization
belongs on the statement that actually mutates data.

## The consistency problem, stated honestly

**R2 and D1 do not share a transaction.** There is no `BEGIN` that spans them.
`D1Database.batch()` is a transaction over *D1 statements only* — it does not
help here at all. Any claim to the contrary is wrong, and designing as if it
were true produces a system that quietly corrupts itself.

So there are two possible inconsistencies, and they are not equally bad:

| State | Cause | User impact | Cost |
|---|---|---|---|
| **Orphan object** — bytes in R2, no D1 row | D1 insert failed after the put; or the R2 delete failed after the row was removed | **None.** Invisible | A little storage |
| **Dangling row** — D1 row, no R2 object | R2 put failed after the row was written; or the object was deleted out of band | **Visible.** A broken photo that never loads | None |

Orphans are strictly better. Every ordering decision in this codebase follows
from that:

- **Upload:** R2 **first**, then D1. A failure leaves an orphan, never a broken
  gallery entry. And we clean it up: if the insert throws, the handler deletes
  the object it just wrote. That rollback is covered by a test that asserts the
  real local bucket is empty afterwards.
- **Delete:** D1 **first**, then R2. A failure leaves an orphan, and the user's
  gallery is already correct — so the request returns 200 rather than failing
  an operation that, as far as the user is concerned, succeeded.

**What is still not handled**, stated plainly:

1. If the R2 rollback *also* fails, the object is orphaned. Logged, not fatal.
2. If the Worker is evicted between the R2 put and the D1 insert, nothing runs
   the rollback. Orphan.
3. A dangling row is still possible if an object is deleted out of band. The
   read endpoint detects it, logs it and returns 404 rather than serving an
   empty image.

The production answer to all three is a **reconciliation sweep**, and it is
implemented: `server/src/reconcile.ts`, run nightly by a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
It lists objects under `photos/`, diffs them against D1, deletes orphans, and
reports dangling rows.

Two details carry the weight, and both are in Part 9: a **one-hour grace
period**, because an upload in flight is indistinguishable from an orphan; and
a **completeness check**, because acting on a partially enumerated bucket would
delete healthy photos. An unbounded delete job is a dangerous thing to ship, so
every loop has a cap, the destructive half is opt-in, and twelve tests cover
it.

---

# Part 8 — Testing and debugging

## The commands

```bash
npm test                            # both projects (164 tests)
npm test -- --project=worker        # Worker only, inside workerd
npm test -- --project=app           # the hooks and client, in jsdom
npm run typecheck                   # the Expo app
npm run server:typecheck            # the Worker (src and test configs)
npx eslint .                        # lint the app
npx expo-doctor                     # dependency / config sanity
```

Expected output:

```text
 Test Files  7 passed (7)
      Tests  164 passed (164)
```

## How the Worker tests work

This is the part worth copying into other projects. The Worker tests do **not**
mock R2 and D1 — they run inside `workerd` against the real local bindings.

`vitest.config.mts` defines two projects. The Worker one:

```ts
cloudflareTest(async () => ({
  wrangler: { configPath: './server/wrangler.jsonc' },
  miniflare: {
    bindings: {
      AUTH_SECRET: 'test-signing-secret-not-used-anywhere-else',
      PASSWORD_ITERATIONS: '1000',   // cost factor turned down; see below
      MAX_UPLOAD_BYTES: '2048',
      TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'server/migrations')),
    },
  },
}))
```

Three things are happening:

1. **`wrangler.configPath` reuses the real config.** Bindings, vars and
   compatibility date come from the same file you deploy with, so tests and
   production cannot drift apart.
2. **`miniflare.bindings` overrides what tests need differently.** Two tokens,
   so ownership isolation is actually testable, and a 2 KB upload limit so the
   size tests do not allocate megabytes.
3. **The migrations are read in Node at config time** and injected as a binding,
   because test code runs inside `workerd` and has no filesystem.

`server/test/setup.ts` then applies them:

```ts
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM photos').run();
  const listed = await env.PHOTOS.list();
  if (listed.objects.length > 0) await env.PHOTOS.delete(listed.objects.map((o) => o.key));
});
```

The schema comes from the **same migration files** that `wrangler d1 migrations
apply` runs. If a migration is wrong, the tests break — which is the whole point.

> **Storage isolation is per test FILE, not per test.** Each file gets its own
> empty D1 and R2; tests *within* a file share them. This project hit exactly
> this: nine tests failed on first run because rows leaked between them, and the
> fix is the `beforeEach` truncation above. If you want files to share storage
> instead, run with `--max-workers=1 --no-isolate`.
> <https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/>

## What is covered

**164 tests in total: 104 in the Worker, 60 in the app.**

### Worker — `server/test/`, 104 tests

`photos.spec.ts` — health; 405s; unknown routes; malformed ids; missing /
malformed / wrong tokens; auth required on *image reads* specifically; upload
writing real bytes to real R2 with real D1 metadata; JPEG and PNG; a **lying
`Content-Type`** being overridden by magic-byte sniffing; a non-image rejected
with nothing written anywhere; oversize rejected via `Content-Length`; **oversize
rejected when `Content-Length` is absent** (a streamed body, exercising the read
loop's guard); empty body; `../../../etc/passwd.png` sanitised out of both the
filename and the key; list ordering; the list response **not containing**
`owner_id` or `object_key`; byte-exact reads; `nosniff` and CSP on image bytes;
ETag/304; a D1 row whose R2 object is missing; ownership isolation across list,
read and delete; R2 keys scoped per account; delete removing both row and
object; double delete; **D1 failure after an R2 put leaving no orphan**; **R2
failure leaving no D1 row and leaking no internal detail**; CORS preflight
allowed, refused, and absent.

`auth.spec.ts` — sign-up creating a user, a session and a working token; the
password hash never appearing in a response; email case-folding and the UNIQUE
constraint; short passwords; malformed emails; non-JSON and oversized bodies;
the invite gate accepting, refusing and **defaulting to closed** on an
unrecognised or unset `SIGNUP_MODE`; sign-in; wrong password; **an unknown
email returning a byte-identical response to a wrong password**; disabled
accounts; **password-hash upgrade on sign-in after the cost factor is raised**;
`/auth/me` including the cases where the user row was deleted or disabled after
the token was minted; refresh rotating the token and revoking the old session;
a wrong secret half not revoking the real session; malformed and expired
refresh tokens; **replay of a rotated token revoking every session**; sign-out;
**a session id alone not being enough to sign somebody out**; sign-out-all
affecting only the caller; the **documented revocation window**; a token signed
with the wrong secret; an expired token; **`{"alg":"none"}` being ignored**; a
tampered payload; a wrong audience; **a missing `AUTH_SECRET` failing closed**;
salt uniqueness; hashes that fail closed when corrupt or hostile; and the
production iteration count.

`ratelimit.spec.ts` — a sustained sign-in burst eventually refused with
`Retry-After`; one account's burst **not** locking out another; **a real user
still able to refresh after the sign-in budget for their shared IP is
exhausted**; upload bursts throttled; reads unaffected by an exhausted upload
budget; fail-open on a missing or throwing binding; and an assertion that the
bindings exist at all, so the other tests cannot silently pass through the
fail-open path.

`reconcile.spec.ts` — an orphan past the grace period deleted; **a recent
orphan left alone, because it may be an upload in flight**; a dangling row
reported but not deleted by default; deleted when explicitly enabled; a recent
one left alone even then; a healthy system reporting nothing to do; expired
sessions purged; **recently revoked sessions kept, so replay stays
detectable**; revoked ones purged after retention; a failed R2 enumeration
recording an error and **not** mistaking "could not list" for "nothing is
there"; and the real `scheduled()` entry point the Cron Trigger calls.

The failure-injection tests pass a broken binding while leaving the other real:

```ts
const brokenDb = { prepare() { throw new Error('D1 unavailable'); } } as unknown as D1Database;
const response = await uploadPhoto(request, { ...env, DB: brokenDb }, principal);
expect(response.status).toBe(500);
expect(await listObjectKeys()).toEqual([]);   // ← the rollback really ran
```

> **Why the test helpers randomise emails and IPs.** The rate limiters are real
> here — Miniflare implements the binding with a Durable Object — and storage
> is isolated per test *file*, not per test. Without distinct limiter keys, the
> thirtieth test in a file would start failing because of the twenty-nine
> before it. The tests that are *about* rate limiting deliberately reuse one
> key.

### App — `src/`, 60 tests

`use-photo-vault.test.ts` (23) — the gallery's full state machine: initial
loading (and that it is *not* "empty" until the server answers); empty and
populated galleries; load failure; retry recovering; refresh; **refresh failure
keeping the existing list visible**; selection; a cancelled picker treated as a
no-op; upload no-op with nothing selected; the in-flight flag; prepending on
success; upload failure **keeping the selection so it can be retried**; a
cancelled upload showing no error; delete requiring confirmation; a 404 on
delete converging the UI silently.

`auth.test.ts` (21) — sign-in storing the refresh token and publishing state;
sign-up with and without an invite code; session restore from storage;
**keeping the refresh token when the failure was the network, discarding it
when the server rejected it**; token reuse while valid; **early renewal inside
the margin**; the three snapshot-stability tests described below; **five
concurrent callers coalescing into one refresh**; a failed refresh not getting
stuck in flight; forced renewal after a 401; sign-out succeeding locally even
when the server call fails.

`config.test.ts` (9) — resolving the API base URL from each of its sources:
an explicit env var winning over everything, `hostUri` in Expo Go and
dev-client builds, **Metro's script URL in a bare debug build**, a bracketed
IPv6 host, the page hostname on web, and a production build refusing to guess
at all. This looks like trivial string handling and is not — see the box below.

`client.test.ts` (7) — the bearer header; **a 401 triggering exactly one
renewal and one retry, with the retry carrying the new token**; giving up after
one retry instead of looping; not refreshing for 429/404/500/network; no
credential on `/health`; and the image source for a private bucket.

> Two bugs were found by tests that were then kept as regressions. The 401
> retry originally mutated and re-sent one `Headers` object, so both attempts
> shared mutable state. And `getAuthState()` returned a fresh object on every
> call — fine anywhere except as the `getSnapshot` of a `useSyncExternalStore`,
> where React compares with `Object.is`, so every render looked like a change
> and the app died with *"Maximum update depth exceeded"*. That one only
> appeared when the page was actually opened in a browser.

## What is *not* covered, and what it would take

Being explicit, because "164 tests pass" is not the same as "it works":

| Verified how | What |
|---|---|
| ✅ Automated, real local bindings | Every Worker behaviour listed above, against real local R2, D1 and rate limiters |
| ✅ Automated, jsdom | Both hooks' state machines and the HTTP wrapper |
| ✅ Manually, live `wrangler dev` | Sign-up at the **production** 600k iterations (~66 ms); the JWT's decoded claims; `/auth/me`; 401 without a token; upload with a byte-identical read back (SHA-256 compared); `nosniff`/CSP/CORP headers; ETag→304 with 0 bytes; a hostile filename sanitised out of the key; refresh rotation; **replay of a rotated token revoking the family**; cross-account isolation on read and delete; delete clearing both the D1 row and the R2 object; the auth rate limiter refusing at the 8th attempt with `Retry-After: 60`; the `scheduled()` handler running and logging its report |
| ✅ Manually, a browser on `expo start --web` | Sign-in form; **account creation through the UI**; the empty state; session **restored from storage across a page reload**; four images loading out of the **private bucket**; the delete confirmation; a confirmed delete removing the tile; sign-out returning to the form and revoking the session server-side |
| ✅ Config validation | `wrangler deploy --env production --dry-run` resolving prod bucket, prod database, three limiters and `SIGNUP_MODE=invite` — without deploying |
| ✅ **On a real Android build** (`npx expo run:android`, Pixel 9 Pro emulator, API 36) | `NativeTabs` with the Vault tab and its Material icon; **creating an account by typing into the form**, producing a `pbkdf2-sha256$600000` row in D1 and a session recording `okhttp/4.9.2`; the keyboard lifting the form rather than covering it; three images rendering **out of the private bucket through `expo-image`'s request headers**; pull-to-refresh; **the session surviving a force-stop via the Android Keystore**, with the old refresh token rotated to revoked and a new one live; delete removing the row and its R2 object |
| ✅ Build | `expo-doctor` 20/20; `tsc` and `eslint` clean across app, server and server tests |
| ❌ **Not verified: iOS.** | The build does not currently complete on this machine, and not because of this project: compiling `node_modules/expo-modules-jsi/.../JavaScriptObject.swift` under Xcode 26.0.1 fails with `error: sending 'slot' risks causing data races`, a Swift 6 strict-concurrency diagnostic inside Expo's own source. `npx expo install --check` reports dependencies are up to date, so this is an Expo SDK 58 / Xcode 26 toolchain incompatibility. Patching a dependency's Swift to silence a data-race diagnostic is not a fix. The iOS-specific paths — `NativeTabs` on UIKit, the iOS Keychain, `SafeAreaView` insets — are therefore unexercised, although every one of them has an Android counterpart that now is |
| ❌ **Not verified** | `expo-image-picker` returning a real asset. The simulator's photo library and the picker UI were not driven; uploads were exercised through the API |
| ❌ **Not verified** | Upload from a physical phone over LAN |
| ❌ **Not verified** | Anything against a real Cloudflare account — no deploy, no remote migration, no production bucket, no real Cron Trigger firing |

Web and Android exercise genuinely different code — `app-tabs.web.tsx` with
the blob-URL image path and `localStorage`, against `NativeTabs` with
`expo-image`'s `headers` and the Android Keystore — so running both is worth
considerably more than running either twice. iOS shares the native branch with
Android but not the platform underneath it.

Adding native component tests would mean `jest-expo` plus
`@testing-library/react-native` — a second test framework, deliberately not
installed, since the logic worth testing already is.

> **Two bugs were found purely by running the app on something**, and both are
> the kind no amount of unit testing reaches, because both were about an
> environment rather than about logic.
>
> On web, `Constants.expoConfig.hostUri` is undefined — the browser loaded a
> page, it did not connect to Metro the way a device does — so the base URL
> could not be derived and the screen showed a configuration error instead of
> a gallery. Fixed with a `window.location.hostname` fallback.
>
> Then the Android build showed *the same error*, for a different reason: an
> app built with plain `expo run:android` has no `expo-dev-client`, so it never
> fetches a manifest, `Constants.executionEnvironment` is `"bare"`, and every
> Expo manifest field is null. A probe on the device showed the bundle had come
> from `http://10.0.2.2:8081/...` — the emulator's address for its host
> machine, and precisely the value needed. `config.ts` now falls back to
> Metro's script URL, which is in fact the most trustworthy signal of the
> three: the one address the device has already proved it can reach.
>
> Run the thing. Then run it somewhere else.

## Debugging

**Local Worker logs.** `console.log`/`console.error` from the Worker appear in
the terminal running `wrangler dev`. All the error paths in this codebase log
with context (the object key, the cause) while returning a response body that
contains none of it.

**Production logs.**

```bash
cd server && npx wrangler tail --env production
```

This needs `"observability": { "enabled": true }` in the config, which is
already set.

**Is it the client or the server?** Take the app out of the loop:

```bash
curl -i -H "Authorization: Bearer tok_dev_local_change_me" http://127.0.0.1:8787/photos
```

If curl works and the app does not, it is configuration or networking (Part 11,
items 4 and 5). If curl fails too, it is the Worker.

**Did the data land?** Part 5's `wrangler d1 execute` and `wrangler r2 object
get` read the local state directly, which settles "did the upload actually
write anything" immediately.

**Are the bytes intact?** This is how the round trip was verified here:

```bash
curl -s -o out.png -H "Authorization: Bearer $T" "$B/photos/$ID/content"
shasum -a 256 assets/images/favicon.png out.png
```

Two identical hashes means the whole path — device → Worker → R2 → Worker →
device — is byte-exact.

---

# Part 9 — Security and production

## Authentication: read this before you deploy anything

**A photo gallery with unauthenticated upload, listing and deletion is not
production-safe.** Not "less secure" — not safe. Anyone who finds the URL can
fill your bucket at your expense, read every photo, and delete all of them. So
every photo operation requires a credential, **including image reads**, and
every query is scoped to the owner.

### A design that was replaced, and why

The first version of this project shipped a pre-shared bearer token:
`API_TOKENS` was a secret mapping an opaque string to a principal id, and the
app received its copy through `EXPO_PUBLIC_PHOTO_VAULT_TOKEN`.

The *shape* was right — one `Principal`, every statement filtered by
`owner_id`. The credential was wrong, for a reason worth internalising:

> Anything prefixed `EXPO_PUBLIC_` is substituted into the JavaScript bundle at
> build time, in plain text. It is shipped to every device, and it is readable
> by anyone who installs the app.

So every install carried the same extractable string; revoking it meant
shipping an app update to everybody; and because one token mapped to one
`owner_id`, every user of a build shared one photo set. That is acceptable for
a single-user vault and nothing else. It is gone.

### What is implemented now

Accounts in D1, passwords hashed in the Worker, and a two-token session.

```
POST /auth/signup      email + password (+ invite code) -> session
POST /auth/signin      email + password                 -> session
POST /auth/refresh     refresh token                    -> new session pair
POST /auth/signout     refresh token                    -> revoked
POST /auth/signout-all access token                     -> all sessions revoked
GET  /auth/me          access token                     -> the caller
```

**Two tokens, because one cannot do both jobs.**

| | Access token | Refresh token |
|---|---|---|
| Form | signed JWT (HS256) | opaque `ses_<id>.<secret>` |
| Lifetime | 15 minutes | 30 days |
| Stored on device | memory only | OS keychain (`expo-secure-store`) |
| Stored on server | nowhere | SHA-256 of the secret, in `sessions` |
| Verification cost | one HMAC, no I/O | one primary-key read |
| Revocable instantly | **no** | yes |

The reason for the split is the gallery. Painting 50 thumbnails is 50 requests
to `/photos/:id/content`. With a database-backed token, that is 50 extra billed
D1 reads just to work out who is asking. A signed token carries the answer, so
authentication costs microseconds and the only read left is the ownership
check.

The price of that is stated plainly, not buried: **revoking a session does not
invalidate an access token that has already been issued.** It keeps working
until it expires. The window is bounded by the 15-minute TTL, the refresh token
*is* revoked immediately so nothing can be renewed, and there is a test in
`server/test/auth.spec.ts` named *"still accepts an access token after its
session was revoked"* that pins this behaviour so nobody mistakes it for a bug.
If 15 minutes is too long for your threat model, the fix is to look the session
up on every request and pay for it — not to make the JWT longer-lived.

### Password hashing, and the CPU limit nobody warns you about

`server/src/password.ts` uses PBKDF2-HMAC-SHA256 at **600,000 iterations** (the
OWASP recommendation), with a random 16-byte salt per password, stored
self-describing:

```
pbkdf2-sha256$600000$<salt_b64url>$<hash_b64url>
```

Because the parameters travel with the hash, the cost factor can be raised
later: old hashes keep verifying at the count they were made with, and
`needsRehash()` upgrades them on the user's next successful sign-in, which is
the only moment the plaintext is available again.

Argon2id would be the better algorithm. It is not available: `workerd` exposes
Web Crypto, whose `deriveBits` supports PBKDF2, HKDF and ECDH — not Argon2 or
bcrypt. Using Argon2 means shipping a WebAssembly build of it, which is a real
option and a real dependency.

> ⚠️ **Password sign-in requires the Workers Paid plan.** The free plan allows
> **10 ms of CPU per request**; the paid plan allows 5 minutes (30 s by
> default). Measured on this machine, a sign-up at 600,000 iterations took
> **~66 ms of wall time end to end** — comfortably inside the paid budget and
> nowhere near fitting the free one. Turning the iteration count down until it
> fits 10 ms is not a workaround, it is just a weaker password hash. If you
> need the free tier, move authentication to a provider that hashes for you and
> have this Worker verify its tokens.
>
> Only the three auth endpoints pay that cost. Everything else verifies a JWT.
> <https://developers.cloudflare.com/workers/platform/limits/#cpu-time>

### Refresh rotation and theft detection

Every call to `/auth/refresh` invalidates the token it was given and issues a
new one. A stolen refresh token is therefore usable at most once before the
real device's next refresh breaks it — and, more usefully, presenting an
already-rotated token becomes a *detectable event*. When that happens the
Worker revokes **every** session for that account and logs it.

This places a requirement on the client, which `src/lib/photo-vault/auth.ts`
meets: **only one refresh may be in flight at a time.** Two concurrent
refreshes would send the same token twice, and the second would be read as a
replay. That is what the shared `refreshInFlight` promise is for — not an
optimisation, a correctness requirement. Three tests cover it.

This is also why revoked session rows are *kept* for 30 days rather than
deleted on sign-out: if the row is gone, a replayed token looks merely unknown
instead of stolen, and the detection never fires.

### Timing and enumeration

A sign-in for an address that has no account still runs a full PBKDF2
derivation, against a decoy hash generated once per isolate. Without that,
"unknown email" returns in under a millisecond while "known email, wrong
password" takes much longer — which turns the endpoint into a reliable
account-enumeration oracle no matter how carefully the response is worded. The
two cases return byte-identical responses, and a test asserts exactly that.

### Who may create an account

`SIGNUP_MODE` is `open`, `invite` or `closed`. **Anything unrecognised — a
typo, or the variable being unset — is treated as `closed`**, because the
failure direction for a misconfigured gate must be "nobody gets in", not "the
internet may store 5 MB images in your bucket".

Local development runs `open`. **Production defaults to `invite`**, which
requires a code from the `SIGNUP_INVITE_CODES` secret; if that secret is unset,
nobody can sign up at all.

### The properties worth stating

- **Auth is required locally too.** There is no unauthenticated dev mode and no
  bypass flag, so the code path you test is the one you deploy.
- **Ownership is enforced on image reads**, not just on the list.
- **Failures are 404, not 403.** A 403 would confirm an id exists and belongs
  to someone else.
- **A missing `AUTH_SECRET` fails closed.** An empty string is a valid HMAC
  key, so this is checked explicitly rather than left to verification to catch.
- **The token's own `alg` header is ignored.** We verify with HS256 because
  that is what we chose. Honouring the header is the classic JWT vulnerability
  (`{"alg":"none"}`); there is a test that sends exactly that.
- **Signatures are compared in constant time, before the payload is parsed.**
  Nothing from an unverified token reaches any other code.
- **Refresh secrets are stored hashed.** A dump of the `sessions` table does
  not let anyone sign in.

### Is *this* production-safe?

For a multi-user photo vault: the authentication design is sound — per-user
accounts, hashed passwords, short-lived tokens, instant session revocation,
rotation with theft detection, rate-limited endpoints, and ownership enforced
on every operation including reads.

What it does **not** have, and what you must decide you can live without:

- **No email verification.** Anyone can sign up as `someone-else@example.com`.
  With `SIGNUP_MODE=invite` that matters less, but it means you cannot treat
  the address as proven, and you cannot send a password reset to it.
- **No password reset.** A forgotten password needs you, with `wrangler d1
  execute`. Adding reset needs an email provider, which is the first genuinely
  new service this architecture would acquire.
- **No second factor.**
- **No account deletion endpoint.** Deleting an account has to delete its R2
  objects too (see the `photos` foreign-key note below), so it is real work
  rather than a `DELETE FROM users`.

Those are product features, not flaws in the security model. Decide about them
deliberately rather than discovering them.

### If you would rather not own any of this

Entirely reasonable. Replace `authenticate()` in `server/src/auth.ts` with
verification of a third-party JWT: Clerk, Auth0, Firebase Auth, Supabase Auth
or `better-auth`. Fetch the provider's JWKS, cache it in
[Workers KV](https://developers.cloudflare.com/kv/) or the Cache API, verify
with `crypto.subtle.verify`, check `iss`/`aud`/`exp`, return `{ id: payload.sub }`.
You then get email verification, password reset and MFA for free, and you delete
`accounts.ts`, `password.ts`, `jwt.ts` and the `users`/`sessions` tables.

Nothing else in the Worker changes — `photos.ts` only ever sees a `Principal`.
That seam is the point.

## The rest of the safeguards

| Safeguard | Where | Note |
|---|---|---|
| Upload size limit | `body.ts`, `MAX_UPLOAD_BYTES` | Enforced twice: from `Content-Length`, then in the read loop |
| JSON body limit | `accounts.ts` | 4 KB, checked before parsing. Three auth routes are unauthenticated |
| MIME allowlist | `validate.ts` | jpeg, png, webp, heic |
| **Content** validated, not the header | `validate.ts` | Magic bytes. The client's `Content-Type` is ignored |
| Unguessable object keys | `ids.ts` | `crypto.randomUUID()`, never the filename |
| Safe metadata | `validate.ts` | Directory components stripped, length clamped, control characters removed |
| SQL injection prevention | everywhere | `.bind()` only. No string interpolation into SQL, anywhere |
| Password hashing | `password.ts` | PBKDF2-SHA256, 600k iterations, per-password salt, upgradeable |
| Constant-time comparison | `encoding.ts` | Tokens, invite codes, refresh secrets, JWT signatures |
| Error responses leak nothing | `index.ts` | One top-level catch turns any throw into a 500 with no stack, SQL or object key. A test asserts this |
| Logs leak nothing either | everywhere | No password, token or secret is ever logged. Rate-limiter errors log the *kind* of key (`signin`, `upload`) rather than the key, which contains an email or an IP |
| Private R2 bucket | by omission | No public access is ever enabled. Reads go through the Worker |
| No credentials in the app bundle | by design | Bindings, not tokens. Nothing secret in any `EXPO_PUBLIC_` var |
| Refresh token at rest | `token-store.ts` | iOS Keychain / Android Keystore, never `AsyncStorage` or a public var |
| No secrets in git | `.gitignore` | `.dev.vars`, `.env*.local`, `.wrangler/` |
| Cache headers | `photos.ts`, `http.ts` | `private, immutable` on bytes; `no-store` on all JSON, which includes the token responses |
| Security headers | `http.ts` | On **every** response — see below |
| CORS off by default | `cors.ts` | Explicit allowlist. Never `*` on a credentialed API |
| Rate limiting | `ratelimit.ts` | Three limiters — see below |
| Storage reconciliation | `reconcile.ts` | A nightly Cron Trigger — see below |

### Security headers, and the one that genuinely matters

Every response carries:

```
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: DENY
cross-origin-resource-policy: same-origin
content-security-policy: default-src 'none'; frame-ancestors 'none'; sandbox
```

`nosniff` is the load-bearing one, and it is load-bearing *because this service
serves bytes that a user uploaded*. Without it a browser may ignore the
`Content-Type` we send and guess from the content instead — so a file that
passes the JPEG magic-byte check but also contains HTML could be rendered as a
document in the viewer's session rather than displayed as a picture. `nosniff`
tells the browser to believe the declared type or render nothing.

The CSP is the most restrictive policy that exists, which is also the correct
one here: this API serves JSON and images and has no HTML or scripts of its
own.

### HEIC, and why it is allowed

iPhones produce HEIC. Rejecting it would break uploads on real devices, so the
sniffer accepts it (via the `ftyp` brand). Be aware that Android cannot always
display HEIC — if that matters, convert on the device before uploading, or add a
thumbnail pipeline (Part 12).

### Rate limiting

Three [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
declared in `wrangler.jsonc` and applied in `index.ts`:

| Limiter | Budget | Applies to | Key |
|---|---|---|---|
| `AUTH_LIMITER` | 10 / 60 s | `/auth/signup`, `/auth/signin` | `auth-ip:<ip>` **and** `signin:<email>` |
| `UPLOAD_LIMITER` | 30 / 60 s | `POST /photos`, `DELETE /photos/:id` | `upload:<user>` / `delete:<user>` |
| `READ_LIMITER` | 600 / 60 s | everything else | `read:<user>`, or `session-ip:<ip>` on refresh/sign-out |

Three things about the keys, each a decision rather than a default.

**Sign-in is keyed on the email being attempted**, not just the IP. Cloudflare's
guidance is to key on an actor rather than an address, because many real users
share one — and the authenticated limiters do exactly that. Sign-in has no user
yet, so it uses the next best thing: a botnet defeats a per-IP limit trivially,
but every one of its requests still targets the same account, and they all land
in that account's bucket. The per-IP limit is a knowingly blunt backstop on top.

**It also counts attempts for addresses that do not exist.** Limiting only real
accounts would make the 429 itself an enumeration signal.

**Refresh and sign-out are deliberately not on the auth budget.** They are
cheap — one indexed read and one update, no password hashing — and they are
things a legitimate signed-in user does routinely. Ten per minute per IP is
fine for one person and wrong behind a corporate NAT or a carrier gateway,
where dozens of real users share an address and every device renews its token
every quarter of an hour. They sit on the generous read budget instead, which
still bounds a runaway client without throttling a building full of people.

Note that the sign-in limiter counts attempts for addresses that *do not*
exist, too. Limiting only real accounts would make the 429 itself an
enumeration signal.

> **What this is not.** Limits are **approximate** and **per Cloudflare
> location**: "10 per minute" means roughly ten per minute in Frankfurt and
> another roughly ten in Singapore, and a burst can exceed either before the
> background counters catch up. It is a blunt instrument against brute force
> and runaway clients, not a quota, not a billing control, and not a defence
> against an attacker who can choose which location serves them. For one strict
> global number you need a Durable Object per key.
>
> When the binding is missing, `applyLimit` **allows** the request and logs an
> error. Fail-open is usually wrong, and is right here: a rate limiter is
> availability protection, not an authorization check, and turning "the limiter
> is misconfigured" into "the API is down" is the worse outcome. Authorization
> fails closed everywhere.

Measured locally: a burst of wrong-password sign-ins was refused at the 8th
attempt with `Retry-After: 60` — close to the configured 10, and approximate,
exactly as documented.

### Reconciling R2 and D1

Part 7 explains why the two stores can diverge and cannot be made atomic.
Documenting that is necessary but not sufficient; a production system has to
actually converge. `server/src/reconcile.ts` runs nightly from a Cron Trigger
(`"17 3 * * *"` — an odd minute, because everyone's `0 3 * * *` fires at the
same instant) and does three things:

1. **Purges dead sessions.** Expired ones immediately; revoked ones after 30
   days, for the replay-detection reason above.
2. **Deletes orphaned R2 objects** — bytes with no row.
3. **Reports dangling rows** — a row whose bytes are gone.

Two details are where the correctness lives.

**The grace period.** An upload that is *in progress right now* looks exactly
like an orphan: the object exists and the row does not yet. Deleting on that
basis would destroy live uploads under load — rare, data-losing, and
reproducible only in production. So nothing younger than **one hour** is
touched, using the `uploaded` timestamp R2 records on every object. There is a
test named *"leaves a recent orphan alone, because it may be an upload in
flight"*, and it is the most important one in that file.

**The completeness check.** Dangling-row detection is skipped entirely unless
*both* sides were enumerated completely. The test is "this row's key was not
among the objects I listed" — which, if the listing stopped early at its cap or
failed, is true of every row past that point. Acting on a partial listing would
delete healthy photos.

Deleting a dangling row is destructive and irreversible — the row is the last
remaining record that the photo existed — so it is gated behind
`RECONCILE_DELETE_DANGLING_ROWS`, which defaults to `"false"`. The job reports
what it found and leaves the decision to you.

Every run logs one structured line, and it reports what it *skipped* as loudly
as what it did: a job that silently hit its cap every night forever would
otherwise look identical to a healthy one.

```
Reconciliation complete {
  objectsScanned: 0, rowsScanned: 0, completeScan: true,
  orphanObjectsFound: 0, orphanObjectsDeleted: 0,
  danglingRowsFound: 0, danglingRowsDeleted: 0,
  expiredSessionsPurged: 0, errors: []
}
```

Trigger it locally without waiting for 03:17:

```bash
curl -X POST http://127.0.0.1:8787/cdn-cgi/handler/scheduled
```

### Why `photos` has no foreign key to `users`

`sessions` has `REFERENCES users(id) ON DELETE CASCADE`, because deleting a
user's sessions has no effects outside D1. `photos` deliberately does not.

A cascade there would drop the photo rows while leaving their bytes in R2
forever, with nothing left pointing at them — the database would look clean and
the bill would not. Deleting an account has to be code that deletes R2 objects
too, which is why `newObjectKey()` puts the owner first: `list({ prefix:
"photos/<user>/" })` enumerates exactly one account's objects.

## Costs — plan for them

Current published rates (verify before relying on them; R2 pricing last updated
2026-10-30, D1 2026-10-30):

**R2** — <https://developers.cloudflare.com/r2/pricing/>

| | Free / month | Paid |
|---|---|---|
| Storage | 10 GB-month | $0.015 / GB-month |
| Class A ops (writes, lists) | 1 million | $4.50 / million |
| Class B ops (reads) | 10 million | $0.36 / million |
| Egress | Free | Free |

`DeleteObject` is free. Egress being free is R2's main selling point against S3.

**D1** — <https://developers.cloudflare.com/d1/platform/pricing/>

| | Workers Free | Workers Paid |
|---|---|---|
| Rows read | 5 million / day | 25 billion / month, then $0.001 / million |
| Rows written | 100,000 / day | 50 million / month, then $1.00 / million |
| Storage | 5 GB total | 5 GB, then $0.75 / GB-month |
| Databases | 10 | 100,000, then $0.10 each / month |

Three things that will surprise you:

- **Usage is rounded up per billing unit.** 1,000,001 operations bills as two
  million.
- **Rows read means rows *scanned*.** `SELECT … WHERE owner_id = ?` without an
  index on `owner_id` scans the whole table and bills for all of it, even
  returning one row. This is why `idx_photos_owner_created` exists.
- **Each D1 database past the included count costs $0.10/month even if it is
  empty.** Do not create a database per customer casually.
- Also: an *index* adds a written row when the indexed column is written. Worth
  it here; not worth it for every column.

Nothing is free indefinitely. A gallery of 10,000 photos averaging 2 MB is
20 GB — past R2's free tier, around $0.30/month. That is cheap, not free, and
it grows.

## Deploying

> ⛔ **Every command in this section touches your real Cloudflare account and
> can incur charges.** None of them have been run for you. Read each one before
> you run it.

Steps marked **account** need a real Cloudflare account.

### 1. Log in — *account*

```bash
cd server
npx wrangler login          # opens a browser for OAuth
npx wrangler whoami         # confirm which account you are in
```

Run `whoami` every time before a deploy if you have more than one account. In
CI, use a `CLOUDFLARE_API_TOKEN` environment variable instead of `login`.

### 2. Create the production bucket — *account*

```bash
npx wrangler r2 bucket create photo-vault-prod
```

Do **not** enable public access or attach a custom domain. The bucket stays
private; the Worker is the only way in.

### 3. Create the production database — *account*

```bash
npx wrangler d1 create photo-vault-prod
```

This prints a `database_id` UUID.

### 4. Wire up the bindings

Put that UUID into `server/wrangler.jsonc`, replacing
`REPLACE_WITH_PRODUCTION_DATABASE_ID` under `env.production`. Then:

```bash
npx wrangler types          # regenerate, since the config changed
```

### 5. Set the production secrets — *account*

Two secrets. Both are write-only: you can replace one but never read it back.

```bash
# The HMAC key that signs access tokens. Anyone holding this can mint a token
# for any user, so it is the most sensitive value in the system.
openssl rand -base64 48
npx wrangler secret put AUTH_SECRET --env production      # paste the output

# Invite codes, because production runs SIGNUP_MODE=invite. Comma-separated.
npx wrangler secret put SIGNUP_INVITE_CODES --env production
```

Use a **different** `AUTH_SECRET` from your local one. Replacing it later
invalidates every access token immediately and every refresh token at its next
use — which is exactly what you want if it ever leaks.

If you leave `SIGNUP_INVITE_CODES` unset while `SIGNUP_MODE` is `invite`, *no
one can create an account*, including you. That is the intended failure
direction; set it before you try to sign up.

`vars` (in `wrangler.jsonc`) and secrets (via this command) are not
interchangeable: vars are visible in the dashboard, secrets are not. Anything
that grants access is a secret.

### 6. Apply production migrations — *account* ⚠️

```bash
npx wrangler d1 migrations list photo-vault-prod --remote --env production   # look FIRST
npx wrangler d1 migrations apply photo-vault-prod --remote --env production
```

Always run `list` first and read what it intends to do. There are two
migrations: `0001_create_photos.sql` and `0002_create_users_and_sessions.sql`.

Migrations are not automatically reversible — write a new forward migration
rather than editing an applied one, because Wrangler tracks applied migrations
by name and an edited file will not re-run.

### 7. Check what you are about to ship — *no account needed*

```bash
npx wrangler deploy --env production --dry-run --outdir /tmp/dryrun
```

This builds and prints the resolved bindings without uploading anything. Read
the list: it is the cheapest possible way to catch a Worker that is about to go
live pointing at `photo-vault-dev`.

```
env.DB (photo-vault-prod)                     D1 Database
env.PHOTOS (photo-vault-prod)                 R2 Bucket
env.AUTH_LIMITER (10 requests/60s)            Rate Limit
env.UPLOAD_LIMITER (30 requests/60s)          Rate Limit
env.READ_LIMITER (600 requests/60s)           Rate Limit
env.SIGNUP_MODE ("invite")                    Environment Variable
...
```

### 8. Deploy — *account*

```bash
npx wrangler deploy --env production
```

Prints a URL like `https://photo-vault-api.<your-subdomain>.workers.dev`.

The Cron Trigger (`17 3 * * *`) is registered by this command. Changes to a
schedule can take up to 15 minutes to propagate.

> ⚠️ **The Workers Paid plan is required**, because of password hashing — see
> the CPU-time box earlier in this part. On the free plan the auth endpoints
> will fail with `Error 1102: Worker exceeded resource limits`.

### 8b. Point the app at it

In `.env.local`:

```ini
EXPO_PUBLIC_PHOTO_VAULT_API_URL=https://photo-vault-api.<your-subdomain>.workers.dev
```

That is the whole file. There is deliberately no credential here any more — the
app obtains one by signing in, and keeps it in the device keychain.

Restart Metro. `EXPO_PUBLIC_` values are inlined at bundle time, so a running
bundle will not pick up a change — and for a release build they are baked into
the binary, so the values present at build time are the ones your users get.

You also need to set `ALLOWED_ORIGINS` in `wrangler.jsonc` if you serve the web
build, since it defaults to empty in production. Native apps do not need it.

### 9. Test the deployment

```bash
API=https://photo-vault-api.<you>.workers.dev

curl -i  $API/health                      # expect 200
curl -i  $API/photos                      # expect 401  <- the important one
curl -i -X POST $API/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase"}'
                                          # expect 403 invalid_invite (no code)

curl -s -X POST $API/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase",
       "inviteCode":"<one of your codes>"}'
                                          # expect 201 + tokens
```

The 401 and the 403 matter as much as the 201. They are how you confirm you did
not deploy an open API, and that the invite gate is actually on.

Then, with the `accessToken` from that response:

```bash
curl -i -H "Authorization: Bearer $AT" $API/auth/me       # expect 200, your account
curl -i -H "Authorization: Bearer $AT" $API/photos        # expect 200, empty list
```

### 10. Logs and diagnosis — *account*

```bash
npx wrangler tail --env production
```

Also: the dashboard's Workers → your Worker → Logs, and D1 → your database →
Metrics → Row Metrics for whether your queries are scanning more than they
should.

### 11. Not destroying production data

- `env.production` is a separate environment with separately named resources, so
  a bare `wrangler d1 execute photo-vault-dev` cannot reach it.
- `--remote` only ever appears in the two commands above. Never alias it, never
  put it in a script that runs on save.
- Never run `wrangler dev --remote`.
- `wrangler secret put` **overwrites**. Changing `AUTH_SECRET` instantly
  invalidates every token not in the new value.
- There is no "are you sure" on `d1 execute --remote`. A `DELETE` without a
  `WHERE` is immediate and total.

### 12. Backup and recovery

**D1** has [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/):
point-in-time restore within the retention window, with no setup.

```bash
npx wrangler d1 time-travel info photo-vault-prod --env production
npx wrangler d1 time-travel restore photo-vault-prod --timestamp <ISO> --env production
```

For an off-platform copy:

```bash
npx wrangler d1 export photo-vault-prod --remote --output ./backup.sql --env production
```

**R2** has no time travel. Your options are
[object versioning](https://developers.cloudflare.com/r2/buckets/object-versioning/),
turned on per bucket, and a scheduled copy to another bucket or provider.

An important asymmetry: **restoring D1 to an earlier point does not restore
R2.** A restore that brings back rows deleted an hour ago will reference objects
that were deleted along with them — dangling rows, the visible kind of
inconsistency. If you restore D1, reconcile against R2 afterwards.

---

# Part 10 — Cloudflare documentation navigation

The docs are not disorganised; they are organised around an assumption nobody
tells you. Once you know it, the structure is obvious.

## The assumption

**Every Cloudflare product's documentation is a separate book.** R2, D1,
Workers, KV, Queues each have their own getting-started, their own reference,
their own pricing, their own limits. There is no single "Cloudflare manual" with
chapters.

That is why searching "cloudflare upload image" is frustrating — it returns
pages from four different books, each assuming you already read its own earlier
chapters. The fix is to decide *which product's book* you are in before you read
anything.

Every product's book has the same five sections:

| Section | What it is | When you want it |
|---|---|---|
| **Overview** | What the product is, what it is not | Deciding whether you need it |
| **Get started** | A tutorial that ends in something that works | First contact |
| **Reference / API** | Every method, every type | While writing code |
| **Platform** (limits, pricing) | The numbers | Before designing, and before deploying |
| **Examples / Tutorials** | Task-shaped recipes | "How do I do X specifically" |

## 1. Where to begin with a new product

**Overview, then Get started, then the limits page — in that order, and do not
skip the third.**

The overview tells you what the product refuses to do, which is the information
that prevents a wasted week. The limits page tells you whether your use case
fits at all. For this project, reading
<https://developers.cloudflare.com/r2/platform/limits/> early is what tells you
not to route 500 MB videos through a Worker.

Then open the product's `llms.txt` — every Cloudflare product has one, and it is
a complete index of that book's pages:

```text
https://developers.cloudflare.com/r2/llms.txt
https://developers.cloudflare.com/d1/llms.txt
https://developers.cloudflare.com/workers/llms.txt
```

This is the single most useful navigation trick in these docs. It is a flat list
of every page with a description — far faster than clicking through the sidebar,
and it shows you sections you would not have known to look for.

## 2. Getting started vs API reference

| | Getting started | API reference |
|---|---|---|
| Shape | Numbered steps, one narrative | Flat list of methods and types |
| Goal | Something running | Exact signatures |
| Code | A complete example | Fragments |
| Tells you | The happy path | Every option and error |
| Read it | Once per product | Every time you write code |

The trap is stopping after Get started. Compare:

- *Get started* (R2 Workers API) shows `await env.MY_BUCKET.put(key, request.body)`.
- *API reference* adds the thing that would have bitten you: if the value is a
  `ReadableStream`, "its length must be known… Otherwise `put()` throws
  `TypeError`". A request body sent without `Content-Length` — which React
  Native sometimes does — is exactly that case.

That one sentence is why `server/src/body.ts` buffers instead of piping. It is
in the reference, not the tutorial.

## 3. Workers API vs S3 API

R2 has two completely separate interfaces, and nearly all search-engine results
are about the second one:

| | **Workers API** (bindings) | **S3-compatible API** |
|---|---|---|
| Called from | Inside a Worker | Anywhere |
| Auth | A binding. No credential | Access key + secret, SigV4-signed |
| Shape | `env.BUCKET.put(key, value)` | HTTP + the AWS SDK |
| Docs | `/r2/api/workers/` | `/r2/api/s3/` |
| Needed for | Everything in this project | Presigned URLs, non-Worker clients, S3 tool compatibility |

**How to tell which page you are on:** look at the URL path. `/r2/api/workers/`
versus `/r2/api/s3/`. Also look at the code — `env.SOMETHING` means bindings;
`new S3Client({...})` or an `accessKeyId` means the S3 API.

**Choosing:** in a Worker, use bindings. Use the S3 API only when you need
something bindings cannot express. In this project that is exactly one thing —
presigned URLs (Part 12) — and we do not need it yet.

The reference page says this itself, in its second paragraph: "The R2 API
includes some extensions and semantic differences from the S3 API. If you need
S3 compatibility, consider using the S3-compatible API."

## 4. Binding vs API token

Covered in detail in Part 2. The short version: a binding is a capability
granted by configuration and has no secret; an API token is a secret string that
works from anywhere. Tokens can leak. Bindings cannot, because there is nothing
to leak.

Rule of thumb: **if your code runs in a Worker and you are typing a credential,
stop and look for the binding.**

## 5. Finding the exact method for an operation

Go to the product's API reference and read the method list top to bottom. It is
short. For R2 that is *seven* methods on the bucket: `head`, `get`, `put`,
`delete`, `list`, `createMultipartUpload`, `resumeMultipartUpload`. Reading all
seven takes two minutes and means you will never again wonder whether R2 can do
something.

Then use the page's own anchors — `#r2putoptions`, `#r2getoptions` — rather than
searching, because option types are documented on the same page as the method.

Worked example: "how do I set the content type?" There is no `setContentType`.
`put()` takes `options?: R2PutOptions`, `R2PutOptions` has
`httpMetadata?: R2HTTPMetadata`, and `R2HTTPMetadata` has `contentType`. Three
hops on one page. The lesson: **in the Workers APIs, behaviour lives in options
objects, not in extra methods.**

## 6. Spotting an outdated example

In order of reliability:

1. **The "Last updated" date** at the top of every Cloudflare page. The R2
   Workers API reference used for this project says *Nov 4, 2026*.
2. **`wrangler.toml` instead of `wrangler.jsonc`.** Both still work, but current
   docs show JSONC tabs first. TOML-only is a sign of age.
3. **`kv:key` instead of `kv key`** (colons became spaces in Wrangler 3.60).
4. **A `compatibility_date` far in the past** in an example config.
5. **Blog posts and Stack Overflow answers with no date.** Treat as a hint about
   what to search for in the real docs, never as the answer.
6. **The package's own types.** This is the ground truth, and it beats the docs.

That last one is not hypothetical. Both of these happened while building this
project:

- The Vitest integration docs say `readD1Migrations` is imported from
  `@cloudflare/vitest-plugin/config`. In version 1.6.0 there is **no such
  subpath** — `package.json`'s `exports` has only `.` and `./types`, and the
  function is exported from the main entry. Reading `exports` settled it in
  seconds.
- Older guides tell you to install `@cloudflare/workers-types`. `wrangler types`
  now generates the runtime types itself, so the package was redundant and was
  removed from this project.

**So: when the docs and the installed package disagree, the package wins.** Read
`node_modules/<pkg>/package.json` for `exports`, and the `.d.ts` files for
signatures. For this project's dependencies that is how `NativeTabsTriggerIconProps`
(`sf` + `md` icons) and `expo-file-system`'s `File.size` / `File.bytes()` were
confirmed before a line was written.

## 7. Using the Wrangler documentation

Wrangler's docs split into two pages you will return to constantly:

- **Commands** — <https://developers.cloudflare.com/workers/wrangler/commands/>
  Every subcommand and flag. Note that resource subcommands (`d1`, `r2`, `kv`)
  are *also* documented inside their own product's book, sometimes in more
  detail.
- **Configuration** — <https://developers.cloudflare.com/workers/wrangler/configuration/>
  Every key in `wrangler.jsonc`. This is the page to search when you want to
  know "can I configure X", because the answer is usually a key you have never
  heard of.

Two flags are worth memorising because they govern safety:
**`--local` / `--remote`** (which data) and **`--env`** (which environment).

## 8. Pricing, quotas and limits

Three separate pages per product, and they answer different questions:

| Page | Question |
|---|---|
| `/<product>/pricing/` | What will this cost? |
| `/<product>/platform/limits/` | Is my use case even possible? |
| `/workers/platform/pricing/` | Which plan am I on? |

Read **limits before designing** and **pricing before deploying**. Limits change
the architecture; pricing changes the business case. The order matters: no amount
of cost optimisation saves a design that exceeds a hard limit.

## 9. Choosing between Workers, D1, R2, KV and the rest

Match the product to the *access pattern*, not to the data:

| Need | Product | Why |
|---|---|---|
| Run code on a request | **Workers** | The compute layer. Everything else is storage |
| Large binary blobs by key | **R2** | Cheap, unbounded, free egress. No queries |
| Relational queries, joins, ordering | **D1** | SQLite. Indexes. Transactions within D1 |
| Tiny values, read constantly, rarely written | **KV** | Eventually consistent, extremely fast reads. Config, feature flags, cached JWKS |
| Per-object coordination, real-time state | **Durable Objects** | Single-threaded per id. Strong consistency. Chat rooms, collaborative docs |
| Background / retried work | **Queues** | Decoupling. Retries. Dead-letter queues |
| Vector search | **Vectorize** | Embeddings |

For Photo Vault: Workers (compute) + R2 (bytes) + D1 (queries). **KV would be
wrong** for photo metadata — it is eventually consistent, so an upload might not
appear in the gallery immediately, and it cannot sort by date or filter by owner.
**Durable Objects would be wrong** — there is no per-object coordination problem
here. The temptation to use more products is the thing to resist; each one is
another thing to understand, configure, back up and pay for.

## 10. Reading an unfamiliar method's input/output types

Four steps, no guessing:

1. **Find the signature** in the API reference. Cloudflare writes them as
   `name (args): ReturnType`.
2. **Follow each named option type to its own section on the same page.**
   `R2PutOptions`, `R2GetOptions`, `R2ListOptions` all live on the method's page.
3. **Read what the return type can be, including the falsy cases.** This is
   where the bugs are. `get()` returns `R2ObjectBody | R2Object | null` — `null`
   for a missing key, and a body-less `R2Object` when a precondition failed.
   `put()` returns `R2Object | null`, where `null` means a precondition failed
   and **nothing was stored**. Code that ignores those nulls is code that
   pretends a failed write succeeded.
4. **Confirm against the `.d.ts`.** `server/worker-configuration.d.ts` contains
   the real `R2Bucket` and `D1Database` declarations — generated for *your*
   compatibility date, which the website's prose is not.

Worked example — "how do I get the image bytes out of R2?"

```text
Reference: get (key, options?): Promise<R2ObjectBody | R2Object | null>
  → null?        key does not exist → 404
  → R2Object?    a precondition failed; `body` is undefined
  → R2ObjectBody has: body (ReadableStream), arrayBuffer(), text(), json(), blob()
       and inherits from R2Object: httpMetadata, httpEtag, size, uploaded, writeHttpMetadata()
Decision: return `object.body` (a stream) straight into `new Response(...)`,
          so the Worker never holds the whole image in memory,
          and use `writeHttpMetadata(headers)` to restore the content type.
```

## The research process, start to finish

The real worked example from this project — *"I want to upload an image from
Expo. Where do I even look?"*

| Step | | |
|---|---|---|
| **Problem** | Get image bytes from a phone into durable storage, and list them later | |
| **Split it** | Bytes ≠ queries. Two different storage problems | This is the key insight. Most people miss it and try to make one product do both |
| **Product** | Bytes → R2. Queries → D1. Somewhere to decide access → Workers | |
| **Docs section** | `/r2/api/workers/workers-api-reference/` (not `/r2/api/s3/`, because we are in a Worker) and `/d1/worker-api/` | |
| **API choice** | `put(key, value, options)` with `httpMetadata.contentType`; `prepare().bind().run()` for D1 | |
| **Read the fine print** | "If `value` is a `ReadableStream`, its length must be known" → cannot pipe an unknown-length body | Changed the design |
| **Check the limits** | Worker request size and CPU limits → fine for 5 MB, wrong for 500 MB | Set the limit, and documented when to switch to presigned |
| **Architecture** | Phone POSTs raw bytes → Worker validates and buffers (bounded) → R2 put → D1 insert → rollback on failure | |
| **Implementation** | `server/src/photos.ts`, `body.ts`, `validate.ts` | |
| **Verification** | Tests against real local R2 + D1, plus curl against `wrangler dev`, plus a SHA-256 comparison of the round trip | Not "it compiled" |

The transferable part is step two. *"Where do the bytes go and where do the
queries go"* is the question that turns a vague "how do I upload images" into
two problems that each have one obvious product.

---

# Part 11 — Common mistakes

Each one: what you see, why, and the fix.

### 1. Missing R2 binding

```text
TypeError: Cannot read properties of undefined (reading 'put')
```

`env.PHOTOS` is `undefined`. Either `r2_buckets` is absent from
`server/wrangler.jsonc`, or the `binding` value does not match the property name
in your code (it is case-sensitive), or you added it to the top level but are
running `--env production`, which **inherits nothing**.

**Fix:** check the binding table `wrangler dev` prints at startup. If
`env.PHOTOS` is not in that list, the config is wrong, not the code. Then
`npx wrangler types` to regenerate.

### 2. Incorrect bucket name

Locally: it silently *works*. Miniflare creates whatever bucket name you ask
for, so a typo gives you a new, empty bucket and your photos appear to have
vanished.

Remotely:

```text
✘ [ERROR] The specified bucket does not exist.
```

**Fix:** `npx wrangler r2 bucket list`. Remember `binding` is the variable name
and `bucket_name` is the resource — mixing them up is the usual cause.

### 3. D1 migrations not applied

```text
D1_ERROR: no such table: photos
```

**Fix:**

```bash
cd server
npx wrangler d1 migrations list photo-vault-dev --local
npx wrangler d1 migrations apply photo-vault-dev --local
```

This is also what you see after `rm -rf server/.wrangler/state` — the
`d1_migrations` bookkeeping table went with it, so everything needs re-applying.
And note that applying locally does **nothing** for production: separate
databases, separate bookkeeping.

### 4. Expo cannot connect to localhost

```text
TypeError: Network request failed
```

React Native collapses *every* transport failure into this one message: wrong
host, no route, server not running, TLS problem. It tells you nothing. (This is
why `src/lib/photo-vault/client.ts` rewrites it to include the URL it tried.)

Work through these in order:

1. **Is the Worker running?** `curl http://127.0.0.1:8787/health` on your Mac.
2. **Is it listening beyond loopback?** `wrangler dev` binds 127.0.0.1 by
   default, which a phone cannot reach. Use `npm run dev:lan` in `server/`.
3. **Is the app using the right host?** On a physical device or an Android
   emulator, `localhost` is the *device*. See the table in Part 6. This project
   derives the host from `Constants.expoConfig.hostUri` automatically — if that
   is somehow empty, set `EXPO_PUBLIC_PHOTO_VAULT_API_URL` explicitly.
4. **Same network?** Same Wi-Fi, no client isolation, firewall allows inbound
   8787. Guest and corporate networks frequently block this; use a tunnel.
5. **On Android, is it plain `http`?** Android blocks cleartext HTTP by default
   in release builds. Development builds allow it; release builds need HTTPS.

### 5. Missing environment configuration

```text
PhotoVaultError: Set EXPO_PUBLIC_PHOTO_VAULT_API_URL in .env.local (see .env.example).
```

In local development you should never see this — the base URL is derived from
the Metro host. Seeing it means the derivation failed, which happens when
`Constants.expoConfig?.hostUri` is undefined (web, and release builds).

**Fix:** `cp .env.example .env.local`, set the URL, then **restart Metro**.
These values are inlined at bundle time; a running bundle will not pick up a
new `.env.local`.

Two subtler versions of this:

- You wrote `process.env['EXPO_PUBLIC_PHOTO_VAULT_API_URL']`. Only literal dot
  access is substituted. You get `undefined` with no warning.
- You named it `PHOTO_VAULT_API_URL` without the prefix. Only `EXPO_PUBLIC_`
  variables reach app code.

### 6. R2 object exists but the D1 record is missing

**Symptom:** nothing. That is the point — an orphan object is invisible to the
user. You notice it as storage you cannot account for.

**Cause:** the D1 insert failed after the R2 put and the rollback also failed, or
the Worker was evicted between the two writes.

**Find them:**

```bash
cd server
npx wrangler r2 object list photo-vault-prod --remote --env production
npx wrangler d1 execute photo-vault-prod --remote --env production \
  --command "SELECT object_key FROM photos"
```

Keys in the first list and not the second are orphans.

**The reverse is the one that hurts:** a D1 row with no R2 object shows the user
a photo that never loads. `readPhotoContent` detects it, logs it loudly, and
returns 404 rather than serving an empty image. See Part 7 for why the write
ordering makes this the rarer of the two.

**Fix long-term:** this is implemented. The nightly Cron Trigger in
`server/src/reconcile.ts` deletes orphans older than an hour and reports
dangling rows. See Part 9.

### 7. Wrong image Content-Type

**Symptom:** the image downloads but will not render, or it downloads as a file
instead of displaying.

**Cause:** the object was stored without `httpMetadata.contentType`, so it comes
back as `application/octet-stream`.

This project avoids it twice over: the type is sniffed from the file's magic
bytes at upload and stored in R2's metadata; on read, `writeHttpMetadata()`
restores it, with the D1 `content_type` column as a fallback if the object
metadata is ever missing.

**The related mistake** is *trusting* the client's header. A client can send
`Content-Type: image/png` with a PHP script in the body. If you store and echo
that claim, you have built a file host for arbitrary content. `sniffImageType()`
ignores the header entirely — and a test uploads a JPEG labelled `image/png` to
prove the stored type is `image/jpeg`.

### 8. Unauthorized requests

```json
{"error":{"code":"unauthorized","message":"Missing or invalid access token."}}
```

The message is deliberately identical for a missing, expired and forged token —
telling an attacker *which* part of their token was wrong helps only them. So
work through the causes in the order they actually happen:

- No `Authorization` header at all.
- The header lacks the scheme. It must be `Bearer <token>`, not the bare token.
- You sent the **refresh** token where the access token belongs. The refresh
  token looks like `ses_<hex>.<secret>` and is only ever sent to
  `/auth/refresh`; the access token is a JWT with two dots in it.
- The access token has expired. They last 15 minutes. The app renews
  automatically; `curl` does not.
- `AUTH_SECRET` differs between where the token was minted and where it is
  being verified — you signed in against local and are calling production, or
  you rotated the secret. The Worker logs nothing distinguishable here by
  design; check which `API` you are pointing at.
- `AUTH_SECRET` is not set at all. The Worker then rejects *everything*, on
  purpose, and logs `AUTH_SECRET is not set; refusing all authenticated
  requests.`

And a 404 that should be a 200 usually means a valid token for the **wrong
account**: the row exists but `owner_id` does not match, so it is correctly
hidden from you.

### 8b. Signed out of everything, unexpectedly

```json
{"error":{"code":"unauthorized","message":"This session has been revoked. Sign in again."}}
```

Something presented a refresh token that had already been rotated away, and the
Worker treated it as theft and revoked every session for the account (Part 9).

If it was not actually theft, it is almost always **two refreshes in flight at
once** — a second client, a replayed `curl` command, or a custom client that
does not serialise its refreshes. `src/lib/photo-vault/auth.ts` keeps exactly
one refresh in flight for this reason; anything else talking to the API has to
do the same.

### 9. Confusing local and remote resources

The expensive mistake. Three forms:

- **`--remote` where you meant `--local`.** You just mutated production. There is
  no confirmation prompt and no undo for R2.
- **`wrangler dev --remote`.** Your local, half-written code is now operating on
  real data.
- **Forgetting `--persist-to`** on a secondary command when `wrangler dev` uses
  it. The command reads the default `.wrangler/state` instead, and you conclude
  the data is missing when it is just elsewhere.

**Fix:** the five habits at the end of Part 5. Most of all: resources named
differently per environment, so the wrong command fails instead of succeeding
somewhere you did not mean.

### 10. Incompatible package versions

```text
npm error ERESOLVE could not resolve
# or at runtime:
Invariant Violation: requireNativeComponent: "ExpoImagePicker" was not found
```

For Expo packages, **always**:

```bash
npx expo install expo-whatever    # resolves the version matching your SDK
npx expo install --fix            # repair existing mismatches
npx expo-doctor                   # 20 checks, including version compatibility
```

`npm install expo-image-picker` gets you the newest release, which is often for
a newer SDK. `npx expo install` gets you the one that matches SDK 58 — here,
`~58.0.10`.

The `requireNativeComponent … not found` error specifically means **you added a
native module and are still running Expo Go or a stale dev build.** Rebuild:
`npx expo run:ios`.

On the Worker side the equivalent is `compatibility_date`. If a runtime API
behaves unexpectedly, check it before suspecting your code.

### 11. Two tab bars (a repository-specific trap)

A new screen appears on iOS but not on the web, or vice versa. This template has
`src/components/app-tabs.tsx` (native) **and**
`src/components/app-tabs.web.tsx` (web). A new tab must be registered in both.

### 12. `setState` in an effect

```text
error  Calling setState synchronously within an effect can trigger cascading renders
       react-hooks/set-state-in-effect
```

`eslint-config-expo` ships this rule and it flags **any** `setState` reachable
from an effect, including ones that run after an `await`. Fetch-on-mount is the
case it cannot express.

In `src/hooks/use-photo-vault.ts` the fetch function touches no state before its
first `await` — so the only remaining violation is the call itself, and it
carries a one-line, scoped `eslint-disable-next-line` with the reason. Scoping it
to one line keeps the rule protecting the rest of the file. The alternative is a
Suspense-based data library, which is a much bigger dependency than one screen
justifies.

---

# Part 12 — Future improvements

## Presigned URLs — the next architecture

Right now every byte passes **through** the Worker. The alternative is to let
the phone talk to R2 directly, with the Worker handing out time-limited
permission instead of relaying data.

```text
Expo
  │ 1. POST /photos/upload-intent   { filename, size, contentType }
  ▼
Worker  ── validates, generates an object key, records a PENDING row in D1,
  │        signs a URL that permits exactly one PUT to exactly that key
  │ 2. { uploadUrl, photoId }
  ▼
Expo
  │ 3. PUT <uploadUrl>  (bytes go straight to R2 — the Worker sees none of them)
  ▼
Cloudflare R2
  │
  ▼
Expo
  │ 4. POST /photos/:id/complete
  ▼
Worker  ── HEADs the object, checks it exists / size / type, flips the row to READY
  │
  ▼
D1
```

### What a presigned URL is

A normal R2 URL with a cryptographic signature in its query string, covering the
HTTP method, the exact object key, an expiry timestamp, and the other signed
parameters. R2 verifies the signature on arrival.

**What makes it secure:** the signature is computed with your R2 secret key,
which never leaves the Worker. It cannot be forged, and it cannot be *edited* —
change one character of the key or the method and the signature no longer
matches. So a URL signed for `PUT photos/user_1/pht_abc` grants exactly that:
not a GET, not a different key, not a second object.

**How it expires:** the expiry is one of the signed fields, so R2 rejects the
request after it passes. Minutes, not hours — long enough to upload, short
enough that a leaked URL is worthless.

**How it differs from a public URL:** a public bucket URL works for everyone,
forever, for every object. A presigned URL works for one caller, for one
operation, on one key, for a few minutes. Opposite ends of the spectrum.

**Why no R2 secret belongs in Expo:** this is the whole point. The signing key
grants access to the entire bucket. In the app bundle it is extractable (Part 3,
option A). The Worker signs on the phone's behalf precisely so the phone never
holds it.

### Why the confirmation step is not optional

After step 3, **the Worker does not know whether the upload happened.** R2
answered the phone, not the Worker. Without step 4 you would have objects with
no metadata and no way to list them. Hence the PENDING → READY row: the row is
created before the upload so the key is reserved and attributable, and promoted
after the object is verified.

### Why a presigned URL does not prove the file is valid

The signature authorises *a write to a key*. It says nothing about the bytes. The
phone can PUT a zip file, a 0-byte file, or an HTML page, and R2 will store it
happily. This is a real loss compared to the current design, where the Worker
sees every byte and sniffs it. To recover it, step 4 must:

- `HEAD` the object and confirm it exists and the size is plausible;
- **range-read the first few hundred bytes** and run the same
  `sniffImageType()` check on them;
- delete the object and refuse the row if either fails.

Note that this makes the "no bytes through the Worker" claim slightly untrue —
you still read a few hundred bytes. That is a good trade.

### Preventing arbitrary uploads

- The Worker chooses the object key. **Never** sign a key the client supplied.
- Sign the content length and type as well, so the phone cannot substitute a
  500 MB file for the 2 MB it declared.
- Short expiry.
- One signature per intent, and record the intent in D1 so a signature cannot be
  replayed into many objects.

### Abandoned uploads

The user picks a photo, the Worker signs a URL, the app is killed. You now have
a PENDING row and possibly no object. Sweep it: a Cron Trigger deletes PENDING
rows older than an hour along with any object at their key. This is a *new
failure mode that the current architecture does not have* — a real cost of the
migration, not a footnote.

### Large files

Past ~100 MB, a single PUT is the wrong shape: one network hiccup and the whole
transfer restarts. Switch to **multipart** — `createMultipartUpload()`,
`uploadPart()` per chunk, `complete()` with the part list — which gives you
resumability and parallel part uploads. Incomplete multipart uploads are aborted
automatically after 7 days.

### 🚦 When to migrate — the actual triggers

Do **not** do this until at least one is true:

1. Uploads regularly exceed ~10 MB.
2. Worker CPU time or request duration shows up as a cost or a timeout.
3. You need resumable or background uploads.
4. Upload throughput is high enough that relaying bytes is the bottleneck.

If none of these is true, the presigned design costs you three round trips, a new
pending state, a new sweep job, a weaker validation story, and the S3 API with
its credential — in exchange for nothing. **The current design is not a
stepping stone to be outgrown on principle.** It is correct for small images,
and knowing *when* it stops being correct is the skill.

Docs: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>

## Other extensions, roughly by value

The three biggest gaps from the first version of this project — real
authentication, rate limiting, and a reconciliation sweep — are now
implemented; see Part 9. What is left:

| Improvement | Why | Sketch |
|---|---|---|
| **Email verification + password reset** | The largest remaining gap. Without it you cannot prove an address or recover an account | Needs an email provider (Resend, Postmark, SES) — the first genuinely new service this architecture would acquire. A `verification_tokens` table and two routes |
| **Account deletion** | `DELETE FROM users` would orphan every one of that user's objects in R2 forever | A route that lists `photos/<user>/` in R2, deletes the objects, then the rows, then the user. This is why `photos` has no cascading foreign key |
| **Two-factor auth** | Passwords alone | TOTP is ~80 lines on Web Crypto, plus recovery codes |
| **Thumbnails** | A gallery downloading full-size images is slow and burns Class B ops | [Cloudflare Images](https://developers.cloudflare.com/images/) transformations, or generate a thumbnail on upload and store it under a second key |
| **Pagination** | `LIMIT 200` is a stopgap | Keyset pagination on `(created_at, id)` — not `OFFSET`, which makes D1 scan and bill for the skipped rows |
| **Per-account storage quota** | Rate limiting caps *speed*, not *total*. A patient user can still fill your bucket | A `bytes_used` column updated on upload and delete, checked before `put()`. This is the one that protects your bill |
| **A "your devices" screen** | `sessions` already stores `user_agent` and `last_used_at`; nothing surfaces them | List sessions, revoke one by id |
| **Offline cache** | The gallery is blank with no network | `expo-sqlite` mirroring the metadata, D1 remaining the authority |
| **Soft delete** | Deletes are immediate and permanent | A `deleted_at` column, plus an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) to purge the objects later |
| **Shared download links** | Share a photo without sharing an account | A short-lived signed token for one photo id, verified in `readPhotoContent` — the same HS256 machinery already in `jwt.ts` |
| **Storage class** | Rarely-viewed photos are cheaper in Infrequent Access | `storageClass: 'InfrequentAccess'` on `put()`. Note the 30-day minimum and retrieval fees |
| **Shared contract package** | `src/lib/photo-vault/types.ts` duplicates the Worker's `Photo` by hand | A third workspace both import. Worth it once the API grows |
| **Component tests** | The screens themselves are untested | `jest-expo` + `@testing-library/react-native` |
| **Argon2id** | A better password hash than PBKDF2 | A WASM build in the Worker. Measure the CPU cost first |

---

## Appendix — command reference

```bash
# ---- first-time setup -------------------------------------------------
npm install
cp .env.example .env.local                  # app config
cd server && npm install
cp .dev.vars.example .dev.vars              # local secrets
openssl rand -base64 48                     # put this in .dev.vars as AUTH_SECRET
cd ..
npm run server:migrate                      # create the tables locally

# ---- day-to-day -------------------------------------------------------
npm run server                              # Worker on 127.0.0.1:8787
npm run server:lan                          # ...reachable from a phone
npm start                                   # Metro
npx expo run:ios                            # development build (needed once)

# ---- verification -----------------------------------------------------
npm test                                    # 164 tests, both halves
npm run typecheck                           # app
npm run server:typecheck                    # worker
npx eslint .
npx expo-doctor

# ---- local data -------------------------------------------------------
cd server
npx wrangler d1 execute photo-vault-dev --local --command "SELECT * FROM photos"
npx wrangler d1 execute photo-vault-dev --local --command "SELECT id,email FROM users"
npx wrangler r2 object get photo-vault-dev/<key> --local --pipe > out.png
curl -X POST http://127.0.0.1:8787/cdn-cgi/handler/scheduled   # run the cron job now
rm -rf .wrangler/state                      # reset everything local

# ---- production (needs a Cloudflare account; read Part 9 first) -------
cd server
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create photo-vault-prod
npx wrangler d1 create photo-vault-prod
#   ...paste the printed database_id into wrangler.jsonc, env.production
npx wrangler secret put AUTH_SECRET --env production
npx wrangler secret put SIGNUP_INVITE_CODES --env production
npx wrangler d1 migrations list  photo-vault-prod --remote --env production
npx wrangler d1 migrations apply photo-vault-prod --remote --env production
npx wrangler deploy --env production --dry-run --outdir /tmp/dryrun   # look first
npx wrangler deploy --env production
npx wrangler tail --env production
```
