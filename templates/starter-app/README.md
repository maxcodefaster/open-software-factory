# Factory Starter

This application uses TanStack Start for Solid 2, Node.js 24, Better Auth and PostgreSQL.
Factory supplies the configured environment and starts the declared Web app inside its Dev Container.
The exact Solid 2 and Start release candidates are pinned independently of Factory's own frontend.

```sh
npm ci
npm run db:migrate
npm run dev
```

Run `npm run check` before submitting a change. It builds the application and generated route
types, runs every `test/*.test.ts` file, then checks TypeScript. `npm test` also builds before testing.
Tests need a working `DATABASE_URL` and a `BETTER_AUTH_SECRET` of at least 32 characters.
Keep credentials out of source control.

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
