import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { releaseInstallation } from "../fixtures/release-installation";

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
      const endpoints = [
        "/api/session",
        "/api/projects",
        `/api/runtime-attempts?projectId=${project}`,
        `/api/changes?projectId=${project}`,
        `/api/changes/${f.state.dependentChangeID}/agent`,
        `/api/projects/${project}/model-settings`,
        `/api/projects/${project}/skill-settings`,
        `/api/projects/${project}/conversation?ticketId=${f.state.ticketID}`,
      ];
      for (const path of endpoints) await f.command(developer, path);
      await f.command(admin, "/api/model-settings");
      await f.command(admin, "/api/admin/skills");
      expect((await f.request(outsider, `/api/projects/${project}/model-settings`)).status).toBe(
        404,
      );
      const runtimes = await f.database.client<
        { id: string; namespace: string; state: string }[]
      >`SELECT id, kubernetes_namespace AS namespace, state FROM factory.runtime_attempt WHERE project_id = ${project} AND state IN ('ready', 'starting')`;
      for (const runtime of runtimes) {
        const child = Bun.spawn(
          [
            "kubectl",
            "--context",
            "orbstack",
            "-n",
            runtime.namespace,
            "get",
            "secret",
            "runtime-assignment",
            "-o",
            "json",
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        if (exit !== 0) throw new Error("Exact release assignment could not be inspected");
        const secret = JSON.parse(text) as {
          metadata: { labels: Record<string, string> };
          data: Record<string, string>;
        };
        expect(secret.metadata.labels["factory.dev/project"]).toBe(project);
        const assignment = Buffer.from(secret.data["assignment.json"] ?? "", "base64").toString();
        f.noSecrets(assignment);
        expect((JSON.parse(assignment) as { runtimeAttemptId: string }).runtimeAttemptId).toBe(
          runtime.id,
        );
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
        endpoints,
        runtimeIDs: runtimes.map(({ id }) => id),
        sourceFiles: files.length,
        negativeProviderAndForgeProbes: true,
      });
    } finally {
      await f.close();
    }
  },
  60_000,
);
