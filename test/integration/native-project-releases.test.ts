import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { createForgejoReleases } from "../../packages/forge/src/releases";
import { releasePackageOwner } from "../../packages/project-domain/src/release";
import { publicationRuntimeProof } from "../fixtures/publication-runtime";
import { releaseArgoProof } from "../fixtures/release-argo";

test(
  "pinned Forgejo isolates Git and package readers and revokes already-issued OCI bearer access",
  async () => {
    const id = crypto.randomUUID();
    const container = `factory-release-native-${id}`;
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const port = listener.port;
    await listener.stop(true);
    const origin = `http://127.0.0.1:${port}`;
    let owned = false;
    let runnerOwned = false;
    let preserve = false;
    const runnerContainer = `factory-publication-runner-${id}`;
    const directory = resolve(".factory/test-results/releases", `native-${id}`);
    async function command(args: string[]) {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0)
        throw new Error("Owned Forgejo operation failed; sensitive output suppressed");
      return output.trim();
    }
    try {
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--label",
        `factory.release-proof=${id}`,
        "--volume",
        "/var/lib/gitea",
        "--volume",
        "/etc/gitea",
        "-e",
        "FORGEJO__security__INSTALL_LOCK=true",
        "-e",
        "FORGEJO__database__DB_TYPE=sqlite3",
        "-e",
        `FORGEJO__server__ROOT_URL=${origin}/`,
        "-p",
        `127.0.0.1:${port}:3000`,
        "codeberg.org/forgejo/forgejo:15.0.10-rootless@sha256:6ffebd9ab9ee9f6677e3523fa60debd9de630ff2a226fa681d6cc0c7ba541d77",
      ]);
      owned = true;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (
          await fetch(`${origin}/api/healthz`)
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        await Bun.sleep(250);
      }
      await command([
        "docker",
        "exec",
        container,
        "forgejo",
        "admin",
        "user",
        "create",
        "--username",
        "factory-control",
        "--random-password",
        "--email",
        "control@factory.invalid",
        "--admin",
        "--must-change-password=false",
      ]);
      const adminToken = await command([
        "docker",
        "exec",
        container,
        "forgejo",
        "admin",
        "user",
        "generate-access-token",
        "--username",
        "factory-control",
        "--token-name",
        "owned-release-proof",
        "--scopes",
        "all",
        "--raw",
      ]);
      async function api(route: string, method = "GET", body?: unknown, token = adminToken) {
        return fetch(`${origin}/api/v1/${route}`, {
          method,
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      }
      const adapter = createForgejoReleases({
        apiURL: `${origin}/api/v1/`,
        token: adminToken,
        adminToken,
      });
      for (const name of ["source", "unrelated"])
        expect(
          (await api("user/repos", "POST", { name, private: true, auto_init: true })).status,
        ).toBe(201);
      const repository = { owner: "factory-control", name: "source" };
      const forge = createForgejoClient({ apiURL: `${origin}/api/v1/`, token: adminToken });
      const head = await forge.getDefaultBranch(repository);
      const releaseURL = await adapter.ensureRelease(
        repository,
        "0.1.0",
        head.headSha,
        "owned source publication",
      );
      expect(
        await adapter.ensureRelease(repository, "0.1.0", head.headSha, "owned source publication"),
      ).toBe(releaseURL);
      await expect(
        adapter.ensureRelease(repository, "0.1.0", "b".repeat(40), "owned source publication"),
      ).rejects.toThrow();
      const org = releasePackageOwner(id);
      const otherOrg = releasePackageOwner(crypto.randomUUID());
      const password = `proof-${crypto.randomUUID()}`;
      await adapter.ensureMachine("project-git-reader", password);
      await adapter.gitGrant(repository, "project-git-reader");
      const gitToken = await adapter.issueToken(
        repository,
        "project-git-reader",
        password,
        "git",
        "git-read",
      );
      expect(
        (await api("repos/factory-control/source", "GET", undefined, gitToken.sha1)).status,
      ).toBe(200);
      expect([403, 404]).toContain(
        (await api("repos/factory-control/unrelated", "GET", undefined, gitToken.sha1)).status,
      );
      expect([401, 403, 404]).toContain(
        (
          await api(
            "repos/factory-control/source/contents/no.txt",
            "POST",
            {
              content: Buffer.from("must not write").toString("base64"),
              message: "denied",
            },
            gitToken.sha1,
          )
        ).status,
      );
      const gitRead = await fetch(
        `${origin}/factory-control/source.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`project-git-reader:${gitToken.sha1}`).toString("base64")}`,
          },
        },
      );
      expect(gitRead.status).toBe(200);
      const gitWrite = await fetch(
        `${origin}/factory-control/source.git/info/refs?service=git-receive-pack`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`project-git-reader:${gitToken.sha1}`).toString("base64")}`,
          },
        },
      );
      expect([401, 403]).toContain(gitWrite.status);

      await adapter.ensureMachine("project-publisher", password);
      await adapter.packageGrant(org, "project-publisher", true);
      await adapter.packageGrant(otherOrg, "project-publisher", true);
      const writer = await adapter.issueToken(
        repository,
        "project-publisher",
        password,
        "publish",
        "package-write",
      );
      async function bearer(username: string, token: string, owner: string, action: string) {
        const response = await fetch(
          `${origin}/v2/token?service=container_registry&scope=${encodeURIComponent(`repository:${owner}/web:${action}`)}`,
          {
            headers: {
              authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
            },
          },
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { token: string }).token;
      }
      async function upload(owner: string) {
        const auth = await bearer("project-publisher", writer.sha1, owner, "push,pull");
        const config = Buffer.from(
          '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}',
        );
        const digest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
        const begin = await fetch(`${origin}/v2/${owner}/web/blobs/uploads/`, {
          method: "POST",
          headers: { authorization: `Bearer ${auth}` },
        });
        expect(begin.status).toBe(202);
        const location = new URL(begin.headers.get("location")!, origin);
        location.searchParams.set("digest", digest);
        expect(
          (
            await fetch(location, {
              method: "PUT",
              headers: {
                authorization: `Bearer ${auth}`,
                "content-type": "application/octet-stream",
              },
              body: config,
            })
          ).status,
        ).toBe(201);
        const manifest = JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: {
            mediaType: "application/vnd.oci.image.config.v1+json",
            digest,
            size: config.length,
          },
          layers: [],
        });
        expect(
          (
            await fetch(`${origin}/v2/${owner}/web/manifests/1.0.0`, {
              method: "PUT",
              headers: {
                authorization: `Bearer ${auth}`,
                "content-type": "application/vnd.oci.image.manifest.v1+json",
              },
              body: manifest,
            })
          ).status,
        ).toBe(201);
      }
      await upload(org);
      await upload(otherOrg);
      await adapter.ensureMachine("project-package-reader", password);
      await adapter.packageGrant(org, "project-package-reader", false);
      const reader = await adapter.issueToken(
        repository,
        "project-package-reader",
        password,
        "packages",
        "package-read",
      );
      expect(
        (await adapter.manifest(org, "web", "1.0.0", "project-package-reader", reader.sha1)).digest,
      ).toMatch(/^sha256:/);
      await expect(
        adapter.manifest(otherOrg, "web", "1.0.0", "project-package-reader", reader.sha1),
      ).rejects.toThrow();
      expect([403, 404]).toContain(
        (await api("repos/factory-control/source", "GET", undefined, reader.sha1)).status,
      );
      const cachedBearer = await bearer("project-package-reader", reader.sha1, org, "pull");
      const pushBearer = await fetch(
        `${origin}/v2/token?scope=${encodeURIComponent(`repository:${org}/web:push,pull`)}`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`project-package-reader:${reader.sha1}`).toString("base64")}`,
          },
        },
      );
      if (pushBearer.ok) {
        const token = ((await pushBearer.json()) as { token: string }).token;
        const write = await fetch(`${origin}/v2/${org}/web/blobs/uploads/`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        });
        expect([401, 403]).toContain(write.status);
      } else expect([401, 403]).toContain(pushBearer.status);
      expect([401, 403, 404]).toContain(
        (await api(`packages/${org}/container/web/1.0.0`, "DELETE", undefined, reader.sha1)).status,
      );
      const file = Buffer.from("owned generic release payload");
      expect(
        (
          await fetch(`${origin}/api/packages/${org}/generic/client/1.0.0/client.txt`, {
            method: "PUT",
            headers: { authorization: `Bearer ${writer.sha1}` },
            body: file,
          })
        ).status,
      ).toBe(201);
      expect(
        await adapter.genericFile(
          org,
          "client",
          "1.0.0",
          "client.txt",
          "project-package-reader",
          reader.sha1,
        ),
      ).toBe(`sha256:${createHash("sha256").update(file).digest("hex")}`);
      if (process.env["FACTORY_RUN_ARGO_RELEASE_PROOF"] === "1")
        await releaseArgoProof({
          origin,
          owner: org,
          digest: (
            await adapter.manifest(org, "web", "1.0.0", "project-package-reader", reader.sha1)
          ).digest,
          writer: { username: "project-publisher", token: writer.sha1 },
          reader: { username: "project-package-reader", token: reader.sha1 },
        });
      await adapter.revokeMachine(repository, org, "project-package-reader");
      const stale = await fetch(`${origin}/v2/${org}/web/manifests/1.0.0`, {
        headers: { authorization: `Bearer ${cachedBearer}` },
      });
      expect([401, 403, 404]).toContain(stale.status);
      await adapter.revokeMachine(repository, org, "project-git-reader");
      expect([403, 404]).toContain(
        (await api("repos/factory-control/source", "GET", undefined, gitToken.sha1)).status,
      );

      // Exercise the actual pinned runner and native task attribution, not a synthetic run DTO.
      const attemptID = crypto.randomUUID();
      const metadata = (await (await api("repos/factory-control/source")).json()) as {
        default_branch: string;
      };
      const original = (await (
        await api("repos/factory-control/source/contents/README.md")
      ).json()) as { sha: string };
      const probe = [
        "      - name: Allow native task observation",
        "        run: sleep 10",
        "      - name: Guard native job authority",
        "        env:",
        "          OWNED_TASK_TOKEN: ${{ github.token }}",
        "        run: |",
        "          node --input-type=module - <<'NODE'",
        `          const root = "http://host.orb.internal:${port}";`,
        "          const headers = {authorization: 'Bearer ' + process.env.OWNED_TASK_TOKEN, 'content-type': 'application/json'};",
        "          const file = await fetch(root + '/api/v1/repos/factory-control/source/contents/README.md', {headers});",
        `          const write = await fetch(root + '/api/v1/repos/factory-control/source/contents/README.md', {method:'PUT', headers, body:JSON.stringify({branch:${JSON.stringify(metadata.default_branch)},sha:${JSON.stringify(original.sha)},message:'owned permission probe',content:Buffer.from('must not enter protected main').toString('base64')})});`,
        "          const tag = await fetch(root + '/api/v1/repos/factory-control/source/tags', {method:'POST',headers,body:JSON.stringify({tag_name:'v99.0.0',target:'" +
          metadata.default_branch +
          "'})});",
        `          const pkg = await fetch(root + '/api/packages/${org}/generic/denied/0.0.0/denied.txt', {method:'PUT',headers,body:'must not publish'});`,
        "          const {writeFileSync} = await import('node:fs');",
        "          const tagMessage = await tag.text();",
        "          writeFileSync('/observed/authority.json', JSON.stringify({read:file.status,write:write.status,tag:tag.status,tagMessage,package:pkg.status}));",
        "          NODE",
        "          sleep 20",
        "",
      ].join("\n");
      const workflow = (await Bun.file("templates/release/factory-release.yml").text()).replace(
        / {6}- name: Build[\s\S]+$/,
        probe,
      );
      expect(
        (
          await api(
            "repos/factory-control/source/contents/.forgejo/workflows/factory-release.yml",
            "POST",
            {
              content: Buffer.from(workflow).toString("base64"),
              message: "owned publication workflow",
            },
          )
        ).status,
      ).toBe(201);
      const source = await forge.getDefaultBranch(repository);
      await forge.ensureDefaultBranchProtection(repository, source.name);
      await adapter.protectReleaseTags(repository);
      const dispatched = await adapter.dispatch(
        repository,
        source.headSha,
        attemptID,
        "1.0.1",
        org,
      );
      expect(dispatched.jobs).toHaveLength(1);
      let jobs = await adapter.jobs(repository, `factory-release-${attemptID}`);
      for (let observation = 0; observation < 80 && !jobs.length; observation++) {
        await Bun.sleep(250);
        jobs = await adapter.jobs(repository, `factory-release-${attemptID}`);
      }
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      const registration = await forge.registerEphemeralRunner(repository, `owned-${attemptID}`);
      const pins = (await Bun.file("upstream.json").json()) as {
        nodeDevelopment: { image: string };
        forgejoRunner: { version: string; sha256: Record<string, string> };
      };
      const architecture = /arm|aarch/.test(
        await command(["docker", "info", "--format", "{{.Architecture}}"]),
      )
        ? "arm64"
        : "amd64";
      const binary = await fetch(
        `https://code.forgejo.org/forgejo/runner/releases/download/v${pins.forgejoRunner.version}/forgejo-runner-${pins.forgejoRunner.version}-linux-${architecture}`,
      );
      expect(binary.ok).toBe(true);
      const bytes = new Uint8Array(await binary.arrayBuffer());
      const expectedDigest = pins.forgejoRunner.sha256[architecture];
      if (!expectedDigest) throw new Error("Pinned runner architecture is missing");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedDigest);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await Bun.write(`${directory}/runner`, bytes);
      await chmod(`${directory}/runner`, 0o555);
      await Bun.write(
        `${directory}/runner.yml`,
        [
          "runner:",
          "  capacity: 1",
          "  timeout: 1m",
          "cache:",
          "  enabled: false",
          "host:",
          "  workdir_parent: /tmp/factory-actions",
          "server:",
          "  connections:",
          "    factory:",
          `      url: http://host.orb.internal:${port}`,
          `      uuid: ${registration.uuid}`,
          `      token: ${registration.token}`,
          "      labels:",
          "        - factory-publication:host",
          `        - factory-release-${attemptID}:host`,
          "",
        ].join("\n"),
      );
      await chmod(`${directory}/runner.yml`, 0o600);
      await mkdir(resolve(directory, "observed"), { mode: 0o777 });
      await chmod(resolve(directory, "observed"), 0o777);
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        runnerContainer,
        "--label",
        `factory.release-proof=${id}`,
        "--volume",
        `${directory}:/proof:ro`,
        "--volume",
        `${directory}/observed:/observed`,
        "--entrypoint",
        "/proof/runner",
        pins.nodeDevelopment.image,
        "one-job",
        "--wait",
        "--handle",
        job.handle,
        "--config",
        "/proof/runner.yml",
      ]);
      runnerOwned = true;
      let attested = false;
      for (let observation = 0; observation < 80; observation++) {
        const current = await adapter.run(repository, dispatched.id);
        if (current && (await adapter.attestTask(repository, job.handle, current))) {
          attested = true;
          expect(
            await adapter.attestTask(repository, job.handle, {
              ...current,
              index_in_repo: current.index_in_repo + 1,
            }),
          ).toBe(false);
          break;
        }
        await Bun.sleep(250);
      }
      expect(attested).toBe(true);
      expect(await command(["docker", "wait", runnerContainer])).toBe("0");
      const observed = await adapter.run(repository, dispatched.id);
      if (observed?.status !== "success") {
        const logs = Bun.spawn(["docker", "logs", runnerContainer], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(logs.stdout).text(),
          new Response(logs.stderr).text(),
        ]);
        await logs.exited;
        let diagnostic = stdout + stderr;
        for (const value of [
          adminToken,
          gitToken.sha1,
          writer.sha1,
          reader.sha1,
          password,
          registration.token,
        ])
          diagnostic = diagnostic.replaceAll(value, "[redacted]");
        await writeFile(resolve(directory, "runner-diagnostic.txt"), diagnostic, { mode: 0o600 });
      }
      expect(observed?.status).toBe("success");
      const denied = await Bun.file(resolve(directory, "observed/authority.json")).json();
      expect([401, 403, 405]).toContain(denied.write);
      expect(denied.tag).toBe(422);
      expect(denied.tagMessage).toContain("user not allowed to create protected tag");
      expect((await api("repos/factory-control/source/tags/v99.0.0")).status).toBe(404);
      expect((await forge.getDefaultBranch(repository)).headSha).toBe(source.headSha);
      expect([401, 403, 404]).toContain(denied.package);
      expect(observed?.commit_sha).toBe(source.headSha);
      expect(JSON.parse(observed!.event_payload).inputs.factory_release_id).toBe(attemptID);
      if (process.env["FACTORY_RUN_RELEASE_RUNTIME_PROOF"] === "1") {
        expect(
          (
            await api("user/repos", "POST", {
              name: "runtime-source",
              private: true,
              auto_init: true,
            })
          ).status,
        ).toBe(201);
        await publicationRuntimeProof({
          origin,
          token: adminToken,
          repository: { ...repository, name: "runtime-source" },
          forge,
          preserve: () => {
            preserve = true;
          },
          captureFailure: async () => {
            const files = await command([
              "docker",
              "exec",
              container,
              "find",
              "/var/lib/gitea/actions_log/factory-control/runtime-source",
              "-type",
              "f",
              "-name",
              "*.zst",
            ]);
            for (const file of files.split("\n").filter(Boolean)) {
              const process = Bun.spawn(["docker", "exec", container, "cat", file], {
                stdout: "pipe",
                stderr: "ignore",
              });
              const bytes = await new Response(process.stdout).arrayBuffer();
              if (await process.exited) continue;
              const text = new TextDecoder()
                .decode(Bun.zstdDecompressSync(new Uint8Array(bytes)))
                .split("\n")
                .filter((line) => !/token|password|secret|authorization|bearer/i.test(line))
                .map((line) => line.replace(/[a-f0-9]{40,}/g, "[digest]"))
                .join("\n");
              await writeFile(resolve(directory, "publication-job-diagnostic.txt"), text, {
                mode: 0o600,
              });
            }
          },
        });
      }
    } finally {
      if (runnerOwned) {
        const label = await command([
          "docker",
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.release-proof"}}',
          runnerContainer,
        ]);
        expect(label).toBe(id);
        await command(["docker", "rm", "-fv", runnerContainer]);
      }
      if (owned && !preserve) {
        const label = await command([
          "docker",
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.release-proof"}}',
          container,
        ]);
        expect(label).toBe(id);
        await command(["docker", "rm", "-fv", container]);
      }
      await rm(resolve(directory, "runner.yml"), { force: true });
      await rm(resolve(directory, "runner"), { force: true });
    }
  },
  process.env["FACTORY_RUN_RELEASE_RUNTIME_PROOF"] === "1" ||
    process.env["FACTORY_RUN_ARGO_RELEASE_PROOF"] === "1"
    ? 720_000
    : 180_000,
);
