import { expect } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import type { createForgejoClient, ForgeRepository } from "../../packages/forge/src/forge";
import { releaseContract } from "../../packages/project-domain/src/release";
import { localOpenBao } from "../../scripts/factory/openbao";
import { eventually, factoryProcess } from "./factory-process";
import { callFactoryFunction } from "./server-functions";

// Explicit native lane. The retained installation supplies only immutable image metadata.
// Database, forge repository, secret store, Sandbox and publication belong to this proof.
export async function publicationRuntimeProof(input: {
  origin: string;
  token: string;
  repository: ForgeRepository;
  forge: ReturnType<typeof createForgejoClient>;
  preserve(): void;
  captureFailure(): Promise<void>;
}) {
  const id = crypto.randomUUID();
  const directory = resolve(".factory/test-results/releases", `runtime-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bao = await localOpenBao(directory);
  const configuration = await bao.start().catch(async (cause: unknown) => {
    await bao.dispose();
    throw cause;
  });
  const image = (name: string) =>
    readFile(`.factory/${name}-image`, "utf8").then((value) => value.trim());
  const fixture = await factoryProcess(
    {
      runtimeHostImage: await image("runtime-host"),
      forgejoToken: input.token,
    },
    {
      ...configuration,
      FACTORY_FORGEJO_API_URL: `${input.origin}/api/v1/`,
      FACTORY_FORGEJO_PUBLIC_URL: input.origin,
      FACTORY_FORGEJO_OWNER: input.repository.owner,
      FACTORY_FORGEJO_ADMIN_TOKEN: input.token,
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_MODEL_API_KEY: "owned-unused-model-key",
    },
  ).catch(async (cause: unknown) => {
    await bao.dispose();
    throw cause;
  });
  const database = fixture.connect();
  const userID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    releaseID = crypto.randomUUID();
  let safeToDispose = false;
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
      VALUES(${projectID},${`publication-${id.slice(0, 8)}`},'Owned publication',${`${input.origin}/${input.repository.owner}/${input.repository.name}.git`},
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
            namespace: string | null;
            runtimeFailure: string | null;
          }[]
        >`SELECT release.state,release.failure,release.artifacts,runtime.state AS runtime,
        runtime.kubernetes_namespace AS namespace,runtime.failure AS "runtimeFailure"
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
    await writeFile(resolve(directory, "published.json"), JSON.stringify(published));
  } catch (cause) {
    await input.captureFailure().catch(() => {});
    throw cause;
  } finally {
    try {
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
      safeToDispose = true;
    } finally {
      if (safeToDispose) {
        await database.client.end();
        await fixture.dispose();
        await bao.dispose();
      } else {
        input.preserve();
        console.error(`Owned publication resources retained for recovery: ${directory}`);
      }
    }
  }
}
