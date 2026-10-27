import { createFileRoute } from "@tanstack/solid-router";

// Unknown links stay inside the retained desktop and show their navigation
// error there rather than unmounting editors and losing unsaved work.
export const Route = createFileRoute("/$")({ component: () => null });
