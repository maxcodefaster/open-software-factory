import { createFileRoute } from "@tanstack/solid-router";
import { database } from "../services.server.ts";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await database.sql`SELECT 1`;
          return Response.json({ status: "ok" });
        } catch {
          return Response.json({ status: "unavailable" }, { status: 503 });
        }
      },
    },
  },
});
