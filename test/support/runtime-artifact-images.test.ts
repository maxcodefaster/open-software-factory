import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import upstream from "../../upstream.json";

test("native runtime host uses pinned Node, Connector, Git and CA without retired packaging", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  expect(upstream.node.image).toMatch(/@sha256:[a-f0-9]{64}$/);
  expect(dockerfile).toContain(`FROM ${upstream.node.image} AS node`);
  expect(dockerfile).toContain("FROM node AS runtime-host-base");
  expect(dockerfile).toContain(`FROM ${upstream.go.image} AS connector`);
  expect(dockerfile).toContain("-o /factory-runtime-connector ./cmd/factory-runtime-connector");
  expect(dockerfile).toContain(
    "COPY --from=connector /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
  expect(dockerfile).toContain("apk add --no-cache ca-certificates git libgcc libstdc++");
  expect(dockerfile).toContain(
    "factory-runtime-connector 2>&1 | grep -q 'usage: factory-runtime-connector'",
  );
  expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/factory-runtime-connector"]\nCMD []');
  expect(dockerfile).not.toMatch(
    /library\/docker:|AS compose\b|COPY --from=compose|docker-compose|docker-buildx|dockerd|@devcontainers|devcontainer|factory-project-prebuild/,
  );
});

test("both native architectures gate loaded packages and bind signed publication to the proven config", async () => {
  const [workflow, proof] = await Promise.all([
    readFile(".github/workflows/images.yaml", "utf8"),
    readFile("scripts/runtime/substrate-image-proof.sh", "utf8"),
  ]);
  const roles = workflow.split("\n  roles:\n")[1]?.split("\n  manifests:\n")[0];
  if (!roles) throw new Error("Missing native role publication job");
  expect(roles).toContain("- arch: arm64\n            runner: ubuntu-24.04-arm");
  expect(roles).toContain("- arch: amd64\n            runner: ubuntu-24.04");
  expect(roles).toContain('attest=(--provenance=mode=max "--sbom=generator=$SBOM_GENERATOR")');
  expect(roles).toContain(
    'if [[ "$role" == runtime-host ]]; then\n                  bash scripts/runtime/substrate-image-proof.sh "$image_id"',
  );
  let previous = -1;
  for (const step of [
    "--provenance=false --sbom=false --load",
    'image_id="$(docker image inspect --format \'{{.Id}}\' "$image")"',
    'docker image save --output "$proof_archive" "$image_id"',
    'config_file="$(tar -xOf "$proof_archive" manifest.json',
    'proven_config="sha256:$(tar -xOf "$proof_archive" -- "$config_file" | sha256sum',
    '[[ "$proven_config" =~ ^sha256:[a-f0-9]{64}$ ]]',
    'bash scripts/runtime/substrate-image-proof.sh "$image_id"',
    'elif [[ "$role" == substrate-runtime ]]; then\n                  bash scripts/runtime/substrate-image-proof.sh "$image_id"',
    'test "$(docker image inspect --format \'{{.Id}}\' "$image")" = "$image_id"',
    `"\${build[@]}" "\${attest[@]}" --push --metadata-file`,
    'native_child="$(docker buildx imagetools inspect "$image" --raw',
    'published_config="$(docker buildx imagetools inspect "$image@$native_child" --raw',
    'test "$published_config" = "$proven_config"',
    'digest="$(release_digest "$image")"',
    'release_sign "$IMAGE_ROOT/$role@$digest"',
  ]) {
    const index = roles.indexOf(step);
    expect(index, step).toBeGreaterThan(previous);
    previous = index;
  }
  expect(roles).toContain('else error("unexpected proof image count") end');
  expect(roles).toContain('select(.platform.os == "linux" and .platform.architecture == $arch)');
  expect(roles).toContain('else error("unexpected published platform count") end');
  expect(roles).toContain("jq -er '.config.digest'");
  expect(roles).toContain(
    'if release_exists "$IMAGE_ROOT/factory:$RELEASE" && ! release_overwrite; then',
  );
  expect(roles).toContain('release_require_revision "$image" "$REVISION"');
  expect(roles).toContain(
    `cosign verify --certificate-identity-regexp "^https://github.com/\${GITHUB_REPOSITORY}/"`,
  );
  expect(roles).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
  expect(workflow).toContain('test "$RELEASE_TAG" = v0.1.0-beta.1');
  expect(workflow).not.toContain("scripts/runtime/compose-inputs-proof.sh");
  expect(proof).toContain('[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]');
  expect(proof).toContain('case "$platform" in linux/amd64|linux/arm64)');
  expect(proof).toContain(
    'test "$(docker version --format \'{{.Server.Os}}/{{.Server.Arch}}\')" = "$platform"',
  );
  expect(proof).toContain(
    "docker run --rm --network=none --read-only --cap-drop=ALL --user 1000:1000",
  );
  expect(proof).toContain(
    '--security-opt=no-new-privileges --tmpfs /tmp --entrypoint /bin/sh "$image" -ec',
  );
  expect(proof).not.toMatch(/--privileged|--volume|--mount/);
  expect(proof).toContain('"nativeActorImagePackages":true');
  expect(proof).toContain('"nativeActorLifecycle":false');
});

test("one runtime host contains role tools while the independent editor remains separate", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const base = dockerfile
    .split(" AS runtime-host-base\n")[1]
    ?.split("FROM runtime-host-base AS runtime-host")[0];
  expect(base).toBeDefined();
  expect(base).toContain(
    "COPY --from=connector /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
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

test("native package proof requires role tools and rejects retired Docker, Dev Containers and prebuild binaries", async () => {
  const proof = await readFile("scripts/runtime/substrate-image-proof.sh", "utf8");
  for (const check of [
    "test -x /usr/local/bin/factory-runtime-connector",
    "test -x /usr/bin/git",
    "test -s /etc/ssl/certs/ca-certificates.crt",
    'test -n "$(node --version)"',
    'test -n "$(npm --version)"',
    'test -n "$(forgejo-runner --version)"',
    "for libc in glibc musl; do",
    'test -x "/opt/factory/opencode/$libc/bun"',
    'test -x "/opt/factory/language-tools/$libc/node"',
    'test -s "/opt/factory/language-tools/$libc/lib/libgcc_s.so.1"',
    'test -s "/opt/factory/language-tools/$libc/lib/libstdc++.so.6"',
    "test -s /opt/factory/opencode/server/server.mjs",
    "test -s /opt/factory/opencode/server/input-stop.mjs",
    "test -s /opt/factory/opencode/manifest.json",
    "test -r /opt/factory/opencode/server/config/AGENTS.md",
    "test -r /opt/factory/opencode/server/config/opencode.json",
  ])
    expect(proof).toContain(check);
  const retired = /for executable in ([\s\S]*?); do([\s\S]*?)\n {4}done/.exec(proof);
  expect(retired?.[1]?.replace(/\\\n/g, " ").trim().split(/\s+/)).toEqual([
    "docker",
    "dockerd",
    "docker-compose",
    "docker-buildx",
    "devcontainer",
    "containerd",
    "containerd-shim-runc-v2",
    "ctr",
    "runc",
    "buildkitd",
    "buildctl",
    "rootlesskit",
    "dockerd-entrypoint.sh",
    "factory-project-prebuild",
  ]);
  expect(retired?.[2]).toContain('if command -v "$executable" >/dev/null 2>&1; then');
  expect(retired?.[2]).toContain("exit 1");
  expect(proof).toContain(
    "/usr/lib/docker /usr/local/lib/node_modules/@devcontainers /opt/factory-rootless; do",
  );
  expect(proof).toContain('test ! -e "$path"');
  expect(proof).toContain("test ! -S /var/run/docker.sock");
});
