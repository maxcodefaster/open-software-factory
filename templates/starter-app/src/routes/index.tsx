import { createFileRoute } from "@tanstack/solid-router";
import { App } from "../web.tsx";

export const Route = createFileRoute("/")({ component: App });
