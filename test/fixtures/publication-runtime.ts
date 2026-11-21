import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { type ForgeRepository } from "../../packages/forge/src/contracts";
import { type createForgejoClient } from "../../packages/forge/src/forge";
import { releaseContract, releasePackageOwner } from "../../packages/project-domain/src/release";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { nativeActor } from "../../packages/runtime-kubernetes/src/substrate-control";
import { requirePublishedRuntimeArtifacts } from "../../scripts/factory/artifacts";
import { localOpenBao } from "../../scripts/factory/openbao";
import { requireOwnedProjectSourceRetention } from "./editor-source-resources";
import { eventually, factoryProcess } from "./factory-process";
import { nativeLiveConfiguration, requireNativeLiveHost } from "./native-live-configuration";
import { callFactoryFunction } from "./server-functions";

// Explicit live lane. This proves execution of an admitted publication intent,
// not the separate human admission or a complete native Helm journey.
export async function publicationRuntimeProof(input: {
  origin: string;
  publicOrigin: string;
  nativeConfiguration: string;
  token: string;
  repository: ForgeRepository;
  forge: ReturnType<typeof createForgejoClient>;
  preserve(inventory: { directory: string; factoryID: string; base: string }): void;
  captureFailure(): Promise<void>;
}) {
  if (!input.nativeConfiguration || !input.publicOrigin)
    throw Error("Native publication requires its explicit configuration and Forge HTTPS origin");
  requireNativeLiveHost();
  const id = crypto.randomUUID();
  const native = nativeLiveConfiguration(
    await Bun.file(input.nativeConfiguration).json(),
    `owned_${id.replaceAll("-", "")}`,
    {
      FACTORY_FORGEJO_API_URL: `${input.origin}/api/v1/`,
      FACTORY_FORGEJO_PUBLIC_URL: input.publicOrigin,
    },
  );
  const runtimeHostImage = (await requirePublishedRuntimeArtifacts(".factory"))["runtime-host"];
  const directory = resolve(".factory/test-results/releases", `runtime-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bao = await localOpenBao(directory);
  const configuration = await bao.start().catch(async (cause: unknown) => {
    await bao.dispose();
    throw cause;
  });
  const fixture = await factoryProcess(
    {
      runtimeHostImage,
      forgejoToken: input.token,
    },
    {
      ...configuration,
      FACTORY_FORGEJO_API_URL: `${input.origin}/api/v1/`,
      FACTORY_FORGEJO_PUBLIC_URL: input.publicOrigin,
      FACTORY_FORGEJO_OWNER: input.repository.owner,
      FACTORY_FORGEJO_ADMIN_TOKEN: input.token,
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: "owned-unused-model-key",
      FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: input.nativeConfiguration,
    },
  ).catch(async (cause: unknown) => {
    await bao.dispose();
    throw cause;
  });
  // Stop retains native names and history. Their owned Forge and encryption
  // dependencies must survive too, including when a later assertion fails.
  input.preserve({ directory, factoryID: fixture.id, base: fixture.base });
  const database = fixture.connect();
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    releaseID = crypto.randomUUID();
  let workFailure: unknown;
  let publishedConfirmed = false;
  let cookie = "";
  const repoPath = `repos/${input.repository.owner}/${input.repository.name}`;
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${input.origin}/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Owned publication source operation failed (${response.status})`);
    return response.json();
  }
  async function file(path: string, content: string) {
    const observed = await fetch(`${input.origin}/api/v1/${repoPath}/contents/${path}`, {
      headers: { authorization: `Bearer ${input.token}` },
    });
    const previous = observed.ok ? ((await observed.json()) as { sha: string }) : undefined;
    await api(`${repoPath}/contents/${path}`, previous ? "PUT" : "POST", {
      ...(previous ? { sha: previous.sha } : {}),
      content: Buffer.from(content).toString("base64"),
      message: "Owned native publication source",
    });
  }
  try {
    const starter = JSON.parse(await readFile(".factory/starter-images.json", "utf8")) as {
      development: string;
    };
    const starterRecipe = JSON.parse(
      await readFile("templates/starter-app/.devcontainer/devcontainer.json", "utf8"),
    ) as {
      features: Record<string, unknown>;
    };
    await file(
      ".devcontainer/devcontainer.json",
      JSON.stringify({
        image: starter.development,
        workspaceFolder: "/workspace/project",
        workspaceMount: `source=\${localWorkspaceFolder},target=/workspace/project,type=bind`,
        remoteUser: "node",
        updateRemoteUserUID: false,
        features: starterRecipe.features,
        runArgs: ["--cap-drop=ALL"],
      }),
    );
    await file(
      ".factory/release.json",
      JSON.stringify({
        schemaVersion: 1,
        files: [{ name: "proof", filename: "proof.txt" }],
      }),
    );
    await file(
      ".factory/publish.mjs",
      `
const response = await fetch(process.env.FACTORY_RELEASE_CREDENTIAL_URL, {
  method: "POST", headers: {authorization: "Bearer " + process.env.FACTORY_RELEASE_CREDENTIAL_TOKEN}
});
if (!response.ok) throw new Error("Publication credential denied: " + response.status);
const credential = await response.json();
const owner = process.argv[2];
if (credential.packageOwner !== owner) throw new Error("Package owner mismatch");
const body = "release=" + process.env.FACTORY_RELEASE_ID + "\\nsource=" + process.env.GITHUB_SHA + "\\n";
const uploaded = await fetch(process.env.FACTORY_RELEASE_REGISTRY_URL + "/api/packages/" + owner + "/generic/proof/" + process.env.FACTORY_RELEASE_VERSION + "/proof.txt", {
  method: "PUT", headers: {authorization: "Bearer " + credential.token}, body
});
if (!uploaded.ok) throw new Error("Publication upload failed: " + uploaded.status);
console.log("Owned exact-source package published");
`,
    );
    await file(
      ".forgejo/workflows/factory-release.yml",
      await readFile("templates/release/factory-release.yml", "utf8"),
    );
    const head = await input.forge.getDefaultBranch(input.repository);
    await input.forge.ensureDefaultBranchProtection(input.repository, head.name);
    const metadata = (await api(repoPath)) as { default_branch: string };
    const contract = releaseContract.parse({
      schemaVersion: 1,
      files: [{ name: "proof", filename: "proof.txt" }],
    });
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userID},'Owned publication commissioner',${`publication-${id}@factory.invalid`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`publication-${id.slice(0, 8)}`},'Owned publication',${`${input.publicOrigin}/${input.repository.owner}/${input.repository.name}.git`},
        ${metadata.default_branch},'.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
      VALUES(${projectID},${userID},'developer',true,${userID})`;
    // This proof owns publication, not the separate opportunistic prebuild producer.
    for (const environment of ["development", "main-preview"])
      await database.client`INSERT INTO factory.project_image_preparation(id,project_id,environment,revision,environment_version,state,failure)
        VALUES(${crypto.randomUUID()},${projectID},${environment},${head.headSha},0,'unsupported','Owned publication fixture uses normal startup')`;
    // This native proof resumes an admitted intent. Separate admission tests own human gates.
    await database.client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,workflow,contract,notes,created_by)
      VALUES(${releaseID},${projectID},${releaseID},'2.0.1',${head.headSha},'.forgejo/workflows/factory-release.yml',${JSON.stringify(contract)}::text::jsonb,'Owned native publication',${userID})`;
    await database.client`INSERT INTO factory.release_attempt(id,release_id,command_id,ordinal)
      VALUES(${releaseID},${releaseID},${releaseID},1)`;
    await writeFile(
      resolve(directory, "intent.json"),
      JSON.stringify({
        fixtureID: fixture.id,
        base: fixture.base,
        projectID,
        releaseID,
        commitSHA: head.headSha,
      }),
    );
    await fixture.start();
    cookie = await fixture.signIn();
    let previous = "";
    const published = await eventually(
      async () => {
        const [row] = await database.client<
          {
            state: string;
            failure: string | null;
            artifacts: unknown[];
            runtime: string | null;
            runtimeAttemptID: string | null;
            runtimeFailure: string | null;
          }[]
        >`SELECT release.state,release.failure,release.artifacts,runtime.state AS runtime,
        runtime.id AS "runtimeAttemptID",runtime.failure AS "runtimeFailure"
        FROM factory.project_release release JOIN factory.release_attempt publication ON publication.release_id=release.id
        LEFT JOIN factory.runtime_attempt runtime ON runtime.id=publication.runtime_attempt_id WHERE release.id=${releaseID}`;
        const current = `${row?.state}/${row?.runtime}`;
        if (current !== previous) {
          previous = current;
          console.info(`Owned publication: ${current}`);
          await writeFile(resolve(directory, "state.json"), JSON.stringify(row));
        }
        if (row?.state === "failed" || ["failed", "cleanup-failed"].includes(row?.runtime ?? ""))
          throw new Error(
            `Owned publication failed: ${row?.failure ?? row?.runtimeFailure ?? "unknown"}`,
          );
        return row;
      },
      (row) => row?.state === "published",
      "Owned publication did not confirm its native artifact",
      360_000,
    );
    expect(published?.artifacts).toHaveLength(1);
    expect(published?.artifacts[0]).toMatchObject({
      kind: "file",
      name: "proof",
      filename: "proof.txt",
    });
    const body = `release=${releaseID}\nsource=${head.headSha}\n`;
    const artifact = await fetch(
      `${input.origin}/api/packages/${releasePackageOwner(projectID)}/generic/proof/2.0.1/proof.txt`,
      {
        headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toBe(body);
    expect(published?.artifacts[0]).toMatchObject({
      digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    });
    const runtimeAttemptID = runtimeIdentity(releaseID, 1).attemptID;
    expect(published?.runtimeAttemptID).toBe(runtimeAttemptID);
    const [bound] = await database.client<
      {
        revision: string;
        ownerID: string;
        kind: string;
        actorUID: string;
        atespace: string;
        actorName: string;
        observation: unknown;
      }[]
    >`SELECT attempt.revision,isolated.owner_id AS "ownerID",
      isolated.kind,binding.actor_uid AS "actorUID",binding.atespace,
      binding.actor_name AS "actorName",binding.observation
      FROM factory.runtime_attempt attempt
      JOIN factory.substrate_isolated isolated ON isolated.runtime_attempt_id=attempt.id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      WHERE attempt.id=${runtimeAttemptID} AND attempt.project_id=${projectID}
        AND attempt.isolated_kind='publication' AND attempt.generation=1`;
    if (!bound) throw Error("Published artifact has no saved native publication owner");
    const observed = nativeActor.parse(bound.observation);
    const actorUID = z.uuid().parse(bound.actorUID);
    expect(bound).toMatchObject({
      revision: head.headSha,
      ownerID: releaseID,
      kind: "publication",
      atespace: `fa-${runtimeAttemptID.replaceAll("-", "")}`,
      actorName: `runtime-${runtimeAttemptID.replaceAll("-", "")}`,
    });
    expect(observed.metadata).toMatchObject({
      uid: actorUID,
      atespace: bound.atespace,
      name: bound.actorName,
    });
    expect(isDeepStrictEqual(observed.workerSelector?.matchLabels, native.workerSelector)).toBe(
      true,
    );
    await eventually(
      async () => {
        const [grant] = await database.client<{ state: string }[]>`
        SELECT state FROM factory.release_access WHERE release_id=${releaseID} AND scope='publish'`;
        return grant?.state;
      },
      (state) => state === "revoked",
      "Owned publication credential revocation is unconfirmed",
      60_000,
    );
    await writeFile(
      resolve(directory, "published.json"),
      JSON.stringify({
        ...published,
        native: {
          scope: "recorded-native-publication-binding",
          runtimeAttemptID,
          actorUID,
          atespace: bound.atespace,
          actorName: bound.actorName,
          currentLivenessProven: false,
        },
        exactArtifactBytesVerified: true,
        humanAdmissionProven: false,
        fullFactoryE2E: false,
      }),
    );
    publishedConfirmed = true;
  } catch (cause) {
    workFailure = cause;
    await input.captureFailure().catch(() => {});
  }
  const cleanupFailures: unknown[] = [];
  const cleanup = async (action: () => unknown) => {
    try {
      await action();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  };
  let stopConfirmed = false;
  let controlPlanePaused = false;
  await cleanup(async () => {
    const attempts = await database.client<
      { id: string }[]
    >`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID} AND state <> 'stopped'`;
    if (attempts.length) {
      if (!cookie) cookie = await fixture.signIn();
      for (const attempt of attempts)
        await serverCall(
          callFactoryFunction(
            fixture.base,
            "stopRuntimeAttempt",
            [attempt.id],
            {
              cookie,
              origin: fixture.base,
              "content-type": "application/json",
            },
            AbortSignal.timeout(180_000),
          ),
        );
      await eventually(
        async () => {
          const [remaining] = await database.client<{ count: number }[]>`
            SELECT count(*)::int AS count FROM factory.runtime_attempt WHERE project_id=${projectID} AND state <> 'stopped'`;
          return remaining?.count;
        },
        (count) => count === 0,
        "Owned publication cleanup is unconfirmed",
        180_000,
      );
    }
    await requireOwnedProjectSourceRetention(database, projectID);
    stopConfirmed = true;
  });
  await cleanup(async () => {
    await fixture.pause();
    controlPlanePaused = true;
  });
  await cleanup(() => database.client.end({ timeout: 2 }));
  await cleanup(() =>
    writeFile(
      resolve(directory, "retained.json"),
      JSON.stringify({
        fixtureID: fixture.id,
        base: fixture.base,
        projectID,
        releaseID,
        publicationAssertionsPassed: publishedConfirmed,
        computeStopConfirmed: stopConfirmed,
        controlPlanePaused,
        nativeResourceInventoryRetained: true,
        ownedForgeRetained: true,
        encryptionDependenciesRetained: true,
        cleanupConfirmed: cleanupFailures.length === 0,
      }),
      { flag: "wx", mode: 0o600 },
    ),
  );
  if (cleanupFailures.length)
    throw new AggregateError(
      [...(publishedConfirmed ? [] : [workFailure]), ...cleanupFailures],
      "Native publication or owned fixture shutdown failed",
    );
  if (!publishedConfirmed) throw workFailure;
  await writeFile(
    resolve(directory, "result.json"),
    JSON.stringify({
      passed: true,
      assertions: "published.json",
      retained: "retained.json",
      scope: "admitted-native-publication-execution",
      fullFactoryE2E: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
}
