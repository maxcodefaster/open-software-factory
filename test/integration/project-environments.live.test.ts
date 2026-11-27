import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  createSubstrateControl,
  nativeActor,
  nativeMetadata,
} from "#runtime-kubernetes/substrate-control";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { requirePublishedRuntimeArtifacts } from "../../scripts/factory/artifacts";
import { localOpenBao } from "../../scripts/factory/openbao";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { nativeEnvironmentImage } from "../fixtures/native-environment-image";
import { requireNativeLiveHost } from "../fixtures/native-live-configuration";
import { ownedRuntimeTerminal, runtimeAccessCookie } from "../fixtures/runtime-access";
import { callFactoryFunction } from "../fixtures/server-functions";

test("native Project starts use exact protected variables without image production on save", async () => {
  const nativeConfiguration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  if (!nativeConfiguration)
    throw Error("Explicit owned native configuration is required for the live Environment proof");
  const tokenFile = process.env["FACTORY_NATIVE_RUNTIME_FORGE_TOKEN_FILE"];
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
  const publicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  const owner = process.env["FACTORY_FORGEJO_OWNER"];
  if (!tokenFile || !apiURL || !publicURL || !owner)
    throw Error("Explicit owned Forge credentials and TLS origins are required");
  requireNativeLiveHost();
  const installation = substrateInstallationConfiguration(
    await Bun.file(nativeConfiguration).json(),
  );
  const runtimeArtifacts = await requirePublishedRuntimeArtifacts(".factory");
  const developmentImage = nativeEnvironmentImage(runtimeArtifacts, installation);
  const nativeControl = createSubstrateControl(installation.connection);
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-environment-proof-"));
  const bao = await localOpenBao(directory);
  const configuration = await bao.start();
  const forgeToken = (await readFile(tokenFile, "utf8")).trim();
  const factory = await factoryProcess(
    { runtimeHostImage: runtimeArtifacts["runtime-host"], forgejoToken: forgeToken },
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
    >`SELECT id,state,failure,isolated_kind::text AS kind FROM factory.runtime_attempt
      WHERE project_id=${projectID} ORDER BY id`;
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
          projectImage: developmentImage,
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
    // Use the published immutable native image. Project Environment settings
    // do not supply image-pull authority or produce images.
    const actorTemplate = JSON.stringify({
      containers: [
        {
          name: "work",
          image: developmentImage,
          command: [
            "node",
            "-e",
            "if(!process.env.APP_TOKEN||process.env.UNGRANTED_TOKEN||process.env.VERIFICATION_ONLY)process.exit(2);require('fs').writeFileSync('hook.json',JSON.stringify({token:process.env.APP_TOKEN,multiline:process.env.MULTILINE}));",
          ],
          volumeMounts: [{ name: "source", mountPath: "/workspace" }],
        },
      ],
      volumes: [{ name: "source", durableDir: {} }],
    });
    const files: Record<string, string> = {
      ".factory/actor-template.json": actorTemplate,
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
    for (const [path, content] of Object.entries(files))
      await forge(`repos/${owner}/${name}/contents/${path}`, "POST", {
        branch: "main",
        message: "Owned environment recipe",
        content: Buffer.from(content).toString("base64"),
      });
    await factory.start();
    cookie = await factory.signIn();
    const environmentStarted = performance.now();
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
            actorTemplatePath: ".factory/actor-template.json",
          },
        ],
        { cookie },
      ),
    );
    projectID = registration.id;
    const variables = (value: string) => [
      { name: "APP_TOKEN", value, runtime: true, verification: false },
      {
        name: "MULTILINE",
        value: "owned line one\nline two",
        runtime: true,
        verification: false,
      },
      {
        name: "UNGRANTED_TOKEN",
        value: "owned-ungranted-sentinel",
        runtime: false,
        verification: false,
      },
      {
        name: "VERIFICATION_ONLY",
        value: "owned-verification-only-sentinel",
        runtime: false,
        verification: true,
      },
    ];
    expect(await attempts()).toHaveLength(0);
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
          },
        ],
        { cookie },
      );
      expect(saved.ok).toBe(true);
      expect(JSON.stringify(saved)).not.toContain("sentinel");
      const current = await serverCall(
        callFactoryFunction(factory.base, "getEnvironment", [projectID, environment], { cookie }),
      );
      expect(current.version).toBe(1);
      expect(current).not.toHaveProperty("preparation");
    }
    expect(await attempts()).toHaveLength(0);
    timings["registrationAndEnvironmentSavesMS"] = Math.round(
      performance.now() - environmentStarted,
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
    timings["nativeDevelopmentTerminalMS"] = Math.round(performance.now() - runtimeStarted);
    expect(await terminal.evaluate<string | null>("return process.env.APP_TOKEN")).toBe(
      "owned-development-sentinel",
    );
    expect(
      await terminal.evaluate<string | null>("return process.env.UNGRANTED_TOKEN??null"),
    ).toBeNull();
    expect(
      await terminal.evaluate<string | null>("return process.env.VERIFICATION_ONLY??null"),
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
        "return (await fetch('http://127.0.0.1:4300/health').then(r=>r.json())).token",
      ),
    ).toBe("owned-development-sentinel");
    // Match retained source and the actual native Actor/ActorTemplate, not
    // nested Docker containers or a preference labelled as preparation.
    const [provision] = await database.client<
      Array<{ template: { content: string } }>
    >`SELECT provision.intent->'projectTemplate' AS template FROM factory.substrate_provision provision
      JOIN factory.runtime_attempt attempt ON attempt.workspace_id=provision.owner_id
        AND provision.kind='workspace' AND attempt.generation=provision.generation WHERE attempt.id=${attemptID}`;
    expect(provision?.template.content).toBe(actorTemplate);
    expect(JSON.parse(provision?.template.content ?? "{}").containers[0].image).toBe(
      developmentImage,
    );
    const [binding] = await database.client<
      Array<{ atespace: string; actorName: string; actorUID: string }>
    >`SELECT atespace,actor_name AS "actorName",actor_uid AS "actorUID"
      FROM factory.runtime_attempt WHERE id=${attemptID} AND atespace IS NOT NULL`;
    if (!binding) throw new Error("Owned native Actor binding is missing");
    const actor = nativeActor.parse(
      await nativeControl("GetActor", {
        actor: { atespace: binding.atespace, name: binding.actorName },
      }),
    );
    expect(actor.metadata.uid).toBe(binding.actorUID);
    expect(actor.status.state).toBe("ACTOR_STATE_RUNNING");
    const template = z
      .object({
        metadata: nativeMetadata,
        containers: z.array(
          z.object({ name: z.string(), image: z.string(), command: z.array(z.string()) }),
        ),
      })
      .passthrough()
      .parse(await nativeControl("GetActorTemplate", { actorTemplate: actor.actorTemplate }));
    expect(template.metadata.atespace).toBe(binding.atespace);
    expect(template.containers.find(({ name }) => name === "work")).toMatchObject({
      image: developmentImage,
      command: ["/opt/factory-tools/usr/local/bin/factory-runtime-connector", "native-project"],
    });
    const inspection = JSON.stringify(template);
    const persistedInspection = JSON.stringify(
      await database.client`SELECT binding_intent AS intent FROM factory.runtime_attempt WHERE id=${attemptID}`,
    );
    for (const nativeConfiguration of [inspection, persistedInspection]) {
      expect(nativeConfiguration).not.toContain("owned-development-sentinel");
      expect(nativeConfiguration).not.toContain("owned-ungranted-sentinel");
      expect(nativeConfiguration).not.toContain("owned-verification-only-sentinel");
    }
    const initialAttempts = await attempts();
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
        },
      ],
      { cookie },
    );
    expect(modified.ok).toBe(true);
    expect(await attempts()).toEqual(initialAttempts);
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
    timings["nativeMainPreviewMS"] = Math.round(performance.now() - previewStarted);
    expect(
      JSON.stringify(
        await database.client`SELECT * FROM factory.operation WHERE kind='runtime.environment_intent'`,
      ),
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
