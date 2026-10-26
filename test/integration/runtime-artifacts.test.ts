import { expect, test } from "bun:test";
import {
  freezeRuntimeArtifacts,
  type RuntimeArtifactConfiguration,
} from "../../apps/factory/src/runtime/artifacts";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

const image = (name: string, digest: string) =>
  `registry.invalid/${name}@sha256:${digest.repeat(64)}`;
const configuration = {
  factoryboxProfile: {
    image: image("worker", "5"),
    executableSHA256: "6".repeat(64),
    architecture: "amd64",
    nodeName: "owned-node",
    kernel: "6.12.0",
    boundedBytes: 8589934592,
    claimGiB: 32,
  },
  hostImages: {
    development: image("development", "1"),
    staging: image("development", "1"),
    build: image("build", "2"),
    verification: image("verification", "3"),
  },
  browserToolsImage: image("browser", "4"),
} satisfies RuntimeArtifactConfiguration;

test("runtime artifact selection follows persisted role, freezes before create and retains pins across recovery", async () => {
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    const owned = await fixture(undefined, undefined, database);
    const [build] = await database.client<Array<{ workspaceID: string }>>`
      SELECT workspace_id AS "workspaceID" FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
    if (!build) throw new Error("Missing owned Build attempt");
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    const verificationID = crypto.randomUUID();
    await database.client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,created_by)
      VALUES(${verificationID},${owned.changeID},${"a".repeat(40)},1,'owned-artifact-runner',${owned.userID})`;
    const personalID = crypto.randomUUID();
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${personalID},${owned.projectID},'personal',${owned.userID},'main',${"a".repeat(40)},${owned.userID})`;
    for (const [index, role] of (
      ["development", "build", "verification", "staging", "publication"] as const
    ).entries()) {
      const attemptID = crypto.randomUUID();
      const workspaceID =
        role === "build" ? build.workspaceID : role === "development" ? personalID : null;
      const isolatedKind =
        role === "verification" || role === "staging" || role === "publication" ? role : null;
      await database.client`INSERT INTO factory.runtime_attempt(id,project_id,change_id,workspace_id,verification_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${attemptID},${owned.projectID},${role === "build" ? owned.changeID : null},${workspaceID},${role === "verification" ? verificationID : null},${isolatedKind},${index + 2},${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID})`;
      const first = await freezeRuntimeArtifacts(database.client, attemptID, configuration);
      const [location] = await database.client<Array<{ workerID: string }>>`
        SELECT factorybox_worker_id AS "workerID" FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!location) throw new Error("Missing Runtime Attempt worker");
      const artifactRole = role === "publication" ? "verification" : role;
      expect(first).toEqual({
        workerID: location.workerID,
        reserveSlotID: null,
        role: artifactRole,
        runtimeHostImage: configuration.hostImages[artifactRole],
        browserToolsImage: role === "build" ? configuration.browserToolsImage : null,
        environmentVersion: 0,
        factoryboxProfile: configuration.factoryboxProfile,
      });
      const changed: RuntimeArtifactConfiguration = {
        hostImages: {
          development: undefined,
          build: undefined,
          verification: undefined,
          staging: undefined,
        },
        browserToolsImage: undefined,
      };
      expect(await freezeRuntimeArtifacts(database.client, attemptID, changed)).toEqual(first);
      await expect(
        (async () => {
          await database.client`UPDATE factory.runtime_artifact_intent SET runtime_host_image=${image("changed", "5")} WHERE runtime_attempt_id=${attemptID}`;
        })(),
      ).rejects.toThrow("immutable");
      await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${attemptID}`;
      expect(await freezeRuntimeArtifacts(database.client, attemptID, changed)).toEqual(first);
    }
    const stoppedID = crypto.randomUUID();
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${stoppedID},${owned.projectID},${personalID},9,${"a".repeat(40)},'stop-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID})`;
    await expect(freezeRuntimeArtifacts(database.client, stoppedID, configuration)).rejects.toThrow(
      "active create intent",
    );
    expect(
      await database.client`SELECT runtime_attempt_id FROM factory.runtime_artifact_intent WHERE runtime_attempt_id=${stoppedID}`,
    ).toHaveLength(0);
    const invalidID = crypto.randomUUID();
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${stoppedID}`;
    await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      VALUES(${invalidID},${owned.projectID},${personalID},10,${"a".repeat(40)},'create-intended',${"b".repeat(64)},${"c".repeat(64)},now(),${owned.userID})`;
    await expect(
      freezeRuntimeArtifacts(database.client, invalidID, {
        ...configuration,
        hostImages: {
          ...configuration.hostImages,
          development: "registry.invalid/development:latest",
        },
      }),
    ).rejects.toThrow("exact image digest");
    await expect(
      (async () => {
        await database.client`INSERT INTO factory.runtime_artifact_intent(runtime_attempt_id,role,runtime_host_image,browser_tools_image)
        VALUES(${invalidID},'build',${configuration.hostImages.build},${configuration.browserToolsImage})`;
      })(),
    ).rejects.toThrow("matching active create intent");
    expect(
      await database.client`SELECT runtime_attempt_id FROM factory.runtime_artifact_intent WHERE runtime_attempt_id=${invalidID}`,
    ).toHaveLength(0);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
  }
}, 30_000);
