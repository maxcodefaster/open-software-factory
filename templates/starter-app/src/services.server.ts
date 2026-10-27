import { createAuth } from "./auth.ts";
import { createDatabase } from "./db/client.ts";
import { appProxyContext } from "./proxy.ts";

export const database = createDatabase();
const auths = new Map<string, ReturnType<typeof createAuth>>();
const close = () => {
  void database.sql.end({ timeout: 5 });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    close();
  });

export function requestAuth(request: Request) {
  const origin = new URL(request.url).origin;
  const basePath = appProxyContext(request.headers)?.basePath ?? "";
  const key = origin + basePath;
  let auth = auths.get(key);
  if (!auth) {
    if (auths.size >= 16) throw new Error("Too many auth origins");
    auth = createAuth(database, {
      baseURL: origin,
      basePath,
      secret: process.env.BETTER_AUTH_SECRET ?? "",
    });
    auths.set(key, auth);
  }
  return auth;
}
