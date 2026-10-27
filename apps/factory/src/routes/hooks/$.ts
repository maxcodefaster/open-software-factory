import { createFileRoute } from "@tanstack/solid-router";
import { factoryProtocolContext } from "../../server/request-context";

export const Route = createFileRoute("/hooks/$")({
  server: {
    handlers: {
      ANY: ({ request, context }) => factoryProtocolContext(context).hooks(request),
    },
  },
});
