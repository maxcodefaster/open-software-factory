import type { JSX } from "@solidjs/web";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { Factory } from "../factory-entry";
import { FactoryNavigationProvider } from "../navigation/router";
import "../tokens.css";
import "../knowledge-workspace.css";
import "../runtime-workspace.css";
import "../style.css";

export const Route = createRootRoute({
  ssr: false,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0, viewport-fit=cover" },
      { title: "Open Software Factory" },
    ],
  }),
  component: () => (
    <>
      <FactoryNavigationProvider>
        <Factory />
      </FactoryNavigationProvider>
      <Outlet />
    </>
  ),
  shellComponent: Document,
});

function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
