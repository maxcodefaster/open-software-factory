import { expect } from "bun:test";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page, expect as visible } from "@playwright/test";
import { z } from "zod";
import { createDatabase } from "#db/client";
import { runtimeIdentity } from "#runtime-domain/identity";
import { runCommand } from "#runtime-kubernetes/command";
import {
  createSubstrateControl,
  type SubstrateConnection,
  SubstrateRPCError,
  substrateConnection,
} from "#runtime-kubernetes/substrate-control";
import {
  type requireSubstrateActor,
  substrateTemplateSHA256,
} from "../../apps/factory/src/runtime/substrate";
import { boundNativeProvisioningResource } from "../../apps/factory/src/runtime/substrate-bound-provisioning";
import { installationDirectory, loadInstallation } from "../../scripts/factory/installation";
import {
  requireNativeForgeOrigin,
  requireNativeInstallation,
} from "../../scripts/factory/native-installation";
import { retainedFactoryServerContainer } from "../../scripts/factory/server-container";
import { openProjectMenu } from "./project-menu";

// Read-only bridge adapter. Keep the original connection and process user;
// a source launcher on macOS can execute the Linux bridge in its confirmed server.
export function releaseNativeControl(
  directory: string,
  original: SubstrateConnection,
  execute = runCommand,
) {
  const { bridge, ...connection } = substrateConnection.parse(original);
  async function context() {
    const available = await Promise.all(
      (
        [
          [bridge, constants.X_OK],
          [connection.caFile, constants.R_OK],
          [connection.tokenFile, constants.R_OK],
        ] as const
      ).map(([file, mode]) =>
        access(file, mode).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (available.every(Boolean)) return [];
    const receipt = await retainedFactoryServerContainer(directory);
    if (!receipt?.containerID)
      throw new Error(
        "Original native paths unavailable and no confirmed Factory server container",
      );
    const inspected = await execute([
      "docker",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}',
      receipt.containerID,
    ]);
    if (inspected.exitCode !== 0) throw new Error("Original Factory server container unavailable");
    const actual = JSON.parse(inspected.stdout);
    if (
      actual.id !== receipt.containerID ||
      actual.name !== `/${receipt.name}` ||
      actual.image !== receipt.image ||
      actual.labels?.["factory.dev/server-owner"] !== receipt.owner ||
      actual.labels?.["factory.dev/server-startup"] !== receipt.startupID ||
      actual.running !== true
    )
      throw new Error(
        "Refusing native observation in a different or stopped Factory server container",
      );
    // docker exec otherwise inherits every Factory credential. The native
    // bridge receives only PATH, just as createSubstrateControl does.
    return [
      "docker",
      "exec",
      "-i",
      receipt.containerID,
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ];
  }
  return {
    async call(method: string, request: unknown): Promise<unknown> {
      z.enum(["GetActor", "GetActorTemplate", "GetAtespace"]).parse(method);
      const prefix = await context();
      if (!prefix.length)
        return z
          .record(z.string(), z.unknown())
          .parse(await createSubstrateControl({ bridge, ...connection })(method, request));
      const result = await execute(
        [...prefix, bridge],
        JSON.stringify({ ...connection, method, request }),
        { timeoutMS: 185_000, outputBytes: 2 << 20 },
      );
      if (result.exitCode !== 0) throw new Error("Original native bridge response unavailable");
      const value: unknown = JSON.parse(result.stdout);
      const failure = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(value);
      if (failure.success)
        throw new SubstrateRPCError(failure.data.error.code, failure.data.error.message);
      return z.record(z.string(), z.unknown()).parse(value);
    },
    async credential() {
      const prefix = await context();
      const result = prefix.length
        ? await execute([...prefix, "/usr/bin/cat", "--", connection.tokenFile], undefined, {
            timeoutMS: 15_000,
            outputBytes: 64 << 10,
          })
        : { exitCode: 0, stdout: await readFile(connection.tokenFile, "utf8") };
      if (result.exitCode !== 0 || !result.stdout.trim())
        throw new Error("Original native credential unavailable");
      return result.stdout.trim();
    },
  };
}

export async function readReleaseNativeTemplate(
  native: ReturnType<typeof releaseNativeControl>,
  binding: Awaited<ReturnType<typeof readReleaseNativeBinding>>,
) {
  const space = boundNativeProvisioningResource.parse(
    await native.call("GetAtespace", { atespace: { name: binding.atespace } }),
  );
  const original = await native.call("GetActorTemplate", {
    actorTemplate: { atespace: binding.atespace, name: "runtime" },
  });
  const template = boundNativeProvisioningResource.parse(original);
  if (
    space.metadata.name !== binding.atespace ||
    space.metadata.uid !== binding.intent.atespaceUID ||
    template.metadata.atespace !== binding.atespace ||
    template.metadata.name !== "runtime" ||
    template.metadata.uid !== binding.intent.templateUID ||
    template.metadata.version !== binding.intent.templateVersion ||
    substrateTemplateSHA256(original) !== binding.intent.templateSHA256
  )
    throw new Error("Release native Atespace/template differs from its frozen original binding");
  return original;
}

export async function readReleaseNativeBinding(
  database: ReturnType<typeof createDatabase>,
  projectID: string,
  attemptID: string,
) {
  type Bound = Parameters<typeof requireSubstrateActor>[1];
  const [row] = await database.client<
    Array<
      Bound & {
        id: string;
        projectID: string;
        workspaceID: string | null;
        generation: number;
        state: string;
        stopIntendedAt: string | null;
        deletedAt: string | null;
        rejected: boolean;
      }
    >
  >`
    SELECT attempt.id,attempt.project_id AS "projectID",attempt.workspace_id AS "workspaceID",
      attempt.generation::float8 AS generation,attempt.state,attempt.stop_intended_at::text AS "stopIntendedAt",
      attempt.atespace,attempt.actor_name AS "actorName",attempt.actor_uid AS "actorUID",
      attempt.create_attempted_at::text AS "attemptedAt",attempt.binding_intent AS intent,
      attempt.deleted_at::text AS "deletedAt",attempt.create_rejected AS rejected
    FROM factory.runtime_attempt attempt
    WHERE attempt.id=${z.uuid().parse(attemptID)} AND attempt.project_id=${z.uuid().parse(projectID)}`;
  if (!row?.intent || !row.actorUID || !row.attemptedAt || row.rejected)
    throw new Error("Release attempt has no confirmed original native binding");
  const ownerID =
    "workspaceID" in row.intent
      ? row.intent.workspaceID
      : "isolatedID" in row.intent
        ? row.intent.isolatedID
        : row.intent.verificationID;
  if (
    !ownerID ||
    row.intent.projectID !== projectID ||
    row.intent.generation !== row.generation ||
    (row.workspaceID !== null && row.workspaceID !== ownerID) ||
    runtimeIdentity(ownerID, row.generation).attemptID !== attemptID ||
    row.atespace !== `fa-${attemptID.replaceAll("-", "")}` ||
    row.actorName !== `runtime-${attemptID.replaceAll("-", "")}`
  )
    throw new Error("Release native binding differs from its original Attempt/Workspace identity");
  substrateConnection.parse(row.intent.connection);
  return { ...row, actorUID: row.actorUID };
}

const stateInput = z
  .object({
    installation: z.string(),
    projectID: z.uuid().optional(),
    ticketID: z.uuid().optional(),
    dependentTicketID: z.uuid().optional(),
    rootEpicID: z.uuid().optional(),
    childEpicID: z.uuid().optional(),
    planningSkillID: z.uuid().optional(),
    buildSkillID: z.uuid().optional(),
    editedRevisionID: z.uuid().optional(),
    changeID: z.uuid().optional(),
    buildCommandID: z.uuid().optional(),
    inspectionCommandID: z.uuid().optional(),
    inspectionRetryCommandID: z.uuid().optional(),
    dependentChangeID: z.uuid().optional(),
    dependentCommandID: z.uuid().optional(),
    dependentRetryCommandID: z.uuid().optional(),
    verifiedSHA: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    deliveredSHA: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    completed: z.array(z.string()),
    timings: z.record(z.string(), z.number()),
  })
  .strict();
export type ReleaseState = z.infer<typeof stateInput>;

export function releaseRepositoryURL(
  forgejoPort: number,
  environment: Record<string, string | undefined> = process.env,
) {
  const native = requireNativeInstallation(environment, { database: "factory" });
  return new URL(
    "/factory-mutation/runtime-fixture.git",
    requireNativeForgeOrigin(
      {
        ...environment,
        FACTORY_FORGEJO_API_URL: `http://127.0.0.1:${forgejoPort}/api/v1/`,
      },
      native,
    ),
  ).href;
}

export async function releaseInstallation(name: string) {
  const root = resolve(import.meta.dir, "../..");
  const installation = await loadInstallation(root, name);
  if (installation.phase !== "active")
    throw new Error("Release journey requires an active disposable installation");
  const directory = installationDirectory(root, name);
  const evidence = resolve(root, ".factory/test-results/release-proof", name);
  await mkdir(evidence, { recursive: true });
  const stateFile = resolve(evidence, "journey.json");
  const stored = await readFile(stateFile, "utf8").catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  });
  const state = stateInput.parse(
    stored ? JSON.parse(stored) : { installation: name, completed: [], timings: {} },
  );
  if (state.installation !== name)
    throw new Error("Release journey identity differs from installation");
  const base = `http://127.0.0.1:${installation.ports.factory}`;
  const repositoryURL = releaseRepositoryURL(installation.ports.forgejo);
  const secret = async (file: string) => (await readFile(resolve(directory, file), "utf8")).trim();
  const databasePassword = await secret("database-password");
  const original = process.env["DATABASE_URL"];
  let database: ReturnType<typeof createDatabase>;
  try {
    process.env["DATABASE_URL"] =
      `postgresql://factory:${databasePassword}@127.0.0.1:${installation.ports.postgres}/factory`;
    database = createDatabase(2);
  } finally {
    if (original === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = original;
  }
  const secrets = await Promise.all(
    [
      "admin-password",
      "database-password",
      "zero-password",
      "auth-secret",
      "forgejo-token",
      "forgejo-admin-token",
    ].map(secret),
  );
  const native = (connection: SubstrateConnection) => {
    const control = releaseNativeControl(directory, connection);
    return {
      ...control,
      async credential() {
        const token = await control.credential();
        if (!secrets.includes(token)) secrets.push(token);
        return token;
      },
    };
  };
  const configuration = requireNativeInstallation(process.env, { database: "factory" });
  await native(configuration.connection).credential();
  await native(configuration.provisioner).credential();
  const providerKey = process.env["FACTORY_MODEL_API_KEY"];
  if (providerKey) secrets.push(providerKey);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] }
      : {}),
  });
  const pageErrors = new Map<Page, string[]>();
  const slug = `release-${name}`;
  const credentials = (role: "admin" | "manager" | "developer" | "outsider") => ({
    email: `${role}-${name}@factory.local`,
    password:
      role === "admin"
        ? (secrets[0] ?? "")
        : role === "developer"
          ? "disposable-release-developer-password"
          : "disposable-release-account-password",
  });
  async function login(role: "admin" | "manager" | "developer" | "outsider") {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify(credentials(role)),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Release ${role} sign-in failed with ${response.status}`);
    return response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
  }
  function noSecrets(text: string) {
    for (const value of secrets) expect(text.includes(value)).toBe(false);
  }
  function sanitize(text: string) {
    return secrets.reduce((value, secret) => value.replaceAll(secret, "<REDACTED>"), text);
  }
  async function page(role: "admin" | "manager" | "developer") {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", (error) => errors.push((error.stack ?? error.message).slice(0, 4_000)));
    await page.goto(base);
    try {
      await page.getByLabel("Email").waitFor({ timeout: 5_000 });
    } catch {
      await page.screenshot({ path: resolve(evidence, `signin-${role}-failure.png`) });
      const safeErrors = errors.map((error) =>
        secrets.reduce((text, value) => text.replaceAll(value, "<REDACTED>"), error),
      );
      await writeFile(
        resolve(evidence, `signin-${role}-failure.json`),
        JSON.stringify({
          errors: safeErrors,
          body: (await page.locator("body").innerText()).slice(0, 2_000),
        }),
        { mode: 0o600 },
      );
      throw new Error(
        "Release login UI did not render; inspect its local screenshot and sanitized browser errors",
      );
    }
    await page.getByLabel("Email").fill(credentials(role).email);
    await page.getByLabel("Password").fill(credentials(role).password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await visible(page.getByRole("region", { name: "Ticket board" })).toBeVisible();
    expect(
      errors.map((error) =>
        secrets.reduce((text, value) => text.replaceAll(value, "<REDACTED>"), error),
      ),
    ).toEqual([]);
    return page;
  }
  async function selectProject(page: Page) {
    await openProjectMenu(page);
    await page.getByRole("button").filter({ hasText: slug }).click();
  }
  async function save(stage: string, elapsedMS: number) {
    state.completed = [...new Set([...state.completed, stage])];
    state.timings[stage] = Math.round(elapsedMS);
    await writeFile(`${stateFile}.next`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(`${stateFile}.next`, stateFile);
  }
  return {
    installation,
    native,
    state,
    database,
    browser,
    base,
    slug,
    repositoryURL,
    evidence,
    credentials,
    login,
    noSecrets,
    sanitize,
    page,
    selectProject,
    save,
    async record(name: string, value: unknown) {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid release evidence name");
      const text = `${JSON.stringify(value, null, 2)}\n`;
      noSecrets(text);
      await writeFile(resolve(evidence, `${name}.json`), text, { mode: 0o600 });
    },
    async capture(label: string) {
      const sanitize = (value: string) =>
        secrets.reduce((text, secret) => text.replaceAll(secret, "<REDACTED>"), value);
      for (const [index, [page, errors]] of [...pageErrors.entries()].entries()) {
        if (page.isClosed()) continue;
        await page.screenshot({ path: resolve(evidence, `${label}-page-${index}.png`) });
        await writeFile(
          resolve(evidence, `${label}-page-${index}.json`),
          JSON.stringify({
            body: sanitize((await page.locator("body").innerText()).slice(0, 6_000)),
            errors: errors.map(sanitize),
          }),
          { mode: 0o600 },
        );
      }
    },
    async close() {
      await browser.close();
      await database.client.end();
    },
  };
}
