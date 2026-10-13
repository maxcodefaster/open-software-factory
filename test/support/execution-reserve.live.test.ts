import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createExecutionReserve } from "../../apps/factory/src/runtime/reserve-controller";
import {
  createReserveClient,
  type ReserveClient,
} from "../../packages/runtime-kubernetes/src/reserve";
import {
  defaultReservePolicy,
  type ExecutionSlot,
} from "../../packages/runtime-domain/src/reserve";
import { factoryProcess, eventually } from "../fixtures/factory-process";
import { editorFixtureNamespaces, editorFixtureKubectl } from "../fixtures/editor-source-resources";
import { runtimeAccessCookie } from "../fixtures/runtime-access";
import { runtimeAttemptSchema } from "../../apps/factory/src/api-contracts";

test.skipIf(process.env["FACTORY_RUN_EXECUTION_RESERVE_PROOF"] !== "1")(
  "clean slots recover lost create acknowledgement, assign once, refill and survive pre-activation Factory crash",
  async () => {
    const image = async (name: string) => (await readFile(`.factory/${name}-image`, "utf8")).trim();
    const images = {
      staging: await image("runtime-host"),
      verification: await image("verification-runtime-host"),
    };
    const fixture = await factoryProcess({
      runtimeHostImage: images.staging,
      forgejoToken: (await readFile(".factory/forgejo-token", "utf8")).trim(),
    });
    const database = fixture.connect();
    const proofID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/execution-reserve", proofID);
    await mkdir(artifacts, { recursive: true });
    const before = await editorFixtureNamespaces();
    const client = createReserveClient();
    const policy = { ...defaultReservePolicy, retryMS: 1_000 };
    let cookie = "";
    let manager: ReturnType<typeof createExecutionReserve> | undefined;
    let lost: { id: string; namespaceUID: string; podUID: string; claimUID: string } | undefined;
    const adapter: ReserveClient = {
      ...client,
      async prepare(slot) {
        const [intent] = await database.client<
          Array<{ state: string }>
        >`SELECT state FROM factory.execution_slot WHERE id=${slot.id}`;
        expect(intent?.state).toBe("creating");
        const result = await client.prepare(slot);
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
        'SELECT id,role,state,runtime_host_image AS "runtimeHostImage",kubernetes_namespace AS namespace,namespace_uid AS "namespaceUID",pod_uid AS "podUID",claim_uid AS "claimUID",expires_at AS "expiresAt",assigned_attempt_id AS "assignedAttemptID" FROM factory.execution_slot ORDER BY created_at,id',
      );
    const api = (path: string, body?: unknown) =>
      fetch(`${fixture.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: fixture.base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(180_000),
      });
    try {
      manager = createExecutionReserve(database, images, policy, adapter);
      const preparedAt = performance.now();
      await manager.reconcile();
      expect(lost).toBeDefined();
      const lostOutcome = lost;
      if (!lostOutcome) throw new Error("Expected lost external-create acknowledgement");
      expect((await slots()).find((slot) => slot.id === lostOutcome.id)?.podUID).toBeNull();
      await manager.close();
      manager = createExecutionReserve(database, images, policy, client);
      await manager.start();
      const prepared = await eventually(
        slots,
        (rows) => rows.filter((slot) => slot.state === "ready").length === 2,
        "Owned clean reserve did not become ready",
        180_000,
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
      const privateDocker = (args: string[]) =>
        editorFixtureKubectl([
          "exec",
          "-n",
          selected.namespace,
          "slot",
          "--",
          "docker",
          "exec",
          "workspace_cvm",
          "docker",
          ...args,
        ]);
      expect((await privateDocker(["ps", "--all", "--quiet"])).trim()).toBe("");
      expect((await privateDocker(["volume", "ls", "--quiet"])).trim()).toBe("");
      expect(
        (
          await editorFixtureKubectl([
            "exec",
            "-n",
            selected.namespace,
            "slot",
            "--",
            "sh",
            "-c",
            "test ! -e /home/coder/project && test ! -e /home/coder/connector-state && echo clean",
          ])
        ).trim(),
      ).toBe("clean");
      let server = await fixture.start();
      cookie = await fixture.signIn();
      const session = z
        .object({ session: z.object({ user: z.object({ id: z.uuid() }) }) })
        .parse(await (await api("/api/session")).json());
      const projectID = crypto.randomUUID();
      await writeFile(
        resolve(artifacts, "intent.json"),
        JSON.stringify({
          proofID,
          projectID,
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
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`reserve-${proofID}`},'Owned reserve journey',${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json',${session.session.user.id})`;
      const startedAt = performance.now();
      const pending = api(`/api/projects/${projectID}/staging/ensure`, {}).catch(() => null);
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
            .parse(await (await api(`/api/runtime-attempts?projectId=${projectID}`)).json());
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
      expect((await api(`/api/runtime-attempts/${assigned.id}/stop`, {})).ok).toBe(true);
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
    } finally {
      await manager?.close();
      // Stop only this database's disposable runtime owners before removing their unassigned reserve.
      const attempts = await database.client<
        Array<{ id: string; state: string; generation: string }>
      >`SELECT id,state,generation FROM factory.runtime_attempt`;
      for (const attempt of attempts) {
        if (!["stopped", "failed"].includes(attempt.state) && cookie)
          await api(`/api/runtime-attempts/${attempt.id}/stop`, {}).catch(() => null);
      }
      for (const slot of await slots()) {
        if (slot.assignedAttemptID) {
          const attempt = attempts.find((candidate) => candidate.id === slot.assignedAttemptID);
          if (attempt) await client.removeAssigned(slot, Number(attempt.generation));
        } else if (slot.state !== "deleted") await client.retire(slot);
      }
      const after = await editorFixtureNamespaces();
      for (const expected of before)
        expect(after.find((item) => item.name === expected.name)?.uid).toBe(expected.uid);
      for (const slot of await slots())
        expect(after.some((item) => item.name === slot.namespace)).toBe(false);
      await writeFile(
        resolve(artifacts, "cleanup.json"),
        JSON.stringify({ ownedNamespacesRemoved: true, unrelatedNamespacesUnchanged: true }),
      );
      await database.client.end({ timeout: 2 });
      await fixture.dispose();
    }
  },
  420_000,
);
