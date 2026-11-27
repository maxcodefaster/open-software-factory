import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import {
  readReleaseNativeBinding,
  readReleaseNativeTemplate,
  releaseInstallation,
} from "../fixtures/release-installation";
import { callFactoryFunction } from "../fixtures/server-functions";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "release browser, exact assignments, compact outcomes and source contain no installation secrets",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const f = await releaseInstallation(installation);
    try {
      const admin = await f.login("admin");
      const developer = await f.login("developer");
      const outsider = await f.login("outsider");
      const project = f.state.projectID;
      if (!project) throw new Error("Release Project required");
      if (!f.state.dependentChangeID || !f.state.ticketID)
        throw new Error("Completed dependent Change and release Ticket required");
      for (const result of [
        await serverCall(
          callFactoryFunction(f.base, "getRuntimeAttempts", [project], { cookie: developer }),
        ),
        await serverCall(
          callFactoryFunction(f.base, "getChanges", [project], { cookie: developer }),
        ),
        await serverCall(
          callFactoryFunction(f.base, "getAgentView", [f.state.dependentChangeID], {
            cookie: developer,
          }),
        ),
        await serverCall(
          callFactoryFunction(
            f.base,
            "getConversation",
            [project, { ticketId: f.state.ticketID }],
            { cookie: developer },
          ),
        ),
        await serverCall(callFactoryFunction(f.base, "getProjects", [], { cookie: developer })),
        await serverCall(callFactoryFunction(f.base, "getBootstrap", [], { cookie: developer })),
        await serverCall(
          callFactoryFunction(f.base, "getProjectModels", [project], { cookie: developer }),
        ),
        await serverCall(callFactoryFunction(f.base, "getModelSettings", [], { cookie: admin })),
        await serverCall(
          callFactoryFunction(f.base, "getSkillLibrary", [project], { cookie: developer }),
        ),
        await serverCall(callFactoryFunction(f.base, "getSkillLibrary", [], { cookie: admin })),
      ])
        f.noSecrets(JSON.stringify(result));
      expect(
        await callFactoryFunction(f.base, "getProjectModels", [project], { cookie: outsider }),
      ).toMatchObject({ ok: false, status: 404 });
      const runtimes = await f.database.client<{ id: string }[]>`
        SELECT id FROM factory.runtime_attempt WHERE project_id=${project}
        AND state IN ('ready','starting') ORDER BY id`;
      expect(runtimes.length).toBeGreaterThan(0);
      const templates = [];
      for (const runtime of runtimes) {
        const binding = await readReleaseNativeBinding(f.database, project, runtime.id);
        const native = f.native(binding.intent.connection);
        const original = await readReleaseNativeTemplate(native, binding);
        // Inspect the entire credential-bearing frozen native specification,
        // not Factory's deliberately compact metadata or redacted API output.
        const text = JSON.stringify(original);
        f.noSecrets(text);
        const credential = await native.credential();
        expect(text.includes(credential)).toBe(false);
        expect(() => f.noSecrets(`negative native disclosure probe ${credential}`)).toThrow();
        const template = z
          .object({
            containers: z.array(
              z.object({
                name: z.string(),
                env: z.array(z.object({ name: z.string(), value: z.string() })),
              }),
            ),
          })
          .parse(original);
        const environments = template.containers
          .flatMap((container) => container.env)
          .filter(({ name }) => name === "FACTORY_SUBSTRATE_BOOTSTRAP");
        expect(environments.length).toBe(1);
        const bootstrap = z
          .object({
            sourceHandoff: z.boolean(),
            assignment: z.object({
              runtimeAttemptId: z.uuid(),
              generation: z.number().int().positive(),
              repositoryIdentity: z.uuid(),
              controlUrl: z.string(),
            }),
            source: z.object({ projectId: z.uuid(), workspaceId: z.uuid() }),
          })
          .parse(JSON.parse(environments[0]?.value ?? ""));
        expect(bootstrap).toMatchObject({
          sourceHandoff: Boolean(binding.workspaceID),
          assignment: {
            runtimeAttemptId: runtime.id,
            generation: binding.generation,
            repositoryIdentity: project,
            controlUrl: binding.intent.connectorURL,
          },
          source: { projectId: project, workspaceId: binding.workspaceID ?? runtime.id },
        });
        templates.push({
          attemptID: runtime.id,
          templateUID: binding.intent.templateUID,
          version: binding.intent.templateVersion,
          sha256: binding.intent.templateSHA256,
        });
      }
      const outcomes = await f.database
        .client`SELECT outcome_summary FROM factory.agent_turn WHERE project_id = ${project}`;
      f.noSecrets(JSON.stringify([...outcomes]));
      const browserEvidence = await f.database
        .client`SELECT browser.inspection_context FROM factory.build_browser_session browser JOIN factory.change change ON change.id = browser.change_id WHERE change.project_id = ${project}`;
      f.noSecrets(JSON.stringify([...browserEvidence]));
      const root = resolve(import.meta.dir, "../..");
      const listed = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const files = (await new Response(listed.stdout).text())
        .trim()
        .split("\n")
        .filter((path) => /\.(ts|tsx|js|mjs|json|sql|md|ya?ml|example)$/.test(path));
      expect(await listed.exited).toBe(0);
      for (const path of files) f.noSecrets(await readFile(resolve(root, path), "utf8"));
      const providerKey = process.env["FACTORY_MODEL_API_KEY"];
      if (!providerKey) throw new Error("Configured provider key required for disclosure proof");
      expect(() => f.noSecrets(`negative disclosure probe ${providerKey}`)).toThrow();
      const forgeToken = await readFile(
        resolve(root, ".factory/installations", installation, "forgejo-token"),
        "utf8",
      );
      expect(() => f.noSecrets(`negative disclosure probe ${forgeToken.trim()}`)).toThrow();
      await f.record("secret-disclosure-check", {
        functions: [
          "getRuntimeAttempts",
          "getChanges",
          "getAgentView",
          "getConversation",
          "getProjects",
          "getBootstrap",
          "getProjectModels",
          "getModelSettings",
          "getSkillLibrary",
          "getSkillLibrary",
        ],
        runtimeIDs: runtimes.map(({ id }) => id),
        nativeTemplates: templates,
        sourceFiles: files.length,
        negativeProviderAndForgeProbes: true,
        negativeNativeCredentialProbes: true,
      });
    } finally {
      await f.close();
    }
  },
  60_000,
);
