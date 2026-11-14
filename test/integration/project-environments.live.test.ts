import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { localOpenBao } from "../../scripts/factory/openbao";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { requireNativeLiveHost } from "../fixtures/native-live-configuration";
import { nativeRegistryInputs } from "../fixtures/native-registry-inputs";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { callFactoryFunction } from "../fixtures/server-functions";
import { fixtureValue } from "../fixtures/value";

test("registered Project automatically prebuilds and uses exact secure Development/Main-Preview values in hooks, app and PTY", async () => {
  const nativeConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  if (!nativeConfiguration)
    throw Error("Explicit owned native configuration is required for the live Environment proof");
  const registryFile = process.env["FACTORY_NATIVE_REGISTRY_FIXTURE"];
  const tokenFile = process.env["FACTORY_NATIVE_RUNTIME_FORGE_TOKEN_FILE"];
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
  const publicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  const owner = process.env["FACTORY_FORGEJO_OWNER"];
  if (!registryFile || !tokenFile || !apiURL || !publicURL || !owner)
    throw Error("Explicit owned native registry, Forge credentials and TLS origins are required");
  requireNativeLiveHost();
  const registry = nativeRegistryInputs(
    await Bun.file(registryFile).json(),
    substrateInstallationConfiguration(await Bun.file(nativeConfiguration).json()),
  );
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-environment-proof-"));
  const bao = await localOpenBao(directory);
  const configuration = await bao.start();
  const image = (name: string) =>
    readFile(`.factory/${name}-image`, "utf8").then((value) => value.trim());
  const forgeToken = (await readFile(tokenFile, "utf8")).trim();
  const factory = await factoryProcess(
    { runtimeHostImage: await image("runtime-host"), forgejoToken: forgeToken },
    {
      ...configuration,
      FACTORY_MODEL_BASE_URL: "http://127.0.0.1:9/v1",
      FACTORY_FORGEJO_API_URL: apiURL,
      FACTORY_FORGEJO_PUBLIC_URL: publicURL,
      FACTORY_FORGEJO_OWNER: owner,
      FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION: nativeConfiguration,
    },
  ).catch(async (cause: unknown) => {
    await bao.dispose();
    await rm(directory, { recursive: true });
    throw cause;
  });
  const database = factory.connect();
  const name = `environment-${crypto.randomUUID().slice(0, 8)}`;
  const artifacts = join(".factory/test-results/project-environments", name);
  await mkdir(artifacts, { recursive: true });
  const timings: Record<string, number> = {};
  let projectID = "";
  let cookie = "";
  let created = false;
  let workFailure: unknown;
  let terminal: Awaited<ReturnType<typeof ownedRuntimeTerminal>> | undefined;
  async function forge(path: string, method: string, body?: unknown) {
    const response = await fetch(apiURL + path, {
      method,
      headers: { authorization: `token ${forgeToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Owned repository ${method} failed with ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  const attempts = () =>
    database.client<
      Array<{
        id: string;
        state: string;
        failure: string | null;
        kind: string | null;
      }>
    >`SELECT id,state,failure,isolated_kind::text AS kind FROM factory.runtime_attempt WHERE project_id=${projectID}`;
  async function retainNativeFixture() {
    let cleanupFailure: unknown;
    let stopConfirmed = false;
    try {
      if (projectID) {
        for (const row of await attempts())
          if (row.state !== "stopped")
            await serverCall(
              callFactoryFunction(
                factory.base,
                "stopRuntimeAttempt",
                [row.id],
                { cookie, origin: factory.base, "content-type": "application/json" },
                AbortSignal.timeout(180_000),
              ),
            );
        await requireOwnedProjectSourceRetention(database, projectID);
      }
      stopConfirmed = !!projectID;
    } catch (cause) {
      cleanupFailure = cause;
    }
    try {
      await factory.pause();
    } catch (cause) {
      cleanupFailure = cleanupFailure
        ? new AggregateError(
            [cleanupFailure, cause],
            "Native Stop and control-plane shutdown failed",
          )
        : cause;
    }
    try {
      await writeFile(
        join(artifacts, "retained.json"),
        JSON.stringify({
          projectID,
          factoryID: factory.id,
          base: factory.base,
          repository: { owner, name, created },
          timings,
          computeStopConfirmed: stopConfirmed,
          sourceRetentionConfirmed: stopConfirmed,
          nativeResourceInventoryRetained: true,
          openBaoDirectory: directory,
          commissionedRegistryUnchanged: true,
        }),
      );
    } finally {
      await database.client.end({ timeout: 2 });
    }
    if (cleanupFailure) {
      if (workFailure)
        throw new AggregateError(
          [workFailure, cleanupFailure],
          "Environment proof and native fixture shutdown failed",
        );
      throw cleanupFailure;
    }
  }
  try {
    await forge("user/repos", "POST", {
      name,
      private: true,
      auto_init: true,
      default_branch: "main",
    });
    created = true;
    const files: Record<string, string> = {
      ".devcontainer/devcontainer.json": JSON.stringify({
        build: {
          dockerfile: "Dockerfile",
          context: "..",
          options: ["--secret", "id=BUILD_TOKEN,src=/run/factory-build-secrets/BUILD_TOKEN"],
        },
        workspaceFolder: "/workspace/project",
        workspaceMount: `source=\${localWorkspaceFolder},target=/workspace/project,type=bind`,
        remoteUser: "node",
        runArgs: ["--cap-drop=ALL"],
        features: { "./feature": {}, [registry.feature]: {} },
        onCreateCommand: [
          "node",
          "-e",
          "if(!process.env.APP_TOKEN)process.exit(2);require('fs').writeFileSync('hook.json',JSON.stringify({token:process.env.APP_TOKEN,multiline:process.env.MULTILINE}));",
        ],
      }),
      ".devcontainer/Dockerfile": `FROM ${registry.developmentImage}\nRUN --mount=type=secret,id=BUILD_TOKEN node -e "const fs=require('fs');if(fs.existsSync('/run/secrets/BUILD_TOKEN'))fs.writeFileSync('/opt/build-grant',String(fs.readFileSync('/run/secrets/BUILD_TOKEN').length));else fs.writeFileSync('/opt/build-grant','not-granted');"\n`,
      ".factory/system.json": JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          {
            id: "web",
            label: "Web",
            command: ["node", "app.mjs"],
            port: 4300,
            healthPath: "/health",
          },
        ],
      }),
      "app.mjs":
        "import{createServer}from'node:http';createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({configured:!!process.env.APP_TOKEN,token:process.env.APP_TOKEN,multiline:process.env.MULTILINE}));}).listen(4300,'0.0.0.0');\n",
    };
    files[".devcontainer/feature/devcontainer-feature.json"] = JSON.stringify({
      id: "owned",
      version: "1.0.0",
      name: "Owned Feature",
      postCreateCommand: ["node", "-e", "require('fs').writeFileSync('feature-hook.txt','ran')"],
    });
    files[".devcontainer/feature/install.sh"] =
      "#!/bin/sh\nset -eu\nprintf prepared > /opt/owned-feature\n";
    files[".devcontainer/devcontainer.json"] = fixtureValue(
      files[".devcontainer/devcontainer.json"],
      'files[".devcontainer/devcontainer.json"]',
    ).replace(/}$/, ", // authored JSONC\n}");
    for (const [path, content] of Object.entries(files))
      await forge(`repos/${owner}/${name}/contents/${path}`, "POST", {
        branch: "main",
        message: "Owned environment recipe",
        content: Buffer.from(content).toString("base64"),
      });
    await factory.start();
    cookie = await factory.signIn();
    const preparationStarted = performance.now();
    const registration = await serverCall(
      callFactoryFunction(
        factory.base,
        "registerProject",
        [
          {
            slug: name,
            name: "Owned environment journey",
            repositoryUrl: `${publicURL}/${owner}/${name}.git`,
            defaultBranch: "main",
            devcontainerPath: ".devcontainer/devcontainer.json",
          },
        ],
        { cookie },
      ),
    );
    projectID = registration.id;
    const variables = (value: string) => [
      { name: "APP_TOKEN", value, runtime: true, build: false, verification: false },
      {
        name: "MULTILINE",
        value: "owned line one\nline two",
        runtime: true,
        build: false,
        verification: false,
      },
      {
        name: "BUILD_TOKEN",
        value: "owned-build-sentinel",
        runtime: false,
        build: true,
        verification: false,
      },
    ];
    for (const environment of ["development", "main-preview"] as const) {
      const saved = await callFactoryFunction(
        factory.base,
        "saveEnvironment",
        [
          projectID,
          environment,
          {
            commandID: crypto.randomUUID(),
            version: 0,
            variables: variables(`owned-${environment}-sentinel`),
            registries: [
              {
                host: registry.host,
                username: registry.username,
                password: registry.password,
                certificate: registry.certificate,
                verification: false,
                publish: true,
              },
            ],
          },
        ],
        { cookie },
      );
      expect(saved.ok).toBe(true);
      expect(JSON.stringify(saved)).not.toContain("sentinel");
    }
    await eventually(
      async () => {
        const rows = await database.client<
          Array<{ state: string; version: string; failure: string | null }>
        >`SELECT state,environment_version::text AS version,failure FROM factory.project_image_preparation WHERE project_id=${projectID} AND environment_version=1`;
        if (rows.some((row) => row.state === "failed")) {
          const failed = (await attempts()).find((row) => row.kind === "prebuild" && row.failure);
          throw new Error(failed?.failure ?? "Automatic Project preparation failed");
        }
        return rows;
      },
      (rows) => rows.length === 2 && rows.every((row) => row.state === "succeeded"),
      "Automatic secure Project preparation did not succeed",
      300_000,
    );
    timings["registrationThroughBothPreparedImagesMS"] = Math.round(
      performance.now() - preparationStarted,
    );
    const runtimeStarted = performance.now();
    const ensured = await serverCall(
      callFactoryFunction(
        factory.base,
        "startPersonalWorkspace",
        [projectID],
        { cookie, origin: factory.base, "content-type": "application/json" },
        AbortSignal.timeout(180_000),
      ),
    );
    const attemptID = ensured.id;
    if (typeof attemptID !== "string") throw new Error("Owned runtime admission failed");
    const current = await eventually(
      async () => {
        const row = (await attempts()).find((a) => a.id === attemptID);
        if (row?.state === "failed") throw new Error(row.failure ?? "Owned runtime failed");
        return row;
      },
      (row) => row?.state === "ready",
      "Owned Development runtime was not ready",
      180_000,
    );
    if (!current) throw new Error("Missing Development runtime");
    const sourceStarted = performance.now();
    const source = await serverCall(
      callFactoryFunction(factory.base, "ensurePersonalSource", [projectID], { cookie }),
    );
    await eventually(
      async () =>
        (
          await serverCall(
            callFactoryFunction(factory.base, "getWorkspaceSource", [source.workspaceID], {
              cookie,
            }),
          )
        ).state,
      (state) => state === "ready",
      "Owned native Source did not become ready after initial Start",
      150_000,
    );
    timings["sourceReadyMS"] = Math.round(performance.now() - sourceStarted);
    terminal = await ownedRuntimeTerminal(factory.base, cookie, attemptID);
    timings["preparedDevelopmentTerminalMS"] = Math.round(performance.now() - runtimeStarted);
    expect(await terminal.evaluate<string | null>("return process.env.APP_TOKEN")).toBe(
      "owned-development-sentinel",
    );
    expect(
      await terminal.evaluate<string | null>("return process.env.BUILD_TOKEN??null"),
    ).toBeNull();
    expect(await terminal.evaluate<string | null>("return process.env.MULTILINE")).toBe(
      "owned line one\nline two",
    );
    expect(
      await terminal.evaluate<string | null>(
        "return JSON.parse(require('fs').readFileSync('hook.json','utf8')).token",
      ),
    ).toBe("owned-development-sentinel");
    expect(
      await terminal.evaluate<string | null>(
        "return require('fs').readFileSync('/opt/build-grant','utf8')",
      ),
    ).toBe(String("owned-build-sentinel".length));
    expect(
      await terminal.evaluate<string | null>(
        "return (await fetch('http://127.0.0.1:4300/health').then(r=>r.json())).token",
      ),
    ).toBe("owned-development-sentinel");
    // Use the authenticated Dev Container PTY, never a worker/host runtime exec.
    const inspection = await terminal.evaluate<string>(
      `const cp=require("node:child_process");const ids=cp.execFileSync("docker",["ps","-q","--filter",${JSON.stringify(`label=factory.dev/runtime-attempt=${attemptID}`)}],{encoding:"utf8"}).trim().split(/\\s+/).filter(Boolean);if(!ids.length)throw Error("No owned Dev Container");return cp.execFileSync("docker",["inspect",...ids],{encoding:"utf8"});`,
    );
    expect(inspection).not.toContain("owned-development-sentinel");
    expect(inspection).not.toContain("owned-build-sentinel");
    expect(inspection).not.toContain(registry.password);
    const privateManifest = await fetch(
      `https://${registry.host}/v2/${registry.developmentImage.slice(registry.host.length + 1).split("@")[0]}/manifests/${registry.developmentImage.split("@")[1]}`,
      { tls: { ca: registry.certificate }, signal: AbortSignal.timeout(10_000) },
    );
    expect(privateManifest.status).toBe(401);
    expect(
      await terminal.evaluate<string>(
        "return require('fs').readFileSync('/opt/owned-feature','utf8')",
      ),
    ).toBe("prepared");
    expect(
      await terminal.evaluate<string>(
        "return require('fs').readFileSync('feature-hook.txt','utf8')",
      ),
    ).toBe("ran");
    expect(
      await terminal.evaluate<string>(
        "return require('fs').readFileSync('/opt/owned-remote-feature','utf8')",
      ),
    ).toBe("prepared");
    expect(
      await terminal.evaluate<string>(
        "return require('fs').readFileSync('remote-feature-hook.txt','utf8')",
      ),
    ).toBe("ran");
    const containers = JSON.parse(inspection) as Array<{
      Config: { Image: string; Labels: Record<string, string> };
    }>;
    const [prepared] = await database.client<
      Array<{ image: string }>
    >`SELECT image FROM factory.project_image_preparation WHERE project_id=${projectID} AND environment='development' AND environment_version=1 AND state='succeeded'`;
    expect(containers[0]?.Config.Image).toBe(prepared?.image);
    expect(containers[0]?.Config.Labels["factory.dev/prebuild-input"]).toMatch(/^[a-f0-9]{64}$/);
    const modified = await callFactoryFunction(
      factory.base,
      "saveEnvironment",
      [
        projectID,
        "development",
        {
          commandID: crypto.randomUUID(),
          version: 1,
          variables: variables("owned-new-development"),
          registries: [],
        },
      ],
      { cookie },
    );
    expect(modified.ok).toBe(true);
    expect(await terminal.evaluate<string | null>("return process.env.APP_TOKEN")).toBe(
      "owned-development-sentinel",
    );
    terminal.close();
    terminal = undefined;
    await serverCall(
      callFactoryFunction(
        factory.base,
        "stopRuntimeAttempt",
        [attemptID],
        { cookie, origin: factory.base, "content-type": "application/json" },
        AbortSignal.timeout(180_000),
      ),
    );
    const initialStaging = (await attempts()).filter((a) => a.kind === "staging");
    for (const row of initialStaging)
      if (row.state !== "stopped")
        await serverCall(
          callFactoryFunction(
            factory.base,
            "stopRuntimeAttempt",
            [row.id],
            { cookie, origin: factory.base, "content-type": "application/json" },
            AbortSignal.timeout(180_000),
          ),
        );
    const previewStarted = performance.now();
    const preview = await serverCall(
      callFactoryFunction(
        factory.base,
        "ensureStaging",
        [projectID],
        { cookie, origin: factory.base, "content-type": "application/json" },
        AbortSignal.timeout(180_000),
      ),
    );
    await eventually(
      async () => (await attempts()).find((a) => a.id === preview.id)?.state,
      (state) => state === "ready",
      "Main-Preview restart was not ready",
      180_000,
    );
    const previewCookie = await runtimeAccessCookie(factory.base, cookie, preview.id, "app");
    expect(
      (
        await (
          await fetch(`${factory.base}/runtime/${preview.id}/app/health`, {
            headers: { cookie: previewCookie },
          })
        ).json()
      ).token,
    ).toBe("owned-main-preview-sentinel");
    timings["preparedMainPreviewMS"] = Math.round(performance.now() - previewStarted);
    expect(
      JSON.stringify(await database.client`SELECT * FROM factory.runtime_environment_intent`),
    ).not.toContain("sentinel");
  } catch (cause) {
    workFailure = cause;
    await writeFile(
      join(artifacts, "failure.json"),
      JSON.stringify({
        error: cause instanceof Error ? cause.message : String(cause),
        timings,
      }),
    );
    throw cause;
  } finally {
    terminal?.close();
    // Native logical names/history are retained after Actor Stop. Do not drop
    // their database, private Source or encryption dependencies as "cleanup".
    await retainNativeFixture();
  }
}, 720_000);
