import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import {
  createRuntimeEnvironmentEndpoint,
  freezeRuntimeEnvironment,
} from "../../apps/factory/src/environments/runtime";
import { hashConnectorToken } from "../../packages/runtime-domain/src/identity";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

test("runtime environment freezes version, authenticates parent generation, isolates Main-Preview and explicit Verification grants", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  let ownedFixture: Awaited<ReturnType<typeof fixture>> | undefined;
  let native: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  try {
    const token = "owned-runtime-environment-token";
    const owned = await fixture(undefined, undefined, database, token);
    ownedFixture = owned;
    await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    const values = new Map<string, StoredEnvironment>();
    let credentialReads = 0;
    const secrets = {
      configured: true,
      async read(key: string) {
        credentialReads++;
        return values.get(key);
      },
      async create(key: string, value: StoredEnvironment) {
        values.set(key, value);
      },
    };
    const controller = createEnvironmentController(
      database,
      secrets,
      "owned-runtime-environment-key",
    );
    const variable = (name: string, verification: boolean) => ({
      name,
      value: `owned-${name}`,
      runtime: true,
      build: false,
      verification,
    });
    await controller.save(owned.projectID, owned.userID, "development", {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [variable("PRIVATE_DEV", false), variable("TEST_TOKEN", true)],
      registries: [
        {
          host: "private.registry.test",
          username: "robot",
          password: "owned-registry",
          verification: false,
        },
      ],
    });
    // The shared fixture already admitted its original runtime before settings
    // existed. Saving settings cannot retarget that immutable empty admission.
    expect(await freezeRuntimeEnvironment(database.client, owned.attemptID)).toMatchObject({
      environment: "development",
      version: 0,
      secretKey: null,
    });
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    const developmentAttempt = await recordUncreatedWorkspaceAttempt(database, {
      workspaceID: owned.workspaceID,
      generation: 2,
      createdBy: owned.userID,
      parentHash: hashConnectorToken(token),
      childHash: hashConnectorToken("owned-development-child"),
      connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
      state: "create-intended",
    });
    await database.client`UPDATE factory.change SET runtime_attempt_id=${developmentAttempt} WHERE id=${owned.changeID}`;
    expect((await freezeRuntimeEnvironment(database.client, developmentAttempt)).version).toBe(1);
    const endpoint = createRuntimeEnvironmentEndpoint(database, secrets);
    const request = (attemptID = developmentAttempt, authorization = token, generation = 2) =>
      new Request(`https://factory.test/internal/runtime-environment/${attemptID}`, {
        headers: {
          authorization: `Bearer ${authorization}`,
          "x-factory-runtime-generation": String(generation),
        },
      });
    expect((await endpoint(request(developmentAttempt, "wrong"), developmentAttempt)).status).toBe(
      401,
    );
    expect((await endpoint(request(developmentAttempt, token, 1), developmentAttempt)).status).toBe(
      401,
    );
    const readsBeforeBootstrap = credentialReads;
    expect((await endpoint(request(), developmentAttempt)).status).toBe(401);
    expect(credentialReads).toBe(readsBeforeBootstrap);
    // Controlled already-committed Source grant. The cold import/commit protocol
    // is exercised separately, not simulated by the environment endpoint.
    const actorUID = crypto.randomUUID();
    await database.client.begin(async (sql) => {
      await sql`UPDATE factory.substrate_binding SET actor_uid=${actorUID},create_attempted_at=now()
        WHERE runtime_attempt_id=${developmentAttempt}`;
      await sql`INSERT INTO factory.substrate_source(workspace_id,actor_uid)
        VALUES(${owned.workspaceID},${actorUID})`;
    });
    const response = await endpoint(request(), developmentAttempt);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).bundle.variables.map((v: { name: string }) => v.name)).toEqual([
      "PRIVATE_DEV",
      "TEST_TOKEN",
    ]);
    const original = [...values.entries()][0];
    if (!original) throw new Error("Owned environment credential missing");
    const [key, stored] = original;
    try {
      values.set(key, { ...stored, fingerprint: "0".repeat(64) });
      const unavailable = await endpoint(request(), developmentAttempt);
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("cache-control")).toBe("no-store");
    } finally {
      values.set(key, stored);
    }
    expect((await endpoint(request(), developmentAttempt)).status).toBe(200);
    await controller.save(owned.projectID, owned.userID, "development", {
      commandID: crypto.randomUUID(),
      version: 1,
      variables: [variable("NEW_VALUE", false), variable("TEST_TOKEN", true)],
      registries: [
        {
          host: "test.registry.test",
          username: "robot",
          password: "owned-test-registry",
          verification: true,
        },
      ],
    });
    expect((await freezeRuntimeEnvironment(database.client, developmentAttempt)).version).toBe(1);
    expect(
      (await (await endpoint(request(), developmentAttempt)).json()).bundle.variables[0].name,
    ).toBe("PRIVATE_DEV");
    const verificationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.verification(
      id,change_id,commit_sha,pull_request_number,runner_name,action_run_id,runner_uuid,
      runner_token,runner_job_handle,created_by)
      VALUES(${verificationID},${owned.changeID},${"a".repeat(40)},1,'owned-environment-runner',
        1,${crypto.randomUUID()},'owned-environment-runner-token','owned-environment-job',${owned.userID})`;
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${developmentAttempt}`;
    native = await nativeJobsFixture(database, owned.projectID);
    const verificationAttempt = await native.startVerification(verificationID, owned.userID);
    const verificationToken = native.tokens(verificationAttempt, 1).parent;
    expect(await freezeRuntimeEnvironment(database.client, verificationAttempt)).toMatchObject({
      environment: "development",
      version: 2,
    });
    // New Verification uses the current Development version, with explicit grants only.
    expect(
      (await endpoint(request(verificationAttempt, verificationToken, 2), verificationAttempt))
        .status,
    ).toBe(401);
    expect(
      (await endpoint(request(verificationAttempt, token, 1), verificationAttempt)).status,
    ).toBe(401);
    const verified = await (
      await endpoint(request(verificationAttempt, verificationToken, 1), verificationAttempt)
    ).json();
    expect(verified.bundle.variables.map((v: { name: string }) => v.name)).toEqual(["TEST_TOKEN"]);
    expect(verified.bundle.registries.map((v: { host: string }) => v.host)).toEqual([
      "test.registry.test",
    ]);
    await expect(
      database.client`UPDATE factory.runtime_environment_intent SET version=2 WHERE runtime_attempt_id=${developmentAttempt}`.execute(),
    ).rejects.toThrow("immutable");
    await controller.save(owned.projectID, owned.userID, "main-preview", {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [variable("PREVIEW_ONLY", false)],
      registries: [],
    });
    await database.client`INSERT INTO factory.staging_preview(project_id,revision)
      VALUES(${owned.projectID},${"a".repeat(40)})`;
    const stagingAttempt = await native.startStaging(owned.userID);
    const stagingToken = native.tokens(stagingAttempt, 1).parent;
    expect(await freezeRuntimeEnvironment(database.client, stagingAttempt)).toMatchObject({
      environment: "main-preview",
      version: 1,
    });
    expect(
      (
        await (await endpoint(request(stagingAttempt, stagingToken, 1), stagingAttempt)).json()
      ).bundle.variables.map((v: { name: string }) => v.name),
    ).toEqual(["PREVIEW_ONLY"]);
    await database.client`UPDATE factory.runtime_attempt SET state='stopping',stop_intended_at=now() WHERE id=${verificationAttempt}`;
    expect(
      (await endpoint(request(verificationAttempt, verificationToken, 1), verificationAttempt))
        .status,
    ).toBe(401);
    expect((await endpoint(request(), developmentAttempt)).status).toBe(401);
    expect((await endpoint(request(owned.attemptID, token, 1), owned.attemptID)).status).toBe(401);
    expect(
      JSON.stringify(await database.client`SELECT * FROM factory.runtime_environment_intent`),
    ).not.toContain("owned-PRIVATE_DEV");
  } finally {
    try {
      await native?.close();
      await database.client.end();
      await process.dispose();
    } finally {
      ownedFixture?.restoreEnvironment();
    }
  }
}, 60_000);
