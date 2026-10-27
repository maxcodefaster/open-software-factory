import { createRouter } from "@tanstack/solid-router";
import { applicationBase } from "./base.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const basepath = applicationBase();
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    rewrite: {
      input: ({ url }) => {
        if (basepath && (url.pathname === basepath || url.pathname.startsWith(`${basepath}/`)))
          url.pathname = url.pathname.slice(basepath.length) || "/";
        return url;
      },
      output: ({ url }) => {
        url.pathname = basepath + url.pathname;
        return url;
      },
    },
  });
}

declare module "@tanstack/solid-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
