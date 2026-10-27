import { hydrate } from "@solidjs/web";
import { configureServerFunctionsClient } from "@solidjs/web/server-functions/client";
import { hydrateStart, StartClient } from "@tanstack/solid-start/client";
import { applicationBase, scopedAsset } from "./base.ts";

// Keep native function transport scoped even when a lazy route registers more
// Start references and reconfigures their endpoint.
configureServerFunctionsClient({
  fetch: (address, init) => fetch(scopedAsset(String(address), applicationBase()), init),
});
const router = await hydrateStart();
hydrate(() => <StartClient router={router} />, document);
