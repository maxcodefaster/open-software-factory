import { getBootstrap } from "../server-functions/bootstrap";
import { serverCall } from "../server-functions/result";

import { browserBootstrap } from "./browser-origin";

export async function loadBootstrap() {
  return browserBootstrap(
    await serverCall(getBootstrap({ data: [] })),
    import.meta.env.DEV,
    location.origin,
  );
}
