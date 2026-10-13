import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createProjectSetupController } from "../../apps/factory/src/setup/controller";
import { createImportSecrets } from "../../apps/factory/src/setup/secrets";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { localOpenBao } from "../../scripts/factory/openbao";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { assistedImportRuntime } from "../fixtures/assisted-import-runtime";
import { removeOwnedProjectSources } from "../fixtures/editor-source-resources";

test.skipIf(process.env["FACTORY_RUN_PRIVATE_IMPORT_PROOF"] !== "1")(
  "private HTTPS import transfers exact history, branches and tags once and removes its encrypted token",
  async () => {
    const retained = process.env["FACTORY_ASSISTED_IMPORT_RESUME"]
      ? z
          .object({
            id: z.uuid(),
            base: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
            directory: z.string().startsWith(tmpdir()).includes("factory-owned-private-import-"),
            container: z.string().regex(/^factory-owned-import-forge-[a-f0-9-]{36}$/),
            projectID: z.uuid(),
            sourceSetupID: z.uuid().optional(),
            repository: z.object({
              owner: z.literal("factory-mutation"),
              name: z.string().regex(/^owned-import-[a-f0-9]{8}$/),
            }),
          })
          .strict()
          .parse(JSON.parse(process.env["FACTORY_ASSISTED_IMPORT_RESUME"]))
      : undefined;
    const directory =
      retained?.directory ?? (await mkdtemp(join(tmpdir(), "factory-owned-private-import-")));
    const id = retained
      ? z.uuid().parse(retained.container.replace("factory-owned-import-forge-", ""))
      : crypto.randomUUID();
    const container = `factory-owned-import-forge-${id}`;
    const name = `owned-import-${id.slice(0, 8)}`;
    const repository = { owner: "factory-mutation", name };
    const sourceSetupID = retained?.sourceSetupID ?? crypto.randomUUID();
    const bao = await localOpenBao(directory);
    const runtimeProof = process.env["FACTORY_RUN_ASSISTED_IMPORT_RUNTIME_PROOF"] === "1";
    let factory: Awaited<ReturnType<typeof factoryProcess>> | undefined;
    let database: ReturnType<Awaited<ReturnType<typeof factoryProcess>>["connect"]> | undefined;
    let succeeded = false;
    let cookie = "";
    let importedProjectID = "";
    const sourceToken = (await readFile(".factory/forgejo-token", "utf8")).trim();
    const source = createForgejoClient({
      apiURL: "http://127.0.0.1:33030/api/v1/",
      token: sourceToken,
    });
    let sourceCreated = false;
    let destinationCreated = false;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    async function command(args: string[]) {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0)
        throw new Error(`Owned import ${args[0]} operation failed. Sensitive output suppressed.`);
      return output.trim();
    }
    async function sourceAPI(path: string, body: unknown) {
      const response = await fetch(
        `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${name}/${path}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${sourceToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.ok).toBe(true);
      return response.json();
    }
    try {
      const configuration = await bao.start();
      if (retained) {
        expect(
          await command([
            "docker",
            "inspect",
            "--format",
            '{{index .Config.Labels "factory.owned-private-import"}}',
            container,
          ]),
        ).toBe(id);
        const port = (await command(["docker", "port", container, "3000/tcp"])).split(":").at(-1);
        const origin = `http://127.0.0.1:${port}`;
        const token = await command([
          "docker",
          "exec",
          container,
          "forgejo",
          "admin",
          "user",
          "generate-access-token",
          "--username",
          repository.owner,
          "--token-name",
          `owned-continuation-${crypto.randomUUID()}`,
          "--scopes",
          "all",
          "--raw",
        ]);
        factory = await factoryProcess(
          {
            runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
            forgejoToken: token,
          },
          {
            ...configuration,
            FACTORY_FORGEJO_API_URL: `${origin}/api/v1/`,
            FACTORY_FORGEJO_OWNER: repository.owner,
            FACTORY_FORGEJO_ADMIN_TOKEN: token,
          },
          retained,
        );
        database = factory.connect();
        importedProjectID = retained.projectID;
        destinationCreated = true;
        sourceCreated = retained.sourceSetupID !== undefined;
        await factory.start();
        cookie = await factory.signIn();
        if (process.env["FACTORY_ASSISTED_IMPORT_CLEANUP_ONLY"] === "1") {
          const api = (path: string) =>
            fetch(factory!.base + path, {
              method: "POST",
              headers: { cookie, origin: factory!.base, "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(60_000),
            });
          const attempts = await database.client<
            { id: string; state: string }[]
          >`SELECT id,state FROM factory.runtime_attempt WHERE project_id=${importedProjectID}`;
          for (const attempt of attempts) {
            if (attempt.state === "stopped") continue;
            expect((await api(`/api/runtime-attempts/${attempt.id}/stop`)).ok).toBe(true);
            await eventually(
              async () =>
                (
                  await database!
                    .client`SELECT state FROM factory.runtime_attempt WHERE id=${attempt.id}`
                )[0]?.["state"],
              (state) => state === "stopped",
              "Owned import Stop pending",
              150_000,
            );
          }
          await removeOwnedProjectSources(database, importedProjectID, (workspace) =>
            api(`/api/workspaces/${workspace}/source/stop`),
          );
          succeeded = true;
          return;
        }
        const forge = createForgejoClient({ apiURL: `${origin}/api/v1/`, token });
        const head = await forge.getDefaultBranch(repository);
        const sourceFiles = await Promise.all(
          (await forge.listFiles(repository, head.headSha))
            .filter(
              (file) =>
                !file.path.startsWith(".devcontainer/") &&
                !file.path.startsWith(".factory/") &&
                !file.path.startsWith(".forgejo/"),
            )
            .map(async (file) => ({
              path: file.path,
              content: await forge.getFile(repository, file.path, head.headSha),
            })),
        );
        await assistedImportRuntime({
          factory,
          projectID: importedProjectID,
          cookie,
          forge,
          repository,
          sourceCommit: head.headSha,
          sourceFiles,
        });
        succeeded = true;
        return;
      }
      const caDirectory = await command(["mise", "exec", "--", "mkcert", "-CAROOT"]);
      await command([
        "mise",
        "exec",
        "--",
        "mkcert",
        "-cert-file",
        join(directory, "cert.pem"),
        "-key-file",
        join(directory, "key.pem"),
        "host.orb.internal",
      ]);
      await source.createSetupRepository({ repository, setupID: sourceSetupID });
      sourceCreated = true;
      const sourceFiles = runtimeProof
        ? (await starterFiles()).filter(
            (file) =>
              !file.path.startsWith(".devcontainer/") &&
              !file.path.startsWith(".factory/") &&
              !file.path.startsWith(".forgejo/"),
          )
        : [{ path: "README.md", content: "# Imported product\n" }];
      if (runtimeProof) {
        const readme = {
          path: "README.md",
          content:
            "# Imported Starter\nMinimal Solid/PostgreSQL/Drizzle/Better Auth web app with signup, login and protected home.\n",
        };
        sourceFiles.push(readme);
        readme.content +=
          "\nDevelopment uses Node 24 and PostgreSQL 16, a Compose service named postgres with database/user app. npm ci, npm run db:migrate, npm run dev on port 4300 with /health, npm run check. Required secure environment settings: DATABASE_URL, POSTGRES_PASSWORD and BETTER_AUTH_SECRET. Database URL uses app:POSTGRES_PASSWORD at postgres:5432/app. These values are entered in Factory Settings, never committed.\n";
      }
      await source.createSetupFiles({
        repository,
        setupID: sourceSetupID,
        branch: "main",
        files: sourceFiles,
      });
      const first = await source.getDefaultBranch(repository);
      await sourceAPI("contents/application.txt", {
        message: "Second source commit",
        content: Buffer.from("preserve imported source\n").toString("base64"),
        branch: "main",
      });
      const head = await source.getDefaultBranch(repository);
      await sourceAPI("branches", {
        new_branch_name: "feature/retained",
        old_ref_name: first.headSha,
      });
      await sourceAPI("tags", { tag_name: "v0.1.0", target: first.headSha });
      let authenticatedRequests = 0;
      proxy = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        tls: {
          cert: await readFile(join(directory, "cert.pem")),
          key: await readFile(join(directory, "key.pem")),
        },
        async fetch(request) {
          const url = new URL(request.url);
          if (!url.pathname.startsWith(`/${repository.owner}/${name}.git/`))
            return new Response(null, { status: 404 });
          if (request.headers.has("authorization")) authenticatedRequests++;
          const headers = new Headers(request.headers);
          headers.delete("host");
          const response = await fetch(`http://127.0.0.1:33030${url.pathname}${url.search}`, {
            method: request.method,
            headers,
            ...(request.body ? { body: request.body } : {}),
            redirect: "manual",
          });
          const forwarded = new Headers(response.headers);
          forwarded.delete("content-encoding");
          forwarded.delete("content-length");
          return new Response(response.body, { status: response.status, headers: forwarded });
        },
      });
      await command([
        "docker",
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `factory.owned-private-import=${id}`,
        "--tmpfs",
        "/var/lib/gitea:uid=1000,gid=1000",
        "--tmpfs",
        "/etc/gitea:uid=1000,gid=1000",
        "--mount",
        `type=bind,src=${join(caDirectory, "rootCA.pem")},dst=/tmp/factory-ca.pem,readonly`,
        "--env",
        "SSL_CERT_FILE=/tmp/factory-ca.pem",
        "--env",
        "GIT_SSL_CAINFO=/tmp/factory-ca.pem",
        "--env",
        "FORGEJO__security__INSTALL_LOCK=true",
        "--env",
        "FORGEJO__database__DB_TYPE=sqlite3",
        "--env",
        "FORGEJO__migrations__ALLOWED_DOMAINS=host.orb.internal",
        "--env",
        "FORGEJO__migrations__ALLOW_LOCALNETWORKS=false",
        "--env",
        "FORGEJO__service__DISABLE_REGISTRATION=true",
        "--publish",
        "127.0.0.1::3000",
        "codeberg.org/forgejo/forgejo:15.0.10-rootless@sha256:6ffebd9ab9ee9f6677e3523fa60debd9de630ff2a226fa681d6cc0c7ba541d77",
      ]);
      destinationCreated = true;
      const port = (await command(["docker", "port", container, "3000/tcp"])).split(":").at(-1);
      const origin = `http://127.0.0.1:${port}`;
      await eventually(
        () => fetch(`${origin}/api/healthz`).catch(() => null),
        (r) => r?.ok === true,
        "Owned import forge unavailable",
        30000,
      );
      await command([
        "docker",
        "exec",
        container,
        "forgejo",
        "admin",
        "user",
        "create",
        "--username",
        repository.owner,
        "--random-password",
        "--email",
        `${id}@import.test`,
        "--must-change-password=false",
        "--admin=true",
      ]);
      const token = await command([
        "docker",
        "exec",
        container,
        "forgejo",
        "admin",
        "user",
        "generate-access-token",
        "--username",
        repository.owner,
        "--token-name",
        "owned-import",
        "--scopes",
        "all",
        "--raw",
      ]);
      factory = await factoryProcess(
        runtimeProof
          ? {
              runtimeHostImage: (await readFile(".factory/runtime-host-image", "utf8")).trim(),
              forgejoToken: token,
            }
          : undefined,
        runtimeProof
          ? {
              ...configuration,
              FACTORY_FORGEJO_API_URL: `${origin}/api/v1/`,
              FACTORY_FORGEJO_OWNER: repository.owner,
              FACTORY_FORGEJO_ADMIN_TOKEN: token,
              FACTORY_GIT_IMPORT_ORIGINS: `https://host.orb.internal:${proxy.port}`,
            }
          : undefined,
      );
      database = factory.connect();
      async function api(path: string, method = "GET", body?: unknown) {
        if (!factory) throw new Error("Owned import Factory missing");
        const response = await fetch(factory.base + path, {
          method,
          headers: { cookie, origin: factory.base, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`Owned import ${path}: HTTP ${response.status}`);
        return response.json();
      }
      if (runtimeProof) {
        await factory.start();
        cookie = await factory.signIn();
      }
      const secrets = createImportSecrets({
        address: configuration.FACTORY_OPENBAO_URL,
        tokenFile: configuration.FACTORY_OPENBAO_TOKEN_FILE,
        caFile: configuration.FACTORY_OPENBAO_CA_FILE,
      });
      const forge = createForgejoClient({ apiURL: `${origin}/api/v1/`, token });
      const controller = createProjectSetupController({
        database,
        forge,
        forgeOwner: repository.owner,
        forgeOrigin: origin,
        secrets,
        signingKey: "owned-import-signing-key",
        importOrigins: [`https://host.orb.internal:${proxy.port}`],
        onCreated: async () => {},
      });
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Owned importer',${`${id}@import.test`})`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${id})`;
      const draft = runtimeProof
        ? await api("/api/project-setup", "POST")
        : await controller.begin(id);
      if (!draft) throw new Error("Owned import draft missing");
      const draftInput = {
        id: draft.id,
        version: draft.version,
        name: "Imported product",
        slug: name,
        kind: "import" as const,
        sourceURL: `https://host.orb.internal:${proxy.port}/${repository.owner}/${name}.git`,
      };
      const saved = runtimeProof
        ? await api("/api/project-setup", "PUT", draftInput)
        : await controller.save(id, draftInput);
      const commandID = crypto.randomUUID();
      const createInput = {
        id: draft.id,
        version: saved?.version,
        commandID,
        importToken: sourceToken,
      };
      const result = runtimeProof
        ? await api("/api/project-setup/create", "POST", createInput)
        : await controller.create(id, createInput);
      importedProjectID = result?.projectID ?? "";
      expect(result?.state).toBe("created");
      expect(authenticatedRequests).toBeGreaterThan(0);
      expect((await forge.getDefaultBranch(repository)).headSha).toBe(head.headSha);
      expect((await forge.getBranch(repository, "feature/retained"))?.headSha).toBe(first.headSha);
      const read = async (path: string) => {
        const response = await fetch(`${origin}/api/v1/repos/${repository.owner}/${name}/${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.ok).toBe(true);
        return response.json();
      };
      const commits = await read("commits");
      expect(commits.map((commit: { sha: string }) => commit.sha)).toEqual([
        head.headSha,
        first.headSha,
      ]);
      expect((await read("tags"))[0].name).toBe("v0.1.0");
      expect(await forge.getFile(repository, "application.txt", head.headSha)).toBe(
        "preserve imported source\n",
      );
      const beforeReplay = authenticatedRequests;
      expect(
        (runtimeProof
          ? await api("/api/project-setup/create", "POST", {
              id: draft.id,
              version: saved?.version,
              commandID,
            })
          : await controller.create(id, { id: draft.id, version: saved?.version, commandID })
        )?.projectID,
      ).toBe(result?.projectID);
      expect(authenticatedRequests).toBe(beforeReplay);
      expect(await secrets.read(`imports/${draft.id}/${commandID}`)).toBeUndefined();
      const rows = await database.client`SELECT * FROM factory.project_repository_intent`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["credential_removed_at"]).not.toBeNull();
      expect(JSON.stringify(rows)).not.toContain(sourceToken);
      if (runtimeProof)
        await assistedImportRuntime({
          factory,
          projectID: importedProjectID,
          cookie,
          forge,
          repository,
          sourceCommit: head.headSha,
          sourceFiles,
        });
      succeeded = true;
    } finally {
      await proxy?.stop(true);
      if (runtimeProof && importedProjectID && !succeeded) {
        console.log(
          JSON.stringify({
            retainedAssistedImport: {
              id: factory?.id,
              base: factory?.base,
              directory,
              container,
              projectID: importedProjectID,
              repository,
              sourceSetupID,
            },
          }),
        );
        await database?.client.end({ timeout: 2 });
        await factory?.pause();
      } else {
        if (sourceCreated && (await source.setupRepository(repository, sourceSetupID))) {
          const deleted = await fetch(
            `http://127.0.0.1:33030/api/v1/repos/${repository.owner}/${name}`,
            { method: "DELETE", headers: { authorization: `Bearer ${sourceToken}` } },
          );
          expect(deleted.ok).toBe(true);
        }
        if (destinationCreated) {
          expect(
            await command([
              "docker",
              "inspect",
              "--format",
              '{{index .Config.Labels "factory.owned-private-import"}}',
              container,
            ]),
          ).toBe(id);
          await command(["docker", "rm", "--force", container]);
        }
        await database?.client.end({ timeout: 2 });
        await factory?.dispose();
        await bao.dispose();
        await rm(directory, { recursive: true });
      }
    }
  },
  1_200_000,
);
