import type { JSX } from "@solidjs/web";
import { createRootRoute, HeadContent, Link, Scripts } from "@tanstack/solid-router";
import { applicationBase } from "../base.ts";
import "../web.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Factory Starter" },
    ],
  }),
  shellComponent: Document,
  notFoundComponent: () => (
    <main>
      <section>
        <h1>Page not found</h1>
        <Link to="/">Go home</Link>
      </section>
    </main>
  ),
  errorComponent: () => (
    <main>
      <section>
        <h1>Could not load this page</h1>
        <a href={`${applicationBase()}/`}>Try again</a>
      </section>
    </main>
  ),
});

function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <base href={`${applicationBase()}/`} />
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
