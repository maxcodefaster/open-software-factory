import { createFileRoute, Outlet } from "@tanstack/solid-router";
export const Route = createFileRoute("/projects/$projectId/wiki")({ component: Outlet });
