import { createFileRoute } from "@tanstack/solid-router";
import { requestAuth } from "../../../services.server.ts";

const auth = ({ request }: { request: Request }) => requestAuth(request).handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: auth, POST: auth } },
});
