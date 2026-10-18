# Factory Starter

This application uses Node.js 24, Solid, Better Auth and PostgreSQL. Factory supplies the
configured environment and starts the declared Web app inside its Dev Container.

```sh
npm ci
npm run db:migrate
npm run dev
```

Run `npm run check` before submitting a change. It checks types, builds the browser application
and runs every `test/*.test.ts` file. Tests need a working `DATABASE_URL` and a
`BETTER_AUTH_SECRET` of at least 32 characters. Keep credentials out of source control.

## Application and tests

- `src/app.ts` exports `createApplication`. It creates the production HTTP server without
  opening a listener. `src/server.ts` starts it for normal development.
- `src/web.tsx` contains the browser interface.
- `src/db/schema.ts` and `drizzle/` define the database and migrations.
- `test/auth.test.ts` demonstrates real HTTP authentication and protected-session tests.

Use `createApplication` in HTTP tests, listen on an available local port and call `close` when
finished. Exercise production handlers and shared production predicates instead of copying their
validation, filtering or SQL into a test helper. Fixtures must own their users and records;
never clear unrelated application data to make a test pass.
