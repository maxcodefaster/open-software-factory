import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { factoryProcess } from "../fixtures/factory-process";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { createSetupInspection } from "../../apps/factory/src/setup/inspection";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";

test.skipIf(process.env["FACTORY_RUN_SETUP_INSPECTION_PROOF"] !== "1")(
  "Luna inspects real exact-commit Forgejo source and confirms only missing configuration",
  async () => {
    const factory = await factoryProcess();
    const database = factory.connect();
    const projectID = crypto.randomUUID();
    const manager = crypto.randomUUID();
    const setupID = crypto.randomUUID();
    const repository = {
      owner: "factory-mutation",
      name: `owned-luna-setup-${projectID.slice(0, 8)}`,
    };
    const apiURL = "http://127.0.0.1:33030/api/v1/";
    const token = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const forge = createForgejoClient({ apiURL, token });
    let created = false;
    let preparations = 0;
    const reads = new Set<string>();
    const started = performance.now();
    try {
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${manager},'Owned Luna setup',${`${manager}@setup.test`})`;
      await forge.createSetupRepository({ repository, setupID });
      created = true;
      const application =
        "import{createServer}from'node:http';createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(req.url==='/health'?'ok':'Support desk');}).listen(4300,'0.0.0.0');\n";
      await forge.createSetupFiles({
        repository,
        setupID,
        branch: "main",
        files: [
          {
            path: "package.json",
            content: JSON.stringify({
              name: "support-desk",
              type: "module",
              scripts: { dev: "node server.js", test: "node --check server.js" },
            }),
          },
          { path: "server.js", content: application },
          {
            path: "README.md",
            content:
              "# Support desk\nInternal support desk application. Node 24, no dependencies. npm run dev starts port 4300, /health returns ok. npm test checks syntax. No environment variables or external services required.\n",
          },
        ],
      });
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
        VALUES(${projectID},${repository.name},'Support desk',${`http://127.0.0.1:33030/${repository.owner}/${repository.name}`},'main','.devcontainer/devcontainer.json',${manager})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by) VALUES(${projectID},${manager},'developer',true,${manager})`;
      const controller = createSetupInspection({
        database,
        forge: {
          ...forge,
          getFile: async (repository, path, commit) => {
            reads.add(path);
            return forge.getFile(repository, path, commit);
          },
        },
        forgeURL: apiURL,
        forgeOwner: repository.owner,
        model: async () => ({
          modelID: process.env["FACTORY_PROJECT_AGENT_MODEL"] ?? "gpt-6-luna",
          connectionID: null,
          connectionVersion: null,
        }),
        connection: async () => projectModelConnection(),
        ready: async () => {
          preparations++;
        },
      });
      const inspectionID = crypto.randomUUID();
      const before = await forge.getDefaultBranch(repository);
      await controller.start(projectID, manager, inspectionID);
      await controller.settle();
      const proposal = await controller.view(projectID, manager);
      console.log(
        JSON.stringify({
          state: proposal?.state,
          elapsedMS: Math.round(performance.now() - started),
          readPaths: [...reads],
          questions: proposal?.output?.questions.length,
          proposedPaths: proposal?.output?.files.map((file) => file.path),
        }),
      );
      expect(proposal?.state).toBe("proposal");
      expect(proposal?.output?.questions).toHaveLength(0);
      expect(proposal?.output?.services.some((service) => service.port === 4300)).toBe(true);
      expect(reads.size).toBeGreaterThan(0);
      expect((await forge.getDefaultBranch(repository)).headSha).toBe(before.headSha);
      expect(preparations).toBe(0);
      await forge.ensureDefaultBranchProtection(repository, "main", false);
      await controller.confirm(projectID, manager, inspectionID);
      expect((await controller.view(projectID, manager))?.state).toBe("confirmed");
      expect(preparations).toBe(1);
      const after = await forge.getDefaultBranch(repository);
      expect(await forge.getFile(repository, "server.js", after.headSha)).toBe(application);
      await controller.confirm(projectID, manager, inspectionID);
      expect(preparations).toBe(1);
    } finally {
      if (created && (await forge.setupRepository(repository, setupID))) {
        const deletion = await fetch(`${apiURL}repos/${repository.owner}/${repository.name}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(deletion.ok).toBe(true);
      }
      await database.client.end({ timeout: 2 });
      await factory.dispose();
    }
  },
  90_000,
);
