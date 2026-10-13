import { readFile } from "node:fs/promises";
import { createForgejoClient } from "../../packages/forge/src/forge";

const apiURL = new URL("http://127.0.0.1:33030/api/v1/");
const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
if (!token) throw new Error("Local Forgejo token is missing");
const repository = { owner: "factory-mutation", name: "runtime-fixture" };
const authorization = { authorization: `Bearer ${token}` };
const probe = createForgejoClient({ apiURL: apiURL.toString(), token });
const base = await probe.getDefaultBranch(repository);
const branchName = `factory/integration-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const branchURL = new URL(
  `repos/${repository.owner}/${repository.name}/branches/${encodeURIComponent(branchName)}`,
  apiURL,
);
let discardedCreateResponse = false;
let probeFailure: unknown;

try {
  const recovering = createForgejoClient({
    apiURL: apiURL.toString(),
    token,
    async fetch(input, init) {
      const response = await fetch(input, init);
      if (init?.method === "POST" && !discardedCreateResponse) {
        discardedCreateResponse = true;
        if (!response.ok) throw new Error(`Forgejo branch create returned ${response.status}`);
        throw new DOMException("simulated lost response", "TimeoutError");
      }
      return response;
    },
  });
  const recovered = await recovering.ensureBranch(repository, branchName, base.headSha);
  if (!discardedCreateResponse || recovered.headSha !== base.headSha) {
    throw new Error("Forgejo ambiguous branch create did not recover the exact SHA");
  }
  const repeated = await probe.ensureBranch(repository, branchName, base.headSha);
  if (repeated.headSha !== base.headSha) {
    throw new Error("Forgejo exact-SHA branch creation is not idempotent");
  }
} catch (cause) {
  probeFailure = cause;
}
const removed = await fetch(branchURL, { method: "DELETE", headers: authorization });
if (!removed.ok && removed.status !== 404) {
  const cleanupFailure = new Error(`Forgejo integration branch cleanup returned ${removed.status}`);
  if (probeFailure) throw new AggregateError([probeFailure, cleanupFailure]);
  throw cleanupFailure;
}
if (probeFailure) throw probeFailure;

console.log("Forgejo exact-SHA idempotency and ambiguous-outcome recovery passed");
