import { createFileRoute } from "@tanstack/solid-router";
import { factoryProtocolContext } from "../../server/request-context";

export const Route = createFileRoute("/health/ready")({
  server: {
    handlers: {
      ANY: ({ request, context }) => factoryProtocolContext(context).health(request),
    },
  },
});
