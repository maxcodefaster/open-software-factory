import { createServerFn } from "@tanstack/solid-start";
import { getRequest } from "@tanstack/solid-start/server";
import { requestAuth } from "../services.server.ts";

export const getSession = createServerFn({ method: "POST" }).handler(async () => {
  const request = getRequest();
  const session = await requestAuth(request).api.getSession({ headers: request.headers });
  return session ? { name: session.user.name } : null;
});
