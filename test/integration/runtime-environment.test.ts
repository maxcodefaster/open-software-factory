import { expect, test } from "bun:test";
import { createEnvironmentController } from "../../apps/factory/src/environments/controller";
import type { StoredEnvironment } from "../../apps/factory/src/environments/openbao";
import {
  createRuntimeEnvironmentEndpoint,
  freezeRuntimeEnvironment,
} from "../../apps/factory/src/environments/runtime";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("runtime environment freezes version, authenticates parent generation, isolates Main-Preview and explicit Verification grants", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    const token = "owned-runtime-environment-token";
    const owned = await fixture(undefined, undefined, database, token);
    await database.client`UPDATE factory.project_membership SET manage_project=true WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await database.client`UPDATE factory.runtime_attempt SET state='create-intended' WHERE id=${owned.attemptID}`;
    const values = new Map<string, StoredEnvironment>();
    const secrets = {
      configured: true,
      async read(key: string) {
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
    expect((await freezeRuntimeEnvironment(database.client, owned.attemptID)).version).toBe(1);
    const endpoint = createRuntimeEnvironmentEndpoint(database, secrets);
    const request = (authorization = token, generation = 1) =>
      new Request(`https://factory.test/internal/runtime-environment/${owned.attemptID}`, {
        headers: {
          authorization: `Bearer ${authorization}`,
          "x-factory-runtime-generation": String(generation),
        },
      });
    expect((await endpoint(request("wrong"), owned.attemptID)).status).toBe(401);
    expect((await endpoint(request(token, 2), owned.attemptID)).status).toBe(401);
    const response = await endpoint(request(), owned.attemptID);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).bundle.variables.map((v: { name: string }) => v.name)).toEqual([
      "PRIVATE_DEV",
      "TEST_TOKEN",
    ]);
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
    expect((await freezeRuntimeEnvironment(database.client, owned.attemptID)).version).toBe(1);
    expect(
      (await (await endpoint(request(), owned.attemptID)).json()).bundle.variables[0].name,
    ).toBe("PRIVATE_DEV");
    const verificationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,created_by) VALUES(${verificationID},${owned.changeID},${"a".repeat(40)},1,'owned-environment-runner',${owned.userID})`;
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    const verificationAttempt = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,verification_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${verificationAttempt},project_id,NULL,${verificationID},'verification',2,revision,'create-intended',parent_connector_token_hash,child_connector_token_hash,now(),created_by FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    await freezeRuntimeEnvironment(database.client, verificationAttempt);
    // New Verification uses the current Development version, with explicit grants only.
    const verified = await (await endpoint(request(token, 2), verificationAttempt)).json();
    expect(verified.bundle.variables.map((v: { name: string }) => v.name)).toEqual(["TEST_TOKEN"]);
    expect(verified.bundle.registries.map((v: { host: string }) => v.host)).toEqual([
      "test.registry.test",
    ]);
    await expect(
      database.client`UPDATE factory.runtime_environment_intent SET version=2 WHERE runtime_attempt_id=${owned.attemptID}`.execute(),
    ).rejects.toThrow("immutable");
    await controller.save(owned.projectID, owned.userID, "main-preview", {
      commandID: crypto.randomUUID(),
      version: 0,
      variables: [variable("PREVIEW_ONLY", false)],
      registries: [],
    });
    const stagingAttempt = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${stagingAttempt},project_id,'staging',1,revision,'create-intended',parent_connector_token_hash,child_connector_token_hash,now(),created_by FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    expect(await freezeRuntimeEnvironment(database.client, stagingAttempt)).toMatchObject({
      environment: "main-preview",
      version: 1,
    });
    expect(
      (await (await endpoint(request(), stagingAttempt)).json()).bundle.variables.map(
        (v: { name: string }) => v.name,
      ),
    ).toEqual(["PREVIEW_ONLY"]);
    await database.client`UPDATE factory.runtime_attempt SET stop_intended_at=now() WHERE id=${verificationAttempt}`;
    expect((await endpoint(request(token, 2), verificationAttempt)).status).toBe(401);
    expect((await endpoint(request(), owned.attemptID)).status).toBe(401);
    expect(
      JSON.stringify(await database.client`SELECT * FROM factory.runtime_environment_intent`),
    ).not.toContain("owned-PRIVATE_DEV");
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
