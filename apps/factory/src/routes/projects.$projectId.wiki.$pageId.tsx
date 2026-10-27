import { createFileRoute } from "@tanstack/solid-router";
export const Route = createFileRoute("/projects/$projectId/wiki/$pageId")({
  component: () => null,
});
