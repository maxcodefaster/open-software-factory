# Factory Starter

This application uses TanStack Start for Solid 2, Node.js 24, Better Auth and PostgreSQL.
Factory supplies the approved environment and starts the Web app in the native `work` container.
The generated `.factory/actor-template.json` uses the installation's published, immutable
Starter images for its selected Linux arm64 or amd64 Substrate workers. No Docker daemon,
Dev Container, Compose service discovery or runtime image build is involved.
Start RC11 uses the fixed upstream server core 1.169.45. Installation repairs its missing
request-scope export automatically, without changing the upstream implementation.
Production bundles TanStack's declared dependency graph before Nitro packages the server.
TypeScript 6 supplies both build checks and the `tsserver` API used by Factory's language tools.
The exact Solid 2 and Start release candidates are pinned independently of Factory's own frontend.

```sh
npm ci
npm run db:wait
npm run db:migrate
npm run dev
```

Run `npm run check` before submitting a change. It builds the application and generated route
types, runs every `test/*.test.ts` file, then checks TypeScript. `npm test` also builds before testing.
Tests need a working `DATABASE_URL` and a `BETTER_AUTH_SECRET` of at least 32 characters.
Keep credentials out of source control.

## Native runtime and images

The ActorTemplate declares `work` and PostgreSQL as direct native containers sharing the Actor's
loopback network. Only `work` mounts saved Source; PostgreSQL has its own durable data directory.
The checkout is `project/` inside the Source mount. Preparation and Verification commands are
relative to that checkout, not a hardcoded working directory. Factory admits Source before any
Project entrypoint and starts the Web app through `.factory/system.json` after preparation succeeds.
Every cold start runs `npm ci`, waits for a successful SQL query, then runs the existing migrations
once. Only readiness is retried; migrations and application writes are not replayed on failure.
Native MEMORY continuation may keep the processes; Substrate's ROOTFS fallback restarts them.

Configure these variables in the applicable Project Environment, including Verification access:

- `POSTGRES_PASSWORD`: a strong password for the Actor-local PostgreSQL server.
- `DATABASE_URL`: `postgres://app:<URL-encoded-password>@127.0.0.1:5432/app`, using the same password.
- `BETTER_AUTH_SECRET`: at least 32 characters. Keep credentials out of repository files.

Template environment values are literal. They do not interpolate `${...}` or reference other
variables. Containers do not have Compose DNS names or `depends_on`; the SQL readiness command
handles concurrent PostgreSQL startup before migration.

The recipes in `.factory/images/work/Dockerfile` and `.factory/images/postgres/Dockerfile` use the
repository's pinned upstream base images. Work adds Git and runs as the existing UID/GID 1000;
PostgreSQL runs as its existing non-root `postgres` user. The release owns their build, publication
and exact references as `starter-work` and `starter-postgres` in its normal artifact bundle.
Startup selects the catalog for the configured native worker platform. Creating a Starter never
builds images; it writes those exact published references into the new Project's template.

An administrator may deliberately override the installation catalog with `FACTORY_STARTER_IMAGES`
as `{platform, development, postgres}`. Its platform must match the selected Substrate runtime.
There is deliberately no fallback to upstream root images, mutable tags, emulation or locally
created acceptance images. Preparing these installation defaults is separate from the opportunistic
Project image-preparation feature; publication never changes an existing Project's saved template.

## Application and tests

- `src/routes/` contains Start's file-based routes. `__root.tsx` owns the streamed HTML document,
  shared styles and page boundaries; `index.tsx` renders the session interface.
  Add routes there and use TanStack Router's typed `Link`, navigation and search-parameter APIs.
  Start generates `src/routeTree.gen.ts`; do not edit it manually.
- `src/router.tsx` creates a fresh router per request. Factory's scoped Preview paths use
  request-local URL rewriting rather than a fixed deployment prefix.
- `src/web.tsx` contains the session interface, rendered on the server and hydrated in the browser.
  Server reads use async `createMemo`, `Loading` and `Errored`. Call Solid's `refresh` after a
  successful write; retrying a failed read must not repeat that write. Signals hold local UI
  and form-submission state, not copies of server data. Submission guards also block duplicate
  events before Solid's batched updates reach the DOM.
- `src/server-functions/session.ts` defines the typed read with Start's `createServerFn`.
  Start's Solid 2 adapter uses Solid's native Server Function transport and serialization.
  Validate inputs and check the caller's authority inside each new Server Function.
  Reads can be reactive; writes must remain explicit event-driven calls.
- Better Auth owns the `/api/auth/*` server route; `/health` checks PostgreSQL.
  `src/services.server.ts` keeps the database and authentication configuration server-only.
  Other application access belongs in Server Functions rather than separate JSON routes.
- `src/server.ts` wraps Start's fetch handler with validated Factory origin/path integration.
  `src/client.tsx` hydrates Solid 2 and scopes native function requests to the same App address.
  `src/dev.ts` provides Vite's per-mount module graphs and HMR, not another application dispatcher.
- `src/db/schema.ts` and `drizzle/` define the database and migrations.
- `test/auth.test.ts` demonstrates real HTTP authentication and protected-session tests.

Use `test/application.ts` to start the actual built Nitro server on an available local port,
then call `close` when finished. Exercise production handlers and shared production predicates
instead of copying their validation, filtering or SQL into a test helper.
Fixtures must own their users and records; never clear unrelated data to make a test pass.

## Production

Run `npm run build`, then `npm start`. Nitro emits the Node server in `.output/server` and
public assets in `.output/public`; production does not start Vite. Its intermediate build
files live under `.tanstack/`. Neither directory belongs in Project source.
Page HTML and session responses are never cached. Hashed assets use immutable caching.
Development and production both support Factory's scoped App and Preview addresses, including
deep links, client navigation and request-scoped session cookies.

Better Auth's optional Solid/Start peer ranges still describe the Solid 1 integration.
The manifest overrides those two peers to the exact selected Solid 2/Start versions; this
application uses Better Auth's framework-independent client and HTTP handler.
