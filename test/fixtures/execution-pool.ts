import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeRuntimeArtifacts } from "../../apps/factory/src/runtime/artifacts";
import type { createReserveStore } from "../../apps/factory/src/runtime/reserve-store";
import { freezeStagingConfiguration } from "../../apps/factory/src/runtime/staging-configuration";
import { createStagingTemplateProducer } from "../../apps/factory/src/runtime/staging-template";
import type { createDatabase } from "../../packages/db/src/client";
import type { FactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import upstream from "../../upstream.json";
import { fixtureValue } from "./value";

// PostgreSQL controller fixture only. It deliberately does not claim that its
// seeded healthy Staging is a native execution proof.
export async function executionPoolFixture(
  database: ReturnType<typeof createDatabase>,
  store: ReturnType<typeof createReserveStore>,
  profile: FactoryboxRuntimeProfile,
  images: { staging: string; verification: string },
  existingProject?: { projectID: string; userID: string },
) {
  const projectID = existingProject?.projectID ?? crypto.randomUUID(),
    userID = existingProject?.userID ?? crypto.randomUUID(),
    stagingID = crypto.randomUUID();
  const source = await mkdtemp(join(tmpdir(), "factory-pool-project-"));
  await mkdir(join(source, ".factory"));
  await mkdir(join(source, ".devcontainer"));
  await writeFile(
    join(source, ".factory/system.json"),
    JSON.stringify({
      version: 1,
      primaryApp: "web",
      apps: [
        { id: "web", label: "App", command: ["node", "server.js"], port: 19472, healthPath: "/" },
      ],
    }),
  );
  await writeFile(
    join(source, ".devcontainer/devcontainer.json"),
    JSON.stringify({
      image: upstream.node.image,
      workspaceFolder: "/workspace/project",
      workspaceMount: "source=/home/coder/project,target=/workspace/project,type=bind",
      remoteUser: "node",
      updateRemoteUserUID: false,
      overrideCommand: true,
      runArgs: ["--cap-drop=NET_RAW", "--cap-drop=SYS_PTRACE", "--cpus=1", "--memory=768m"],
    }),
  );
  await writeFile(
    join(source, "server.js"),
    'const nonce=require("node:crypto").randomUUID();let counter=0;setInterval(()=>counter++,25);require("node:http").createServer((req,res)=>res.end(JSON.stringify({nonce,pid:process.pid,counter}))).listen(19472,"0.0.0.0");',
  );
  async function git(args: string[]) {
    const child = Bun.spawn(["git", "-C", source, ...args], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error("Owned pool source failed");
    return text.trim();
  }
  try {
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "owned pool",
    ]);
    const revision = await git(["rev-parse", "HEAD"]);
    const artifactConfiguration = {
      factoryboxProfile: profile,
      hostImages: {
        staging: images.staging,
        verification: images.verification,
        development: images.staging,
        build: images.staging,
      },
      browserToolsImage: `registry.invalid/browser@sha256:${"3".repeat(64)}`,
    };
    await database.client.begin(async (sql) => {
      if (!existingProject) {
        await sql`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${userID},'Pool fixture',${`${userID}@factory.invalid`},true)`;
        await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
          VALUES(${projectID},${`pool-${projectID.slice(0, 8)}`},'Owned pool',${`file://${source}`},'main','.devcontainer/devcontainer.json',${userID},'gulf-of-marseille')`;
      }
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        VALUES(${stagingID},${projectID},'staging',1,${revision},'create-intended',${"a".repeat(64)},${"b".repeat(64)},now(),${userID})`;
      await freezeRuntimeArtifacts(sql, stagingID, artifactConfiguration);
      await freezeStagingConfiguration(sql, stagingID, [
        {
          kind: "Secret",
          stringData: {
            "assignment.json": JSON.stringify({
              runtimeAttemptId: stagingID,
              repositoryIdentity: projectID,
              revision,
              devcontainerPath: ".devcontainer/devcontainer.json",
              channels: [
                { name: "app", kind: "app", target: "http://127.0.0.1:19472", healthPath: "/" },
              ],
              processes: [{ name: "app", label: "App", command: ["node", "server.js"] }],
              repositoryUrl: "https://factory.invalid/private-source-capability-do-not-capture",
              controlUrl: "ws://factory.invalid/only-this-attempt",
            }),
            "parent-token": "parent-authority-do-not-capture",
            "child-token": "child-authority-do-not-capture",
          },
        },
      ]);
      await sql`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${stagingID}`;
      await sql`INSERT INTO factory.staging_preview(project_id,revision,runtime_attempt_id) VALUES(${projectID},${revision},${stagingID})`;
    });
    await createStagingTemplateProducer(database, store, images).refresh();
    const [template] = await database.client.begin((sql) => store.plan(sql));
    if (!template || template.templateID !== null)
      throw new Error("Owned clean template intent missing");
    async function prepareTemplate() {
      await store.observe(database.client, fixtureValue(template, "template").id, {
        namespaceUID: "owned-namespace",
        podUID: "owned-pod",
        claimUID: "owned-claim",
        ready: false,
        factoryboxIdentity: { epoch: "owned" },
        factoryboxPreparation: { bundle: "owned" },
      });
      await store.intendSourceImport(
        database.client,
        fixtureValue(template, "template").id,
        "d".repeat(64),
      );
      await store.completeSourceImport(database.client, fixtureValue(template, "template").id, {
        sha256: "d".repeat(64),
      });
      await store.intendStart(database.client, fixtureValue(template, "template").id);
      await store.intendStandby(database.client, fixtureValue(template, "template").id, "pause");
      await store.observe(database.client, fixtureValue(template, "template").id, {
        namespaceUID: "owned-namespace",
        podUID: "owned-pod",
        claimUID: "owned-claim",
        ready: true,
        factoryboxPaused: true,
        factoryboxStandby: {
          sandboxID: `runtime-${fixtureValue(template, "template").id.replaceAll("-", "")}`,
          owner: "e".repeat(32),
          snapshotID: fixtureValue(template, "template").id.replaceAll("-", ""),
          checkpointSHA256: "f".repeat(64),
          inputSHA256: "a".repeat(64),
          anonymousBytes: 0,
          snapshotResidentBytes: 0,
        },
      });
      return store.get(database.client, fixtureValue(template, "template").id);
    }
    return {
      projectID,
      userID,
      stagingID,
      revision,
      source,
      template,
      artifactConfiguration,
      prepareTemplate,
      cleanup: () => rm(source, { recursive: true, force: true }),
    };
  } catch (cause) {
    await rm(source, { recursive: true, force: true });
    throw cause;
  }
}
