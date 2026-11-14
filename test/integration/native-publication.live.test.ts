import { test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { ownedMonitoringForge } from "../fixtures/monitoring-native";
import {
  nativeLiveConfiguration,
  requireNativeLiveHost,
} from "../fixtures/native-live-configuration";
import { publicationRuntimeProof } from "../fixtures/publication-runtime";

test("an admitted exact-source publication runs on native Substrate and verifies its actual artifact bytes", async () => {
  const nativeConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  const publicOrigin = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  if (!nativeConfiguration || !publicOrigin)
    throw Error("Explicit native publication configuration and Forge HTTPS origin are required");
  requireNativeLiveHost();
  const id = crypto.randomUUID();
  nativeLiveConfiguration(
    await Bun.file(nativeConfiguration).json(),
    `owned_${id.replaceAll("-", "")}`,
    {
      FACTORY_FORGEJO_PUBLIC_URL: publicOrigin,
      FACTORY_FORGEJO_API_URL: `${publicOrigin}/api/v1/`,
    },
  );
  const directory = resolve(".factory/test-results/releases", `native-publication-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const forge = await ownedMonitoringForge(directory, id, undefined, publicOrigin);
  let retained = false;
  let publicationFixture: { directory: string; factoryID: string; base: string } | undefined;
  let workFailure: unknown;
  let succeeded = false;
  try {
    const repository = { owner: forge.owner, name: `publication-${id.slice(0, 8)}` };
    const api = createForgejoClient({ apiURL: `${forge.origin}/api/v1/`, token: forge.token });
    await writeFile(
      resolve(directory, "intent.json"),
      JSON.stringify({
        id,
        repository,
        forgeContainer: forge.container,
        publicOrigin,
        scope: "new-owned-native-publication-fixture",
      }),
      { flag: "wx", mode: 0o600 },
    );
    await api.createSetupRepository({ repository, setupID: id });
    await publicationRuntimeProof({
      nativeConfiguration,
      origin: forge.origin,
      publicOrigin,
      token: forge.token,
      repository,
      forge: api,
      preserve(inventory) {
        retained = true;
        publicationFixture = inventory;
      },
      async captureFailure() {
        await writeFile(
          resolve(directory, "failure-inventory.json"),
          JSON.stringify({
            id,
            forgeContainer: forge.container,
            repository,
            nativeResourceInventoryRetained: retained,
            scope: "inventory-only-not-an-acceptance-result",
          }),
          { flag: "wx", mode: 0o600 },
        );
      },
    });
    succeeded = true;
  } catch (cause) {
    workFailure = cause;
  }
  let cleanupFailure: unknown;
  try {
    if (!retained) await forge.dispose();
    else
      await writeFile(
        resolve(directory, "retained.json"),
        JSON.stringify({
          id,
          forgeContainer: forge.container,
          publicationFixture,
          nativeResourceInventoryRetained: true,
          cleanup:
            "native names and dependencies retained; inspect the publication fixture's retained.json for confirmed shutdown",
        }),
        { flag: "wx", mode: 0o600 },
      );
  } catch (cause) {
    cleanupFailure = cause;
  }
  if (cleanupFailure)
    throw new AggregateError(
      [...(succeeded ? [] : [workFailure]), cleanupFailure],
      "Native publication or owned Forge inventory recording failed",
    );
  if (!succeeded) throw workFailure;
}, 720_000);
