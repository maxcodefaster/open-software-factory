import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { createSubstrateControl } from "#runtime-kubernetes/substrate-control";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { requirePublishedRuntimeArtifacts } from "../../scripts/factory/artifacts";
import { localOpenBao } from "../../scripts/factory/openbao";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  nativeLiveArtifacts,
  nativeLiveConfiguration,
  requireNativeLiveHost,
} from "../fixtures/native-live-configuration";
import { callFactoryFunction } from "../fixtures/server-functions";
import {
  connectStarterNativeLifecycle,
  starterArtifactDirectory,
} from "../fixtures/starter-native-lifecycle";
import { starterRuntimeJourney } from "../fixtures/starter-runtime-journey";

test.skipIf(process.env["FACTORY_RUN_STARTER_RUNTIME_PROOF"] !== "1")(
  "turnkey native Starter creates through setup, authenticates against PostgreSQL and retains saved Source through compiler/tests, PTY and Actor lifecycle",
  async () => {
    const restoreFidelity = z
      .enum(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"])
      .parse(process.env["FACTORY_STARTER_SNAPSHOT_FIDELITY"] ?? "SNAPSHOT_FIDELITY_MEMORY");
    const retained = process.env["FACTORY_STARTER_RESUME"]
      ? z
          .object({
            id: z.uuid(),
            base: z.string(),
            directory: z.string().startsWith(`${tmpdir()}/factory-owned-starter-runtime-`),
            projectID: z.uuid(),
            setupID: z.uuid(),
            slug: z.string().regex(/^owned-starter-[a-f0-9]{8}$/),
          })
          .parse(JSON.parse(process.env["FACTORY_STARTER_RESUME"]))
      : undefined;
    requireNativeLiveHost();
    const nativeConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
    const publicForgeOrigin = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
    if (!nativeConfiguration || !publicForgeOrigin)
      throw Error(
        "Starter live proof requires explicit owned native configuration and Forge HTTPS origin",
      );
    const artifactDirectory = starterArtifactDirectory(
      process.env["FACTORY_STARTER_ARTIFACT_DIRECTORY"],
    );
    const artifacts = await requirePublishedRuntimeArtifacts(artifactDirectory);
    const nativeConfigurationValue: unknown = JSON.parse(
      await readFile(nativeConfiguration, "utf8"),
    );
    const native = nativeLiveConfiguration(
      nativeConfigurationValue,
      `owned_${(retained?.id ?? crypto.randomUUID()).replaceAll("-", "")}`,
      { FACTORY_FORGEJO_PUBLIC_URL: publicForgeOrigin },
    );
    await nativeLiveArtifacts(native, artifacts["runtime-host"], artifactDirectory);
    const nativeRead = createSubstrateControl(native.connection);
    const directory =
      retained?.directory ?? (await mkdtemp(join(tmpdir(), "factory-owned-starter-runtime-")));
    const bao = await localOpenBao(directory);
    const configuration = await bao.start();
    const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const factory = await factoryProcess(
      {
        runtimeHostImage: artifacts["runtime-host"],
        forgejoToken: token,
        artifactDirectory,
      },
      {
        ...configuration,
        FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: nativeConfiguration,
        FACTORY_FORGEJO_PUBLIC_URL: publicForgeOrigin,
        FACTORY_FORGEJO_ADMIN_TOKEN: (
          await readFile(".factory/forgejo-admin-token", "utf8")
        ).trim(),
      },
      retained,
    );
    const database = factory.connect();
    const browser = await chromium.launch({ headless: true });
    let cookie = "";
    let succeeded = false;
    const slug = retained?.slug ?? `owned-starter-${crypto.randomUUID().slice(0, 8)}`;
    const ownership = {
      factoryID: factory.id,
      databaseName: `owned_${factory.id.replaceAll("-", "")}`,
      slug,
      projectID: retained?.projectID ?? "",
      setupID: retained?.setupID ?? "",
    };
    const evidenceDirectory = join(
      ".factory/test-results/starter-runtime",
      factory.id,
      crypto.randomUUID(),
    );
    const attempts = () =>
      database.client<
        { id: string; workspaceID: string | null; state: string }[]
      >`SELECT id,workspace_id AS "workspaceID",state FROM factory.runtime_attempt
        WHERE project_id=${ownership.projectID}`;
    try {
      if (process.env["FACTORY_RUN_STARTER_DESKTOP_PROOF"] === "1")
        await factory.startPlanningCache();
      await factory.start();
      cookie = await factory.signIn();
      await starterRuntimeJourney({
        base: factory.base,
        cookie,
        database,
        artifacts,
        artifactDirectory,
        nativeRead,
        browser,
        evidenceDirectory,
        ownership,
        restoreFidelity,
        desktopProof: process.env["FACTORY_RUN_STARTER_DESKTOP_PROOF"] === "1",
        restartPreview: process.env["FACTORY_STARTER_RESTART_PREVIEW"] === "1",
        ...(process.env["FACTORY_STARTER_DELIVERY_ONLY"] === "1"
          ? { delivery: "only" as const }
          : process.env["FACTORY_RUN_STARTER_DELIVERY_PROOF"] === "1"
            ? { delivery: "after-journey" as const }
            : {}),
      });
      succeeded = true;
    } finally {
      const { projectID, setupID } = ownership;
      let haltConfirmed = false;
      let lifecycle: Awaited<ReturnType<typeof connectStarterNativeLifecycle>> | undefined;
      try {
        await browser.close();
        // A failed journey retains its admitted work without implicitly cancelling
        // Coding. A completed journey may pause compute, not export/delete Source.
        if (succeeded && projectID) {
          if (factory.processes.at(-1)?.exitCode !== null) await factory.start();
          cookie = await factory.signIn();
          for (const attempt of await attempts())
            if (
              !["failed", "stopped"].includes(attempt.state) &&
              !(attempt.workspaceID && attempt.state === "paused")
            ) {
              if (attempt.workspaceID) {
                lifecycle ??= await connectStarterNativeLifecycle(factory.base, cookie);
                const requestID = crypto.randomUUID();
                await writeFile(
                  join(evidenceDirectory, `final-pause-${attempt.id}.json`),
                  JSON.stringify({ projectID, workspaceID: attempt.workspaceID, requestID }),
                  { mode: 0o600, flag: "wx" },
                );
                expect(await lifecycle.pause(attempt.workspaceID, requestID)).toMatchObject({
                  id: attempt.id,
                  projectId: projectID,
                  workspaceId: attempt.workspaceID,
                });
              } else {
                await serverCall(
                  callFactoryFunction(
                    factory.base,
                    "stopRuntimeAttempt",
                    [attempt.id],
                    { cookie, origin: factory.base, "content-type": "application/json" },
                    AbortSignal.timeout(nativeLifecycleWindowMS + 30_000),
                  ),
                );
              }
              await eventually(
                async () => (await attempts()).find((row) => row.id === attempt.id)?.state,
                (state) => state === (attempt.workspaceID ? "paused" : "stopped"),
                "Starter final compute halt is unconfirmed",
                nativeLifecycleWindowMS,
              );
            }
          haltConfirmed = true;
        }
      } finally {
        try {
          await lifecycle?.close();
        } finally {
          const retainedStarter = {
            id: factory.id,
            base: factory.base,
            directory,
            projectID,
            setupID,
            slug,
          };
          try {
            if (projectID || setupID) {
              // No destructive Workspace teardown exists. Keep the database,
              // Forge repository and OpenBao identities needed by retained Source.
              const retainedFixture = {
                retainedStarter,
                qualificationSucceeded: succeeded,
                haltConfirmed,
                destructiveDisposal: false,
              };
              console.log(JSON.stringify(retainedFixture));
              await mkdir(evidenceDirectory, { recursive: true });
              await writeFile(
                join(evidenceDirectory, "retained-fixture.json"),
                JSON.stringify(retainedFixture, null, 2),
                { mode: 0o600 },
              );
            }
          } finally {
            try {
              await database.client.end({ timeout: 2 });
            } finally {
              if (projectID || setupID) await factory.pause();
              else {
                // Only an empty, unadmitted fixture uses its existing guarded disposal.
                await factory.dispose();
                await bao.dispose();
                await rm(directory, { recursive: true });
              }
            }
          }
        }
      }
    }
  },
  2_400_000,
);
