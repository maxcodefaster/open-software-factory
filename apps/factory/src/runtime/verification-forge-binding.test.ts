import { expect, test } from "bun:test";
import { drizzleTransaction } from "../../../../packages/db/src/client";
import {
  forgeBinding,
  forgeBindingDatabase,
  forgeRepositoryBindingMatrix,
  useForgeBindingEnvironment,
} from "../../../../test/support/forge-repository-binding";
import { createRuntimeController } from "./controller";
import type { RuntimeHub } from "./hub";
import type { SubstrateInstallationConfiguration } from "./substrate-workspaces";

test("Verification binds before Forge lookup or retained-job execution and preserves exact receipts", async () => {
  const actor = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const verificationID = crypto.randomUUID();
  const commit = "a".repeat(40);
  const requests: string[] = [];
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer owned-binding-test-token");
      const path = new URL(request.url).pathname;
      requests.push(path);
      return Response.json(
        path.endsWith("/jobs")
          ? [
              {
                run_id: 4,
                handle: "owned-exact-job",
                runs_on: ["factory-verification"],
                status: "waiting",
              },
            ]
          : {
              id: 4,
              commit_sha: commit,
              event: "pull_request",
              workflow_id: "factory-verification.yml",
            },
      );
    },
  });
  const binding = { ...forgeBinding, apiURL: `${forge.url}api/v1/` };
  const restore = useForgeBindingEnvironment(binding);
  const { accepted, malformed } = forgeRepositoryBindingMatrix(binding);
  let repository = "";
  let handle: string | null = null;
  let runID: string | null = "4";
  let available = true;
  let changedAuthority = false;
  let starts = 0;
  let nativeCalls = 0;
  const receipts: unknown[][] = [];
  const fixture = forgeBindingDatabase(
    (text) => {
      throw new Error(`Unexpected Verification query: ${text}`);
    },
    (text, parameters) => {
      if (text.startsWith('select "factory"."change"."project_id"')) return [[projectID]];
      if (text.startsWith('select "factory"."verification"."runner_job_handle"'))
        return [[handle, runID, commit, repository]];
      if (text.startsWith('update "factory"."verification"')) {
        expect(text).toContain('coalesce("factory"."verification"."runner_job_handle", $1)');
        expect(text).toContain('"factory"."verification"."action_run_id" = $3');
        expect(text).toContain('"factory"."verification"."commit_sha" = $4');
        expect(text).toContain('"factory"."verification"."state" in ($5, $6, $7)');
        expect(parameters).toEqual([
          "owned-exact-job",
          verificationID,
          4,
          commit,
          "pending",
          "runner-starting",
          "running",
        ]);
        if (changedAuthority) return [];
        receipts.push(parameters);
        handle = "owned-exact-job";
        return [[handle]];
      }
      if (text.includes('"auth"."user"')) return [[actor]];
      if (text.includes('"factory"."account_access"')) return [[null, null]];
      if (text.includes('"factory"."project_membership"'))
        return available ? [["developer", false]] : [];
      if (text.includes('"factory"."administrator"')) return [];
      if (text.includes('"factory"."project"')) return [[projectID]];
      throw new Error(`Unexpected Verification authority query: ${text}`);
    },
  );
  fixture.database.db = drizzleTransaction(fixture.database.client);
  fixture.database.coordination = () => {
    starts++;
    throw new Error("Owned test stops at the Verification provisioning boundary");
  };
  const connection = {
    bridge: "/not-dispatched",
    endpoint: "owned.invalid:443",
    serverName: "api.ate-system.svc" as const,
    caFile: "/not-read",
    tokenFile: "/not-read",
  };
  const configuration: SubstrateInstallationConfiguration = {
    deployment: "owned-test",
    database: `owned_${"a".repeat(32)}`,
    connection,
    provisioner: connection,
    editorPrincipal: "user:system:serviceaccount:owned:factory",
    connectorURL: "wss://factory.invalid/internal/runtime-connect",
    factoryCAFile: "/not-read",
    workloadImage: `registry.invalid/owned@sha256:${"a".repeat(64)}`,
    profile: "nightly-20261109-975fb172241c",
    runtime: {
      sandboxClass: "gvisor",
      version: { schemaVersion: "v1", attributes: [{ key: "owned", value: "fixture" }] },
    },
    workerSelector: {
      "factory.runtime/profile": "nightly-20261109-975fb172241c",
      "factory.dev/deployment": "owned",
    },
    egressHosts: ["git.native.test"],
  };
  const call = async () => {
    nativeCalls++;
    throw new Error("Malformed binding cannot call Substrate");
  };
  try {
    const controller = createRuntimeController(
      fixture.database,
      { onAppRunning() {} } as unknown as RuntimeHub,
      "owned-secret",
      { configuration, call, provisionerCall: call },
    );
    for (const value of accepted) {
      repository = value.url;
      handle = null;
      await expect(controller.startVerification(verificationID, actor)).rejects.toThrow(
        "provisioning boundary",
      );
      expect(requests.slice(-2)).toEqual([
        `/api/v1/repos/owned/${value.repository.name}/actions/runs/4`,
        `/api/v1/repos/owned/${value.repository.name}/actions/runs/4/jobs`,
      ]);
      const before = requests.length;
      const saved = receipts.length;
      await expect(controller.startVerification(verificationID, actor)).rejects.toThrow(
        "provisioning boundary",
      );
      expect(requests).toHaveLength(before);
      expect(receipts).toHaveLength(saved);
    }
    const before = { requests: requests.length, receipts: receipts.length, starts };
    for (repository of malformed) {
      for (handle of [null, "owned-exact-job"])
        for (runID of ["4", null])
          await expect(controller.startVerification(verificationID, actor)).rejects.toThrow(
            "outside the configured forge",
          );
      expect(requests).toHaveLength(before.requests);
      expect(receipts).toHaveLength(before.receipts);
      expect(starts).toBe(before.starts);
    }
    repository = accepted[0]?.url ?? "";
    available = false;
    await expect(controller.startVerification(verificationID, actor)).rejects.toMatchObject({
      code: "not-found",
    });
    expect(requests).toHaveLength(before.requests);
    available = true;
    handle = null;
    runID = "4";
    changedAuthority = true;
    await expect(controller.startVerification(verificationID, actor)).rejects.toThrow(
      "Verification job authority changed before execution",
    );
    expect(receipts).toHaveLength(before.receipts);
    expect(starts).toBe(before.starts);
    expect(nativeCalls).toBe(0);
  } finally {
    restore();
    await forge.stop(true);
  }
});
