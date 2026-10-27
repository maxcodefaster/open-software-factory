import { createFileRoute } from "@tanstack/solid-router";
import { factoryProtocolContext } from "../../server/request-context";

export const Route = createFileRoute("/editor/$")({
  server: {
    handlers: {
      ANY: ({ request, context }) => factoryProtocolContext(context).editor(request),
    },
  },
});
