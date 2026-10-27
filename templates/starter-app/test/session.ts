import { readdir } from "node:fs/promises";
import { decodeResponse } from "@solidjs/web/server-functions/client";

// Use the build's actual identity rather than guessing a transport id.
export async function sessionFunctionPath() {
  const directory = new URL("../.output/server/_ssr/", import.meta.url);
  const module = (await readdir(directory)).find((name) => /^session-[\w-]+\.mjs$/.test(name));
  if (!module) throw new Error("Session function missing from server build");
  const exports = await import(new URL(module, directory).href);
  for (const value of Object.values(exports)) {
    if (typeof value !== "function") continue;
    const reference = value as { url?: string; serverFnMeta?: { name?: string } };
    if (reference.serverFnMeta?.name === "getSession" && reference.url)
      return reference.url.replace(/\/([^/]+)$/, "/data/$1");
  }
  throw new Error("Session function missing its native reference metadata");
}

export async function readSession(base: string, cookie = "", origin = "http://localhost:4300") {
  const url = new URL(await sessionFunctionPath(), base);
  url.searchParams.set("args", JSON.stringify([{ method: "POST", context: {} }]));
  return fetch(url, {
    method: "POST",
    headers: { origin, cookie },
    redirect: "manual",
  });
}

export async function sessionValue(response: Response) {
  const payload = await decodeResponse<{ result: { name: string } | null }>(response);
  if (!payload || !("result" in payload)) throw new Error("Session response missing its result");
  return payload.result;
}
