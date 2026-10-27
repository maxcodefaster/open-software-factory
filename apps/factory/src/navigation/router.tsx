import { useRouter, useRouterState } from "@tanstack/solid-router";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type ParentProps,
  useContext,
} from "solid-js";
import { type FactoryLocation, factoryLocation, factoryPath } from "./location";

type Destination = Exclude<FactoryLocation, { view: "unavailable" }>;
export type FactoryNavigation = {
  location(): FactoryLocation;
  path(): string;
  failure(): string;
  open(destination: Destination, replace?: boolean): void;
  retry(): void;
};
const Navigation = createContext<FactoryNavigation | null>(null);

export function FactoryNavigationProvider(props: ParentProps) {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const location = createMemo(() => factoryLocation(pathname()));
  const [failure, setFailure] = createSignal("");
  let version = 0;
  let attempted: { destination: Destination; replace: boolean } | undefined;
  createEffect(pathname, () => {
    version++;
    attempted = undefined;
    setFailure("");
  });
  function navigate(destination: Destination, replace: boolean) {
    switch (destination.view) {
      case "home":
        return router.navigate({ to: "/", replace });
      case "inbox":
        return router.navigate({ to: "/inbox", replace });
      case "project":
        return router.navigate({
          to: "/projects/$projectId",
          params: { projectId: destination.projectID },
          replace,
        });
      case "ticket":
        return router.navigate({
          to: "/projects/$projectId/tickets/$ticketId",
          params: { projectId: destination.projectID, ticketId: destination.ticketID },
          replace,
        });
      case "knowledge":
        return destination.pageID
          ? router.navigate({
              to: "/projects/$projectId/wiki/$pageId",
              params: { projectId: destination.projectID, pageId: destination.pageID },
              replace,
            })
          : router.navigate({
              to: "/projects/$projectId/wiki",
              params: { projectId: destination.projectID },
              replace,
            });
      case "settings":
        return destination.projectID
          ? router.navigate({
              to: "/projects/$projectId/settings",
              params: { projectId: destination.projectID },
              replace,
            })
          : router.navigate({ to: "/settings", replace });
    }
  }
  function open(destination: Destination, replace = false) {
    const request = ++version;
    const path = factoryPath(destination);
    setFailure("");
    if (path === pathname()) {
      attempted = undefined;
      return;
    }
    attempted = { destination, replace };
    // The parser admits only these resource routes. The route tree supplies
    // typed destinations; IDs are data, never URLs or access capabilities.
    void navigate(destination, replace).catch(() => {
      if (request === version) setFailure("Could not open this link. Try again.");
    });
  }
  return Navigation({
    value: {
      location,
      path: pathname,
      failure,
      open,
      retry() {
        if (attempted) open(attempted.destination, attempted.replace);
      },
    },
    get children() {
      return props.children;
    },
  });
}

// Feature components also have isolated, non-routed browser fixtures.
export function useFactoryNavigation() {
  return useContext(Navigation) ?? undefined;
}
