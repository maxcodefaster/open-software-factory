import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import upstream from "../../upstream.json";

test("runtime Compose pins the upstream configured-input grant fix without disabling Bake security", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const environment = await readFile("services/runtime-connector/connector/environment.go", "utf8");
  expect(upstream.dockerCompose.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(upstream.dockerCompose.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(upstream.dockerCompose.source).toContain(upstream.dockerCompose.commit);
  expect(dockerfile).toContain(`FROM ${upstream.go.image} AS compose`);
  expect(dockerfile).toContain(
    `ADD --checksum=sha256:${upstream.dockerCompose.sha256} ${upstream.dockerCompose.source}`,
  );
  expect(dockerfile).toContain(
    `github.com/docker/compose/v5/internal.Version=v${upstream.dockerCompose.version}`,
  );
  expect(dockerfile).toContain(
    "COPY --from=compose /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose",
  );
  expect(dockerfile).toContain(
    "COPY --from=compose /src/compose/LICENSE /usr/local/share/licenses/docker-compose/LICENSE",
  );
  expect(dockerfile).toContain(
    `test "$(docker compose version --short)" = "${upstream.dockerCompose.version}"`,
  );
  expect(dockerfile).toContain(`FROM ${upstream.docker.image} AS runtime-host-base`);
  for (const source of [dockerfile, environment]) {
    expect(source).not.toContain("BUILDX_BAKE_ENTITLEMENTS_FS=0");
    expect(source).not.toContain("COMPOSE_BAKE");
  }
});

test("both native release jobs prove configured Compose inputs before pushing the runtime image", async () => {
  const [workflow, proof] = await Promise.all([
    readFile(".github/workflows/images.yaml", "utf8"),
    readFile("scripts/runtime/compose-inputs-proof.sh", "utf8"),
  ]);
  expect(workflow).toContain("runner: ubuntu-24.04-arm");
  const load = workflow.indexOf("--provenance=false --sbom=false --load");
  const configBytes = workflow.indexOf(
    'tar -xOf "$proof_archive" -- "$config_file" | sha256sum',
    load,
  );
  const gate = workflow.indexOf('bash scripts/runtime/compose-inputs-proof.sh "$image_id"');
  const push = workflow.indexOf(['"$', '{attest[@]}" --push --metadata-file'].join(""));
  const sameImage = workflow.indexOf('test "$published_config" = "$proven_config"', push);
  expect(load).toBeGreaterThan(0);
  expect(configBytes).toBeGreaterThan(load);
  expect(configBytes).toBeLessThan(gate);
  expect(gate).toBeGreaterThan(load);
  expect(push).toBeGreaterThan(gate);
  expect(sameImage).toBeGreaterThan(push);
  expect(workflow).toContain('docker buildx imagetools inspect "$image@$native_child" --raw');
  expect(proof).toContain('test "$image_arch" = "$server_arch"');
  expect(proof).toContain("BUILDX_BAKE_ENTITLEMENTS_FS=1");
  expect(proof).toContain("--network=none --cpus=3 --memory=3g");
  expect(proof).toContain("configuredDockerfileBuilt");
  expect(proof).toContain("unconfiguredReadRefused");
});

test("one runtime host contains role tools while the independent editor remains separate", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const base = dockerfile
    .split(" AS runtime-host-base\n")[1]
    ?.split("FROM runtime-host-base AS runtime-host")[0];
  expect(base).toBeDefined();
  expect(base).toContain("@devcontainers/cli@0.89.0");
  expect(base).not.toContain("opencode");
  expect(base).not.toContain("forgejo-runner");
  expect(base).not.toContain("theia");
  expect(base).not.toContain("COPY --from=language-tools");
  const runtime = dockerfile
    .split("FROM runtime-host-base AS runtime-host")[1]
    ?.split("FROM runtime-host AS runtime")[0];
  expect(runtime).toContain("COPY --from=language-tools");
  expect(runtime).toContain("COPY --from=language-node-glibc");
  expect(runtime).toContain("COPY --from=language-node-musl");
  expect(runtime).toContain("COPY --from=bun-tool");
  expect(runtime).toContain("COPY --from=opencode-server /opt/factory/opencode/server");
  expect(runtime).toContain("COPY --from=verification-tool /usr/local/bin/forgejo-runner");
  expect(runtime).not.toContain("theia");
  expect(dockerfile).not.toContain("AS build-runtime-host");
  expect(dockerfile).not.toContain("AS verification-runtime-host");
  const editor = dockerfile.split(" AS developer-ide\n")[1]?.split(" AS runtime-host-base")[0];
  expect(editor).toContain("ENV THEIA_CONFIG_DIR=/home/node/.factory-theia");
  expect(editor).not.toContain("COPY --from=language-tools");
});

test("runtime OpenCode packages the pinned Bun server without unused CLI binaries", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const server = dockerfile.split(" AS opencode-server\n")[1]?.split("\nFROM ")[0];
  expect(upstream.openCode).toEqual({ version: upstream.openCodeServer.version });
  expect(dockerfile).toContain(`FROM ${upstream.openCodeServer.bunImage} AS opencode-server`);
  expect(server).toContain(
    "COPY deploy/opencode-server/package.json deploy/opencode-server/bun.lock ./",
  );
  expect(server).toContain(
    "bun install --frozen-lockfile --ignore-scripts --production --os='*' --cpu=\"$cpu\"",
  );
  for (const libc of ["glibc", "musl"])
    expect(dockerfile).toContain(
      `COPY --from=bun-tool /opt/factory/opencode/${libc}/bun /opt/factory/opencode/${libc}/bun`,
    );
  expect(dockerfile).toContain(
    "COPY --from=opencode-server /opt/factory/opencode/server /opt/factory/opencode/server",
  );
  for (const obsolete of [
    "AS build-tool",
    "--from=build-tool",
    "opencode_tarball",
    "openCode.packages",
    "openCode.glibcPackages",
    "/opt/factory/opencode/opencode",
    "/opt/factory/opencode/glibc/opencode",
  ])
    expect(dockerfile).not.toContain(obsolete);
});

test("input Stop builds from its own frozen dependency scope and the original helper sources", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const helper = dockerfile.split(" AS input-stop\n")[1]?.split("\nFROM ")[0];
  expect(dockerfile).toContain(`FROM ${upstream.openCodeServer.bunImage} AS input-stop`);
  expect(helper).toBeDefined();
  expect(helper?.match(/^COPY .+$/gm)).toEqual([
    "COPY deploy/input-stop/package.json deploy/input-stop/bun.lock ./",
    "COPY upstream.json ./upstream.json",
    "COPY apps/factory/src/agent/opencode-adapter.ts apps/factory/src/agent/input-stop-worker.ts ./apps/factory/src/agent/",
    "COPY scripts/factory/build-input-stop.ts ./scripts/factory/build-input-stop.ts",
  ]);
  expect(helper).toContain("RUN bun install --frozen-lockfile --ignore-scripts --production");
  expect(helper).toContain("RUN bun scripts/factory/build-input-stop.ts /out");
  expect(dockerfile).toContain(
    "COPY --from=input-stop /out/input-stop.mjs /opt/factory/opencode/server/input-stop.mjs",
  );
});

test("input Stop locks only its SDK and validation closure at approved versions and integrities", async () => {
  type Lock = {
    workspaces: Record<string, { name: string; dependencies: Record<string, string> }>;
    packages: Record<
      string,
      [
        string,
        string,
        {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          optionalPeers?: string[];
        },
        string,
      ]
    >;
  };
  const manifest = JSON.parse(await readFile("deploy/input-stop/package.json", "utf8"));
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const lock = Bun.JSON5.parse(await readFile("deploy/input-stop/bun.lock", "utf8")) as Lock;
  const approved = Bun.JSON5.parse(await readFile("bun.lock", "utf8")) as Lock;
  const dependencies = {
    "@opencode/client": root.dependencies["@opencode/client"],
    zod: root.dependencies.zod,
  };
  expect(manifest).toEqual({
    name: "factory-input-stop",
    private: true,
    type: "module",
    dependencies,
  });
  expect(lock.workspaces).toEqual({ "": { name: manifest.name, dependencies } });
  expect(lock.packages["@opencode/client"]?.[3]).toBe(upstream.openCodeClient.integrity);
  expect(dependencies["@opencode/client"]).toBe(upstream.openCodeClient.version);
  const closure = new Set<string>();
  const pending = Object.keys(dependencies);
  while (pending.length) {
    const name = pending.pop();
    if (!name || closure.has(name)) continue;
    closure.add(name);
    const entry = approved.packages[name];
    if (!entry) throw new Error(`Missing approved helper dependency: ${name}`);
    expect(lock.packages[name]).toEqual(entry);
    pending.push(...Object.keys(entry[2].dependencies ?? {}));
    pending.push(
      ...Object.keys(entry[2].peerDependencies ?? {}).filter(
        (peer) => !entry[2].optionalPeers?.includes(peer),
      ),
    );
  }
  expect(Object.keys(lock.packages).sort()).toEqual([...closure].sort());
  const imports = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: "ts" });
  for (const path of [
    "apps/factory/src/agent/input-stop-worker.ts",
    "apps/factory/src/agent/opencode-adapter.ts",
  ])
    for (const imported of scanner.scanImports(await readFile(path, "utf8")))
      if (!imported.path.startsWith(".") && !imported.path.startsWith("node:"))
        imports.add(imported.path);
  expect([...imports].sort()).toEqual(Object.keys(dependencies).sort());
});

test("pinned process fixture uses native server identity and retains explicit candidate execution", async () => {
  const fixture = await readFile("test/fixtures/pinned-opencode.ts", "utf8");
  expect(fixture).toContain('process.env["FACTORY_OPENCODE_SERVER_TEST_BINARY"]');
  expect(fixture).toContain("const packaged = !serverBinary;");
  expect(fixture).toContain('await copyFile(serverBinary, resolve(scratch, "opencode"));');
  expect(fixture).toContain('"FACTORY_PROCESS_NATIVE_SERVER=1",');
  expect(fixture).toContain('"FACTORY_PROCESS_PACKAGED_SERVER=1"');
  expect(fixture).toContain("dst=/opt/factory/opencode,readonly");
  expect(fixture).toContain("dst=/owned-server,readonly");
  expect(fixture).toContain('const path = "/api/info";');
  expect(fixture).toMatch(/const version = `opencode v\$\{\(await nativeInfo\(\)\)\.version\}`;/);
  for (const obsolete of ["nativeServer", "/opt/factory/opencode/glibc/opencode", '"--version"'])
    expect(fixture).not.toContain(obsolete);
});

test("Project prebuild identity binds the same integrity-checked Dev Containers CLI shipped by the host", async () => {
  const [producer, dockerfile] = await Promise.all([
    readFile("services/runtime-connector/connector/prebuild.go", "utf8"),
    readFile("deploy/runtime-host/Dockerfile", "utf8"),
  ]);
  expect(producer).toContain(`const prebuildCLIVersion = "${upstream.devcontainersCli.version}"`);
  expect(producer).toContain(
    `const prebuildCLIIntegrity = "${upstream.devcontainersCli.integrity}"`,
  );
  expect(dockerfile).toContain(
    "COPY --from=connector /factory-project-prebuild /usr/local/bin/factory-project-prebuild",
  );
});
