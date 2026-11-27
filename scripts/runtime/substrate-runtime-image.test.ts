import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import upstream from "../../upstream.json";

test("Factory native image uses immutable Factory tools and direct native entrypoints, never nested Docker", async () => {
  const dockerfile = await Bun.file("deploy/substrate/Runtime.Dockerfile").text();
  expect(dockerfile).toContain("FROM ${FACTORY_RUNTIME_HOST_IMAGE}");
  expect(dockerfile).toContain("@sha256:[a-f0-9]{64}");
  expect(dockerfile).toContain("test -x /usr/local/bin/factory-runtime-connector");
  expect(dockerfile).toContain("test -x /usr/bin/git");
  expect(dockerfile).toContain(
    'ENTRYPOINT ["/usr/local/bin/factory-runtime-connector", "native-parent"]',
  );
  expect(dockerfile).not.toMatch(/containerd|rootless|dockerd|devcontainer|tinyproxy/);
  const packageProof = await Bun.file("scripts/runtime/substrate-image-proof.sh").text();
  expect(packageProof).toContain("for libc in glibc musl");
  expect(packageProof).toContain("/opt/factory/language-tools");
  expect(packageProof).toContain("/opt/factory/opencode/server/input-stop.mjs");
  const factory = await Bun.file("deploy/factory/Dockerfile").text();
  const tools = await Bun.file("deploy/runtime-host/Dockerfile").text();
  expect(tools).toContain(
    "COPY --from=input-stop /out/input-stop.mjs /opt/factory/opencode/server/input-stop.mjs",
  );
  expect(factory).toContain("COPY deploy/substrate/pins.json ./deploy/substrate/pins.json");
  expect(await Bun.file(".dockerignore").text()).toContain("core.[0-9]*");
  expect(factory).toContain(
    "COPY services/substrate-control/go.mod services/substrate-control/go.sum ./",
  );
  expect(factory).toContain("CGO_ENABLED=0 go build -mod=readonly -trimpath");
  expect(factory).toContain(
    "COPY --from=substrate-control /factory-substrate-control /usr/local/bin/factory-substrate-control",
  );
  expect(factory).toContain("FROM substrate-control AS source-service");
  expect(factory).toContain(
    "COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./",
  );
  expect(factory).toContain("-o /factory-runtime-connector ./cmd/factory-runtime-connector");
  expect(factory).toContain(
    "COPY --from=source-service /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
});

test("native tools inherit pinned Node Alpine and retain their tools, source and permissions without a build daemon", async () => {
  const tools = await Bun.file("deploy/runtime-host/Dockerfile").text();
  expect(tools).toContain(`FROM ${upstream.node.image} AS node`);
  expect(tools).toContain("FROM node AS runtime-host-base");
  expect(tools).toContain("apk add --no-cache ca-certificates git libgcc libstdc++");
  expect(tools).toContain(
    "COPY --from=connector /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
  expect(tools).toContain('ENTRYPOINT ["/usr/local/bin/factory-runtime-connector"]\nCMD []');
  expect(tools).not.toMatch(
    /library\/docker:|AS compose\b|COPY --from=compose|@devcontainers|devcontainer|dockerd|factory-project-prebuild/,
  );
  for (const libc of ["glibc", "musl"]) {
    expect(tools).toContain(
      `COPY --from=language-node-${libc} /opt/node-runtime /opt/factory/language-tools/${libc}`,
    );
    expect(tools).toContain(
      `COPY --from=bun-tool /opt/factory/opencode/${libc}/bun /opt/factory/opencode/${libc}/bun`,
    );
  }
  for (const copy of [
    "COPY services/runtime-connector ./",
    "COPY deploy/opencode-server/server.mjs deploy/opencode-server/retained-events.mjs deploy/opencode-server/install-skills.mjs ./",
    "COPY deploy/opencode-server/config ./config",
    "COPY deploy/language-tools/package.json deploy/language-tools/package-lock.json ./",
    "COPY --from=opencode-server /opt/factory/opencode/server /opt/factory/opencode/server",
    "COPY --from=language-tools /opt/factory/language-tools/node_modules /opt/factory/language-tools/node_modules",
    "COPY --from=verification-tool /usr/local/bin/forgejo-runner /usr/local/bin/forgejo-runner",
  ])
    expect(tools).toContain(copy);
  expect(tools).toContain("chmod 0555 config && chmod 0444 config/opencode.json config/AGENTS.md");
  expect(tools).toContain("chmod -R a+rX,go-w,ug-s,o-t /opt/factory/opencode/server");
  expect(tools).toContain("chmod 0444 /opt/factory/opencode/manifest.json");
  expect(tools).toContain('echo "$runner_sha  /usr/local/bin/forgejo-runner" | sha256sum -c -');
  const proof = await Bun.file("scripts/runtime/substrate-image-proof.sh").text();
  for (const path of [
    "/etc/ssl/certs/ca-certificates.crt",
    "/usr/lib/libgcc_s.so.1",
    "/usr/lib/libstdc++.so.6",
    "/opt/factory/language-tools/node_modules/typescript/lib/tsserver.js",
    "/opt/factory/language-tools/node_modules/typescript-language-server/lib/cli.mjs",
    "/opt/factory/language-tools/node_modules/pyright/langserver.index.js",
    "/opt/factory/opencode/server/retained-events.mjs",
    "/opt/factory/opencode/server/install-skills.mjs",
    "/opt/factory/opencode/manifest.json",
  ])
    expect(proof).toContain(`test -s ${path}`);
  expect(proof).toContain('test -n "$(forgejo-runner --version)"');
});

test("package proof rejects every retired executable instead of accepting an empty Docker socket check", async () => {
  const proof = await Bun.file("scripts/runtime/substrate-image-proof.sh").text();
  const block = / {4}for executable in [\s\S]*?\n {4}done/.exec(proof)?.[0];
  if (!block) throw new Error("Missing retired executable package checks");
  const directory = await mkdtemp(join(tmpdir(), "factory-retired-executables-"));
  try {
    for (const executable of [
      "",
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
    ]) {
      const path = join(directory, executable);
      if (executable) await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const child = Bun.spawn(["/bin/sh", "-ec", block], {
        env: { ...process.env, PATH: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, executable || "clean tool path").toBe(executable ? 1 : 0);
      if (executable) {
        expect(error).toContain(`Obsolete runtime executable is bundled: ${executable}`);
        await rm(path);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native language tools package the same integrity-pinned TypeScript 6 compiler as Factory", async () => {
  const factory = await Bun.file("package.json").json();
  const tools = await Bun.file("deploy/language-tools/package.json").json();
  const lock = await Bun.file("deploy/language-tools/package-lock.json").json();
  const approved = Bun.JSON5.parse(await Bun.file("bun.lock").text()) as {
    packages: Record<string, unknown[]>;
  };
  const version = factory.devDependencies.typescript;
  expect(version).toMatch(/^6\.\d+\.\d+$/);
  expect(tools.dependencies.typescript).toBe(version);
  expect(lock.packages[""].dependencies.typescript).toBe(version);
  expect(lock.packages["node_modules/typescript"].version).toBe(version);
  expect(lock.packages["node_modules/typescript"].integrity).toBe(
    approved.packages["typescript"]?.[3],
  );
  expect(lock.packages["node_modules/typescript"].bin.tsserver).toBe("bin/tsserver");
});

test("package proof requires the old parent CLI's exact refusal, not success, a crash or an assignment error", async () => {
  const proof = await Bun.file("scripts/runtime/substrate-image-proof.sh").text();
  const block =
    / {4}if output="\$\(factory-runtime-connector parent[\s\S]*? {4}test "\$output" = "mode must be a native entrypoint or child"/.exec(
      proof,
    )?.[0];
  if (!block) throw new Error("Missing retired parent CLI package check");
  const directory = await mkdtemp(join(tmpdir(), "factory-retired-parent-cli-"));
  const argumentsFile = join(directory, "arguments");
  const refusal = "mode must be a native entrypoint or child";
  try {
    await writeFile(
      join(directory, "factory-runtime-connector"),
      `#!/bin/sh
printf '%s\\n' "$*" > "$OWNED_ARGUMENTS"
printf '%s' "$OWNED_OUTPUT" >&2
exit "$OWNED_STATUS"
`,
      { mode: 0o700 },
    );
    for (const [status, output, expected] of [
      [1, refusal, 0],
      [0, refusal, 1],
      [1, "read assignment: no such file", 1],
      [1, "", 1],
      [127, refusal, 1],
      [139, refusal, 1],
    ] as const) {
      const child = Bun.spawn(["/bin/sh", "-ec", block], {
        env: {
          ...process.env,
          PATH: directory,
          OWNED_ARGUMENTS: argumentsFile,
          OWNED_OUTPUT: output,
          OWNED_STATUS: String(status),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(expected);
      expect(await readFile(argumentsFile, "utf8")).toBe(
        "parent --assignment /tmp/retired-parent-assignment.json\n",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
