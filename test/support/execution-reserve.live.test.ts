import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { forgeUsername } from "../../packages/forge/src/access";
import {
  defaultReservePolicy,
  type ExecutionSlot,
} from "../../packages/runtime-domain/src/reserve";
import { factoryboxWorkerIdentity } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import {
  createReserveClient,
  factoryboxReserveInput,
  type ReserveClient,
} from "../../packages/runtime-kubernetes/src/reserve";
import { editorFixtureNamespaces } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { removeOwnedFactoryboxFixture } from "../fixtures/factorybox-cleanup";
import { factoryboxFixtureCommand, observeFactoryboxFixture } from "../fixtures/factorybox-runtime";
import { runtimeAccessCookie } from "../fixtures/runtime-access";
import { ownedRuntimeRepository } from "../fixtures/runtime-repository";
import { authenticatedBootstrap, callFactoryFunction } from "../fixtures/server-functions";

test.skipIf(process.env["FACTORY_RUN_EXECUTION_RESERVE_PROOF"] !== "1")(
  "clean slots recover lost create acknowledgement, assign once, refill and survive pre-activation Factory crash",
  async () => {
    const image = async (name: string) =>
      (
        (name === "runtime-host" ? process.env["FACTORY_RUNTIME_HOST_IMAGE"] : undefined) ??
        (await readFile(`.factory/${name}-image`, "utf8"))
      ).trim();
    const images = {
      staging: await image("runtime-host"),
      verification: await image("runtime-host"),
    };
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/execution-reserve", proofID);
    await mkdir(artifacts, { recursive: true });
    for (const [name, path] of [
      ["fixture-source.ts", "test/support/execution-reserve.live.test.ts"],
      ["prepare-source.py", "packages/runtime-kubernetes/src/factorybox/prepare.py"],
    ] as const)
      await writeFile(resolve(artifacts, name), await readFile(path, "utf8"), {
        flag: "wx",
        mode: 0o400,
      });
    const forgeHost = await ownedRuntimeRepository(artifacts, proofID);
    const fixture = await factoryProcess(
      { runtimeHostImage: images.staging, forgejoToken: forgeHost.token },
      {
        FACTORY_FORGEJO_ADMIN_TOKEN: forgeHost.token,
        FACTORY_FORGEJO_API_URL: `${forgeHost.origin}/api/v1/`,
        FACTORY_FORGEJO_OWNER: forgeHost.owner,
        FACTORY_EXECUTION_RESERVE_TARGET: "1",
      },
    ).catch(async (cause) => {
      await forgeHost.dispose();
      throw cause;
    });
    const database = fixture.connect();
    const before = await editorFixtureNamespaces();
    const client = createReserveClient();
    const policy = { ...defaultReservePolicy, retryMS: 1_000 };
    let cookie = "";
    let manager: ReturnType<typeof createExecutionReserve> | undefined;
    let lost: { id: string; namespaceUID: string; podUID: string; claimUID: string } | undefined;
    let preparationFailures = 0;
    let passed = false;
    const cleanSlots = new Set<string>();
    const adapter: ReserveClient = {
      ...client,
      async prepare(slot, options) {
        const [intent] = await database.client<
          Array<{ state: string }>
        >`SELECT state FROM factory.execution_slot WHERE id=${slot.id}`;
        expect(intent?.state).toBe("creating");
        if (!options) throw new Error("Owned reserve proof requires durable lifecycle callbacks");
        const result = await client
          .prepare(slot, {
            ...options,
            async intendStandby(action) {
              if (action === "pause") {
                const target = {
                  input: factoryboxReserveInput(slot),
                  identity: factoryboxWorkerIdentity.parse(slot.factoryboxIdentity),
                };
                for (const args of [
                  ["docker", "ps", "--all", "--quiet"],
                  ["docker", "volume", "ls", "--quiet"],
                ])
                  expect((await factoryboxFixtureCommand(target, args)).trim()).toBe("");
                expect(
                  (
                    await factoryboxFixtureCommand(target, [
                      "sh",
                      "-ec",
                      "test ! -e /home/coder/project && test ! -e /home/coder/connector-state && echo clean",
                    ])
                  ).trim(),
                ).toBe("clean");
                cleanSlots.add(slot.id);
              }
              return options.intendStandby(action);
            },
          })
          .catch(async (cause: unknown) => {
            await writeFile(
              resolve(artifacts, `prepare-failure-${++preparationFailures}.json`),
              JSON.stringify({
                slotID: slot.id,
                attemptedStart: slot.factoryboxStartAttempted,
                prepared: Boolean(slot.factoryboxPreparation),
                error: (cause instanceof Error ? cause.message : "Native preparation failed")
                  .replaceAll(forgeHost.token, "<REDACTED>")
                  .slice(-4000),
              }),
              { flag: "wx", mode: 0o600 },
            );
            throw cause;
          });
        if (!lost) {
          lost = {
            id: slot.id,
            namespaceUID: result.namespaceUID,
            podUID: result.podUID,
            claimUID: result.claimUID,
          };
          throw new Error("Owned lost external-create acknowledgement");
        }
        return result;
      },
    };
    const slots = () =>
      database.client.unsafe<ExecutionSlot[]>(
        'SELECT id,role,state,runtime_host_image AS "runtimeHostImage",factorybox_worker_id AS "workerID",kubernetes_namespace AS namespace,namespace_uid AS "namespaceUID",pod_uid AS "podUID",claim_uid AS "claimUID",expires_at AS "expiresAt",assigned_attempt_id AS "assignedAttemptID",factorybox_profile AS "factoryboxProfile",factorybox_identity AS "factoryboxIdentity",factorybox_preparation AS "factoryboxPreparation",factorybox_start_attempted AS "factoryboxStartAttempted",factorybox_pause_attempted AS "factoryboxPauseAttempted",factorybox_resume_attempted AS "factoryboxResumeAttempted",factorybox_delete_attempted AS "factoryboxDeleteAttempted" FROM factory.execution_slot ORDER BY created_at,id',
      );
    try {
      manager = createExecutionReserve(database, images, policy, adapter);
      const preparedAt = performance.now();
      await manager.reconcile();
      expect(lost).toBeDefined();
      const lostOutcome = lost;
      if (!lostOutcome) throw new Error("Expected lost external-create acknowledgement");
      expect((await slots()).find((slot) => slot.id === lostOutcome.id)?.podUID).toBeNull();
      await manager.close();
      manager = createExecutionReserve(database, images, policy, adapter);
      await manager.start();
      const prepared = await eventually(
        slots,
        (rows) => rows.filter((slot) => slot.state === "ready").length === 2,
        "Owned clean reserve did not become ready",
        420_000,
      );
      const preparationMS = Math.round(performance.now() - preparedAt);
      const recovered = prepared.find((slot) => slot.id === lostOutcome.id);
      expect(recovered).toMatchObject({
        namespaceUID: lostOutcome.namespaceUID,
        podUID: lostOutcome.podUID,
        claimUID: lostOutcome.claimUID,
      });
      const selected = prepared.find((slot) => slot.role === "staging");
      if (!selected?.podUID || !selected.namespaceUID || !selected.claimUID)
        throw new Error("Ready reserve lacks complete owned resource outcomes");
      for (const slot of prepared.filter((value) => value.state === "ready")) {
        expect(cleanSlots.has(slot.id)).toBe(true);
        const paused = await observeFactoryboxFixture({
          input: factoryboxReserveInput(slot),
          identity: factoryboxWorkerIdentity.parse(slot.factoryboxIdentity),
        });
        expect(paused.record.phase).toBe("paused");
        expect(paused.record["pause"]).toMatchObject({
          snapshot_id: slot.id.replaceAll("-", ""),
          after: { anon: 0 },
          snapshot: { resident_bytes_after: 0 },
        });
      }
      expect(new Set(prepared.map((slot) => slot.workerID)).size).toBe(1);
      expect(new Set(prepared.map((slot) => slot.podUID)).size).toBe(1);
      let server = await fixture.start();
      cookie = await fixture.signIn();
      const session = z
        .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
        .parse(await authenticatedBootstrap(fixture.base, { cookie }));
      await forgeHost.execute([
        "admin",
        "user",
        "create",
        "--username",
        forgeUsername(session.session.user.id),
        "--random-password",
        "--email",
        `${proofID}@reserve-proof.invalid`,
        "--must-change-password=false",
      ]);
      const projectID = crypto.randomUUID();
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({
          proofID,
          projectID,
          factoryID: fixture.id,
          forgeContainer: forgeHost.container,
          repository: forgeHost.repository,
          prepared: prepared.map(({ id, namespace, namespaceUID, podUID, claimUID, role }) => ({
            id,
            namespace,
            namespaceUID,
            podUID,
            claimUID,
            role,
          })),
        }),
      );
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`reserve-${proofID}`},'Owned reserve journey',${forgeHost.repositoryURL},'main','.devcontainer/devcontainer.json',${session.session.user.id})`;
      const startedAt = performance.now();
      const pending = callFactoryFunction(
        fixture.base,
        "ensureStaging",
        [projectID],
        { cookie, origin: fixture.base, "content-type": "application/json" },
        AbortSignal.timeout(180_000),
      ).catch(() => null);
      const [assigned] = await eventually(
        async () =>
          database.client<
            Array<{ id: string; state: string; generation: string; namespace: string }>
          >`SELECT id,state,generation,kubernetes_namespace AS namespace FROM factory.runtime_attempt WHERE project_id=${projectID}`,
        (rows) => rows.length === 1,
        "Owned runtime intent missing",
      );
      if (!assigned) throw new Error("Owned runtime intent missing");
      expect(assigned.namespace).toBe(selected.namespace);
      expect(assigned.state).toBe("create-intended");
      await fixture.kill(server);
      await pending;
      server = await fixture.start();
      const ready = await eventually(
        async () => {
          const result = z
            .object({ attempts: z.array(runtimeAttemptSchema) })
            .parse(
              await serverCall(
                callFactoryFunction(
                  fixture.base,
                  "getRuntimeAttempts",
                  [projectID],
                  { cookie, origin: fixture.base, "content-type": "application/json" },
                  AbortSignal.timeout(180_000),
                ),
              ),
            );
          const attempt = result.attempts.find((candidate) => candidate.id === assigned.id);
          if (!attempt || ["failed", "stopped", "cleanup-failed"].includes(attempt.state))
            throw new Error(
              `Owned reserved runtime unavailable: ${attempt?.failure ?? attempt?.state ?? "missing"}`,
            );
          return attempt;
        },
        (attempt) => attempt.state === "ready",
        "Owned reserved runtime did not reconnect",
        180_000,
      );
      expect(ready.id).toBe(assigned.id);
      const [outcome] = await database.client<
        Array<{ podUID: string; namespaceUID: string }>
      >`SELECT kubernetes_uid AS "podUID",kubernetes_namespace_uid AS "namespaceUID" FROM factory.runtime_attempt WHERE id=${assigned.id}`;
      expect(outcome).toEqual({ podUID: selected.podUID, namespaceUID: selected.namespaceUID });
      const connectedMS = Math.round(performance.now() - startedAt);
      const access = await runtimeAccessCookie(fixture.base, cookie, assigned.id, "app");
      expect(
        (
          await fetch(`${fixture.base}/runtime/${assigned.id}/app/health`, {
            headers: { cookie: access },
          })
        ).status,
      ).toBe(200);
      const refilled = await eventually(
        slots,
        (rows) =>
          rows.some(
            (slot) => slot.role === "staging" && slot.state === "ready" && slot.id !== selected.id,
          ),
        "Reservation did not immediately trigger bounded refill",
        180_000,
      );
      expect(refilled.filter((slot) => slot.state === "ready")).toHaveLength(2);
      expect(refilled.find((slot) => slot.id === selected.id)).toMatchObject({
        state: "assigned",
        assignedAttemptID: assigned.id,
        podUID: selected.podUID,
        claimUID: selected.claimUID,
      });
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE project_id=${projectID}`,
      ).toHaveLength(0);
      expect(await database.client`SELECT id FROM factory.agent_turn`).toHaveLength(0);
      await manager.close();
      manager = undefined;
      expect(
        (
          await callFactoryFunction(
            fixture.base,
            "stopRuntimeAttempt",
            [assigned.id],
            { cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          )
        ).ok,
      ).toBe(true);
      await eventually(
        async () =>
          database.client<
            Array<{ state: string }>
          >`SELECT state FROM factory.runtime_attempt WHERE id=${assigned.id}`,
        (rows) => rows[0]?.state === "stopped",
        "Owned reserved runtime cleanup incomplete",
        120_000,
      );
      expect((await slots()).find((slot) => slot.id === selected.id)?.state).toBe("deleted");
      await writeFile(
        resolve(artifacts, "result.json"),
        JSON.stringify({
          preparationMS,
          connectedMS,
          lostCreateRecovered: true,
          samePodAndClaim: true,
          factoryCrashBeforeActivation: true,
          assignedOnce: true,
          refilledOnReservation: true,
          noInference: true,
          attemptID: assigned.id,
        }),
      );
      passed = true;
    } catch (cause) {
      await writeFile(
        resolve(artifacts, "failure.json"),
        JSON.stringify({
          error: (cause instanceof Error ? cause.message : "Native reserve proof failed")
            .replaceAll(forgeHost.token, "<REDACTED>")
            .slice(-4000),
        }),
        { flag: "wx", mode: 0o600 },
      ).catch(() => console.error("Owned reserve failure could not be saved"));
      throw cause;
    } finally {
      if (!passed)
        await writeFile(
          resolve(artifacts, "failure-state.json"),
          JSON.stringify({ slots: await slots() }),
          { flag: "wx", mode: 0o600 },
        ).catch(() => console.error("Owned reserve failure evidence could not be saved"));
      await manager?.close();
      // Stop only this database's disposable runtime owners before removing their unassigned reserve.
      const attempts = await database.client<
        Array<{ id: string; state: string; generation: string }>
      >`SELECT id,state,generation FROM factory.runtime_attempt`;
      for (const attempt of attempts) {
        if (!["stopped", "failed"].includes(attempt.state) && cookie)
          await callFactoryFunction(
            fixture.base,
            "stopRuntimeAttempt",
            [attempt.id],
            { cookie, origin: fixture.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ).catch(() => null);
      }
      await eventually(
        () => database.client<Array<{ state: string }>>`
          SELECT state FROM factory.runtime_attempt WHERE state NOT IN ('stopped','failed')`,
        (rows) => rows.length === 0,
        "Owned reserve consumers did not Stop before pool retirement",
        120_000,
      );
      // Do not race a live target=1 controller against teardown's target=0.
      await fixture.shutdown();
      // Use the real controller's durable Delete/retirement intents. Direct
      // adapter cleanup without those callbacks cannot retire paused slots.
      manager = createExecutionReserve(database, images, { ...policy, readyTarget: 0 }, client);
      await manager.start();
      await eventually(
        slots,
        (rows) => rows.every((slot) => slot.state === "deleted"),
        "Owned reserve retirement did not settle",
        180_000,
      );
      await manager.close();
      manager = undefined;
      await removeOwnedFactoryboxFixture(fixture, artifacts);
      const after = await editorFixtureNamespaces();
      for (const expected of before)
        expect(after.find((item) => item.name === expected.name)?.uid).toBe(expected.uid);
      for (const slot of await slots())
        expect(after.some((item) => item.name === slot.namespace)).toBe(false);
      await writeFile(
        resolve(artifacts, "cleanup.json"),
        JSON.stringify({ ownedSharedWorkerRemoved: true, unrelatedNamespacesUnchanged: true }),
      );
      await database.client.end({ timeout: 2 });
      await fixture.dispose();
      await forgeHost.dispose();
    }
  },
  // This journey includes cold pool provisioning, a Factory crash, assignment,
  // refill and retirement. Each native operation keeps its own lifecycle bound.
  900_000,
);
