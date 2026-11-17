import { readFileSync } from "node:fs";

// A listening process and a completed bootstrap marker precede Kubernetes
// endpoint publication. Cold Actors must not call an unrouted public origin.
export function createStartupDispatchGate(input: {
  required: boolean;
  origin: string;
  startupID: string;
  caFile?: string | undefined;
}) {
  if (!input.required) return async () => true;
  const origin = new URL(input.origin);
  if (origin.protocol !== "https:" || input.origin !== origin.origin || !input.caFile)
    throw new Error("Installation dispatch requires its HTTPS origin and public CA");
  const ca = readFileSync(input.caFile, "utf8");
  if (!ca.trim()) throw new Error("Installation dispatch requires its nonempty public CA");
  let ready = false;
  let waiting = false;
  let pending: Promise<boolean> | undefined;
  async function observe() {
    const response = await fetch(new URL("/health/ready?installation=complete", origin), {
      tls: { ca },
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    }).catch(() => null);
    ready = Boolean(
      response?.ok &&
        response.headers.get("x-open-factory") === "ready" &&
        response.headers.get("x-open-factory-startup") === input.startupID,
    );
    await response?.body?.cancel();
    if (ready) console.info("Factory public HTTPS startup route is ready for background work");
    else if (!waiting) {
      waiting = true;
      console.info("Factory background work is waiting for its public HTTPS startup route");
    }
    return ready;
  }
  return () => {
    if (ready) return Promise.resolve(true);
    pending ??= observe().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
