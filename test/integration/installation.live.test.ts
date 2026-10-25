import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { requirementsInterviewSkill } from "../../apps/factory/src/skills/reviewed";
import { callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import {
  composeProject,
  installationDirectory,
  loadInstallation,
  requireOwnedResource,
} from "../../scripts/factory/installation";

const name = process.env["FACTORY_INSTALLATION_PROOF"];
test.skipIf(!name)(
  "isolated startup, denied reset and restart retain configured state without touching the developer installation",
  async () => {
    if (!name) throw new Error("Explicit disposable installation required");
    const root = resolve(import.meta.dir, "../..");
    const installation = await loadInstallation(root, name);
    if (installation.phase !== "active")
      throw new Error("Installation proof requires an active disposable identity");
    const directory = installationDirectory(root, name);
    const base = `http://127.0.0.1:${installation.ports.factory}`;
    const resultDirectory = resolve(root, ".factory/test-results/installations", name);
    await mkdir(resultDirectory, { recursive: true });
    const started = performance.now();
    async function cli(args: string[]) {
      const process = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      return { output, error, code };
    }
    async function docker(args: string[]) {
      const value = await cli(["docker", ...args]);
      if (value.code !== 0) throw new Error(`Owned installation Docker ${args[0]} failed`);
      return value.output.trim();
    }
    async function runtimeInventory() {
      const value = await cli([
        "kubectl",
        "--context",
        "orbstack",
        "get",
        "pods",
        "--all-namespaces",
        "-l",
        "app.kubernetes.io/managed-by=open-software-factory",
        "-o",
        "json",
      ]);
      if (value.code !== 0) throw new Error("Cannot establish unrelated runtime inventory");
      return z
        .object({ items: z.array(z.object({ metadata: z.object({ uid: z.string() }) })) })
        .parse(JSON.parse(value.output))
        .items.map((item) => item.metadata.uid)
        .sort();
    }
    const beforeInventory = await runtimeInventory();
    const beforeMain = await fetch("http://127.0.0.1:3000/health/ready");
    const mainMarker = beforeMain.headers.get("x-open-factory-startup");
    expect(beforeMain.ok).toBe(true);
    const initial = await fetch(`${base}/health/ready`);
    expect(initial.headers.get("x-open-factory")).toBe("ready");
    const initialMarker = initial.headers.get("x-open-factory-startup");
    const password = (await readFile(resolve(directory, "admin-password"), "utf8")).trim();
    const login = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ email: `admin-${name}@factory.local`, password }),
    });
    expect(login.ok).toBe(true);
    const cookies = login.headers.getSetCookie();
    expect(cookies.every((item) => item.startsWith(`factory-${name}.`))).toBe(true);
    const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
    const secrets = await Promise.all(
      ["admin-password", "database-password", "zero-password", "auth-secret", "forgejo-token"].map(
        async (file) => (await readFile(resolve(directory, file), "utf8")).trim(),
      ),
    );
    if (process.env["FACTORY_MODEL_API_KEY"]) secrets.push(process.env["FACTORY_MODEL_API_KEY"]);
    async function command(path: string, method = "GET", body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      expect(response.ok).toBe(true);
      for (const secret of secrets) expect(text.includes(secret)).toBe(false);
      return JSON.parse(text) as unknown;
    }
    const model = process.env["FACTORY_AGENT_MODEL_ID"];
    if (!model) throw new Error("Configured model required");
    const defaults = await serverCall(
      callFactoryFunction(base, "getModelSettings", [], { cookie }),
    );
    const settings = await serverCall(
      callFactoryFunction(
        base,
        "saveModelSettings",
        [
          {
            version: defaults.version,
            planningModelId: model,
            buildModelId: model,
          },
        ],
        { cookie },
      ),
    );
    const skillID = crypto.randomUUID();
    const skill = await serverCall(
      callFactoryFunction(
        base,
        "publishSkill",
        [
          {
            revisionId: skillID,
            expectedRevision: 0,
            content: requirementsInterviewSkill,
          },
        ],
        { cookie },
      ),
    );
    const user = await serverCall(
      callFactoryFunction(
        base,
        "createAccount",
        [
          {
            name: "Release proof developer",
            email: `developer-${name}@factory.local`,
            password: "disposable-release-developer-password",
          },
        ],
        { cookie },
      ),
    );
    const usersBefore = await serverCall(callFactoryFunction(base, "getAccounts", [], { cookie }));
    const skillBefore = await serverCall(
      callFactoryFunction(base, "getSystemSkills", [], { cookie }),
    );
    const extraVolume = `${composeProject(installation)}_unknown-guard`;
    await writeFile(
      resolve(resultDirectory, "guard-intent.json"),
      JSON.stringify({ name: extraVolume, owner: installation.owner }),
      { mode: 0o600 },
    );
    await docker([
      "volume",
      "create",
      "--label",
      `com.docker.compose.project=${composeProject(installation)}`,
      "--label",
      `factory.dev/installation=${installation.owner}`,
      "--label",
      "factory.dev/disposable=true",
      extraVolume,
    ]);
    try {
      const rejected = await cli([
        process.execPath,
        "scripts/factory/index.ts",
        "reset",
        "--data",
        "--disposable",
        name,
        "--confirm",
        name,
      ]);
      expect(rejected.code).not.toBe(0);
      expect(rejected.error.includes("Reset refused unexpected")).toBe(true);
      for (const secret of secrets)
        expect((rejected.output + rejected.error).includes(secret)).toBe(false);
      const stillReady = await fetch(`${base}/health/ready`);
      expect(stillReady.headers.get("x-open-factory-startup")).toBe(initialMarker);
      expect(await loadInstallation(root, name)).toEqual(installation);
      expect(await serverCall(callFactoryFunction(base, "getAccounts", [], { cookie }))).toEqual(
        usersBefore,
      );
    } finally {
      const volumes = JSON.parse(await docker(["volume", "inspect", extraVolume])) as Array<{
        Labels: Record<string, string>;
      }>;
      requireOwnedResource(installation, {
        labels: volumes[0]?.Labels,
        projectLabel: "com.docker.compose.project",
      });
      await docker(["volume", "rm", extraVolume]);
    }
    const restartStarted = performance.now();
    const restarted = await cli([
      process.execPath,
      "scripts/factory/index.ts",
      "restart",
      "--disposable",
      name,
    ]);
    const restartMS = Math.round(performance.now() - restartStarted);
    expect(restarted.code).toBe(0);
    for (const secret of secrets)
      expect((restarted.output + restarted.error).includes(secret)).toBe(false);
    const current = await fetch(`${base}/health/ready`);
    expect(current.headers.get("x-open-factory-startup")).not.toBe(initialMarker);
    expect(await serverCall(callFactoryFunction(base, "getModelSettings", [], { cookie }))).toEqual(
      settings,
    );
    expect(await serverCall(callFactoryFunction(base, "getSystemSkills", [], { cookie }))).toEqual(
      skillBefore,
    );
    expect(await serverCall(callFactoryFunction(base, "getAccounts", [], { cookie }))).toEqual(
      usersBefore,
    );
    const main = await fetch("http://127.0.0.1:3000/health/ready");
    expect(main.ok).toBe(true);
    expect(main.headers.get("x-open-factory-startup")).toBe(mainMarker);
    expect(await runtimeInventory()).toEqual(beforeInventory);
    await writeFile(
      resolve(resultDirectory, "startup-restart-guard.json"),
      `${JSON.stringify({ installation: name, base, settingsRetained: true, immutableSkillRetained: true, userRetained: true, cookieRetained: true, rejectedResetBeforeStop: true, guardVolumeRemoved: true, mainListenerUntouched: true, unrelatedRuntimeUIDs: beforeInventory, restartMS, totalMS: Math.round(performance.now() - started), skill, user }, null, 2)}\n`,
    );
  },
  180_000,
);

const resetName = process.env["FACTORY_INSTALLATION_RESET_PROOF"];
test.skipIf(!resetName)(
  "confirmed reset deletes only its disposable installation and repeats without deletion",
  async () => {
    if (!resetName || resetName === name)
      throw new Error(
        "Reset proof needs its own explicit disposable installation, separate from the customer journey",
      );
    const root = resolve(import.meta.dir, "../..");
    const before = await fetch("http://127.0.0.1:3000/health/ready");
    const marker = before.headers.get("x-open-factory-startup");
    const resetID = resetName;
    async function run(action: "up" | "reset") {
      const child = Bun.spawn(
        [
          process.execPath,
          "scripts/factory/index.ts",
          action,
          "--disposable",
          resetID,
          ...(action === "reset" ? ["--data", "--confirm", resetID] : []),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { output, error, code };
    }
    const startup = await run("up");
    expect(startup.code).toBe(0);
    const installation = await loadInstallation(root, resetName);
    const first = await run("reset");
    expect(first.code).toBe(0);
    expect((await loadInstallation(root, resetName)).phase).toBe("reset");
    expect(first.output.includes("Data deletion is not recoverable")).toBe(true);
    const again = await run("reset");
    expect(again.code).toBe(0);
    expect(again.output.includes("no deletion was repeated")).toBe(true);
    expect(
      (await fetch("http://127.0.0.1:3000/health/ready")).headers.get("x-open-factory-startup"),
    ).toBe(marker);
    const resultDirectory = resolve(root, ".factory/test-results/installations", resetName);
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      resolve(resultDirectory, "reset.json"),
      `${JSON.stringify({ installation: installation.name, owner: installation.owner, disposableResourcesRemoved: true, repeatedReset: "already-confirmed", developerInstallationUntouched: true })}\n`,
    );
  },
  180_000,
);
